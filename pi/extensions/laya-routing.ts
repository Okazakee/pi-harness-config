/**
 * Laya delegation advisor (`/laya-routing`).
 *
 * One small advisory decision per root user turn: would auxiliary context
 * help, and of what kind? The parent model stays in charge. The hint is a
 * request-local `role: "custom"` message (never persisted, never replayed by
 * Pi), never triggers delegation on its own, and only exists in `advise` mode.
 *
 * Modes: `off` (inert; no daemon, no connect, no telemetry), `shadow`
 * (classify + telemetry, never inject), `advise` (inject above the confidence
 * gate). Delegated sessions (`PI_SUBAGENT_DEPTH > 0`) register nothing.
 *
 * Runtime: one shared warm daemon per user behind the `DecisionClient`
 * boundary. This process holds one persistent socket connection while it
 * runs — the connection is the lease, so the daemon frees all model RAM five
 * minutes after the last Pi exits. `session_shutdown` closes it idempotently.
 *
 * Everything here fails open: a missing daemon, model, timeout, malformed
 * answer or exception yields ordinary Pi behavior with a telemetry reason.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createDaemonDecisionClient } from "./laya-routing/client";
import {
	defaultConfigPath,
	defaultTelemetryPath,
	isMode,
	loadConfig,
	saveConfig,
	type ConfigLoad,
	type Env,
	type LayaRoutingConfig,
	type LayaRoutingMode,
} from "./laya-routing/config";
import { explicitIntent, lowInformation } from "./laya-routing/intent";
import { buildHintMessage, sanitizePrompt, specialistFor } from "./laya-routing/routing";
import { appendDecisionEvent, buildDecisionEvent, countEvents, readLastEvent, summarizeEvent } from "./laya-routing/telemetry";
import { LayaDaemonTransport, resolveRuntimePaths, type DaemonStatus, type RuntimePaths } from "./laya-routing/transport";
import type { BypassReason, DecisionClient, DecisionResult } from "./laya-routing/types";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export interface LayaRoutingDeps {
	env?: Env;
	configFile?: string;
	telemetryFile?: string;
	daemonPath?: string;
	runtimePaths?: RuntimePaths;
	/** Injectable seams for tests: config loading, classifier, transport, telemetry, clock. */
	loadConfig?: (path: string) => ConfigLoad;
	client?: DecisionClient;
	transport?: LayaDaemonTransport;
	appendEvent?: (event: Record<string, unknown>) => void;
	now?: () => number;
	newId?: () => string;
}

interface TurnState {
	id: string;
	repositorySession: boolean;
	mode: LayaRoutingMode;
	threshold: number;
	budgetMs: number;
	bypass?: BypassReason;
	decision?: Promise<DecisionResult>;
	result?: DecisionResult;
	injected: boolean;
	budgetSpent: boolean;
	agents: Set<string>;
}

/**
 * Registers the advisor. Exported separately from the default export so tests
 * can drive it with injectable seams and a fake ExtensionAPI.
 */
