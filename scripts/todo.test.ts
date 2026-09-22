// Tests for pi/extensions/todo.ts.
//
// Run with:  bun test scripts/todo.test.ts
// or via:    scripts/test-todo.sh
//
// The extension uses type-only imports from @earendil-works/pi-coding-agent, so
// it loads here without that package or pi-tui being installed — no
// node_modules needed. Everything below is deterministic and offline.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// The todo extension intentionally registers nothing when PI_SUBAGENT_DEPTH is
// positive. This suite owns that variable: clear any ambient value from a
// delegated runner so the file stays hermetic. The subagent gate tests below
// set it explicitly inside try/finally and restore it.
delete process.env.PI_SUBAGENT_DEPTH

import todoExtension, {
	activeTask,
	analyzeListItems,
	applyTodoOperation,
	boardStats,
	buildTodoContextMessage,
	buildTodoNudgeMessage,
	cloneBoard,
	countActionVerbs,
	describeToolCall,
	firstPendingTask,
	formatBoardStatus,
	formatFullView,
	formatTodoContext,
	formatTodoNudge,
	formatWidgetLines,
	isSubagentProcess,
	labelKey,
	locatePhase,
	locateTask,
	normalizeBoard,
	normalizeLabel,
	nudgeKindFor,
	parseBoardSnapshot,
	parseSubagentDepth,
	reconstructBoard,
	resolveTodoTarget,
	shouldSuggestTodo,
	splitBlockTarget,
	stripFencedBlocks,
	textComponent,
	textFromToolContent,
	todoComplexityScore,
	TODO_CONTEXT_MAX_CHARS,
	TODO_CONTEXT_TYPE,
	TODO_ENTRY_TYPE,
	TODO_HELP,
	TODO_NUDGE_MAX_CHARS,
	TODO_NUDGE_THRESHOLD,
	TODO_NUDGE_TYPE,
	TODO_TOOL_NAME,
	TODO_WIDGET_KEY,
	truncateLabel,
	type BranchEntryLike,
	type TodoItem,
	type TodoPhase,
} from "../pi/extensions/todo"

// ---------------------------------------------------------------- fixtures

function phase(name: string, ...tasks: Array<string | [string, TodoItem["status"]]>): TodoPhase {
	return {
		name,
		tasks: tasks.map((task) =>
			typeof task === "string"
				? { content: task, status: "pending" as const }
				: { content: task[0], status: task[1] },
		),
	}
}

function sample(): TodoPhase[] {
	return normalizeBoard([
		phase("Discovery", "Inspect current routing"),
		phase("Implementation", "Add fallback chain", "Handle provider cooldown", "Add usage preflight"),
		phase("Verification", "Add regression coverage", "Run repository contract", "Independent review"),
	])
}

const toolEntry = (details: unknown): BranchEntryLike => ({
	type: "message",
	message: { role: "toolResult", toolName: TODO_TOOL_NAME, details },
})

const customEntry = (phases: TodoPhase[]): BranchEntryLike => ({
	type: "custom",
	customType: TODO_ENTRY_TYPE,
	data: { phases },
})

const otherEntry = (): BranchEntryLike => ({ type: "message", message: { role: "user" } })

// ---------------------------------------------------------------- fake Pi harness

interface FakeHarness {
	pi: Record<string, unknown>
	tools: Map<string, any>
	commands: Map<string, any>
	handlers: Map<string, Array<(...args: any[]) => unknown>>
	entries: Array<{ customType: string; data: unknown }>
}

function createFakePi(): FakeHarness {
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

interface FakeCtx {
	ctx: Record<string, unknown>
	widgets: Array<string[] | undefined>
	notices: Array<{ message: string; type: string }>
	branch: BranchEntryLike[]
	branchCalls: Array<string | undefined>
}

function createFakeCtx(options: { branch?: BranchEntryLike[]; hasUI?: boolean; cwd?: string } = {}): FakeCtx {
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

function boot(branch: BranchEntryLike[] = []): FakeHarness {
	const harness = createFakePi()
	todoExtension(harness.pi as never)
	return harness
}

async function runTool(harness: FakeHarness, params: unknown, ctx: Record<string, unknown>) {
	const tool = harness.tools.get(TODO_TOOL_NAME)
	return tool.execute("call-1", params, undefined, undefined, ctx)
}

function runHandler(harness: FakeHarness, event: string, ...args: unknown[]): unknown {
	const handlers = harness.handlers.get(event) ?? []
	return handlers[0]?.(...args)
}

async function runCommand(harness: FakeHarness, args: string, ctx: Record<string, unknown>) {
	const command = harness.commands.get("todo")
	return command.handler(args, ctx)
}

// ================================================================ state machine

describe("label helpers", () => {
	test("normalizeLabel collapses whitespace", () => {
		expect(normalizeLabel("  Add   usage\npreflight  ")).toBe("Add usage preflight")
	})
	test("labelKey is case-insensitive", () => {
		expect(labelKey("Add Usage  PREFLIGHT")).toBe("add usage preflight")
	})
	test("truncateLabel keeps short text", () => {
		expect(truncateLabel("short", 10)).toBe("short")
	})
	test("truncateLabel bounds long text on code points", () => {
		const out = truncateLabel("x".repeat(50), 10)
		expect([...out].length).toBe(10)
		expect(out.endsWith("…")).toBe(true)
	})

	test("truncateLabel honors tiny caps exactly", () => {
		expect(truncateLabel("ab", 1)).toBe("a")
		expect(truncateLabel("ab", 0)).toBe("")
		expect(truncateLabel("ab", 2)).toBe("ab")
	})
})

describe("normalizeBoard", () => {
	test("promotes the first pending task", () => {
		const board = normalizeBoard([phase("P", "a", "b")])
		expect(board[0].tasks[0].status).toBe("in_progress")
		expect(board[0].tasks[1].status).toBe("pending")
	})

	test("keeps at most one active task", () => {
		const board = normalizeBoard([
			phase("P", "a", "b"),
			phase("Q", "c"),
		].map((p) => ({ ...p, tasks: p.tasks.map((t) => ({ ...t, status: "in_progress" as const })) })))
		const stats = boardStats(board)
		expect(stats.active).toBe(1)
		expect(board[0].tasks[0].status).toBe("in_progress")
		expect(board[0].tasks[1].status).toBe("pending")
		expect(board[1].tasks[0].status).toBe("pending")
	})

	test("never promotes blocked, completed or abandoned work", () => {
		const board = normalizeBoard([
			phase("P", ["done", "completed"], ["gone", "abandoned"], ["stuck", "blocked"]),
		])
		expect(board[0].tasks.map((t) => t.status)).toEqual(["completed", "abandoned", "blocked"])
		expect(activeTask(board)).toBeNull()
	})

	test("zero active with all blocked is valid", () => {
		const board = normalizeBoard([phase("P", ["stuck", "blocked"], ["stuck2", "blocked"])])
		expect(boardStats(board).active).toBe(0)
		expect(boardStats(board).blocked).toBe(2)
	})
})

describe("init", () => {
	test("creates phases and promotes the first task", () => {
		const result = applyTodoOperation([], {
			op: "init",
			list: [
				{ phase: "Discovery", items: ["Inspect routing"] },
				{ phase: "Implementation", items: ["Add fallback", "Handle cooldown"] },
			],
		})
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.phases.length).toBe(2)
		expect(activeTask(result.phases)?.task.content).toBe("Inspect routing")
	})

	test("rejects duplicate phase names", () => {
		const result = applyTodoOperation([], {
			op: "init",
			list: [
				{ phase: "Impl", items: ["a"] },
				{ phase: "impl", items: ["b"] },
			],
		})
		expect(result.ok).toBe(false)
	})

	test("rejects duplicate task labels globally", () => {
		const result = applyTodoOperation([], {
			op: "init",
			list: [
				{ phase: "A", items: ["Run tests"] },
				{ phase: "B", items: ["run tests"] },
			],
		})
		expect(result.ok).toBe(false)
	})

	test("rejects empty boards, empty phases and empty labels", () => {
		expect(applyTodoOperation([], { op: "init" }).ok).toBe(false)
		expect(applyTodoOperation([], { op: "init", list: [] }).ok).toBe(false)
		expect(applyTodoOperation([], { op: "init", list: [{ phase: "A", items: [] }] }).ok).toBe(false)
		expect(applyTodoOperation([], { op: "init", list: [{ phase: " ", items: ["a"] }] }).ok).toBe(false)
		expect(applyTodoOperation([], { op: "init", list: [{ phase: "A", items: [" "] }] }).ok).toBe(false)
	})

	test("replaces an existing board", () => {
		const result = applyTodoOperation(sample(), {
			op: "init",
			list: [{ phase: "Only", items: ["One task"] }],
		})
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.phases).toEqual([{ name: "Only", tasks: [{ content: "One task", status: "in_progress" }] }])
	})
})

