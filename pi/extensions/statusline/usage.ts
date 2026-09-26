/**
 * Provider usage windows for the custom statusline footer.
 *
 * Three subscription providers expose a usage endpoint that the footer
 * renders in one compact style (`tier · label X% (reset)`):
 *
 *   opencode-go    GET <base>/v1/usage
 *                  → rolling / weekly / monthly windows
 *   openai-codex   GET https://chatgpt.com/backend-api/wham/usage
 *                  → primary / secondary rate-limit windows
 *   commandcode    GET https://api.commandcode.ai/alpha/billing/credits
 *                  → fiveHour / weekly window limits (used/cap credits)
 *
 * Everything here is either pure or takes an injectable `fetch`, so the
 * parsers and the request shape stay unit-testable without Pi, network access
 * or a node_modules tree. Credentials are read only by the caller (Pi's model
 * registry) and are never logged: each credential is sent exclusively to its
 * provider's pinned origin below, and redirects are refused so a bearer token
 * cannot be forwarded to another host.
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent"

// ── Providers ──────────────────────────────────────────────────────────────

export const OPENCODE_GO = "opencode-go"
export const OPENCODE_GO_BASE = "https://opencode.ai/zen/go"
export const OPENCODE_GO_TIER = "OpenCode Go"

export const OPENAI_CODEX = "openai-codex"
/** Pinned ChatGPT backend origin; the OAuth access token is never sent elsewhere. */
export const OPENAI_CODEX_BASE = "https://chatgpt.com/backend-api"
export const OPENAI_CODEX_USAGE_URL = `${OPENAI_CODEX_BASE}/wham/usage`
export const OPENAI_CODEX_TIER = "OpenAI Codex"

export const COMMANDCODE = "commandcode"
/** Pinned Command Code origin; the bearer credential is never sent elsewhere. */
export const COMMANDCODE_BASE = "https://api.commandcode.ai"
export const COMMANDCODE_CREDITS_URL = `${COMMANDCODE_BASE}/alpha/billing/credits`
export const COMMANDCODE_TIER = "Command Code"

/** Providers whose usage windows the footer can render. */
export const USAGE_PROVIDERS: readonly string[] = [OPENCODE_GO, OPENAI_CODEX, COMMANDCODE]

export function isUsageProvider(provider: string | undefined): boolean {
	return provider !== undefined && USAGE_PROVIDERS.includes(provider)
}

/** Separator between footer segments. */
export const SEP = " · "
/** Glyph prefixed to the provider-usage segment. Matches the user's omp footer. */
export const ICON_USAGE = "\u{f0068}"
/** Default request budget for one usage fetch. */
export const USAGE_TIMEOUT_MS = 10_000

// ── Types ──────────────────────────────────────────────────────────────────

export interface UsageWindow {
	percent: number
	/** ISO reset timestamp; absent when the provider did not report one. */
	resetsAt?: string
	status: string
}

export interface UsageWindowEntry {
	label: string
	window: UsageWindow
	/** Reset-countdown unit: minutes for sub-day windows, hours above. */
	unit: "m" | "h"
	/** Floor the displayed percent (month-scale windows) instead of rounding. */
	floor: boolean
}

export interface UsageSnapshot {
	tier?: string
	windows: UsageWindowEntry[]
	fetchedAt: number
}

export interface UsageFetchOptions {
	/** Injectable for tests; defaults to the global `fetch`. */
	fetchImpl?: typeof fetch
	timeoutMs?: number
}

// ── Shared helpers ─────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

function fetchImplFor(options: UsageFetchOptions): typeof fetch {
	return options.fetchImpl ?? fetch
}

function timeoutFor(options: UsageFetchOptions): number {
	return options.timeoutMs ?? USAGE_TIMEOUT_MS
}

const DAY_SECONDS = 86_400
const MONTH_SECONDS = 2_592_000

// ── OpenCode Go ────────────────────────────────────────────────────────────

