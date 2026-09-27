/**
 * Two-row statusline for Pi.
 *
 * Top bar — a widget above the editor, always visible:
 *
 *   <pi> 1h 42m · <spinner> 3m 07s          ~/proj (main)
 *
 * Bottom bar — the custom footer, model/context/cache on the left and the
 * provider limits on the right:
 *
 *   DeepSeek V4.1 Flash · max · 2.4%/1M · CH87%    <bolt> Command Code · 5h 0% (4h 51m) · 7d 5% (5d 14h) · mo 5% (25d)
 *
 * Pi's built-in working row is hidden: the top bar already shows the spinner
 * next to the timings, so keeping both would print two spinners.
 *
 * Provider limit windows come from the active subscription provider's usage
 * endpoint — `GET <baseUrl>/v1/usage` for `opencode-go`, the pinned ChatGPT
 * `/wham/usage` route for `openai-codex`, the pinned Command Code
 * `/alpha/billing/credits` route plus `/alpha/usage/summary` and
 * `/alpha/billing/subscriptions` for the derived monthly window — with the
 * credential Pi already stores. Fetching is best-effort: on any failure
 * (offline, 401, missing subscription, another provider) the usage segment is
 * hidden and the last good snapshot is kept. Provider parsers and the request
 * shape live in `statusline/usage.ts`.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
	COMMANDCODE,
	OPENCODE_GO,
	OPENAI_CODEX,
	SEP,
	fetchCodexUsage,
	fetchCommandCodeUsage,
	fetchOpencodeGoUsage,
	isUsageProvider,
	renderUsage,
	type UsageSnapshot,
} from "./statusline/usage";

// ── Tweakables ─────────────────────────────────────────────────────────────
/** Leading glyph (nf-md). Matches the user's omp footer. */
const ICON_PI = "\u{f0d57}";
/** Show the active thinking level next to the model name. */
const SHOW_THINKING_LEVEL = true;
/** How often provider usage is refetched. */
const USAGE_REFRESH_MS = 60_000;
/** Task-timer spinner frames (braille) and frame interval. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 100;
/** Clock refresh so the total Pi time keeps ticking while idle. */
const CLOCK_MS = 1_000;
/** Wall-clock start of this Pi process: the "total pi time" counts from here. */
const PI_STARTED_AT = Date.now() - process.uptime() * 1_000;

// ── Usage plumbing ─────────────────────────────────────────────────────────

/** Resolve the credential Pi stores for the active provider and fetch usage. */
async function fetchUsage(ctx: ExtensionContext): Promise<UsageSnapshot | undefined> {
	const provider = ctx.model?.provider;
	if (provider === OPENCODE_GO) {
		const auth = await ctx.modelRegistry.getProviderAuth(OPENCODE_GO);
		const apiKey = auth?.auth?.apiKey;
		if (!apiKey) return undefined;
		return fetchOpencodeGoUsage(apiKey, auth?.auth?.baseUrl ?? ctx.model?.baseUrl);
	}
	if (provider === OPENAI_CODEX) {
		const auth = await ctx.modelRegistry.getProviderAuth(OPENAI_CODEX);
		const accessToken = auth?.auth?.apiKey;
		if (!accessToken) return undefined;
		// The account id and pinned origin live inside the usage module.
		return fetchCodexUsage(accessToken);
	}
	if (provider === COMMANDCODE) {
		const auth = await ctx.modelRegistry.getProviderAuth(COMMANDCODE);
		const apiKey = auth?.auth?.apiKey;
		if (!apiKey) return undefined;
		// The pinned origin lives inside the usage module.
		return fetchCommandCodeUsage(apiKey);
	}
	return undefined;
}

// ── Formatting ─────────────────────────────────────────────────────────────