describe("start / done / drop", () => {
	test("start makes the target the only active task", () => {
		const board = sample()
		const result = applyTodoOperation(board, { op: "start", task: "Add usage preflight" })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(activeTask(result.phases)?.task.content).toBe("Add usage preflight")
		expect(boardStats(result.phases).active).toBe(1)
	})

	test("start on a blocked task is rejected until unblocked", () => {
		const blocked = applyTodoOperation(sample(), { op: "block", task: "Handle provider cooldown" })
		expect(blocked.ok).toBe(true)
		if (!blocked.ok) return
		const result = applyTodoOperation(blocked.phases, { op: "start", task: "Handle provider cooldown" })
		expect(result.ok).toBe(false)
	})

	test("start on an unknown task is a no-op error", () => {
		const result = applyTodoOperation(sample(), { op: "start", task: "does not exist" })
		expect(result.ok).toBe(false)
	})

	test("done completes the active task and promotes the next pending", () => {
		const board = sample()
		const result = applyTodoOperation(board, { op: "done", task: "Inspect current routing" })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		const done = locateTask(result.phases, "Inspect current routing")
		expect(done?.task.status).toBe("completed")
		expect(activeTask(result.phases)?.task.content).toBe("Add fallback chain")
	})

	test("completing a non-active task keeps the current pointer", () => {
		const result = applyTodoOperation(sample(), { op: "done", task: "Handle provider cooldown" })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(activeTask(result.phases)?.task.content).toBe("Inspect current routing")
	})

	test("done on a phase completes every open task", () => {
		const board = sample()
		const result = applyTodoOperation(board, { op: "done", phase: "Implementation" })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(locatePhase(result.phases, "Implementation")?.tasks.every((t) => t.status === "completed")).toBe(true)
	})

	test("done requires an explicit target", () => {
		expect(applyTodoOperation(sample(), { op: "done" }).ok).toBe(false)
	})

	test("done rejects task and phase together", () => {
		expect(applyTodoOperation(sample(), { op: "done", task: "x", phase: "y" }).ok).toBe(false)
	})

	test("drop abandons the active task and promotes the next pending", () => {
		const result = applyTodoOperation(sample(), { op: "drop", task: "Inspect current routing" })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(locateTask(result.phases, "Inspect current routing")?.task.status).toBe("abandoned")
		expect(activeTask(result.phases)?.task.content).toBe("Add fallback chain")
	})

	test("drop requires an explicit target", () => {
		expect(applyTodoOperation(sample(), { op: "drop" }).ok).toBe(false)
	})

	test("completed and abandoned tasks never auto-promote", () => {
		const board = normalizeBoard([
			phase("A", ["done", "completed"], ["gone", "abandoned"]),
			phase("B", "next"),
		])
		expect(boardStats(board).active).toBe(1)
		expect(activeTask(board)?.task.content).toBe("next")
	})
})

describe("block / unblock", () => {
	test("blocking the active task promotes the next pending", () => {
		const board = sample()
		const active = activeTask(board)?.task.content
		const result = applyTodoOperation(board, { op: "block", task: active ?? "", reason: "waiting on API key" })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		const blocked = locateTask(result.phases, active ?? "")
		expect(blocked?.task.status).toBe("blocked")
		expect(blocked?.task.blocker).toBe("waiting on API key")
		expect(activeTask(result.phases)?.task.content).toBe("Add fallback chain")
	})

	test("blocked tasks never auto-promote", () => {
		const board = normalizeBoard([phase("P", ["stuck", "blocked"], "next")])
		// "next" is already promoted before the block; block it too via phase op.
		const result = applyTodoOperation(board, { op: "block", phase: "P", reason: "external" })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(boardStats(result.phases).active).toBe(0)
		expect(result.phases[0].tasks.every((t) => t.status === "blocked")).toBe(true)
	})

	test("blocker text collapses to one trimmed line and is capped", () => {
		const result = applyTodoOperation(sample(), {
			op: "block",
			task: "Handle provider cooldown",
			reason: "  waiting\n on   the   key\n",
		})
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(locateTask(result.phases, "Handle provider cooldown")?.task.blocker).toBe("waiting on the key")
	})

	test("unblock returns work to pending and clears the reason", () => {
		const blocked = applyTodoOperation(sample(), { op: "block", task: "Handle provider cooldown" })
		if (!blocked.ok) throw new Error("fixture failed")
		const result = applyTodoOperation(blocked.phases, { op: "unblock", task: "Handle provider cooldown" })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		const task = locateTask(result.phases, "Handle provider cooldown")?.task
		expect(task?.status).toBe("pending")
		expect(task?.blocker).toBeUndefined()
	})

	test("unblocking a non-blocked task is an explicit no-op", () => {
		const result = applyTodoOperation(sample(), { op: "unblock", task: "Handle provider cooldown" })
		expect(result.ok).toBe(true)
	})

	test("block requires a target", () => {
		expect(applyTodoOperation(sample(), { op: "block" }).ok).toBe(false)
	})

	test("all blocked leaves zero active and no pending", () => {
		let board = sample()
		for (const task of board.flatMap((p) => p.tasks)) {
			const result = applyTodoOperation(board, { op: "block", task: task.content })
			if (!result.ok) throw new Error(result.error)
			board = result.phases
		}
		expect(boardStats(board).active).toBe(0)
		expect(boardStats(board).open).toBe(0)
		expect(boardStats(board).blocked).toBe(7)
	})
})