export function registerLayaRouting(pi: ExtensionAPI, deps: LayaRoutingDeps = {}): void {
	const env = deps.env ?? process.env;
	// Delegated sessions are never classified and never hint: register nothing,
	// matching the todo extension's boundary.
	if (isSubagentProcess(env)) return;

	const configFile = deps.configFile ?? defaultConfigPath(env);
	const telemetryFile = deps.telemetryFile ?? defaultTelemetryPath(env);
	const daemonPath = deps.daemonPath ?? join(MODULE_DIR, "laya-routing", "daemon.py");
	const paths = deps.runtimePaths ?? resolveRuntimePaths(env);
	const loadCfg = deps.loadConfig ?? ((path: string) => loadConfig(path, env));
	const now = deps.now ?? (() => Date.now());
	const newId = deps.newId ?? (() => randomUUID());
	const append = deps.appendEvent ?? ((event: Record<string, unknown>) => appendDecisionEvent(telemetryFile, event));
	const transport =
		deps.transport ??
		new LayaDaemonTransport({
			daemonPath,
			paths,
			env,
			python: () => loadCfg(configFile).config.python,
			graceMs: () => loadCfg(configFile).config.shutdownGraceMs,
		});
	const client = deps.client ?? createDaemonDecisionClient({ transport, config: () => loadCfg(configFile).config, now });

	let turn: TurnState | null = null;
	let lastStatus: string | undefined;

	/** Connect (or start) the daemon for a non-off mode; never blocks a turn. */
	const ensureRuntime = (): void => {
		if (loadCfg(configFile).config.mode === "off") return;
		void transport.ensureConnected();
	};

	pi.on("session_start", () => {
		ensureRuntime();
	});

	// Docs contract: close session-scoped resources from an idempotent
	// shutdown handler (quit, reload and session replacement all fire it).
	pi.on("session_shutdown", () => {
		transport.close();
	});

	/**
	 * One turn record per accepted root user input. Steering a running turn
	 * replaces the record; only the newest prompt is classified.
	 */
	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive" && event.source !== "rpc") return;

		const loaded = loadCfg(configFile);
		if (loaded.config.mode === "off") {
			turn = null;
			return;
		}

		const text = sanitizePrompt(event.text);
		const intent = explicitIntent(event.text);
		const state: TurnState = {
			id: newId(),
			repositorySession: isRepositorySession(ctx.cwd),
			mode: loaded.config.mode,
			threshold: loaded.config.confidenceThreshold,
			budgetMs: loaded.config.advisoryBudgetMs,
			injected: false,
			budgetSpent: false,
			agents: new Set(),
		};

		if (intent !== null) state.bypass = intent;
		else if (lowInformation(text)) state.bypass = "low_information";
		else if (text.length === 0) state.bypass = "unusable_input";
		else {
			state.decision = Promise.resolve()
				.then(() => client.decide({ text, repositorySession: state.repositorySession }))
				.then((result) => {
					state.result = result;
					return result;
				})
				.catch((cause): DecisionResult => ({ ok: false, reason: "exception", detail: cause instanceof Error ? cause.message : String(cause) }));
		}

		turn = state;
	});

	/** Observe specialist delegation in the current run; never intercept it. */
	pi.on("tool_call", (event) => {
		const active = turn;
		if (!active || event.toolName !== "subagent") return;
		for (const agent of subagentAgents(event.input)) active.agents.add(agent);
	});

	/**
	 * One-shot request-local hint. The first provider request of the turn may
	 * wait up to `advisoryBudgetMs`; later requests only pick up a decision
	 * that is already available, so the classifier can never stall Pi.
	 */
	pi.on("context", async (event) => {
		const active = turn;
		if (
			!active ||
			active.mode !== "advise" ||
			active.injected ||
			active.bypass !== undefined ||
			active.decision === undefined
		) {
			return;
		}

		let result = active.result;
		if (result === undefined && !active.budgetSpent) {
			active.budgetSpent = true;
			result = await withBudget(active.decision, active.budgetMs);
		}
		if (result === undefined || !result.ok) return;

		const specialist = specialistFor(result.decision.purpose);
		if (specialist === null || result.decision.answerConfidence < active.threshold) return;

		active.injected = true;
		return { messages: [...event.messages, buildHintMessage(result.decision, specialist, now())] };
	});

	pi.on("agent_settled", () => {
		const settled = turn;
		turn = null;
		if (!settled) return;
		void recordTurn(settled);
	});

	async function recordTurn(settled: TurnState): Promise<void> {
		// Correlation is per agent run: delegation observed through `tool_call`
		// while this turn was active. `changed_course` is not observable and is
		// deliberately not recorded.
		const agents = [...settled.agents].sort();
		let result = settled.result;
		if (result === undefined && settled.decision !== undefined) {
			try {
				result = await settled.decision;
			} catch {
				result = undefined;
			}
		}
		const event = buildDecisionEvent({
			id: settled.id,
			at: now(),
			mode: settled.mode,
			repositorySession: settled.repositorySession,
			threshold: settled.threshold,
			bypass: settled.bypass,
			result,
			injected: settled.injected,
			agents,
			delegated: agents.length > 0,
		});
		append(event);
		lastStatus = summarizeEvent(event);
	}

	async function statusText(): Promise<string> {
		const loaded = loadCfg(configFile);
		const config = loaded.config;
		const lines = [
			`laya-routing: mode=${config.mode}${loaded.exists ? "" : " (no config file, using defaults)"}`,
			`config: ${configFile}`,
			`gate: threshold=${config.confidenceThreshold} timeoutMs=${config.timeoutMs} advisoryBudgetMs=${config.advisoryBudgetMs} gracefulShutdownMs=${config.shutdownGraceMs}`,
			`daemon: ${daemonPath}`,
		];
		const count = countEvents(telemetryFile);
		lines.push(`telemetry: ${telemetryFile}${count === undefined ? "" : ` (${count} events)`}`);
		if (loaded.error) lines.push(`config error: ${loaded.error}`);
		for (const warning of loaded.warnings) lines.push(`config warning: ${warning}`);

		// `off` is inert: never touch the transport, whose status() would connect
		// and could start the daemon. Report without a runtime call.
		let status: DaemonStatus | undefined;
		if (config.mode !== "off") {
			try {
				status = await transport.status(5_000);
			} catch {
				status = undefined;
			}
		}
		if (!status) {
			lines.push(`laya: ${config.mode === "off" ? "not connected (mode=off)" : "daemon unavailable (fail-open)"}`);
		} else {
			const checkpoints = status.checkpoints.map((entry) => `${entry.id}${entry.subfolder ? `:${entry.subfolder}` : ""}`).join(",");
			lines.push(
				`daemon: id=${status.daemonId} pid=${status.pid} state=${status.state} clients=${status.clientCount} uptime=${formatDuration(status.uptimeMs)} router=${status.router ?? "?"} backend=${status.backend ?? "?"}`,
			);
			lines.push(`checkpoints: ${checkpoints}${status.packageVersion ? ` (laya ${status.packageVersion})` : ""}`);
			if (status.loadedMs) {
				const loadedParts = Object.entries(status.loadedMs).map(([id, ms]) => `${id}=${ms}ms`);
				if (loadedParts.length > 0) lines.push(`model load: ${loadedParts.join(" ")}`);
			}
			if (status.grace.pending) lines.push(`shutdown grace: ${status.grace.remainingMs ?? "?"} ms remaining`);
			if (status.error) lines.push(`daemon error: ${status.error.error}${status.error.detail ? ` (${status.error.detail})` : ""}`);
			if (status.last) {
				const last = status.last as Record<string, unknown>;
				if (typeof last.error === "string") lines.push(`last classification: failed (${last.error})`);
				else lines.push(`last classification: language=${last.language ?? "?"} checkpoint=${last.checkpoint ?? "?"} purpose=${last.purpose ?? "?"} latency=${last.latency_ms ?? "?"}ms`);
			}
		}

		const fromMemory = lastStatus;
		const fromFile = fromMemory ?? (readLastEvent(telemetryFile) ? summarizeEvent(readLastEvent(telemetryFile) as Record<string, unknown>) : undefined);
		lines.push(`last event: ${fromFile ?? "none"}`);
		return lines.join("\n");
	}

	pi.registerCommand("laya-routing", {
		description: "Show or set the Laya delegation-advisor mode (off|shadow|advise)",
		handler: async (rawArgs, ctx) => {
			const args = (rawArgs ?? "").trim();
			const [sub, value] = args.split(/\s+/);

			if (sub === "mode") {
				if (!isMode(value)) {
					ctx.ui.notify("usage: /laya-routing mode <off|shadow|advise>\n       /laya-routing status", "warning");
					return;
				}
				try {
					saveConfig(configFile, { ...loadCfg(configFile).config, mode: value });
					// `off` genuinely disconnects this instance; shadow/advise
					// reconnect (and start the daemon on first use).
					if (value === "off") transport.close();
					else void transport.ensureConnected();
					ctx.ui.notify(`laya-routing: mode=${value} (${configFile})`, "info");
				} catch (cause) {
					ctx.ui.notify(`laya-routing: could not write ${configFile}: ${cause instanceof Error ? cause.message : String(cause)}`, "error");
				}
				return;
			}

			ctx.ui.notify(await statusText(), "info");
		},
	});
}

