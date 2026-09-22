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
 *
 * Edit CHAIN to change the order. `pickNext` is exported for testing.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ThinkingLevel,
} from "@earendil-works/pi-coding-agent"

interface Candidate {
  ref: string // "provider/model"
  thinking?: ThinkingLevel
}

/** Ordered fallback candidates. The active model is skipped when present. */
const CHAIN: Candidate[] = [
  { ref: "opencode-go/deepseek-v4.1-flash" },
  { ref: "openai-codex/gpt-5.6-sol", thinking: "high" },
  { ref: "opencode-go/deepseek-v4-flash" },
  { ref: "openai-codex/gpt-5.6-terra", thinking: "high" },
]

/** How long a failed model is skipped before it may be tried again. */
const COOLDOWN_MS = 10 * 60 * 1000

/** Signatures of rate-limit / quota / provider-capacity failures. */
const LIMIT_RE =
  /\b(429|402|529)\b|rate.?limit|too many requests|quota|usage limit|limit (?:reached|exceeded)|overloaded|capacity|unavailable/i

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

export default function modelFallback(pi: ExtensionAPI) {
  const suppressed = new Map<string, number>()

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

  // Reactive: the assistant message finalized with a limit/overload error.
  pi.on("message_end", async (event, ctx) => {
    const errorText = assistantErrorText(event.message)
    if (errorText === null) return
    if (errorText === "" || LIMIT_RE.test(errorText)) {
      await failover(ctx, errorText || "retryable provider error")
    }
  })

  // Proactive: current model is in cooldown when a new turn starts.
  pi.on("before_agent_start", async (_event, ctx) => {
    const current = currentRef(ctx)
    if (current && isSuppressed(suppressed, current, Date.now())) {
      await failover(ctx, "provider in cooldown")
    }
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