describe("append / rm / clear / view", () => {
	test("append to an existing phase", () => {
		const result = applyTodoOperation(sample(), { op: "append", phase: "Verification", items: ["Add coverage"] })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(locatePhase(result.phases, "Verification")?.tasks.some((t) => t.content === "Add coverage")).toBe(true)
	})

	test("append creates a missing phase", () => {
		const result = applyTodoOperation(sample(), { op: "append", phase: "Follow-up", items: ["Document behavior"] })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.phases.at(-1)?.name).toBe("Follow-up")
		expect(locatePhase(result.phases, "Follow-up")?.tasks[0].status).toBe("pending")
	})

	test("append rejects duplicates atomically", () => {
		const before = sample()
		const snapshot = cloneBoard(before)
		const result = applyTodoOperation(before, {
			op: "append",
			phase: "Verification",
			items: ["Fresh task", "run repository contract"],
		})
		expect(result.ok).toBe(false)
		expect(before).toEqual(snapshot)
	})

	test("append requires phase and items", () => {
		expect(applyTodoOperation(sample(), { op: "append", items: ["x"] }).ok).toBe(false)
		expect(applyTodoOperation(sample(), { op: "append", phase: "A" }).ok).toBe(false)
		expect(applyTodoOperation(sample(), { op: "append", phase: "A", items: [] }).ok).toBe(false)
	})

	test("rm removes a task and promotes the next pending", () => {
		const board = sample()
		const active = activeTask(board)?.task.content ?? ""
		const result = applyTodoOperation(board, { op: "rm", task: active })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(locateTask(result.phases, active)).toBeNull()
		expect(activeTask(result.phases)?.task.content).toBe("Add fallback chain")
	})

	test("rm removes a whole phase", () => {
		const result = applyTodoOperation(sample(), { op: "rm", phase: "Verification" })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(locatePhase(result.phases, "Verification")).toBeNull()
	})

	test("rm requires an explicit target", () => {
		expect(applyTodoOperation(sample(), { op: "rm" }).ok).toBe(false)
	})

	test("clear is explicit and drains the board", () => {
		const result = applyTodoOperation(sample(), { op: "clear" })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.phases).toEqual([])
	})

	test("view is read-only and does not normalize", () => {
		const weird: TodoPhase[] = [
			{ name: "P", tasks: [
				{ content: "a", status: "in_progress" },
				{ content: "b", status: "in_progress" },
			] },
		]
		const snapshot = cloneBoard(weird)
		const result = applyTodoOperation(weird, { op: "view" })
		expect(result.ok).toBe(true)
		expect(weird).toEqual(snapshot)
		if (!result.ok) return
		expect(boardStats(result.phases).active).toBe(2)
	})

	test("view on an empty board is harmless", () => {
		const result = applyTodoOperation([], { op: "view" })
		expect(result.ok).toBe(true)
	})

	test("failed mutations leave the input board unchanged", () => {
		const before = sample()
		const snapshot = cloneBoard(before)
		const failures = [
			{ op: "done" as const, task: "missing" },
			{ op: "start" as const, task: "missing" },
			{ op: "rm" as const, phase: "missing" },
			{ op: "append" as const, phase: "A", items: ["Inspect current routing"] },
			{ op: "drop" as const, task: "missing" },
			{ op: "block" as const, task: "missing" },
			{ op: "unblock" as const, phase: "missing" },
		]
		for (const params of failures) {
			const result = applyTodoOperation(before, params)
			expect(result.ok).toBe(false)
		}
		expect(before).toEqual(snapshot)
	})

	test("operations on a cleared board are rejected except init/append/view/clear", () => {
		expect(applyTodoOperation([], { op: "start", task: "x" }).ok).toBe(false)
		expect(applyTodoOperation([], { op: "done", task: "x" }).ok).toBe(false)
		expect(applyTodoOperation([], { op: "append", phase: "Tasks", items: ["first"] }).ok).toBe(true)
		expect(applyTodoOperation([], { op: "view" }).ok).toBe(true)
	})
})

// ================================================================ reconstruction

describe("reconstructBoard", () => {
	test("restores from a todo tool result", () => {
		const board = sample()
		const restored = reconstructBoard([otherEntry(), toolEntry({ op: "init", phases: board })])
		expect(restored).toEqual(board)
	})

	test("restores from a manual custom entry", () => {
		const board = sample()
		const restored = reconstructBoard([customEntry(board)])
		expect(restored).toEqual(board)
	})

	test("the latest snapshot on the branch wins", () => {
		const first = sample()
		const second = applyTodoOperation(first, { op: "done", task: "Handle provider cooldown" })
		if (!second.ok) throw new Error("fixture failed")
		const toolThenManual = reconstructBoard([
			toolEntry({ op: "init", phases: first }),
			customEntry(second.phases),
		])
		expect(locateTask(toolThenManual, "Handle provider cooldown")?.task.status).toBe("completed")

		const manualThenTool = reconstructBoard([
			customEntry(first),
			toolEntry({ op: "done", phases: second.phases }),
		])
		expect(locateTask(manualThenTool, "Handle provider cooldown")?.task.status).toBe("completed")

		const manualWins = reconstructBoard([
			toolEntry({ op: "init", phases: second.phases }),
			customEntry(first),
		])
		expect(locateTask(manualWins, "Handle provider cooldown")?.task.status).toBe("pending")
		expect(activeTask(manualWins)?.task.content).toBe("Inspect current routing")
	})

	test("branch slicing restores the state at that point", () => {
		const before = toolEntry({ op: "init", phases: sample() })
		const after = toolEntry({
			op: "done",
			phases: (() => {
				const r = applyTodoOperation(sample(), { op: "done", task: "Handle provider cooldown" })
				if (!r.ok) throw new Error("fixture failed")
				return r.phases
			})(),
		})
		const early = reconstructBoard([before, after].slice(0, 1))
		const late = reconstructBoard([before, after])
		expect(locateTask(early, "Handle provider cooldown")?.task.status).toBe("pending")
		expect(locateTask(late, "Handle provider cooldown")?.task.status).toBe("completed")
	})

	test("malformed snapshots are skipped, not fatal", () => {
		const good = sample()
		const restored = reconstructBoard([
			toolEntry({ op: "init", phases: good }),
			toolEntry({ op: "done", phases: "not-an-array" }),
			toolEntry({ op: "done", phases: [{ name: "X", tasks: [{ content: "y", status: "bogus" }] }] }),
			customEntry([]),
		])
		expect(restored).toEqual([])
		expect(reconstructBoard([otherEntry()])).toEqual([])
	})

	test("parseBoardSnapshot validates statuses and blockers", () => {
		expect(parseBoardSnapshot(undefined)).toBeNull()
		expect(parseBoardSnapshot({ phases: [{}] })).toBeNull()
		expect(parseBoardSnapshot({ phases: [{ name: "P", tasks: [{ content: "", status: "pending" }] }] })).toBeNull()
		expect(parseBoardSnapshot({ phases: [{ name: "P", tasks: [{ content: "a", status: "blocked", blocker: "why" }] }] }))
			.toEqual([{ name: "P", tasks: [{ content: "a", status: "blocked", blocker: "why" }] }])
	})

	test("compaction entries do not disturb reconstruction", () => {
		const board = sample()
		const restored = reconstructBoard([
			toolEntry({ op: "init", phases: board }),
			{ type: "compaction" },
			otherEntry(),
		])
		expect(restored).toEqual(board)
	})
})

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

		const source = readFileSync(new URL("../pi/extensions/todo.ts", import.meta.url), "utf8")
		expect(source).not.toMatch(/ctx\.cwd|process\.cwd/)
	})

	test("the extension has no runtime imports (testability invariant)", () => {
		const source = readFileSync(new URL("../pi/extensions/todo.ts", import.meta.url), "utf8")
		expect(source).not.toMatch(/^\s*import\s+(?!type\b)/m)
	})
})

// ================================================================ request-local context

