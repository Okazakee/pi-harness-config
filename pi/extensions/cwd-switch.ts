// cwd-switch — an effective (virtual) working directory for Pi.
//
// Pi fixes the session working directory at process start and exposes no
// setter for it (verified against 0.87.0: `ctx.cwd` is read-only, and the only
// cwd override in the API is `SessionManager.open(..., cwdOverride?)` at open
// time). A `!cd …` in the shell cannot persist either, because every bash
// command runs in its own `bash -c` process.
//
// So this extension keeps an *effective* directory alongside the session one:
//
//   /cd <path>   set it (~, relative paths and `-` are supported)
//   /cd          show the effective and session directory
//   /cd reset    drop the override and use the session directory again
//
// While an override is active the `tool_call` hook rewrites tool inputs:
//
//   bash             prefix `cd <dir> || exit 1` (the prefix is a separate line,
//                    so multi-line scripts and heredocs keep working)
//   read/write/edit  resolve a relative `path` against <dir>
//   grep/find/ls     resolve `path`, or default it to <dir> when omitted
//
// The session directory itself never changes, so the footer's cwd segment would
// otherwise be misleading. The extension therefore publishes the effective
// directory as the `cwd` extension status, which the custom statusline renders.
//
// Scope limits, stated rather than implied:
//   - Tools from other extensions (lsp, subagent, mcp) are not rewritten.
//   - Absolute paths are always left alone.
//   - The git branch shown in the footer still comes from the session directory.
//
// Fail-open: any error passes the tool call through untouched.

import { readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, normalize, resolve } from "node:path"
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent"

const ENTRY_TYPE = "cwd-switch"
const STATUS_KEY = "cwd"

/** Tools whose single `path` argument names a target to act on. */
const PATH_TOOLS = new Set(["read", "write", "edit"])
/** Tools whose optional `path` argument scopes a search. */
const SEARCH_TOOLS = new Set(["grep", "find", "ls"])

export type CwdState = {
  /** Effective directory, or null when the session directory is in use. */
  cwd: string | null
  /** Previous effective directory, for `/cd -`. */
  previous: string | null
}

// ── Pure helpers (exported so they can be tested without a Pi runtime) ──────

/** Expand a leading `~` using the supplied home directory. */
export function expandTilde(input: string, home: string): string {
  if (input === "~") return home
  if (input.startsWith("~/")) return home + input.slice(1)
  return input
}

/** True when a path is neither absolute nor `~`-anchored. */
export function isRelativePath(input: string): boolean {
  const expanded = input.trim()
  return !isAbsolute(expanded) && !expanded.startsWith("~")
}

/** Resolve user input to an absolute path, against `base` when relative. */
export function resolveTarget(input: string, base: string, home: string): string {
  const expanded = expandTilde(input.trim(), home)
  return isAbsolute(expanded) ? normalize(expanded) : resolve(base, expanded)
}

/** Single-quote a value for safe interpolation into a shell command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Prefix a command with a `cd` into `dir`.
 *
 * The `cd` is on its own line rather than joined with `&&`, so a multi-line
 * script or heredoc still runs entirely inside `dir`. `|| exit 1` makes a
 * failed `cd` abort instead of silently running in the wrong directory.
 */
export function prefixBashCommand(command: string, dir: string): string {
  if (!command.trim()) return command
  const prefix = `cd ${shellQuote(dir)} || exit 1`
  if (command.startsWith(prefix)) return command
  return `${prefix}\n${command}`
}

/**
 * Rewrite one tool input in place for the effective directory.
 * Returns true when something changed.
 */
export function rewriteToolInput(
  toolName: string,
  input: Record<string, unknown>,
  dir: string,
  home: string,
): boolean {
  if (toolName === "bash") {
    const command = input.command
    if (typeof command !== "string") return false
    const next = prefixBashCommand(command, dir)
    if (next === command) return false
    input.command = next
    return true
  }

  if (PATH_TOOLS.has(toolName)) {
    const raw = input.path
    if (typeof raw !== "string" || !raw.trim()) return false
    const resolved = resolveTarget(raw, dir, home)
    if (resolved === raw) return false
    input.path = resolved
    return true
  }

  if (SEARCH_TOOLS.has(toolName)) {
    const raw = input.path
    if (typeof raw !== "string" || !raw.trim()) {
      // No scope given: search the effective directory, not the session one.
      input.path = dir
      return true
    }
    const resolved = resolveTarget(raw, dir, home)
    if (resolved === raw) return false
    input.path = resolved
    return true
  }

  return false
}

