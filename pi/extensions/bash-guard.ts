/**
 * bash-guard — mechanically deny catastrophic shell commands.
 *
 * Pi port of OMP's `bash.patterns` deny list. Pi's AGENTS.md §14 makes
 * destructive actions a policy matter; this extension enforces the worst cases
 * instead of relying on the model to remember.
 *
 * Denied (blocked, not prompted):
 *   - recursive `rm` targeting `/` (or any `--no-preserve-root`)
 *   - `mkfs*`
 *   - `dd ... of=<block device>`
 *   - `tee` / `cp` / `mv` / `install` writing to a block device
 *   - `shred` on a device node
 *   - redirect (`>`, `>>`) into a block device
 *   - `chmod -R` / `chown -R` on `/`
 *   - `cryptsetup ... /dev/...`
 *   - `kill -9 1`
 *   - `shutdown` / `poweroff` / `reboot` / `halt`
 *
 * Scope and limits — this is a safety net, not a shell parser:
 *   - Segments split on `; && || |` and newlines; tokens split on whitespace.
 *     Quoting is only understood well enough to unquote a redirect target.
 *   - A destructive command hidden inside a quoted string (e.g.
 *     `bash -c "rm -rf /"`) is NOT caught. That is deliberate: catching it
 *     would block harmless read-only commands that merely quote such text.
 *   - Variable-indirected targets (`rm -rf "$DIR"`) are not evaluated.
 * It errs toward NOT blocking ordinary work: `rm -rf node_modules`,
 * `rm -rf ./build`, `cp /dev/sda backup.img`, `kill -9 1234`, and
 * `grep 'x > /dev/sda' file` all pass.
 *
 * `checkCommand` is exported for testing.
 */

import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent"

export interface DenyMatch {
  id: string
  why: string
}

interface Rule {
  id: string
  why: string
  test: (segment: string) => boolean
}

/** Split a command line into shell segments. Naive: ignores quoting. */
export function segments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Strip leading env assignments and `sudo`/`command`/`env` wrappers. */
function stripWrappers(segment: string): string {
  let s = segment.trim()
  s = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "")
  s = s.replace(/^(?:command\s+|env\s+)?sudo\s+(?:-\S+\s+)*/i, "")
  return s.trim()
}

function argv(segment: string): string[] {
  return stripWrappers(segment).split(/\s+/).filter(Boolean)
}

/** Basename of the segment's command word (e.g. `/sbin/mkfs` -> `mkfs`). */
function cmdName(segment: string): string {
  const first = argv(segment)[0] ?? ""
  return first.split("/").pop() ?? ""
}