describe("request-local context injection", () => {
	test("no board injects nothing", () => {
		const harness = boot()
		expect(runHandler(harness, "context", { messages: [] })).toBeUndefined()
	})

	test("a fully completed board injects nothing", async () => {
		const harness = boot()
		const { ctx } = createFakeCtx()
		await runTool(harness, { op: "init", list: [{ phase: "P", items: ["one"] }] }, ctx)
		await runTool(harness, { op: "done", task: "one" }, ctx)
		expect(runHandler(harness, "context", { messages: [] })).toBeUndefined()
	})

	test("an active board injects a compact pointer", async () => {
		const harness = boot()
		const { ctx } = createFakeCtx()
		await runTool(harness, { op: "init", list: [
			{ phase: "Discovery", items: ["Inspect current routing"] },
			{ phase: "Implementation", items: ["Add fallback chain", "Handle provider cooldown"] },
		] }, ctx)
		const result = runHandler(harness, "context", { messages: [] }) as { messages: any[] }
		expect(result.messages.length).toBe(1)
		const message = result.messages[0]
		expect(message.role).toBe("custom")
		expect(message.display).toBe(false)
		expect(message.content).toContain("<todo_context>")
		expect(message.content).toContain("0/3 done · phase: Discovery")
		expect(message.content).toContain("active: Inspect current routing")
		expect(message.content).toContain("next: Add fallback chain")
		expect(message.content).toContain("3 open")
	})

	test("completed task names are not repeated in the pointer", async () => {
		const harness = boot()
		const { ctx } = createFakeCtx()
		await runTool(harness, { op: "init", list: [{ phase: "P", items: ["finished thing", "next thing"] }] }, ctx)
		const result = runHandler(harness, "context", { messages: [] }) as { messages: any[] }
		await runTool(harness, { op: "done", task: "finished thing" }, ctx)
		const advanced = runHandler(harness, "context", { messages: [] }) as { messages: any[] }
		expect(result.messages[0].content).toContain("finished thing")
		expect(advanced.messages[0].content).not.toContain("finished thing")
	})

	test("the pointer advances within the same user turn", async () => {
		const harness = boot()
		const { ctx } = createFakeCtx()
		await runTool(harness, { op: "init", list: [{ phase: "Implementation", items: ["Inspect routing", "Define invariant"] }] }, ctx)
		const before = runHandler(harness, "context", { messages: [] }) as { messages: any[] }
		expect(before.messages[0].content).toContain("active: Inspect routing")
		await runTool(harness, { op: "done", task: "Inspect routing" }, ctx)
		const after = runHandler(harness, "context", { messages: [] }) as { messages: any[] }
		expect(after.messages[0].content).toContain("active: Define invariant")
	})

	test("injection is request-local and never appended to session history", async () => {
		const harness = boot()
		const { ctx, branch } = createFakeCtx()
		await runTool(harness, { op: "init", list: [{ phase: "P", items: ["one"] }] }, ctx)
		const before = harness.entries.length
		const branchBefore = [...branch]
		runHandler(harness, "context", { messages: [{ role: "user", content: "hi" }] })
		runHandler(harness, "context", { messages: [{ role: "user", content: "hi" }] })
		expect(harness.entries.length).toBe(before)
		expect(branch).toEqual(branchBefore)
	})

	test("normal pointers stay within the size cap", () => {
		const text = formatTodoContext(sample())
		expect(text).not.toBeNull()
		expect([...(text ?? "")].length).toBeLessThanOrEqual(TODO_CONTEXT_MAX_CHARS)
	})

	test("very long labels and reasons truncate safely", () => {
		const long = "y".repeat(400)
		const board = normalizeBoard([phase("Phase " + long, long, long + " two")])
		const blocked = applyTodoOperation(board, { op: "block", task: board[0].tasks[0].content, reason: long })
		if (!blocked.ok) throw new Error(blocked.error)
		const allBlocked = applyTodoOperation(blocked.phases, { op: "block", task: board[0].tasks[1].content, reason: long })
		if (!allBlocked.ok) throw new Error(allBlocked.error)
		const text = formatTodoContext(allBlocked.phases)
		expect(text).not.toBeNull()
		expect([...(text ?? "")].length).toBeLessThanOrEqual(TODO_CONTEXT_MAX_CHARS)
		expect(text ?? "").toContain("blocked:")
		expect(text ?? "").toContain("…")
	})

	test("an explicit lower cap is honored even for tiny values", () => {
		for (const cap of [20, 34, 35, 60, 120, TODO_CONTEXT_MAX_CHARS]) {
			const text = formatTodoContext(sample(), cap)
			expect(text).not.toBeNull()
			expect([...(text ?? "")].length).toBeLessThanOrEqual(cap)
		}
	})

	test("buildTodoContextMessage is a hidden custom message", () => {
		const message = buildTodoContextMessage("<todo_context>x</todo_context>", 42)
		expect(message).toEqual({
			role: "custom",
			customType: "okazakee:todo-context",
			content: "<todo_context>x</todo_context>",
			display: false,
			timestamp: 42,
		})
	})
})

// ================================================================ subagents

describe("subagent gating", () => {
	test("parseSubagentDepth treats only positive integers as children", () => {
		expect(parseSubagentDepth(undefined)).toBe(0)
		expect(parseSubagentDepth("")).toBe(0)
		expect(parseSubagentDepth("0")).toBe(0)
		expect(parseSubagentDepth(" 0 ")).toBe(0)
		expect(parseSubagentDepth("abc")).toBe(0)
		expect(parseSubagentDepth("-1")).toBe(0)
		expect(parseSubagentDepth("1.5")).toBe(0)
		expect(parseSubagentDepth("1")).toBe(1)
		expect(parseSubagentDepth(" 2 ")).toBe(2)
		expect(parseSubagentDepth("9007199254740993")).toBe(0)
	})

	test("isSubagentProcess reads the documented variable", () => {
		expect(isSubagentProcess({})).toBe(false)
		expect(isSubagentProcess({ PI_SUBAGENT_DEPTH: "0" })).toBe(false)
		expect(isSubagentProcess({ PI_SUBAGENT_DEPTH: "1" })).toBe(true)
		expect(isSubagentProcess({ PI_SUBAGENT_DEPTH: "2" })).toBe(true)
	})

	test("depth 1 registers nothing", () => {
		const previous = process.env.PI_SUBAGENT_DEPTH
		try {
			process.env.PI_SUBAGENT_DEPTH = "1"
			const harness = boot()
			expect(harness.tools.size).toBe(0)
			expect(harness.commands.size).toBe(0)
			expect(harness.handlers.size).toBe(0)
			expect(harness.handlers.get("input")).toBeUndefined()
			expect(harness.handlers.get("before_agent_start")).toBeUndefined()
			expect(harness.handlers.get("agent_end")).toBeUndefined()
			expect(harness.entries.length).toBe(0)
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT_DEPTH
			else process.env.PI_SUBAGENT_DEPTH = previous
		}
	})

	test("depth 0 and missing depth stay enabled", () => {
		const previous = process.env.PI_SUBAGENT_DEPTH
		try {
			delete process.env.PI_SUBAGENT_DEPTH
			expect(boot().tools.size).toBe(1)
			process.env.PI_SUBAGENT_DEPTH = "0"
			expect(boot().tools.size).toBe(1)
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENT_DEPTH
			else process.env.PI_SUBAGENT_DEPTH = previous
		}
	})
})

// ================================================================ manual commands

