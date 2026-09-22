// Tests for the widget and tool-result presentation in pi/extensions/todo.ts.
//
// Run via: scripts/test-todo.sh

import { describe, expect, test } from "bun:test"

import {
	applyTodoOperation,
	describeToolCall,
	formatBoardStatus,
	formatFullView,
	formatWidgetLines,
	normalizeBoard,
	textComponent,
	textFromToolContent,
	type TodoPhase,
} from "../../pi/extensions/todo"
import {
	phase,
	sample,
} from "./harness"

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
