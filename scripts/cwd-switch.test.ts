// Tests for pi/extensions/cwd-switch.ts.
//
// Run with:  bun test scripts/cwd-switch.test.ts
// or via:    scripts/test-cwd-switch.sh
//
// The extension uses type-only imports from @earendil-works/pi-coding-agent, so
// it loads here without that package being installed — no node_modules needed.

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  completeDirectories,
  expandTilde,
  formatPath,
  isDirectory,
  isRelativePath,
  prefixBashCommand,
  resolveTarget,
  restoreState,
  rewriteToolInput,
  shellQuote,
} from "../pi/extensions/cwd-switch"

const HOME = "/home/tester"
const BASE = "/home/tester/project"

describe("expandTilde", () => {
  test("expands bare ~", () => expect(expandTilde("~", HOME)).toBe(HOME))
  test("expands ~/ prefix", () => expect(expandTilde("~/x/y", HOME)).toBe(`${HOME}/x/y`))
  test("leaves other paths alone", () => expect(expandTilde("/abs/path", HOME)).toBe("/abs/path"))
  test("does not expand ~ inside a path", () => expect(expandTilde("a~b", HOME)).toBe("a~b"))
})

describe("isRelativePath", () => {
  test("relative", () => expect(isRelativePath("sub/dir")).toBe(true))
  test("dot", () => expect(isRelativePath(".")).toBe(true))
  test("absolute", () => expect(isRelativePath("/etc")).toBe(false))
  test("tilde-anchored is not relative", () => expect(isRelativePath("~/x")).toBe(false))
})

describe("resolveTarget", () => {
  test("relative resolves against base", () => {
    expect(resolveTarget("sub", BASE, HOME)).toBe(`${BASE}/sub`)
  })
  test("dot-dot normalises", () => {
    expect(resolveTarget("../other", BASE, HOME)).toBe("/home/tester/other")
  })
  test("absolute is normalised, not re-based", () => {
    expect(resolveTarget("/var/./log/../tmp", BASE, HOME)).toBe("/var/tmp")
  })
  test("tilde resolves against home", () => {
    expect(resolveTarget("~/work", BASE, HOME)).toBe(`${HOME}/work`)
  })
  test("trims surrounding whitespace", () => {
    expect(resolveTarget("  sub  ", BASE, HOME)).toBe(`${BASE}/sub`)
  })
})

describe("shellQuote", () => {
  test("plain value", () => expect(shellQuote("/a/b")).toBe("'/a/b'"))
  test("spaces preserved", () => expect(shellQuote("/a b")).toBe("'/a b'"))
  test("single quote escaped", () => expect(shellQuote("/it's")).toBe(`'/it'\\''s'`))
  test("dollar is inert inside quotes", () => expect(shellQuote("$HOME")).toBe("'$HOME'"))
})

describe("prefixBashCommand", () => {
  test("single line gets a cd line", () => {
    expect(prefixBashCommand("ls -la", "/x")).toBe("cd '/x' || exit 1\nls -la")
  })

  test("multi-line commands keep every line inside the directory", () => {
    const out = prefixBashCommand("echo one\necho two", "/x")
    expect(out.split("\n")).toEqual(["cd '/x' || exit 1", "echo one", "echo two"])
  })

  test("empty command is untouched", () => {
    expect(prefixBashCommand("   ", "/x")).toBe("   ")
  })

  test("idempotent: an already-prefixed command is not prefixed twice", () => {
    const once = prefixBashCommand("ls", "/x")
    expect(prefixBashCommand(once, "/x")).toBe(once)
  })

  test("directory with a quote survives quoting", () => {
    expect(prefixBashCommand("ls", "/it's")).toBe(`cd '/it'\\''s' || exit 1\nls`)
  })
})

describe("rewriteToolInput", () => {
  test("bash command is prefixed", () => {
    const input: Record<string, unknown> = { command: "pwd" }
    expect(rewriteToolInput("bash", input, "/x", HOME)).toBe(true)
    expect(input.command).toBe("cd '/x' || exit 1\npwd")
  })

  test("read with a relative path is rebased", () => {
    const input: Record<string, unknown> = { path: "src/a.ts" }
    expect(rewriteToolInput("read", input, "/x", HOME)).toBe(true)
    expect(input.path).toBe("/x/src/a.ts")
  })

  test("write and edit are rebased too", () => {
    for (const tool of ["write", "edit"]) {
      const input: Record<string, unknown> = { path: "./b.ts" }
      expect(rewriteToolInput(tool, input, "/x", HOME)).toBe(true)
      expect(input.path).toBe("/x/b.ts")
    }
  })

  test("absolute path is left alone and reports no change", () => {
    const input: Record<string, unknown> = { path: "/abs/c.ts" }
    expect(rewriteToolInput("read", input, "/x", HOME)).toBe(false)
    expect(input.path).toBe("/abs/c.ts")
  })

  test("search tool with no path is scoped to the effective directory", () => {
    for (const tool of ["grep", "find", "ls"]) {
      const input: Record<string, unknown> = {}
      expect(rewriteToolInput(tool, input, "/x", HOME)).toBe(true)
      expect(input.path).toBe("/x")
    }
  })

  test("search tool with a relative path is rebased", () => {
    const input: Record<string, unknown> = { path: "docs" }
    expect(rewriteToolInput("grep", input, "/x", HOME)).toBe(true)
    expect(input.path).toBe("/x/docs")
  })

  test("unknown tool is never touched", () => {
    const input: Record<string, unknown> = { path: "a", command: "b" }
    expect(rewriteToolInput("lsp_diagnostics", input, "/x", HOME)).toBe(false)
    expect(input).toEqual({ path: "a", command: "b" })
  })

  test("non-string path is ignored", () => {
    const input: Record<string, unknown> = { path: 42 }
    expect(rewriteToolInput("read", input, "/x", HOME)).toBe(false)
    expect(input.path).toBe(42)
  })
})