export default function layaRouting(pi: ExtensionAPI): void {
	registerLayaRouting(pi);
}

// ── Small pure helpers ─────────────────────────────────────────────────────

/** `PI_SUBAGENT_DEPTH > 0` means this process is a delegated session. */
export function isSubagentProcess(env: Env): boolean {
	const raw = env.PI_SUBAGENT_DEPTH;
	if (typeof raw !== "string" || !/^\d+$/.test(raw)) return false;
	const depth = Number.parseInt(raw, 10);
	return Number.isSafeInteger(depth) && depth > 0;
}

/**
 * Coarse repository signal: the session directory is a repository root or a
 * worktree checkout. Walking parent directories is deliberately not done.
 */
export function isRepositorySession(cwd: string): boolean {
	return existsSync(join(cwd, ".git"));
}

/** Agents requested by one `subagent` tool call, as recorded for telemetry. */
export function subagentAgents(input: unknown): string[] {
	if (typeof input !== "object" || input === null) return [];
	const calls = (input as { calls?: unknown }).calls;
	if (!Array.isArray(calls)) return [];
	const agents: string[] = [];
	for (const call of calls) {
		if (typeof call === "object" && call !== null && typeof (call as { agent?: unknown }).agent === "string") {
			agents.push((call as { agent: string }).agent);
		}
	}
	return agents;
}

/** Resolves the decision early or `undefined` once the budget elapses. */
export function withBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T | undefined> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(undefined), budgetMs);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(undefined);
			},
		);
	});
}

function formatDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}