/** Rebuild state from persisted session entries; the last entry wins. */
export function restoreState(
  entries: ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>,
): CwdState {
  let state: CwdState = { cwd: null, previous: null }
  for (const entry of entries) {
    if (!entry || entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue
    const data = entry.data as Partial<CwdState> | null | undefined
    if (!data || typeof data !== "object") continue
    state = {
      cwd: typeof data.cwd === "string" ? data.cwd : null,
      previous: typeof data.previous === "string" ? data.previous : null,
    }
  }
  return state
}

/** True when the path exists and is a directory. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Render a path with `~` shortening for display. */
export function formatPath(path: string, home: string): string {
  if (path === home) return "~"
  if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`
  return path
}

/** Directory completions for the `/cd` argument. */
export function completeDirectories(
  prefix: string,
  base: string,
  home: string,
): Array<{ value: string; label: string }> | null {
  try {
    const expanded = expandTilde(prefix, home)
    const slash = expanded.lastIndexOf("/")
    const dirPart = slash >= 0 ? expanded.slice(0, slash + 1) : ""
    const namePart = slash >= 0 ? expanded.slice(slash + 1) : expanded
    const searchDir = dirPart
      ? isAbsolute(dirPart)
        ? dirPart
        : resolve(base, dirPart)
      : base

    const items = readdirSync(searchDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(namePart) && !entry.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 50)
      .map((entry) => {
        const value = `${dirPart}${entry.name}/`
        return { value, label: value }
      })

    return items.length > 0 ? items : null
  } catch {
    return null
  }
}

// ── Extension wiring ───────────────────────────────────────────────────────

type StatusContext = { ui?: { setStatus?: (key: string, text: string) => void } }

export default function cwdSwitch(pi: ExtensionAPI) {
  const home = homedir()
  let state: CwdState = { cwd: null, previous: null }

  const publishStatus = (ctx: StatusContext) => {
    try {
      // Empty string means "no override"; the statusline skips empty values.
      ctx.ui?.setStatus?.(STATUS_KEY, state.cwd ? `→ ${formatPath(state.cwd, home)}` : "")
    } catch {
      // Status reporting must never affect the extension's fail-open behaviour.
    }
  }

  const persist = () => {
    try {
      pi.appendEntry(ENTRY_TYPE, { cwd: state.cwd, previous: state.previous })
    } catch {
      // Losing persistence is not a reason to break the current turn.
    }
  }

  // Restore an override that survived a restart, and republish it.
  pi.on("session_start", (_event, ctx) => {
    try {
      state = restoreState(ctx.sessionManager.getEntries() as never)
      if (state.cwd && !isDirectory(state.cwd)) {
        // The directory disappeared; drop the stale override rather than
        // sending every later command to a path that no longer exists.
        state = { cwd: null, previous: null }
        persist()
      }
      publishStatus(ctx)
    } catch {
      // Ignore: a broken restore just means the session directory is used.
    }
  })

  pi.on("tool_call", (event: ToolCallEvent, ctx) => {
    const dir = state.cwd
    if (!dir) return // No override: never touch a tool call.
    try {
      const input = event.input as unknown as Record<string, unknown>
      rewriteToolInput(event.toolName, input, dir, home)
    } catch {
      // Fail open, exactly like the rtk extension.
    }
    void ctx
  })

  pi.registerCommand("cd", {
    description: "Set the effective working directory for tools (/cd reset to clear)",
    getArgumentCompletions: (prefix: string) => {
      const base = state.cwd ?? process.cwd()
      return completeDirectories(prefix, base, home)
    },
    handler: async (args: string, ctx) => {
      const raw = args.trim()
      const sessionCwd = ctx.cwd
      const current = state.cwd ?? sessionCwd

      if (!raw) {
        const lines = [`effective: ${formatPath(current, home)}`]
        if (state.cwd) {
          lines.push(`session:   ${formatPath(sessionCwd, home)}`)
          lines.push("clear it with /cd reset")
        }
        ctx.ui.notify(lines.join("\n"), "info")
        return
      }

      if (raw === "reset") {
        state = { cwd: null, previous: null }
        persist()
        publishStatus(ctx)
        ctx.ui.notify(`effective cwd cleared; using ${formatPath(sessionCwd, home)}`, "info")
        return
      }

      if (raw === "-") {
        if (!state.previous) {
          ctx.ui.notify("no previous effective directory", "warning")
          return
        }
        state = { cwd: state.previous, previous: state.cwd }
        persist()
        publishStatus(ctx)
        ctx.ui.notify(`effective cwd → ${formatPath(state.cwd ?? sessionCwd, home)}`, "info")
        return
      }

      const target = resolveTarget(raw, current, home)
      if (!isDirectory(target)) {
        ctx.ui.notify(`not a directory: ${formatPath(target, home)}`, "error")
        return
      }

      state = { cwd: target, previous: current }
      persist()
      publishStatus(ctx)
      ctx.ui.notify(
        `effective cwd → ${formatPath(target, home)}\nsession cwd is still ${formatPath(sessionCwd, home)}`,
        "info",
      )
    },
  })
}