describe("restoreState", () => {
  test("no entries yields no override", () => {
    expect(restoreState([])).toEqual({ cwd: null, previous: null })
  })

  test("last matching entry wins", () => {
    const entries = [
      { type: "custom", customType: "cwd-switch", data: { cwd: "/a", previous: null } },
      { type: "custom", customType: "cwd-switch", data: { cwd: "/b", previous: "/a" } },
    ]
    expect(restoreState(entries)).toEqual({ cwd: "/b", previous: "/a" })
  })

  test("other custom types and non-custom entries are ignored", () => {
    const entries = [
      { type: "message", customType: "cwd-switch", data: { cwd: "/nope" } },
      { type: "custom", customType: "rtk", data: { cwd: "/nope" } },
      { type: "custom", customType: "cwd-switch", data: { cwd: "/yes" } },
    ]
    expect(restoreState(entries)).toEqual({ cwd: "/yes", previous: null })
  })

  test("malformed data degrades to no override", () => {
    expect(restoreState([{ type: "custom", customType: "cwd-switch", data: null }])).toEqual({
      cwd: null,
      previous: null,
    })
    expect(restoreState([{ type: "custom", customType: "cwd-switch", data: { cwd: 7 } }])).toEqual({
      cwd: null,
      previous: null,
    })
  })

  test("explicit reset is honoured", () => {
    const entries = [
      { type: "custom", customType: "cwd-switch", data: { cwd: "/a", previous: null } },
      { type: "custom", customType: "cwd-switch", data: { cwd: null, previous: null } },
    ]
    expect(restoreState(entries)).toEqual({ cwd: null, previous: null })
  })
})

describe("formatPath", () => {
  test("home becomes ~", () => expect(formatPath(HOME, HOME)).toBe("~"))
  test("inside home is shortened", () => expect(formatPath(`${HOME}/x`, HOME)).toBe("~/x"))
  test("outside home is unchanged", () => expect(formatPath("/var/tmp", HOME)).toBe("/var/tmp"))
})

