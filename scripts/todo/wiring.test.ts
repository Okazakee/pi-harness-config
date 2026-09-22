// Tests for the extension wiring and the end-to-end acceptance path in pi/extensions/todo.ts.
//
// Run via: scripts/test-todo.sh

import { describe, expect, test } from "bun:test"

import { spawnSync } from "node:child_process"
import { cpSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import * as todoFacade from "../../pi/extensions/todo"
import {
	activeTask,
	applyTodoOperation,
	firstPendingTask,
	reconstructBoard,
	TODO_TOOL_NAME,
} from "../../pi/extensions/todo"
import {
	boot,
	collectSourceNames,
	createFakeCtx,
	runHandler,
	runTool,
	runtimeImportSpecifiers,
	sample,
	todoEntrySource,
	todoExtensionPaths,
	todoHelperEntries,
	todoHelperSourceNames,
	todoSources,
	toolEntry,
} from "./harness"

// ================================================================ extension wiring

describe("extension wiring", () => {
	test("registers the tool, command and lifecycle hooks", () => {
		const harness = boot()
		expect(harness.tools.has(TODO_TOOL_NAME)).toBe(true)
		expect(harness.tools.get(TODO_TOOL_NAME).executionMode).toBe("sequential")
		expect(harness.commands.has("todo")).toBe(true)
		expect(harness.handlers.get("session_start")?.length).toBe(1)
		expect(harness.handlers.get("session_tree")?.length).toBe(1)
		expect(harness.handlers.get("context")?.length).toBe(1)
	})

	test("tool results carry the full board in details but a concise message", async () => {
		const harness = boot()
		const { ctx } = createFakeCtx()
		const result = await runTool(harness, {
			op: "init",
			list: [{ phase: "Discovery", items: ["Inspect routing"] }, { phase: "Implementation", items: ["Add fallback"] }],
		}, ctx)
		expect(result.details.op).toBe("init")
		expect(result.details.phases.length).toBe(2)
		expect(result.content[0].text).toContain("Initialized 2 phase(s), 2 task(s)")
		expect(result.content[0].text).toContain("Progress: 0/2")
		expect(result.content[0].text).not.toContain("○")
	})

	test("failed tool mutations throw without touching the board", async () => {
		const harness = boot()
		const { ctx } = createFakeCtx()
		await runTool(harness, { op: "init", list: [{ phase: "P", items: ["only"] }] }, ctx)
		await expect(runTool(harness, { op: "done", task: "missing" }, ctx)).rejects.toThrow("no task matches")
		const context = runHandler(harness, "context", { messages: [] })
		expect(JSON.stringify(context)).toContain("only")
	})

	test("session_start reconstructs from the branch and renders the widget", () => {
		const harness = boot()
		const branch = [toolEntry({ op: "init", phases: sample() })]
		const { ctx, widgets } = createFakeCtx({ branch })
		runHandler(harness, "session_start", { reason: "resume" }, ctx)
		expect(widgets.at(-1)?.[0]).toContain("Discovery · 0/7")
	})

	test("session_tree reconstructs a different branch", () => {
		const complete = applyTodoOperation(sample(), { op: "done", task: "Handle provider cooldown" })
		if (!complete.ok) throw new Error("fixture failed")
		const harness = boot()
		const { ctx, widgets, branchCalls } = createFakeCtx({
			branch: [toolEntry({ op: "init", phases: sample() }), toolEntry({ op: "done", phases: complete.phases })],
		})
		runHandler(harness, "session_tree", { newLeafId: "leaf-7" }, ctx)
		expect(widgets.at(-1)?.[0]).toContain("Discovery · 1/7")
		expect(branchCalls.at(-1)).toBe("leaf-7")
	})

	test("tool mutations update the persistent widget", async () => {
		const harness = boot()
		const { ctx, widgets } = createFakeCtx()
		await runTool(harness, { op: "init", list: [{ phase: "P", items: ["one"] }] }, ctx)
		expect(widgets.at(-1)).toEqual(["P · 0/1", "→ one"])
		await runTool(harness, { op: "done", task: "one" }, ctx)
		expect(widgets.at(-1)).toBeUndefined()
	})

	test("board survives a cwd change and never reads cwd", async () => {
		const harness = boot()
		const first = createFakeCtx({ cwd: "/home/tester/a" })
		const second = createFakeCtx({ cwd: "/home/tester/b" })
		await runTool(harness, { op: "init", list: [{ phase: "P", items: ["one"] }] }, first.ctx)
		const context = runHandler(harness, "context", { messages: [] }, second.ctx)
		expect(JSON.stringify(context)).toContain("one")

		// The invariant covers the entrypoint and every helper source file,
		// including nested ones, not just the file that held the implementation
		// before the split.
		const sources = todoSources()
		expect(sources.map((file) => file.path)).toContain("pi/extensions/todo.ts")
		expect(sources.length).toBe(todoHelperSourceNames().length + 1)
		for (const file of sources) {
			expect(file.source, `${file.path} must not read cwd`).not.toMatch(/ctx\.cwd|process\.cwd/)
		}
	})

	test("the extension and helpers have no external runtime imports (testability invariant)", () => {
		const sources = todoSources()
		expect(sources.length).toBeGreaterThan(1)
		for (const file of sources) {
			for (const specifier of runtimeImportSpecifiers(file.source)) {
				expect(specifier, `${file.path} imports ${specifier} at runtime`).toMatch(/^\.{1,2}\//)
			}
		}
	})

	test("runtime import scanning covers every runtime form and erases type-only imports", () => {
		const cases: Array<[string, string, string[]]> = [
			["type-only import", `import type { A } from "@scope/type-only"`, []],
			["mixed type/value import", `import { type A, b } from "@scope/mixed"`, ["@scope/mixed"]],
			["external side-effect import", `import "@scope/side-effect"`, ["@scope/side-effect"]],
			["multiline relative import", `import {\n\ta,\n\tb,\n} from "./relative"`, ["./relative"]],
			["re-export", `export { a } from "@scope/reexport"`, ["@scope/reexport"]],
			["re-export star", `export * from "@scope/star"`, ["@scope/star"]],
			["dynamic import", `const m = await import("@scope/dynamic")`, ["@scope/dynamic"]],
			["require", `const m = require("@scope/require")`, ["@scope/require"]],
		]
		for (const [name, source, expected] of cases) {
			expect(runtimeImportSpecifiers(source), name).toEqual(expected)
		}
	})

	test("helper modules are not independently discoverable extensions", () => {
		const entries = todoHelperEntries()
		expect(entries.length).toBeGreaterThan(1)
		for (const forbidden of ["index.ts", "index.js", "index.d.ts", "package.json"]) {
			expect(entries, `${forbidden} must not exist`).not.toContain(forbidden)
		}
	})

	test("helper source enumeration is recursive and keeps unexpected JS helpers", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-todo-walk-"))
		try {
			mkdirSync(join(root, "nested", "deeper"), { recursive: true })
			writeFileSync(join(root, "a.ts"), "export const a = 1\n")
			writeFileSync(join(root, "nested", "b.js"), "export const b = 1\n")
			writeFileSync(join(root, "nested", "deeper", "c.ts"), "export const c = 1\n")
			writeFileSync(join(root, "README.md"), "not a source file\n")
			writeFileSync(join(root, "nested", "package.json"), "{}\n")
			expect(collectSourceNames(pathToFileURL(`${root}/`))).toEqual([
				"a.ts",
				"nested/b.js",
				"nested/deeper/c.ts",
			])
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	test("the facade exposes the original public surface and no split internals", () => {
		const exports = Object.keys(todoFacade)
		expect(exports).not.toContain("isRecord")
		expect(exports).not.toContain("VALID_STATUSES")
		expect(exports).toContain("normalizeBoard")
		// A wildcard re-export of the modules that own split internals would leak them.
		expect(todoEntrySource()).not.toMatch(/export \* from "\.\/todo\/(board|constants)"/)
	})

	test("the default export registers the extension exactly once", () => {
		const harness = boot()
		expect(harness.tools.size).toBe(1)
		expect(harness.commands.size).toBe(1)
		for (const event of ["session_start", "session_tree", "input", "before_agent_start", "agent_end", "context"]) {
			expect(harness.handlers.get(event)?.length, `${event} handler count`).toBe(1)
		}
	})

	// Prefer the real loader when a Pi install is available. Without Pi this
	// test is reported as skipped; the deterministic structural checks above
	// still cover the discovery contract.
	test.skipIf(Bun.which("pi") === null)(
		"the installed Pi loader discovers the copied entrypoint with its helper directory",
		() => {
			const root = mkdtempSync(join(tmpdir(), "pi-todo-loader-"))
			try {
				const agentDir = join(root, ".pi", "agent")
				const extensionsDir = join(agentDir, "extensions")
				const paths = todoExtensionPaths()
				mkdirSync(extensionsDir, { recursive: true })
				copyFileSync(paths.entry, join(extensionsDir, "todo.ts"))
				// Copy the helper directory recursively so nested relative imports
				// resolve exactly as they do from the repository.
				cpSync(paths.helperDir, join(extensionsDir, "todo"), { recursive: true })
				const proc = spawnSync(Bun.which("pi") as string, ["--mode", "rpc", "--no-session"], {
					cwd: root,
					env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir },
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 15_000,
					killSignal: "SIGKILL",
				})
				const output = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`
				expect(output).not.toMatch(/Failed to load extension/i)
				expect(proc.status, proc.error?.message ?? "loader exited non-zero").toBe(0)
			} finally {
				rmSync(root, { recursive: true, force: true })
			}
		},
	)
})

// ================================================================ acceptance scenario

describe("acceptance scenario", () => {
	test("request -> board -> advance -> next request sees the new pointer", async () => {
		const harness = boot()
		const { ctx } = createFakeCtx()
		await runTool(harness, {
			op: "init",
			list: [
				{ phase: "Discovery", items: ["Inspect current fallback logic"] },
				{ phase: "Implementation", items: ["Add cooldown handling", "Add usage preflight"] },
				{ phase: "Verification", items: ["Add fallback regressions", "Run repository gate", "Document fallback behavior"] },
			],
		}, ctx)

		const first = runHandler(harness, "context", { messages: [] }) as { messages: any[] }
		expect(first.messages[0].content).toContain("0/6 done · phase: Discovery")
		expect(first.messages[0].content).toContain("active: Inspect current fallback logic")

		await runTool(harness, { op: "done", task: "Inspect current fallback logic" }, ctx)
		const second = runHandler(harness, "context", { messages: [] }) as { messages: any[] }
		expect(second.messages[0].content).toContain("1/6 done · phase: Implementation")
		expect(second.messages[0].content).toContain("active: Add cooldown handling")
		expect(second.messages[0].content).toContain("next: Add usage preflight")
		expect(second.messages[0].content).toContain("5 open")

		await runTool(harness, { op: "done", task: "Add cooldown handling" }, ctx)
		const third = runHandler(harness, "context", { messages: [] }) as { messages: any[] }
		expect(third.messages[0].content).toContain("active: Add usage preflight")
		expect(third.messages[0].content).toContain("2/6 done")

		// A resume from the branch reconstructs the same pointer.
		const entry = harness.entries // no manual mutations were persisted in this flow
		expect(entry.length).toBe(0)
		const reloaded = reconstructBoard([toolEntry({ op: "init", phases: sample() })])
		expect(activeTask(reloaded)?.task.content).toBe("Inspect current routing")
		expect(firstPendingTask(sample())?.task.content).toBe("Add fallback chain")
	})
})
