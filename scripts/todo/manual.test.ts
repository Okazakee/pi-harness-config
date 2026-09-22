// Tests for the manual /todo command in pi/extensions/todo.ts.
//
// Run via: scripts/test-todo.sh

import { describe, expect, test } from "bun:test"

import {
	resolveTodoTarget,
	splitBlockTarget,
	TODO_ENTRY_TYPE,
	TODO_HELP,
	type TodoPhase,
} from "../../pi/extensions/todo"
import {
	sample,
	createFakeCtx,
	boot,
	runTool,
	runCommand,
} from "./harness"

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