describe("manual command target matching", () => {
	const board = sample()

	test("exact match", () => {
		expect(resolveTodoTarget(board, "Add usage preflight")).toEqual({
			target: { kind: "task", name: "Add usage preflight" },
		})
	})

	test("case-insensitive match", () => {
		expect(resolveTodoTarget(board, "add usage PREFLIGHT")).toEqual({
			target: { kind: "task", name: "Add usage preflight" },
		})
	})

	test("unique substring match", () => {
		expect(resolveTodoTarget(board, "cooldown")).toEqual({
			target: { kind: "task", name: "Handle provider cooldown" },
		})
	})

	test("phase match", () => {
		expect(resolveTodoTarget(board, "verification")).toEqual({
			target: { kind: "phase", name: "Verification" },
		})
	})

	test("ambiguous matches are rejected", () => {
		expect("error" in resolveTodoTarget(board, "Add")).toBe(true)
	})

	test("unknown targets report a clean error", () => {
		expect(resolveTodoTarget(board, "nope")).toEqual({ error: 'no task or phase matches "nope"' })
	})

	test("block splits target from reason by longest match", () => {
		expect(splitBlockTarget(board, "Handle provider cooldown waiting on the key")).toEqual({
			target: { kind: "task", name: "Handle provider cooldown" },
			reason: "waiting on the key",
		})
	})

	test("block without a reason works", () => {
		expect(splitBlockTarget(board, "cooldown")).toEqual({
			target: { kind: "task", name: "Handle provider cooldown" },
		})
	})

	test("block stops at an ambiguous prefix", () => {
		const result = splitBlockTarget(board, "Add something else")
		expect("error" in result).toBe(true)
	})
})

describe("manual command handler", () => {
	test("/todo shows the full board", async () => {
		const harness = boot()
		const { ctx, notices } = createFakeCtx()
		await runTool(harness, { op: "init", list: [{ phase: "P", items: ["one"] }] }, ctx)
		await runCommand(harness, "", ctx)
		expect(notices.at(-1)?.message).toContain("→ one")
	})

	test("/todo help lists the command surface", async () => {
		const harness = boot()
		const { ctx, notices } = createFakeCtx()
		await runCommand(harness, "help", ctx)
		expect(notices.at(-1)?.message).toContain("/todo clear")
	})

	test("append with a default phase persists a custom entry", async () => {
		const harness = boot()
		const { ctx } = createFakeCtx()
		await runCommand(harness, "append quickfix", ctx)
		expect(harness.entries.length).toBe(1)
		expect(harness.entries[0].customType).toBe(TODO_ENTRY_TYPE)
		const snapshot = harness.entries[0].data as { phases: TodoPhase[] }
		expect(snapshot.phases[0].name).toBe("Tasks")
		expect(snapshot.phases[0].tasks[0].content).toBe("quickfix")
	})

	test("append with an explicit phase", async () => {
		const harness = boot()
		const { ctx } = createFakeCtx()
		await runCommand(harness, "append Implementation Add the preflight", ctx)
		const snapshot = harness.entries[0].data as { phases: TodoPhase[] }
		expect(snapshot.phases[0].name).toBe("Implementation")
		expect(snapshot.phases[0].tasks[0].content).toBe("Add the preflight")
	})

	test("done resolves a unique substring and persists", async () => {
		const harness = boot()
		const { ctx } = createFakeCtx()
		await runTool(harness, { op: "init", list: [{ phase: "P", items: ["alpha", "beta"] }] }, ctx)
		await runCommand(harness, "done beta", ctx)
		expect(harness.entries.length).toBe(1)
		const snapshot = harness.entries[0].data as { phases: TodoPhase[] }
		expect(snapshot.phases[0].tasks[1].status).toBe("completed")
	})

	test("ambiguous commands are rejected without mutation", async () => {
		const harness = boot()
		const { ctx, notices } = createFakeCtx()
		await runTool(harness, { op: "init", list: [{ phase: "P", items: ["add tests", "add features"] }] }, ctx)
		await runCommand(harness, "done add", ctx)
		expect(harness.entries.length).toBe(0)
		expect(notices.at(-1)?.message).toContain("ambiguous")
	})

	test("block and unblock persist the reason round-trip", async () => {
		const harness = boot()
		const { ctx } = createFakeCtx()
		await runTool(harness, { op: "init", list: [{ phase: "P", items: ["target task"] }] }, ctx)
		await runCommand(harness, "block target waiting on review", ctx)
		let snapshot = harness.entries.at(-1)?.data as { phases: TodoPhase[] }
		expect(snapshot.phases[0].tasks[0].status).toBe("blocked")
		expect(snapshot.phases[0].tasks[0].blocker).toBe("waiting on review")
		await runCommand(harness, "unblock target", ctx)
		snapshot = harness.entries.at(-1)?.data as { phases: TodoPhase[] }
		expect(snapshot.phases[0].tasks[0].status).toBe("in_progress")
		expect(snapshot.phases[0].tasks[0].blocker).toBeUndefined()
	})

	test("clear requires the explicit clear command", async () => {
		const harness = boot()
		const { ctx, notices } = createFakeCtx()
		await runTool(harness, { op: "init", list: [{ phase: "P", items: ["one"] }] }, ctx)
		await runCommand(harness, "", ctx)
		expect(notices.at(-1)?.message).toContain("→ one")
		await runCommand(harness, "clear", ctx)
		const snapshot = harness.entries.at(-1)?.data as { phases: TodoPhase[] }
		expect(snapshot.phases).toEqual([])
		await runCommand(harness, "clear now", ctx)
		expect(notices.at(-1)?.message).toContain("clear takes no arguments")
	})

	test("help text documents every required command", () => {
		for (const fragment of ["/todo", "append", "start", "done", "drop", "block", "unblock", "rm", "clear"]) {
			expect(TODO_HELP).toContain(fragment)
		}
	})
})

// ================================================================ UI formatting

describe("widget formatting", () => {
	test("shows phase, progress, active and at most two next", () => {
		const lines = formatWidgetLines(sample())
		expect(lines[0]).toBe("Discovery · 0/7")
		expect(lines[1]).toBe("→ Inspect current routing")
		expect(lines.filter((line) => line.startsWith("  ")).length).toBe(2)
	})

	test("omits completed and abandoned work", () => {
		const board = normalizeBoard([
			phase("P", ["done", "completed"], ["gone", "abandoned"], "next"),
		])
		const lines = formatWidgetLines(board)
		expect(lines.join("\n")).not.toContain("done")
		expect(lines.join("\n")).not.toContain("gone")
		expect(lines.join("\n")).toContain("next")
	})

	test("shows blocked count only when non-zero", () => {
		const blocked = applyTodoOperation(sample(), { op: "block", phase: "Verification", reason: "external" })
		if (!blocked.ok) throw new Error(blocked.error)
		const withBlocked = formatWidgetLines(blocked.phases).join("\n")
		expect(withBlocked).toContain("! 3 blocked")
		expect(formatWidgetLines(sample()).join("\n")).not.toContain("blocked")
	})

	test("clears to an empty widget when nothing is open", () => {
		const done = applyTodoOperation(sample(), { op: "done", phase: "Discovery" })
		if (!done.ok) throw new Error(done.error)
		expect(formatWidgetLines(normalizeBoard([phase("P", ["x", "completed"])]))).toEqual([])
	})

	test("long widget labels truncate safely", () => {
		const board = normalizeBoard([phase("P", "z".repeat(300), "w".repeat(300))])
		const lines = formatWidgetLines(board)
		for (const line of lines) expect([...line].length).toBeLessThan(200)
	})
})

