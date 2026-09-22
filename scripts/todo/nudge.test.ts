// Tests for the complex-prompt nudge heuristic and wiring in pi/extensions/todo.ts.
//
// Run via: scripts/test-todo.sh

import { describe, expect, test } from "bun:test"

import {
	analyzeListItems,
	applyTodoOperation,
	buildTodoNudgeMessage,
	countActionVerbs,
	formatTodoNudge,
	normalizeBoard,
	nudgeKindFor,
	shouldSuggestTodo,
	stripFencedBlocks,
	todoComplexityScore,
	TODO_CONTEXT_MAX_CHARS,
	TODO_CONTEXT_TYPE,
	TODO_NUDGE_MAX_CHARS,
	TODO_NUDGE_THRESHOLD,
	TODO_NUDGE_TYPE,
} from "../../pi/extensions/todo"
import {
	phase,
	sample,
	toolEntry,
	type FakeHarness,
	createFakeCtx,
	boot,
	runTool,
	runHandler,
} from "./harness"

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
