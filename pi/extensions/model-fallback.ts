/**
 * model-fallback — provider-availability fallback for the active model.
 *
 * Pi port of OMP's `retry.fallbackChains`, minus the free tier. When the
 * active model fails with a rate-limit / quota / overload error, this switches
 * the session to the next healthy candidate so Pi's own auto-retry (and later
 * turns) run on a working model. Suppressed models get a cooldown, and a model
 * that is already in cooldown is skipped proactively before a turn starts.
 *
 * Extensions are inherited by subagent child processes, so this also covers
 * subagent model limits, not just the main session.
 *
 * Scope / non-goals:
 *   - Availability fallback only, never semantic escalation.
 *   - No free tier (your auth has opencode-go + openai-codex only).
 *   - No automatic revert to the preferred model; switch back with `/model`
 *     or `/model-fallback reset`. This avoids flapping on a flaky provider.
 *   - Usage-aware reserve: before each turn the active opencode-go usage is
 *     preflighted (cached) and, inside `USAGE_RESERVE_PCT` remaining, fails
 *     over preemptively instead of waiting for a 429.
 *
 * Edit CHAIN to change the order. `pickNext` is exported for testing.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"

/**
 * Pi does not export its thinking-level union from the package root: it lives in
 * `pi-ai` and `pi-agent-core`, and the two definitions disagree (`pi-ai` omits
 * "off"). Derive it from the API that actually consumes it instead, so the type
 * cannot drift from the installed Pi version and no extra dependency is needed.
 */
type ThinkingLevel = Parameters<ExtensionAPI["setThinkingLevel"]>[0]

interface Candidate {
  ref: string // "provider/model"
  thinking?: ThinkingLevel
}

/** Ordered fallback candidates. The active model is skipped when present. */
const CHAIN: Candidate[] = [
  { ref: "opencode-go/deepseek-v4.1-flash" },
  { ref: "openai-codex/gpt-6-sol", thinking: "high" },
  { ref: "opencode-go/deepseek-v4-flash" },
  { ref: "openai-codex/gpt-5.6-terra", thinking: "high" },
]

/** How long a failed model is skipped before it may be tried again. */
const COOLDOWN_MS = 10 * 60 * 1000

/** Signatures of rate-limit / quota / provider-capacity failures. */
const LIMIT_RE =
  /\b(429|402|529)\b|rate.?limit|too many requests|quota|usage limit|limit (?:reached|exceeded)|overloaded|capacity|unavailable/i

// ── Usage-aware reserve ─────────────────────────────────────────────────
const OPENCODE_GO = "opencode-go"
const OPENCODE_GO_BASE = "https://opencode.ai/zen/go"
/** Fail over when the provider's remaining usage drops to this percent. */
const USAGE_RESERVE_PCT = 10
/** "auto" switches silently; "confirm" asks in the TUI (subagents auto-switch). */
const USAGE_POLICY: "auto" | "confirm" | "off" = "auto"
/** Usage preflight cache lifetime. */
const USAGE_CACHE_MS = 60_000
const USAGE_TIMEOUT_MS = 8_000

export function parseRef(ref: string): { provider: string; model: string } | null {
  const i = ref.indexOf("/")
  if (i <= 0 || i === ref.length - 1) return null
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) }
}

export function isSuppressed(
  map: Map<string, number>,
  ref: string,
  now: number,
): boolean {
  const until = map.get(ref)
  if (until === undefined) return false
  if (until <= now) {
    map.delete(ref)
    return false
  }
  return true
}

/** First healthy candidate that is not the current model. Pure; testable. */
export function pickNext(
  chain: Candidate[],
  currentRef: string | undefined,
  suppressedRefs: ReadonlySet<string>,
): Candidate | undefined {
  return chain.find(
    (c) => c.ref !== currentRef && !suppressedRefs.has(c.ref),
  )
}

/** Extract an assistant error message, or null when the message is fine. */
function assistantErrorText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null
  const m = message as { role?: string; stopReason?: string; errorMessage?: string }
  if (m.role !== "assistant" || m.stopReason !== "error") return null
  return m.errorMessage ?? ""
}

export function normalizeBaseUrl(baseUrl?: string): string {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "")
  return base || OPENCODE_GO_BASE
}

/** Used percent from the provider's rolling/weekly/monthly windows. */
export function windowPercents(payload: unknown): number[] {
  if (!payload || typeof payload !== "object") return []
  const usage = (payload as { usage?: unknown }).usage
  if (!usage || typeof usage !== "object") return []
  const out: number[] = []
  for (const key of ["rolling", "weekly", "monthly"] as const) {
    const w = (usage as Record<string, unknown>)[key]
    if (!w || typeof w !== "object") continue
    const p = (w as { percent?: unknown }).percent
    if (typeof p === "number" && Number.isFinite(p)) out.push(p)
  }
  return out
}

