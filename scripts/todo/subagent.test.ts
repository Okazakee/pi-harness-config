// Tests for the delegated-subagent gating in pi/extensions/todo.ts.
//
// Run via: scripts/test-todo.sh

import { describe, expect, test } from "bun:test"

import {
	isSubagentProcess,
	parseSubagentDepth,
} from "../../pi/extensions/todo"
import {
	boot,
} from "./harness"

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