function normalizeBaseUrl(baseUrl?: string): string {
	const trimmed = (baseUrl ?? "").trim().replace(/\/+$/, "")
	// models.json carries both `zen/go` and `zen/go/v1`; the usage route already
	// includes `/v1`, so strip a trailing `/v1` to avoid doubling it.
	const base = trimmed.replace(/\/v1$/i, "")
	return base || OPENCODE_GO_BASE
}

/** One OpenCode Go window: used percent, ISO reset timestamp and status. */
export function readWindow(payload: unknown): UsageWindow | undefined {
	if (!isRecord(payload)) return undefined
	const { percent, resetsAt, status } = payload
	if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) return undefined
	if (typeof resetsAt !== "string" || !Number.isFinite(Date.parse(resetsAt))) return undefined
	return { percent, resetsAt, status: typeof status === "string" ? status : "ok" }
}

export function parseOpencodeGoUsage(payload: unknown): UsageSnapshot | undefined {
	if (!isRecord(payload) || !isRecord(payload.usage)) return undefined
	const usage = payload.usage
	const windows: UsageWindowEntry[] = []
	const add = (label: string, raw: unknown, unit: "m" | "h", floor: boolean) => {
		const window = readWindow(raw)
		if (window) windows.push({ label, unit, floor, window })
	}
	add("5h", usage.rolling, "m", false)
	add("7d", usage.weekly, "h", false)
	add("mo", usage.monthly, "h", true)
	if (windows.length === 0) return undefined
	return { tier: OPENCODE_GO_TIER, windows, fetchedAt: Date.now() }
}

export async function fetchOpencodeGoUsage(
	apiKey: string,
	baseUrl?: string,
	options: UsageFetchOptions = {},
): Promise<UsageSnapshot | undefined> {
	const response = await fetchImplFor(options)(`${normalizeBaseUrl(baseUrl)}/v1/usage`, {
		headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(timeoutFor(options)),
	})
	if (!response.ok) return undefined
	return parseOpencodeGoUsage(await response.json())
}

// ── OpenAI Codex ───────────────────────────────────────────────────────────

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const segment = token.split(".")[1]
	if (!segment) return undefined
	try {
		const normalized = segment.replace(/-/g, "+").replace(/_/g, "/")
		const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
		const parsed: unknown = JSON.parse(Buffer.from(padded, "base64").toString("utf8"))
		return isRecord(parsed) ? parsed : undefined
	} catch {
		return undefined
	}
}

/**
 * The ChatGPT account id Pi's OAuth credential carries in the access token
 * (`https://api.openai.com/auth` → `chatgpt_account_id`). The value is used as
 * a request header only and is never logged.
 */
export function codexAccountId(accessToken: string): string | undefined {
	const payload = decodeJwtPayload(accessToken)
	if (!payload) return undefined
	const claim = payload["https://api.openai.com/auth"]
	if (!isRecord(claim)) return undefined
	const accountId = claim.chatgpt_account_id
	return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined
}

/** Plan labels that differ from a plain title-case rendering of the wire value. */
const PLAN_TYPE_DISPLAY: Record<string, string> = {
	enterprise_cbp_automation: "Enterprise (Automation)",
	self_serve_business_prolite: "Business Premium",
	self_serve_business_usage_based: "Business",
	team: "Business",
	business: "Enterprise",
	enterprise_cbp_usage_based: "Enterprise",
	prolite: "Pro Lite",
	edu_plus: "Edu Plus",
	edu_pro: "Edu Pro",
	edu: "Edu",
}

/** Human plan label, or undefined for a missing/unknown value. */
export function planTypeDisplay(planType: unknown): string | undefined {
	if (typeof planType !== "string") return undefined
	const key = planType.trim().toLowerCase()
	if (!key || key === "unknown") return undefined
	if (PLAN_TYPE_DISPLAY[key]) return PLAN_TYPE_DISPLAY[key]
	return key
		.split("_")
		.filter(Boolean)
		.map((word) => word[0].toUpperCase() + word.slice(1))
		.join(" ")
}

/**
 * Compact window label derived from the reported window length, mirroring the
 * footer's existing scale vocabulary (5h / 7d / mo). Unknown lengths fall back
 * to the nearest whole hour, day or month.
 */