function trim1(value: number): string {
	const text = value.toFixed(1);
	return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/** Compact token/window count (1_000_000 -> "1M", 200_000 -> "200K"). */
function formatTokens(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value < 1_000) return `${Math.round(value)}`;
	if (value < 10_000) return `${trim1(value / 1_000)}K`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}K`;
	if (value < 10_000_000) return `${trim1(value / 1_000_000)}M`;
	return `${Math.round(value / 1_000_000)}M`;
}

/** Elapsed task time, e.g. "42s", "3m 07s", "1h 02m". */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd === home) return "~";
	if (home && cwd.startsWith(`${home}/`)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

/**
 * Command Code appends "(CC)" to every catalog model name; the provider is
 * already named by the limits segment, so the footer drops the suffix.
 */
export function displayModelName(name: string): string {
	return name.replace(/\s*\(CC\)$/, "");
}

/**
 * Cache hit rate of the latest assistant prompt: cacheRead / (input + cacheRead
 * + cacheWrite). Undefined until a response reports cache reads.
 */
function latestCacheHitRate(ctx: ExtensionContext): number | undefined {
	let rate: number | undefined;
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = (entry.message as AssistantMessage).usage;
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		rate = promptTokens > 0 && usage.cacheRead > 0 ? (usage.cacheRead / promptTokens) * 100 : undefined;
	}
	return rate;
}

/** Left segments, then right-aligned segments, padded to the viewport width. */
function layoutFooter(left: string, right: string, width: number): string {
	const minGap = 2;
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);

	if (rightWidth === 0) return truncateToWidth(left, width, "…");
	if (leftWidth + minGap + rightWidth <= width) {
		return left + " ".repeat(width - leftWidth - rightWidth) + right;
	}

	const availableLeft = Math.max(0, width - rightWidth - minGap);
	const truncatedLeft = truncateToWidth(left, availableLeft, "");
	const gap = " ".repeat(Math.max(1, width - visibleWidth(truncatedLeft) - rightWidth));
	return truncateToWidth(truncatedLeft + gap + right, width, "");
}

/**
 * Top-bar layout: the timings on the left are never dropped. When space is
 * tight, path segments are dropped from the right-hand side (so the branch
 * outlives the full path) instead of blanking the timer.
 */
function layoutTopBar(left: string, rightSegments: string[], separator: string, width: number): string {
	const minGap = 2;
	const leftWidth = visibleWidth(left);
	const availableRight = Math.max(0, width - leftWidth - minGap);
	const segments = [...rightSegments];
	while (segments.length > 1 && visibleWidth(segments.join(separator)) > availableRight) segments.shift();
	const right = truncateToWidth(segments.join(separator), availableRight, "");
	return layoutFooter(left, right, width);
}

// ── Extension ──────────────────────────────────────────────────────────────

export default function statusline(pi: ExtensionAPI) {
	let usage: UsageSnapshot | undefined;
	let usageProvider: string | undefined;
	let fetching = false;
	let requestRender: (() => void) | undefined;
	// Stashed by the footer factory: the widget factory receives no footer data.
	let footerDataRef: ReadonlyFooterDataProvider | undefined;

	// Task timer — rendered as the first element of the top bar.
	let taskStart: number | undefined;
	let lastElapsedMs: number | undefined;
	let spinnerFrame = 0;
	let spinnerTimer: ReturnType<typeof setInterval> | undefined;
	let clockTimer: ReturnType<typeof setInterval> | undefined;

	const startSpinner = () => {
		if (spinnerTimer) return;
		spinnerTimer = setInterval(() => {
			spinnerFrame++;
			requestRender?.();
		}, SPINNER_MS);
		spinnerTimer.unref?.();
	};

	const stopSpinner = () => {
		if (!spinnerTimer) return;
		clearInterval(spinnerTimer);
		spinnerTimer = undefined;
	};

	async function refreshUsage(ctx: ExtensionContext): Promise<void> {
		const provider = ctx.model?.provider;
		if (!isUsageProvider(provider)) {
			usage = undefined;
			usageProvider = undefined;
			requestRender?.();
			return;
		}
		if (fetching) return;
		fetching = true;
		try {
			const snapshot = await fetchUsage(ctx);
			if (snapshot) {
				usage = snapshot;
				usageProvider = provider;
			} else if (usageProvider !== provider) {
				// Never had a good snapshot for this provider; leave undefined.
				usage = undefined;
			}
		} catch {
			// Best-effort: keep the last good snapshot, hide if there is none.
		} finally {
			fetching = false;
			requestRender?.();
		}
	}

	pi.on("agent_start", () => {
		if (taskStart === undefined) {
			taskStart = Date.now();
			lastElapsedMs = undefined;
			spinnerFrame = 0;
		}
		startSpinner();
		requestRender?.();
	});

	pi.on("agent_settled", () => {
		if (taskStart !== undefined) lastElapsedMs = Date.now() - taskStart;
		taskStart = undefined;
		stopSpinner();
		requestRender?.();
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		/**
		 * Top bar: total Pi time and the current/last task on the left; project
		 * directory, cwd-switch override and branch on the right.
		 */
		const renderTopBar = (theme: Theme, width: number): string => {
			const separator = theme.fg("dim", SEP);
			const left: string[] = [];
			left.push(theme.fg("dim", ICON_PI));
			left.push(theme.fg("text", formatDuration(Date.now() - PI_STARTED_AT)));
			if (taskStart !== undefined) {
				const glyph = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
				left.push(`${theme.fg("accent", glyph)} ${theme.fg("text", formatDuration(Date.now() - taskStart))}`);
			} else {
				// Idle: keep the element visible — last task duration, or 0s before any task.
				const glyph = lastElapsedMs !== undefined ? "✓" : "○";
				left.push(`${theme.fg("dim", glyph)} ${theme.fg("dim", formatDuration(lastElapsedMs ?? 0))}`);
			}

			const right: string[] = [];
			right.push(theme.fg("text", formatCwd(ctx.cwd)));

			// cwd-switch keeps an effective directory for tool calls while the
			// session directory stays put; show it so the bar never implies that
			// tools are running in the directory it displays first.
			const effectiveCwd = footerDataRef?.getExtensionStatuses?.().get("cwd");
			if (effectiveCwd) right.push(theme.fg("accent", effectiveCwd));

			const branch = footerDataRef?.getGitBranch();
			if (branch && branch !== "detached") right.push(theme.fg("dim", branch));

			return layoutTopBar(left.join(separator), right, separator, width);
		};

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			footerDataRef = footerData;
			void refreshUsage(ctx);
			const timer = setInterval(() => void refreshUsage(ctx), USAGE_REFRESH_MS);
			timer.unref?.();
			const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					clearInterval(timer);
					stopSpinner();
					if (clockTimer) clearInterval(clockTimer);
					clockTimer = undefined;
					unsubscribeBranch();
					requestRender = undefined;
					footerDataRef = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					if (width <= 0) return [""];

					const model = ctx.model;
					const separator = theme.fg("dim", SEP);

					const left: string[] = [];
					if (model) {
						let modelText = displayModelName(model.name || model.id);
						if (SHOW_THINKING_LEVEL && model.reasoning) {
							const level = pi.getThinkingLevel();
							if (level && level !== "off") {
								modelText = `${modelText}${separator}${theme.fg("dim", level)}`;
							}
						}
						left.push(theme.fg("accent", modelText));
					}

					const contextUsage = ctx.getContextUsage();
					const window = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
					const percent = contextUsage?.percent ?? null;
					if (window > 0) {
						const color: ThemeColor = percent === null ? "muted" : percent >= 80 ? "error" : percent >= 50 ? "warning" : "muted";
						const percentText = percent === null ? "?" : `${percent.toFixed(1)}%`;
						left.push(theme.fg(color, `${percentText}/${formatTokens(window)}`));
					}

					const cacheHit = latestCacheHitRate(ctx);
					if (cacheHit !== undefined) left.push(theme.fg("muted", `CH${cacheHit.toFixed(1)}%`));

					const leftText = left.join(separator);
					// Fall back to the bare provider id when no usage segment renders, so
					// the right side always names the model's provider.
					const rightText = (usage ? (renderUsage(theme, usage) ?? "") : "") || (model ? theme.fg("muted", model.provider) : "");
					return [layoutFooter(leftText, rightText, width)];
				},
			};
		});

		// The top bar already renders the working spinner; Pi's built-in working
		// row would print a second one, so it is hidden for this session.
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setWidget("statusline-top", (tui, theme) => {
			requestRender = () => tui.requestRender();
			return {
				invalidate() {},
				render(width: number): string[] {
					if (width <= 0) return [""];
					return [renderTopBar(theme, width)];
				},
			};
		});

		// Keep the total Pi time ticking while idle; the 100ms spinner timer only
		// runs while a task is active.
		clockTimer = setInterval(() => requestRender?.(), CLOCK_MS);
		clockTimer.unref?.();
	});

	pi.on("model_select", (_event, ctx) => {
		usage = undefined;
		usageProvider = undefined;
		void refreshUsage(ctx);
	});
}
