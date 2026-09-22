// Shared fixtures and a fake Pi harness for the todo extension test suite.
//
// Run with:  bun test scripts/todo/
// or via:    scripts/test-todo.sh
//
// The extension uses type-only imports from @earendil-works/pi-coding-agent, so
// it loads here without that package or pi-tui being installed — no
// node_modules needed. Everything here is deterministic and offline.

import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// The todo extension intentionally registers nothing when PI_SUBAGENT_DEPTH is
// positive. This suite owns that variable: clear any ambient value from a
// delegated runner so the files stay hermetic. The subagent gate tests set it
// explicitly inside try/finally and restore it.
delete process.env.PI_SUBAGENT_DEPTH

import todoExtension, {
	TODO_ENTRY_TYPE,
	TODO_TOOL_NAME,
	normalizeBoard,
	type BranchEntryLike,
	type TodoItem,
	type TodoPhase,
} from "../../pi/extensions/todo"

// ---------------------------------------------------------------- fixtures

export function phase(name: string, ...tasks: Array<string | [string, TodoItem["status"]]>): TodoPhase {
	return {
		name,
		tasks: tasks.map((task) =>
			typeof task === "string"
				? { content: task, status: "pending" as const }
				: { content: task[0], status: task[1] },
		),
	}
}

export function sample(): TodoPhase[] {
	return normalizeBoard([
		phase("Discovery", "Inspect current routing"),
		phase("Implementation", "Add fallback chain", "Handle provider cooldown", "Add usage preflight"),
		phase("Verification", "Add regression coverage", "Run repository contract", "Independent review"),
	])
}

export const toolEntry = (details: unknown): BranchEntryLike => ({
	type: "message",
	message: { role: "toolResult", toolName: TODO_TOOL_NAME, details },
})

export const customEntry = (phases: TodoPhase[]): BranchEntryLike => ({
	type: "custom",
	customType: TODO_ENTRY_TYPE,
	data: { phases },
})

export const otherEntry = (): BranchEntryLike => ({ type: "message", message: { role: "user" } })

// ---------------------------------------------------------------- fake Pi harness

export interface FakeHarness {
	pi: Record<string, unknown>
	tools: Map<string, any>
	commands: Map<string, any>
	handlers: Map<string, Array<(...args: any[]) => unknown>>
	entries: Array<{ customType: string; data: unknown }>
}

export function createFakePi(): FakeHarness {
	const tools = new Map<string, any>()
	const commands = new Map<string, any>()
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>()
	const entries: Array<{ customType: string; data: unknown }> = []
	const pi = {
		registerTool(definition: any) {
			tools.set(definition.name, definition)
		},
		registerCommand(name: string, definition: any) {
			commands.set(name, definition)
		},
		on(event: string, handler: (...args: any[]) => unknown) {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
			return () => {}
		},
		appendEntry(customType: string, data?: unknown) {
			entries.push({ customType, data })
		},
	}
	return { pi, tools, commands, handlers, entries }
}

export interface FakeCtx {
	ctx: Record<string, unknown>
	widgets: Array<string[] | undefined>
	notices: Array<{ message: string; type: string }>
	branch: BranchEntryLike[]
	branchCalls: Array<string | undefined>
}

export function createFakeCtx(options: { branch?: BranchEntryLike[]; hasUI?: boolean; cwd?: string } = {}): FakeCtx {
	const widgets: Array<string[] | undefined> = []
	const notices: Array<{ message: string; type: string }> = []
	const branch = options.branch ?? []
	const branchCalls: Array<string | undefined> = []
	const ctx = {
		hasUI: options.hasUI ?? true,
		cwd: options.cwd ?? "/home/tester/project",
		ui: {
			setWidget(_key: string, content: string[] | undefined) {
				widgets.push(content)
			},
			notify(message: string, type: string) {
				notices.push({ message, type })
			},
		},
		sessionManager: {
			getBranch: (leafId?: string) => {
				branchCalls.push(leafId)
				return branch
			},
		},
	}
	return { ctx, widgets, notices, branch, branchCalls }
}

export function boot(branch: BranchEntryLike[] = []): FakeHarness {
	const harness = createFakePi()
	todoExtension(harness.pi as never)
	return harness
}

export async function runTool(harness: FakeHarness, params: unknown, ctx: Record<string, unknown>) {
	const tool = harness.tools.get(TODO_TOOL_NAME)
	return tool.execute("call-1", params, undefined, undefined, ctx)
}

export function runHandler(harness: FakeHarness, event: string, ...args: unknown[]): unknown {
	const handlers = harness.handlers.get(event) ?? []
	return handlers[0]?.(...args)
}

export async function runCommand(harness: FakeHarness, args: string, ctx: Record<string, unknown>) {
	const command = harness.commands.get("todo")
	return command.handler(args, ctx)
}

// ---------------------------------------------------------------- source inspection

const TODO_ENTRY_URL = new URL("../../pi/extensions/todo.ts", import.meta.url)
const TODO_HELPER_DIR_URL = new URL("../../pi/extensions/todo/", import.meta.url)
const TODO_SOURCE_RE = /\.(ts|js)$/

/** The discoverable extension entrypoint source. */
export function todoEntrySource(): string {
	return readFileSync(TODO_ENTRY_URL, "utf8")
}

/** Top-level entries of pi/extensions/todo/ (files and directories), sorted. */
export function todoHelperEntries(): string[] {
	return readdirSync(TODO_HELPER_DIR_URL).sort()
}

/**
 * Recursively collect `.ts`/`.js` source files below `dir`, sorted, as names
 * relative to `dir`. Unexpected JavaScript helpers are kept so the invariants
 * still inspect them.
 */
export function collectSourceNames(dir: URL, prefix = ""): string[] {
	const names: string[] = []
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name
		if (entry.isDirectory()) {
			names.push(...collectSourceNames(new URL(`${entry.name}/`, dir), relative))
		} else if (entry.isFile() && TODO_SOURCE_RE.test(entry.name)) {
			names.push(relative)
		}
	}
	return names
}

/** Helper source files below pi/extensions/todo/, recursive, repo-relative. */
export function todoHelperSourceNames(): string[] {
	return collectSourceNames(TODO_HELPER_DIR_URL)
}

/** Entrypoint plus every helper source file, so invariants cover the whole split. */
export function todoSources(): Array<{ path: string; source: string }> {
	return [
		{ path: "pi/extensions/todo.ts", source: todoEntrySource() },
		...todoHelperSourceNames().map((name) => ({
			path: `pi/extensions/todo/${name}`,
			source: readFileSync(new URL(name, TODO_HELPER_DIR_URL), "utf8"),
		})),
	]
}

/** Absolute filesystem paths of the entrypoint and its helper directory. */
export function todoExtensionPaths(): { entry: string; helperDir: string } {
	return { entry: fileURLToPath(TODO_ENTRY_URL), helperDir: fileURLToPath(TODO_HELPER_DIR_URL) }
}

const todoTranspiler = new Bun.Transpiler({ loader: "ts" })

/**
 * Module specifiers of every runtime import in a source file, resolved the way
 * Bun itself resolves them. `scanImports` erases `import type`, so what remains
 * is exactly the runtime dependency set: value imports, side-effect imports,
 * re-exports, dynamic `import()` and `require()`. The split is allowed to use
 * local relative imports; anything else regresses the "no third-party runtime
 * dependency" invariant.
 */
export function runtimeImportSpecifiers(source: string): string[] {
	return todoTranspiler.scanImports(source).map((record) => record.path)
}