export function windowLabel(seconds: number): string | undefined {
	if (!Number.isFinite(seconds) || seconds <= 0) return undefined
	const approx = (target: number) => Math.abs(seconds - target) <= target * 0.05
	if (approx(18_000)) return "5h"
	if (approx(DAY_SECONDS)) return "1d"
	if (approx(604_800)) return "7d"
	if (approx(MONTH_SECONDS)) return "mo"
	if (approx(31_536_000)) return "1y"
	if (seconds < DAY_SECONDS) return `${Math.max(1, Math.round(seconds / 3_600))}h`
	if (seconds < MONTH_SECONDS) return `${Math.max(1, Math.round(seconds / DAY_SECONDS))}d`
	return `${Math.max(1, Math.round(seconds / MONTH_SECONDS))}mo`
}

function windowUnit(seconds: number): "m" | "h" {
	return seconds < DAY_SECONDS ? "m" : "h"
}

function windowFloor(seconds: number): boolean {
	return seconds >= MONTH_SECONDS
}

interface CodexWindow {
	percent: number
	seconds: number
	resetsAt: string | undefined
	status: string
}

/** One Codex rate-limit window: used percent, window length and epoch reset. */
export function readCodexWindow(payload: unknown): CodexWindow | undefined {
	if (!isRecord(payload)) return undefined
	const percent = payload.used_percent
	const seconds = payload.limit_window_seconds
	if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) return undefined
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined
	const resetAt = payload.reset_at
	const resetsAt =
		typeof resetAt === "number" && Number.isFinite(resetAt) && resetAt > 0
			? new Date(resetAt * 1000).toISOString()
			: undefined
	return { percent, seconds, resetsAt, status: "ok" }
}

export function parseCodexUsage(payload: unknown): UsageSnapshot | undefined {
	if (!isRecord(payload)) return undefined
	const rateLimit = payload.rate_limit
	const windows: UsageWindowEntry[] = []
	if (isRecord(rateLimit)) {
		for (const field of ["primary_window", "secondary_window"] as const) {
			const window = readCodexWindow(rateLimit[field])
			if (!window) continue
			const label = windowLabel(window.seconds)
			if (!label) continue
			windows.push({
				label,
				unit: windowUnit(window.seconds),
				floor: windowFloor(window.seconds),
				window: { percent: window.percent, resetsAt: window.resetsAt, status: window.status },
			})
		}
	}
	if (windows.length === 0) return undefined
	return { tier: planTypeDisplay(payload.plan_type) ?? OPENAI_CODEX_TIER, windows, fetchedAt: Date.now() }
}

export async function fetchCodexUsage(
	accessToken: string,
	options: UsageFetchOptions = {},
): Promise<UsageSnapshot | undefined> {
	const accountId = codexAccountId(accessToken)
	// Without the account claim the backend rejects the request; hide the
	// segment instead of sending a degraded call.
	if (!accountId) return undefined

	const url = new URL(OPENAI_CODEX_USAGE_URL)
	// Defense in depth: the bearer token only ever goes to the pinned origin,
	// even if the URL constant is edited later.
	if (url.origin !== "https://chatgpt.com" || !url.pathname.startsWith("/backend-api/")) return undefined

	const response = await fetchImplFor(options)(url, {
		headers: {
			accept: "application/json",
			authorization: `Bearer ${accessToken}`,
			"chatgpt-account-id": accountId,
		},
		signal: AbortSignal.timeout(timeoutFor(options)),
		// Never forward the credential to a redirect destination.
		redirect: "error",
	})
	if (!response.ok) return undefined
	return parseCodexUsage(await response.json())
}

// ── Command Code ───────────────────────────────────────────────────────────

/**
 * One Command Code window limit: `used` and `cap` are credit amounts, so the
 * percent is derived client-side, and `resetAt` is an epoch timestamp in
 * milliseconds (`0` before the window opens).
 */
export interface CommandCodeWindow {
	percent: number
	resetsAt: string | undefined
	status: string
}