describe("full view formatting", () => {
	test("renders every status with its glyph", () => {
		const board: TodoPhase[] = [
			{
				name: "P",
				tasks: [
					{ content: "pending task", status: "pending" },
					{ content: "active task", status: "in_progress" },
					{ content: "done task", status: "completed" },
					{ content: "gone task", status: "abandoned" },
					{ content: "stuck task", status: "blocked", blocker: "why not" },
				],
			},
		]
		const view = formatFullView(board)
		expect(view).toContain("○ pending task")
		expect(view).toContain("→ active task")
		expect(view).toContain("✓ done task")
		expect(view).toContain("− gone task")
		expect(view).toContain("! stuck task  (why not)")
	})

	test("shows phase progress counts", () => {
		const view = formatFullView(sample())
		expect(view).toContain("Discovery")
		expect(view).toContain("0/1")
		expect(view).toContain("Implementation")
		expect(view).toContain("0/3")
	})

	test("empty board renders a stable placeholder", () => {
		expect(formatFullView([])).toBe("No todo board.")
	})
})

describe("tool rendering helpers", () => {
	test("describeToolCall formats init/append/simple ops", () => {
		expect(describeToolCall({ op: "init", list: [{ phase: "A", items: ["x", "y"] }] })).toBe("todo init · 1 phase(s), 2 task(s)")
		expect(describeToolCall({ op: "append", phase: "A", items: ["x"] })).toBe("todo append · A (+1)")
		expect(describeToolCall({ op: "done", task: "Fix it" })).toBe("todo done Fix it")
		expect(describeToolCall({ op: "clear" })).toBe("todo clear")
		expect(describeToolCall({ op: "block", task: "Fix it", reason: "waiting for the key" })).toBe("todo block Fix it · waiting for the key")
	})

	test("textFromToolContent extracts text blocks only", () => {
		expect(textFromToolContent([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe("a\nb")
		expect(textFromToolContent("nope")).toBe("")
	})

	test("textComponent renders its lines", () => {
		const component = textComponent(["one", "two"])
		expect(component.render(80)).toEqual(["one", "two"])
		component.invalidate()
	})

	test("board status helper stays concise", () => {
		const status = formatBoardStatus(sample())
		expect(status).toContain("Active: Inspect current routing")
		expect(status).toContain("Progress: 0/7")
	})
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

// ================================================================ complexity heuristic

const BULLET_LIST = [
	"- inspect current auth",
	"- change refresh handling",
	"- add concurrency protection",
	"- write tests",
	"- run the full checks",
].join("\n")

const NUMBERED_LIST = [
	"1. research current implementation",
	"2. implement fallback",
	"3. add tests",
	"4. update docs",
].join("\n")

const LONG_BRIEF =
	"inspect X, update Y, preserve Z, add tests for A and B, run the repository gates, " +
	"then document the final behavior"

describe("todo complexity heuristic", () => {
	test("triggers on an explicit action checklist", () => {
		expect(shouldSuggestTodo(BULLET_LIST)).toBe(true)
		expect(todoComplexityScore(BULLET_LIST)).toBeGreaterThanOrEqual(TODO_NUDGE_THRESHOLD)
	})

	test("triggers on a numbered implementation checklist", () => {
		expect(shouldSuggestTodo(NUMBERED_LIST)).toBe(true)
	})

	test("triggers on a long prose engineering brief", () => {
		expect(shouldSuggestTodo(LONG_BRIEF)).toBe(true)
	})

	test("triggers on research + implement + test + document", () => {
		expect(
			shouldSuggestTodo(
				"Research the current implementation, implement fallback behavior, test the new path, and document it.",
			),
		).toBe(true)
	})

	test("triggers on a migration brief", () => {
		expect(
			shouldSuggestTodo(
				"Migrate the database layer from knex to drizzle, update the migrations, replace the seed scripts, and verify the upgrade path.",
			),
		).toBe(true)
	})

	test("triggers on an explicit tasks section", () => {
		expect(shouldSuggestTodo("Tasks: inspect the parser, update the renderer, add regression coverage.")).toBe(true)
	})

	test("triggers on an explicit requirements section", () => {
		expect(
			shouldSuggestTodo(
				"Here are 4 requirements to implement: apply the patch, update the docs, add tests, run the gate.",
			),
		).toBe(true)
	})

	test("triggers on a task-shaped question with several verbs", () => {
		expect(shouldSuggestTodo("Can you inspect X, fix Y, add tests and update docs?")).toBe(true)
	})

	test("does not trigger on a simple factual question", () => {
		expect(shouldSuggestTodo("why does this type fail?")).toBe(false)
	})

	test("does not trigger on a long explanatory question", () => {
		const explanation = `${"The parser walks tokens and builds a tree. ".repeat(30)}\nCan you explain how this works in detail?`
		expect(explanation.length).toBeGreaterThan(800)
		expect(shouldSuggestTodo(explanation)).toBe(false)
	})

	test("does not trigger on a one-step implementation request", () => {
		expect(shouldSuggestTodo("implement the fallback chain")).toBe(false)
	})

	test("does not trigger on a rename request", () => {
		expect(shouldSuggestTodo("rename foo to bar")).toBe(false)
	})

	test("does not trigger on a single test command", () => {
		expect(shouldSuggestTodo("run the tests")).toBe(false)
	})

	test("does not trigger on a short bug explanation", () => {
		expect(shouldSuggestTodo("The build fails because the lockfile is stale.")).toBe(false)
	})

	test("does not trigger on a /cd-style command", () => {
		expect(shouldSuggestTodo("/cd ~/Desktop")).toBe(false)
	})

	test("does not trigger on long pasted code plus one simple question", () => {
		const prompt = `\`\`\`ts\n${"const x = 1;\n".repeat(400)}\`\`\`\nwhat does this do?`
		expect(prompt.length).toBeGreaterThan(800)
		expect(shouldSuggestTodo(prompt)).toBe(false)
	})

	test("does not trigger on a pure explanation question", () => {
		expect(shouldSuggestTodo("Can you explain X, Y and Z?")).toBe(false)
	})

	test("does not trigger on descriptive context bullets", () => {
		const context = [
			"Here are 10 bullet points describing context, what do you think?",
			"- update latency is 50ms",
			"- cache is invalidated on write",
			"- tokens are refreshed hourly",
			"- logs are rotated daily",
		].join("\n")
		expect(shouldSuggestTodo(context)).toBe(false)
	})

	test("does not trigger on a short architecture question", () => {
		expect(shouldSuggestTodo("is this architecture sane?")).toBe(false)
	})
})

describe("todo complexity score boundaries", () => {
	test("below threshold stays silent", () => {
		expect(todoComplexityScore("add tests")).toBe(2)
		expect(shouldSuggestTodo("add tests")).toBe(false)
	})

	test("exact threshold triggers", () => {
		expect(todoComplexityScore("add tests, update docs, verify the output")).toBe(TODO_NUDGE_THRESHOLD)
		expect(shouldSuggestTodo("add tests, update docs, verify the output")).toBe(true)
	})

	test("above threshold triggers", () => {
		const prompt = "add tests, update docs, verify the output, then check the logs"
		expect(todoComplexityScore(prompt)).toBeGreaterThan(TODO_NUDGE_THRESHOLD)
	})

	test("long prompt alone never triggers", () => {
		const long = "This paragraph only describes background context. ".repeat(20)
		expect(long.length).toBeGreaterThan(800)
		expect(todoComplexityScore(long)).toBe(1)
		expect(shouldSuggestTodo(long)).toBe(false)
	})

	test("checklist wording alone never triggers", () => {
		expect(todoComplexityScore("tasks: keep it simple")).toBe(2)
		expect(shouldSuggestTodo("tasks: keep it simple")).toBe(false)
	})

	test("structure without task-like items never triggers alone", () => {
		const context = ["- alpha is a module", "- beta is a service", "- gamma is a cache"].join("\n")
		expect(todoComplexityScore(context)).toBeLessThan(TODO_NUDGE_THRESHOLD)
	})

	test("question bias applies only without task evidence", () => {
		const plain = "inspect the parser and update the docs"
		expect(todoComplexityScore(plain)).toBe(2)
		expect(todoComplexityScore(`${plain}?`)).toBe(1)
		expect(shouldSuggestTodo(`${plain}?`)).toBe(false)
	})

	test("counts distinct action verbs and their inflections", () => {
		expect(countActionVerbs("migrating the updates after checks")).toBe(3)
		expect(countActionVerbs("adding fixes to replaced files")).toBe(3)
	})
})

describe("todo list item analysis", () => {
	test("recognizes task-like bullets", () => {
		const items = analyzeListItems("- inspect current auth\n- change refresh handling\n- add concurrency protection")
		expect(items.length).toBe(3)
		expect(items.every((item) => item.taskLike)).toBe(true)
	})

	test("does not count descriptive statements as task-like", () => {
		const items = analyzeListItems("- update latency is 50ms\n- tests are flaky\n- docs have typos")
		expect(items.length).toBe(3)
		expect(items.some((item) => item.taskLike)).toBe(false)
	})

	test("ignores tiny and code-fenced entries", () => {
		const items = analyzeListItems("- x\n```\n- add real work here\n- update the thing\n- fix the bug\n```")
		expect(items.length).toBe(0)
	})

	test("treats year-style numbering as a plain item and still finds the real task", () => {
		const items = analyzeListItems("2023. something happened\n1. add a test")
		expect(items.length).toBe(2)
		expect(items.filter((item) => item.taskLike).length).toBe(1)
	})

	test("strips fenced blocks only", () => {
		expect(stripFencedBlocks("before\n```\nadd tests\n```\nafter")).not.toContain("add tests")
	})
})

describe("todo nudge text", () => {
	test("initialize wording matches the advisory contract", () => {
		expect(formatTodoNudge("initialize")).toBe(
			"<todo_nudge>\nThis request appears multi-step. Consider initializing a concise phased todo board before substantial work so all requested scopes remain tracked.\n</todo_nudge>",
		)
	})

	test("reconcile wording matches the advisory contract", () => {
		expect(formatTodoNudge("reconcile")).toBe(
			"<todo_nudge>\nThis prompt appears to add substantial multi-step work. Reconcile the current todo board with the new requirements before substantial work if needed.\n</todo_nudge>",
		)
	})

	test("both wordings stay within the size budget", () => {
		expect([...formatTodoNudge("initialize")].length).toBeLessThanOrEqual(TODO_NUDGE_MAX_CHARS)
		expect([...formatTodoNudge("reconcile")].length).toBeLessThanOrEqual(TODO_NUDGE_MAX_CHARS)
	})

	test("nudge kind follows board actionability", () => {
		expect(nudgeKindFor([])).toBe("initialize")
		expect(nudgeKindFor(sample())).toBe("reconcile")
		const one = normalizeBoard([phase("P", "only task")])
		const doneOne = applyTodoOperation(one, { op: "done", task: "only task" })
		if (!doneOne.ok) throw new Error("fixture failed")
		expect(nudgeKindFor(doneOne.phases)).toBe("initialize")
		const cleared = applyTodoOperation(sample(), { op: "clear" })
		if (!cleared.ok) throw new Error("fixture failed")
		expect(nudgeKindFor(cleared.phases)).toBe("initialize")
	})

	test("nudge message is a hidden custom message", () => {
		expect(buildTodoNudgeMessage("<todo_nudge>x</todo_nudge>", 7)).toEqual({
			role: "custom",
			customType: TODO_NUDGE_TYPE,
			content: "<todo_nudge>x</todo_nudge>",
			display: false,
			timestamp: 7,
		})
	})
})

// ================================================================ nudge wiring

function armPrompt(harness: FakeHarness, prompt: string, source = "interactive"): void {
	runHandler(harness, "input", { source, text: prompt })
	runHandler(harness, "before_agent_start", { prompt })
}

function contextMessages(harness: FakeHarness, messages: unknown[] = []): any[] | undefined {
	const result = runHandler(harness, "context", { messages }) as { messages: any[] } | undefined
	return result?.messages
}

function messagesOfType(messages: any[] | undefined, customType: string): any[] {
	return (messages ?? []).filter((message) => message.customType === customType)
}

describe("todo nudge wiring", () => {
	test("registers source, arming and cleanup handlers", () => {
		const harness = boot()
		expect(harness.handlers.get("input")?.length).toBe(1)
		expect(harness.handlers.get("before_agent_start")?.length).toBe(1)
		expect(harness.handlers.get("agent_end")?.length).toBe(1)
	})

	test("before_agent_start itself persists nothing", () => {
		const harness = boot()
		armPrompt(harness, BULLET_LIST)
		expect(harness.entries.length).toBe(0)
	})

	test("one nudge per user prompt, then silence", () => {
		const harness = boot()
		armPrompt(harness, BULLET_LIST)
		const first = contextMessages(harness) ?? []
		const second = contextMessages(harness)
		const third = contextMessages(harness)
		expect(messagesOfType(first, TODO_NUDGE_TYPE).length).toBe(1)
		expect(second).toBeUndefined()
		expect(third).toBeUndefined()
	})

	test("a new complex prompt arms a new nudge", () => {
		const harness = boot()
		armPrompt(harness, BULLET_LIST)
		contextMessages(harness)
		armPrompt(harness, BULLET_LIST)
		const again = contextMessages(harness) ?? []
		expect(messagesOfType(again, TODO_NUDGE_TYPE).length).toBe(1)
	})

	test("a simple prompt arms nothing", () => {
		const harness = boot()
		armPrompt(harness, "why does this fail?")
		expect(contextMessages(harness)).toBeUndefined()
	})

	test("extension-sent prompts never arm the nudge", () => {
		const harness = boot()
		armPrompt(harness, BULLET_LIST, "extension")
		expect(contextMessages(harness)).toBeUndefined()
	})

	test("an unconsumed nudge is cleared at agent_end", () => {
		const harness = boot()
		armPrompt(harness, BULLET_LIST)
		runHandler(harness, "agent_end")
		expect(contextMessages(harness)).toBeUndefined()
	})

	test("the nudge is request-local and never persisted", () => {
		const harness = boot()
		const { branch } = createFakeCtx()
		armPrompt(harness, BULLET_LIST)
		const branchBefore = [...branch]
		const injected = contextMessages(harness) ?? []
		expect(messagesOfType(injected, TODO_NUDGE_TYPE).length).toBe(1)
		expect(harness.entries.length).toBe(0)
		expect(branch).toEqual(branchBefore)
	})

	test("a cwd change does not duplicate the nudge", () => {
		const harness = boot()
		armPrompt(harness, BULLET_LIST)
		const first = contextMessages(harness) ?? []
		const elsewhere = createFakeCtx({ cwd: "/elsewhere" })
		const second = runHandler(harness, "context", { messages: [] }, elsewhere.ctx)
		expect(messagesOfType(first, TODO_NUDGE_TYPE).length).toBe(1)
		expect(second).toBeUndefined()
	})

	test("resume and tree replay never re-fire an old nudge", () => {
		const branch = [toolEntry({ op: "init", phases: sample() })]
		const harness = boot(branch)
		const { ctx } = createFakeCtx({ branch })
		runHandler(harness, "session_start", { reason: "resume" }, ctx)
		runHandler(harness, "session_tree", { newLeafId: null }, ctx)
		const injected = contextMessages(harness) ?? []
		expect(messagesOfType(injected, TODO_NUDGE_TYPE).length).toBe(0)
		expect(messagesOfType(injected, TODO_CONTEXT_TYPE).length).toBe(1)
	})
})

describe("todo nudge interaction with todo_context", () => {
	test("no board: the first request carries only the nudge", () => {
		const harness = boot()
		armPrompt(harness, BULLET_LIST)
		const injected = contextMessages(harness) ?? []
		expect(injected.length).toBe(1)
		expect(injected[0].customType).toBe(TODO_NUDGE_TYPE)
		expect(injected[0].content).toContain("Consider initializing")
	})

	test("after todo init the next request has context but no nudge", async () => {
		const harness = boot()
		const { ctx } = createFakeCtx()
		armPrompt(harness, BULLET_LIST)
		const first = contextMessages(harness) ?? []
		expect(messagesOfType(first, TODO_NUDGE_TYPE).length).toBe(1)

		await runTool(harness, { op: "init", list: [{ phase: "P", items: ["one", "two"] }] }, ctx)
		const second = contextMessages(harness) ?? []
		expect(second.length).toBe(1)
		expect(second[0].customType).toBe(TODO_CONTEXT_TYPE)
	})

	test("existing board: reconcile nudge and context together, still compact", () => {
		const branch = [toolEntry({ op: "init", phases: sample() })]
		const harness = boot(branch)
		const { ctx } = createFakeCtx({ branch })
		runHandler(harness, "session_start", { reason: "resume" }, ctx)
		armPrompt(harness, BULLET_LIST)
		const injected = contextMessages(harness) ?? []
		const nudge = messagesOfType(injected, TODO_NUDGE_TYPE)[0]
		const context = messagesOfType(injected, TODO_CONTEXT_TYPE)[0]
		expect(nudge).toBeDefined()
		expect(context).toBeDefined()
		expect(nudge.content).toContain("Reconcile the current todo board")
		expect([...nudge.content].length).toBeLessThanOrEqual(TODO_NUDGE_MAX_CHARS)
		expect([...context.content].length).toBeLessThanOrEqual(TODO_CONTEXT_MAX_CHARS)
		expect([...nudge.content].length + [...context.content].length).toBeLessThanOrEqual(
			TODO_NUDGE_MAX_CHARS + TODO_CONTEXT_MAX_CHARS,
		)
		expect(nudge.content).not.toContain("Inspect current routing")
	})
})

// ================================================================ raw vs expanded prompt

const HUGE_EXPANDED = [
	"Implement the migration pipeline, update the renderer, document the fallback behavior.",
	"- add tests for every branch",
	"- refactor the parser",
	"- verify the release notes",
	`${"background context. ".repeat(120)}`,
].join("\n")

describe("todo nudge uses raw user input", () => {
	test("the expanded fixture is genuinely large and task-shaped", () => {
		expect(HUGE_EXPANDED.length).toBeGreaterThan(2000)
		expect(shouldSuggestTodo(HUGE_EXPANDED)).toBe(true)
	})

	test("tiny raw prompt with a huge expanded prompt does not nudge", () => {
		const harness = boot()
		runHandler(harness, "input", { source: "interactive", text: "fix this type error" })
		runHandler(harness, "before_agent_start", { prompt: HUGE_EXPANDED })
		expect(contextMessages(harness)).toBeUndefined()
	})

	test("complex raw prompt nudges even when the expanded text differs", () => {
		const harness = boot()
		const raw = "inspect the fallback logic, implement cooldown handling, add tests, run the checks, and update docs"
		runHandler(harness, "input", { source: "interactive", text: raw })
		runHandler(harness, "before_agent_start", { prompt: "Expanded differently: hello." })
		const injected = contextMessages(harness) ?? []
		expect(messagesOfType(injected, TODO_NUDGE_TYPE).length).toBe(1)
	})

	test("rpc input is scored from raw text too", () => {
		const harness = boot()
		const raw = "inspect the fallback logic, implement cooldown handling, add tests"
		runHandler(harness, "input", { source: "rpc", text: raw })
		runHandler(harness, "before_agent_start", { prompt: HUGE_EXPANDED })
		const injected = contextMessages(harness) ?? []
		expect(messagesOfType(injected, TODO_NUDGE_TYPE).length).toBe(1)
	})

	test("extension input with a task-shaped text never arms", () => {
		const harness = boot()
		runHandler(harness, "input", { source: "extension", text: HUGE_EXPANDED })
		runHandler(harness, "before_agent_start", { prompt: HUGE_EXPANDED })
		expect(contextMessages(harness)).toBeUndefined()
	})

	test("no stale carryover across consecutive prompts", () => {
		const harness = boot()
		// A simple prompt must not nudge even if expansion looks complex.
		runHandler(harness, "input", { source: "interactive", text: "fix this type error" })
		runHandler(harness, "before_agent_start", { prompt: HUGE_EXPANDED })
		expect(contextMessages(harness)).toBeUndefined()
		// A later complex prompt nudges exactly once.
		armPrompt(harness, BULLET_LIST)
		expect(messagesOfType(contextMessages(harness), TODO_NUDGE_TYPE).length).toBe(1)
		// A later simple prompt must not inherit the previous raw candidate.
		armPrompt(harness, "run the tests")
		expect(contextMessages(harness)).toBeUndefined()
	})

	test("session_start clears a pending raw prompt", () => {
		const harness = boot()
		const { ctx } = createFakeCtx()
		runHandler(harness, "input", { source: "interactive", text: BULLET_LIST })
		runHandler(harness, "session_start", { reason: "resume" }, ctx)
		runHandler(harness, "before_agent_start", { prompt: BULLET_LIST })
		expect(contextMessages(harness)).toBeUndefined()
	})

	test("agent_end clears a pending raw prompt", () => {
		const harness = boot()
		runHandler(harness, "input", { source: "interactive", text: BULLET_LIST })
		runHandler(harness, "agent_end")
		runHandler(harness, "before_agent_start", { prompt: BULLET_LIST })
		expect(contextMessages(harness)).toBeUndefined()
	})

	test("a consumed raw prompt is not reused by a second before_agent_start", () => {
		const harness = boot()
		runHandler(harness, "input", { source: "interactive", text: BULLET_LIST })
		runHandler(harness, "before_agent_start", { prompt: BULLET_LIST })
		expect(messagesOfType(contextMessages(harness), TODO_NUDGE_TYPE).length).toBe(1)
		// The raw candidate was consumed; a second arming pass must clear, not arm.
		runHandler(harness, "before_agent_start", { prompt: BULLET_LIST })
		expect(contextMessages(harness)).toBeUndefined()
	})

	test("session_start clears an armed nudge", () => {
		const harness = boot()
		const { ctx } = createFakeCtx()
		runHandler(harness, "input", { source: "interactive", text: BULLET_LIST })
		runHandler(harness, "before_agent_start", { prompt: BULLET_LIST })
		runHandler(harness, "session_start", { reason: "reload" }, ctx)
		expect(contextMessages(harness)).toBeUndefined()
	})
})
