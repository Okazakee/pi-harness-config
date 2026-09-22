// Tests for the board normalisation, lookups and session reconstruction in pi/extensions/todo.ts.
//
// Run via: scripts/test-todo.sh

import { describe, expect, test } from "bun:test"

import {
	activeTask,
	applyTodoOperation,
	boardStats,
	labelKey,
	locateTask,
	normalizeBoard,
	normalizeLabel,
	parseBoardSnapshot,
	reconstructBoard,
	truncateLabel,
} from "../../pi/extensions/todo"
import {
	phase,
	sample,
	toolEntry,
	customEntry,
	otherEntry,
} from "./harness"

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