/** Epoch seconds or milliseconds → ISO; unset (0) resets stay undefined. */
export function commandCodeResetIso(value: unknown): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
	const ms = value >= 1e12 ? value : value * 1000
	const date = new Date(ms)
	return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

export function readCommandCodeWindow(payload: unknown): CommandCodeWindow | undefined {
	if (!isRecord(payload)) return undefined
	const { used, cap, exceeded } = payload
	if (typeof used !== "number" || !Number.isFinite(used) || used < 0) return undefined
	if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0) return undefined
	return {
		// Credit overage (used > cap) reads as a fully consumed window.
		percent: Math.min(100, (used / cap) * 100),
		resetsAt: commandCodeResetIso(payload.resetAt),
		status: exceeded === true ? "exceeded" : "ok",
	}
}

export function parseCommandCodeUsage(payload: unknown): UsageSnapshot | undefined {
	if (!isRecord(payload) || !isRecord(payload.windowLimits)) return undefined
	const limits = payload.windowLimits
	const windows: UsageWindowEntry[] = []
	const add = (label: string, raw: unknown, unit: "m" | "h") => {
		const window = readCommandCodeWindow(raw)
		if (window) windows.push({ label, unit, floor: false, window })
	}
	add("5h", limits.fiveHour, "m")
	add("7d", limits.weekly, "h")
	if (windows.length === 0) return undefined
	return { tier: COMMANDCODE_TIER, windows, fetchedAt: Date.now() }
}

export async function fetchCommandCodeUsage(
	apiKey: string,
	options: UsageFetchOptions = {},
): Promise<UsageSnapshot | undefined> {
	const url = new URL(COMMANDCODE_CREDITS_URL)
	// Defense in depth: the bearer credential only ever goes to the pinned
	// origin, even if the URL constant is edited later.
	if (url.origin !== COMMANDCODE_BASE || !url.pathname.startsWith("/alpha/")) return undefined

	const response = await fetchImplFor(options)(url, {
		headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(timeoutFor(options)),
		// Never forward the credential to a redirect destination.
		redirect: "error",
	})
	if (!response.ok) return undefined
	return parseCommandCodeUsage(await response.json())
}

// ── Formatting ─────────────────────────────────────────────────────────────

/** Remaining time until an ISO timestamp, e.g. "4h 51m" or "5d 14h". */
export function formatReset(resetsAt: string | undefined, unit: "m" | "h"): string | undefined {
	if (!resetsAt) return undefined
	const ms = Date.parse(resetsAt)
	if (!Number.isFinite(ms)) return undefined
	if (unit === "m") {
		const total = Math.max(0, Math.round((ms - Date.now()) / 60_000))
		if (total < 60) return `${total}m`
		const hours = Math.floor(total / 60)
		const minutes = total % 60
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
	}
	const total = Math.max(0, Math.round((ms - Date.now()) / 3_600_000))
	if (total < 24) return `${total}h`
	const days = Math.floor(total / 24)
	const hours = total % 24
	return hours > 0 ? `${days}d ${hours}h` : `${days}d`
}

function pickUsageColor(percent: number): ThemeColor {
	if (percent >= 80) return "error"
	if (percent >= 50) return "warning"
	return "muted"
}

/**
 * Compact usage segment: one `label X% (reset)` group per window, identical
 * for both providers. Returns undefined when no window is renderable.
 */
export function renderUsage(theme: Theme, usage: UsageSnapshot): string | undefined {
	if (usage.windows.length === 0) return undefined
	const separator = theme.fg("dim", SEP)
	const parts = usage.windows.map((entry) => {
		const percent = entry.floor ? Math.floor(entry.window.percent) : Math.round(entry.window.percent)
		const percentText = theme.fg(pickUsageColor(entry.window.percent), `${percent}%`)
		const reset = formatReset(entry.window.resetsAt, entry.unit)
		const resetText = reset ? theme.fg("muted", ` (${reset})`) : ""
		return `${entry.label} ${percentText}${resetText}`
	})
	const head = usage.tier ? `${theme.fg("accent", usage.tier)}${separator}` : ""
	return `${theme.fg("muted", ICON_USAGE)}${separator}${head}${parts.join(separator)}`
}
