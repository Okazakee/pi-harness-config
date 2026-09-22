// Tests for the state-machine operations in pi/extensions/todo.ts.
//
// Run via: scripts/test-todo.sh

import { describe, expect, test } from "bun:test"

import {
	activeTask,
	applyTodoOperation,
	boardStats,
	cloneBoard,
	locatePhase,
	locateTask,
	normalizeBoard,
	type TodoPhase,
} from "../../pi/extensions/todo"
import {
	phase,
	sample,
} from "./harness"

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