/** Lowest remaining % across the provider's usage windows, or undefined. */
async function fetchRemainingPercent(ctx: ExtensionContext): Promise<number | undefined> {
  const model = ctx.model
  if (!model || model.provider !== OPENCODE_GO) return undefined
  const auth = await ctx.modelRegistry.getProviderAuth(OPENCODE_GO)
  const apiKey = auth?.auth?.apiKey
  if (!apiKey) return undefined
  const url = `${normalizeBaseUrl(auth?.auth?.baseUrl ?? model.baseUrl)}/v1/usage`
  const response = await fetch(url, {
    headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
  })
  if (!response.ok) return undefined
  const percents = windowPercents(await response.json())
  if (percents.length === 0) return undefined
  return 100 - Math.max(...percents)
}

export default function modelFallback(pi: ExtensionAPI) {
  const suppressed = new Map<string, number>()
  let usageCache: { at: number; remaining: number | undefined } | undefined

  const currentRef = (ctx: ExtensionContext): string | undefined => {
    const m = ctx.model
    return m ? `${m.provider}/${m.id}` : undefined
  }

  const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error") => {
    try {
      ctx.ui?.notify?.(text, level)
    } catch {
      // Notification failure must never affect routing.
    }
  }

  async function failover(ctx: ExtensionContext, why: string): Promise<void> {
    const now = Date.now()
    const current = currentRef(ctx)
    if (current) suppressed.set(current, now + COOLDOWN_MS)

    for (const candidate of CHAIN) {
      if (candidate.ref === current) continue
      if (isSuppressed(suppressed, candidate.ref, now)) continue
      const parsed = parseRef(candidate.ref)
      if (!parsed) continue
      const model = ctx.modelRegistry?.find?.(parsed.provider, parsed.model)
      if (!model) continue
      const ok = await pi.setModel(model)
      if (!ok) continue
      if (candidate.thinking) pi.setThinkingLevel(candidate.thinking)
      notify(
        ctx,
        `model fallback: ${current ?? "unknown"} → ${candidate.ref} (${why})`,
        "warning",
      )
      return
    }
    notify(
      ctx,
      `model fallback: no healthy candidate for ${current ?? "unknown"} (${why})`,
      "error",
    )
  }

  /** Cached lowest remaining % for the opencode-go provider, or undefined. */
  async function reserved(ctx: ExtensionContext): Promise<number | undefined> {
    if (ctx.model?.provider !== OPENCODE_GO) return undefined
    const now = Date.now()
    if (usageCache && now - usageCache.at < USAGE_CACHE_MS) return usageCache.remaining
    let remaining: number | undefined
    try {
      remaining = await fetchRemainingPercent(ctx)
    } catch {
      remaining = undefined
    }
    usageCache = { at: now, remaining }
    return remaining
  }

  // Reactive: the assistant message finalized with a limit/overload error.
  pi.on("message_end", async (event, ctx) => {
    const errorText = assistantErrorText(event.message)
    if (errorText === null) return
    if (errorText === "" || LIMIT_RE.test(errorText)) {
      await failover(ctx, errorText || "retryable provider error")
    }
  })

  // Proactive: cooldown skip, then usage-reserve preflight.
  pi.on("before_agent_start", async (_event, ctx) => {
    const current = currentRef(ctx)
    if (current && isSuppressed(suppressed, current, Date.now())) {
      await failover(ctx, "provider in cooldown")
      return
    }
    if (USAGE_POLICY === "off") return
    const remaining = await reserved(ctx)
    if (remaining === undefined || remaining > USAGE_RESERVE_PCT) return
    const label = `${remaining.toFixed(0)}% left`
    if (USAGE_POLICY === "confirm" && ctx.mode === "tui") {
      let proceed = true
      try {
        proceed = await ctx.ui.confirm(
          "Provider reserve reached",
          `${ctx.model?.name ?? "Current model"} has ${label}. Switch to a fallback model?`,
        )
      } catch {
        proceed = true
      }
      if (!proceed) return
    }
    await failover(ctx, `usage reserve (${label})`)
  })

  pi.registerCommand("model-fallback", {
    description: "Show or reset model-fallback cooldowns",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase()
      if (arg === "reset" || arg === "clear") {
        suppressed.clear()
        notify(ctx, "model fallback: cooldowns cleared", "info")
        return
      }
      const now = Date.now()
      const active = [...suppressed.entries()]
        .filter(([, until]) => until > now)
        .map(([ref, until]) => `${ref} (${Math.ceil((until - now) / 60000)}m)`)
      notify(
        ctx,
        active.length
          ? `model fallback cooldowns: ${active.join(", ")}`
          : "model fallback: no active cooldowns",
        "info",
      )
    },
  })
}
