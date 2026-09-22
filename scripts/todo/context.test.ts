// Tests for the request-local todo_context injection in pi/extensions/todo.ts.
//
// Run via: scripts/test-todo.sh

import { describe, expect, test } from "bun:test"

import {
	applyTodoOperation,
	buildTodoContextMessage,
	formatTodoContext,
	normalizeBoard,
	TODO_CONTEXT_MAX_CHARS,
} from "../../pi/extensions/todo"
import {
	phase,
	sample,
	createFakeCtx,
	boot,
	runTool,
	runHandler,
} from "./harness"

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