describe("isDirectory", () => {
  test("true for a directory, false for a file and for a missing path", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwd-switch-"))
    try {
      expect(isDirectory(dir)).toBe(true)
      const file = join(dir, "f.txt")
      writeFileSync(file, "x")
      expect(isDirectory(file)).toBe(false)
      expect(isDirectory(join(dir, "missing"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("completeDirectories", () => {
  test("lists matching directories and ignores files and dotdirs", () => {
    const root = mkdtempSync(join(tmpdir(), "cwd-switch-"))
    try {
      mkdirSync(join(root, "alpha"))
      mkdirSync(join(root, "alpine"))
      mkdirSync(join(root, ".hidden"))
      writeFileSync(join(root, "alfile.txt"), "x")

      const items = completeDirectories("al", root, HOME)
      expect(items?.map((i) => i.value)).toEqual(["alpha/", "alpine/"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("nested prefix keeps the typed directory part", () => {
    const root = mkdtempSync(join(tmpdir(), "cwd-switch-"))
    try {
      mkdirSync(join(root, "sub", "inner"), { recursive: true })
      const items = completeDirectories("sub/i", root, HOME)
      expect(items?.map((i) => i.value)).toEqual(["sub/inner/"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("no match yields null, and a missing directory does not throw", () => {
    const root = mkdtempSync(join(tmpdir(), "cwd-switch-"))
    try {
      expect(completeDirectories("zzz", root, HOME)).toBeNull()
      expect(completeDirectories("x", join(root, "nope"), HOME)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ── Wiring tests ───────────────────────────────────────────────────────────
// The pure helpers above can all pass while the extension is wired up wrongly,
// so drive the real factory with a fake Pi host.

import cwdSwitch from "../pi/extensions/cwd-switch"

type Handler = (event: unknown, ctx: unknown) => unknown

function makeHost(sessionCwd: string, seedEntries: unknown[] = []) {
  const handlers = new Map<string, Handler[]>()
  const commands = new Map<string, { handler: Handler; getArgumentCompletions?: (p: string) => unknown }>()
  const entries: unknown[] = [...seedEntries]
  const statuses = new Map<string, string>()
  const notifications: string[] = []

  const pi = {
    on(name: string, fn: Handler) {
      const list = handlers.get(name) ?? []
      list.push(fn)
      handlers.set(name, list)
    },
    registerCommand(name: string, opts: { handler: Handler }) {
      commands.set(name, opts)
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data })
    },
  }

  const ctx = {
    cwd: sessionCwd,
    sessionManager: { getEntries: () => entries },
    ui: {
      setStatus: (key: string, text: string) => statuses.set(key, text),
      notify: (message: string) => notifications.push(message),
    },
  }

  cwdSwitch(pi as never)

  const fire = async (name: string, event: unknown = {}) => {
    for (const fn of handlers.get(name) ?? []) await fn(event, ctx)
  }
  const run = async (args: string) => {
    const command = commands.get("cd")
    if (!command) throw new Error("cd command was not registered")
    await command.handler(args, ctx)
  }

  return { fire, run, statuses, notifications, entries, commands }
}

describe("wiring: /cd command and tool_call hook", () => {
  test("registers the cd command", () => {
    const host = makeHost("/session")
    expect(host.commands.has("cd")).toBe(true)
  })

  test("no override means tool calls are never rewritten", async () => {
    const host = makeHost("/session")
    await host.fire("session_start")

    const event = { toolName: "bash", input: { command: "pwd" } }
    await host.fire("tool_call", event)

    expect(event.input.command).toBe("pwd")
    expect(host.statuses.get("cwd")).toBe("")
  })

  test("/cd sets the effective directory and publishes status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cwd-switch-wire-"))
    try {
      const host = makeHost("/session")
      await host.run(dir)

      expect(host.statuses.get("cwd")).toContain("→")

      const event = { toolName: "bash", input: { command: "pwd" } }
      await host.fire("tool_call", event)
      expect(event.input.command).toBe(`cd '${dir}' || exit 1\npwd`)

      const read = { toolName: "read", input: { path: "a.ts" } }
      await host.fire("tool_call", read)
      expect(read.input.path).toBe(`${dir}/a.ts`)

      // The session directory is untouched — that is the whole point.
      expect(host.entries.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("/cd rejects a non-directory and keeps the previous state", async () => {
    const host = makeHost("/session")
    await host.run("/definitely/not/a/real/path")

    expect(host.notifications.join("\n")).toContain("not a directory")
    expect(host.statuses.get("cwd")).toBeUndefined()

    const event = { toolName: "bash", input: { command: "pwd" } }
    await host.fire("tool_call", event)
    expect(event.input.command).toBe("pwd")
  })

  test("/cd reset clears the override and stops rewriting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cwd-switch-wire-"))
    try {
      const host = makeHost("/session")
      await host.run(dir)
      await host.run("reset")

      expect(host.statuses.get("cwd")).toBe("")

      const event = { toolName: "bash", input: { command: "pwd" } }
      await host.fire("tool_call", event)
      expect(event.input.command).toBe("pwd")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("/cd - returns to the previous effective directory", async () => {
    const a = mkdtempSync(join(tmpdir(), "cwd-switch-a-"))
    const b = mkdtempSync(join(tmpdir(), "cwd-switch-b-"))
    try {
      const host = makeHost("/session")
      await host.run(a)
      await host.run(b)

      const event = { toolName: "bash", input: { command: "pwd" } }
      await host.fire("tool_call", event)
      expect(event.input.command).toContain(b)

      await host.run("-")
      const back = { toolName: "bash", input: { command: "pwd" } }
      await host.fire("tool_call", back)
      expect(back.input.command).toContain(a)
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  test("a surviving override is restored on session_start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cwd-switch-restore-"))
    try {
      const seed = [{ type: "custom", customType: "cwd-switch", data: { cwd: dir, previous: null } }]
      const host = makeHost("/session", seed)
      await host.fire("session_start")

      expect(host.statuses.get("cwd")).toContain("→")

      const event = { toolName: "bash", input: { command: "pwd" } }
      await host.fire("tool_call", event)
      expect(event.input.command).toContain(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a stale override for a deleted directory is dropped at startup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cwd-switch-stale-"))
    rmSync(dir, { recursive: true, force: true })

    const seed = [{ type: "custom", customType: "cwd-switch", data: { cwd: dir, previous: null } }]
    const host = makeHost("/session", seed)
    await host.fire("session_start")

    expect(host.statuses.get("cwd")).toBe("")

    const event = { toolName: "bash", input: { command: "pwd" } }
    await host.fire("tool_call", event)
    expect(event.input.command).toBe("pwd")
  })

  test("a throwing host does not break the tool call (fail-open)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cwd-switch-failopen-"))
    try {
      const host = makeHost("/session")
      await host.run(dir)

      // A read tool whose input is frozen will throw inside the hook.
      const frozen = Object.freeze({ toolName: "read", input: Object.freeze({ path: "a.ts" }) })
      await expect(host.fire("tool_call", frozen)).resolves.toBeUndefined()
      expect(frozen.input.path).toBe("a.ts")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