/** Drop surrounding quotes and backslash escapes from a single token. */
export function unquoteToken(token: string): string {
  return token.replace(/\\(.)/g, "$1").replace(/^["']|["']$/g, "")
}

const BLOCK_DEV_RE =
  /^\/dev\/(?:sd|hd|vd|nvme\d|mmcblk|disk|loop|sr|dm-|md\d|zram|mapper\/)/i

export function isBlockDevice(path: string): boolean {
  return BLOCK_DEV_RE.test(path)
}

/**
 * Redirect targets (`> file`, `>> file`) that sit outside quotes, unquoted.
 * Skips `>&`/`&>` fd duplication targets.
 */
export function redirectTargets(segment: string): string[] {
  const targets: string[] = []
  let quote: string | null = null
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (quote) {
      if (ch === "\\") i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (ch === "\\") {
      i++
      continue
    }
    if (ch !== ">") continue

    let j = i + 1
    if (segment[j] === ">") j++
    while (segment[j] === " " || segment[j] === "\t") j++

    let k = j
    let inner: string | null = null
    while (k < segment.length) {
      const c = segment[k]
      if (inner) {
        if (c === "\\") k += 2
        else k++
        if (c === inner) inner = null
        continue
      }
      if (c === "'" || c === '"') {
        inner = c
        k++
        continue
      }
      if (/\s/.test(c)) break
      k++
    }

    const token = unquoteToken(segment.slice(j, k))
    if (token && !/^&\d*$/.test(token) && token !== "&-") targets.push(token)
    i = k - 1
  }
  return targets
}

const isRootTarget = (t: string): boolean =>
  t === "/" || t === "/*" || t === "//" || t === "/."

const RULES: Rule[] = [
  {
    id: "rm-root",
    why: "recursive rm targeting / (or --no-preserve-root)",
    test(segment) {
      if (cmdName(segment) !== "rm") return false
      const a = argv(segment).slice(1)
      const short = a.filter((t) => /^-[^-]/.test(t))
      const long = a.filter((t) => t.startsWith("--"))
      const targets = a.filter((t) => !t.startsWith("-"))
      const recursive = short.some((f) => /[rR]/.test(f)) || long.includes("--recursive")
      const noPreserve = long.includes("--no-preserve-root")
      return noPreserve || (recursive && targets.some(isRootTarget))
    },
  },
  {
    id: "mkfs",
    why: "filesystem creation on a device",
    test: (segment) => {
      const n = cmdName(segment)
      return n === "mkfs" || n.startsWith("mkfs.")
    },
  },
  {
    id: "dd-raw-device",
    why: "dd writing to a raw device",
    test: (segment) => {
      if (cmdName(segment) !== "dd") return false
      const normalized = segment.replace(/\\(.)/g, "$1").replace(/["']/g, "")
      return /\bof=\/dev\//.test(normalized)
    },
  },
  {
    id: "write-device",
    why: "write command targeting a block device",
    test: (segment) => {
      const name = cmdName(segment)
      const args = argv(segment).slice(1).filter((t) => !t.startsWith("-")).map(unquoteToken)
      if (name === "tee") return args.some(isBlockDevice)
      if (name === "cp" || name === "mv" || name === "install") {
        const dest = args[args.length - 1]
        return dest !== undefined && isBlockDevice(dest)
      }
      return false
    },
  },
  {
    id: "shred-device",
    why: "shred targeting a device node",
    test: (segment) =>
      cmdName(segment) === "shred" &&
      argv(segment).slice(1).map(unquoteToken).some(isBlockDevice),
  },
  {
    id: "redirect-raw-device",
    why: "redirect into a raw device",
    test: (segment) => redirectTargets(segment).some(isBlockDevice),
  },
  {
    id: "chmod-recursive-root",
    why: "recursive chmod on /",
    test: (segment) => {
      if (cmdName(segment) !== "chmod") return false
      const a = argv(segment).slice(1)
      const recursive = a.some((t) => /^-[^-]*R/.test(t)) || a.includes("--recursive")
      const targets = a.filter((t) => !t.startsWith("-"))
      return recursive && targets.some(isRootTarget)
    },
  },
  {
    id: "chown-recursive-root",
    why: "recursive chown on /",
    test: (segment) => {
      if (cmdName(segment) !== "chown") return false
      const a = argv(segment).slice(1)
      const recursive = a.some((t) => /^-[^-]*R/.test(t)) || a.includes("--recursive")
      const targets = a.filter((t) => !t.startsWith("-"))
      return recursive && targets.some(isRootTarget)
    },
  },
  {
    id: "cryptsetup-device",
    why: "cryptsetup on a device",
    test: (segment) => cmdName(segment) === "cryptsetup" && /\/dev\//.test(segment),
  },
  {
    id: "kill-init",
    why: "SIGKILL to PID 1 (or every process)",
    test: (segment) => {
      if (cmdName(segment) !== "kill") return false
      const a = argv(segment).slice(1)
      const kill9 =
        a.includes("-9") ||
        a.some((t) => /^-(?:SIG)?KILL$/i.test(t)) ||
        (a.includes("-s") && a.some((t) => /^(?:9|KILL|SIGKILL)$/i.test(t)))
      const targetsInit = a.includes("1") || a.includes("-1")
      return kill9 && targetsInit
    },
  },
  {
    id: "system-power",
    why: "system shutdown / power state change",
    test: (segment) =>
      ["shutdown", "poweroff", "reboot", "halt"].includes(cmdName(segment)),
  },
]

/** Return the first deny rule a command trips, or null. */
export function checkCommand(command: string): DenyMatch | null {
  for (const segment of segments(command)) {
    for (const rule of RULES) {
      if (rule.test(segment)) return { id: rule.id, why: rule.why }
    }
  }
  return null
}

export function isBashToolCallEvent(
  event: ToolCallEvent,
): event is ToolCallEvent & { input: { command?: unknown } } {
  return event.toolName === "bash"
}

export default function bashGuard(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isBashToolCallEvent(event)) return
    const command = event.input.command
    if (typeof command !== "string" || command.trim() === "") return

    const hit = checkCommand(command)
    if (!hit) return

    try {
      ctx.ui?.notify?.(`bash-guard blocked ${hit.id}: ${hit.why}`, "error")
    } catch {
      // Never let notification failure change the block decision.
    }

    return {
      block: true,
      reason: `bash-guard refused \`${hit.id}\` — ${hit.why}. Rephrase with a safe alternative.`,
    }
  })
}
