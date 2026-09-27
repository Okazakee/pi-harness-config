// Tests for the Laya delegation-advisor extension
// (pi/extensions/laya-routing.ts + pi/extensions/laya-routing/*).
//
// Run with:  bun test scripts/laya-routing.test.ts
// or via:    scripts/test-laya-routing.sh
//
// Everything is deterministic and offline: the classifier is a fake
// DecisionClient, config/telemetry are injected, and the only external
// process is the pinned Python bridge exercised in its deterministic
// `--selftest` / fake-response modes.

import { describe, expect, test } from "bun:test"

import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type { BridgeExec, BridgeRun } from "../pi/extensions/laya-routing/client"
import { createLayaProcessClient, parseBridgeOutput, validateDecisionPayload } from "../pi/extensions/laya-routing/client"
import { DEFAULT_CONFIG, parseConfig, saveConfig, defaultTelemetryPath, loadConfig } from "../pi/extensions/laya-routing/config"
import { explicitIntent } from "../pi/extensions/laya-routing/intent"
import { MAX_PROMPT_CHARS, PURPOSE_SCHEMA, buildHintMessage, isAdviceWorthy, sanitizePrompt, specialistFor } from "../pi/extensions/laya-routing/routing"
import { buildDecisionEvent, summarizeEvent } from "../pi/extensions/laya-routing/telemetry"
import type { DecisionClient, DecisionResult, RoutingDecision } from "../pi/extensions/laya-routing/types"
import { registerLayaRouting, isRepositorySession, isSubagentProcess, subagentAgents, withBudget } from "../pi/extensions/laya-routing"
import type { LayaRoutingConfig, LayaRoutingMode } from "../pi/extensions/laya-routing/config"

// ---------------------------------------------------------------- helpers

const BRIDGE_PATH = fileURLToPath(new URL("../pi/extensions/laya-routing/bridge.py", import.meta.url))

function decision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
	return {
		purpose: "local_context",
		answerConfidence: 0.91,
		confidence: 0.4,
		probabilities: { local_context: 0.91, none: 0.09 },
		classifier: { name: "laya", packageVersion: "0.3.20", model: "convaiinnovations/laya", revision: "55cf4c4e" },
		latencyMs: 42,
		...overrides,
	}
}

function okClient(result: DecisionResult, calls: string[] = []): DecisionClient {
	return {
		async decide(input) {
			calls.push(input.text)
			return result
		},
	}
}

interface FakePi {
	handlers: Map<string, Array<(...args: any[]) => any>>
	commands: Map<string, { description?: string; handler: (...args: any[]) => any }>
	on(event: string, handler: (...args: any[]) => any): void
	registerCommand(name: string, options: { description?: string; handler: (...args: any[]) => any }): void
}

function fakePi(): FakePi {
	const handlers = new Map<string, Array<(...args: any[]) => any>>()
	const commands = new Map<string, { description?: string; handler: (...args: any[]) => any }>()
	return {
		handlers,
		commands,
		on(event, handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler])
		},
		registerCommand(name, options) {
			commands.set(name, options)
		},
	}
}

function fire(pi: FakePi, event: string, payload: unknown, ctx: unknown = {}): any {
	const handlers = pi.handlers.get(event) ?? []
	return handlers.length > 0 ? handlers[0](payload, ctx) : undefined
}

interface HarnessOptions {
	mode?: LayaRoutingMode
	env?: Record<string, string | undefined>
	client?: DecisionClient
	threshold?: number
	budgetMs?: number
	configFile?: string
	probe?: () => Promise<{ available: boolean; compliant: boolean; packageVersion?: string; model?: string; revision?: string; cached?: boolean; reason?: string }>
}

function harness(options: HarnessOptions = {}) {
	const events: Array<Record<string, unknown>> = []
	const calls: string[] = []
	const pi = fakePi()
	const config: LayaRoutingConfig = {
		...DEFAULT_CONFIG,
		mode: options.mode ?? "shadow",
		confidenceThreshold: options.threshold ?? DEFAULT_CONFIG.confidenceThreshold,
		advisoryBudgetMs: options.budgetMs ?? DEFAULT_CONFIG.advisoryBudgetMs,
	}
	let idCounter = 0
	registerLayaRouting(pi as never, {
		env: options.env ?? {},
		configFile: options.configFile ?? join(tmpdir(), "laya-routing-unused.json"),
		telemetryFile: "/tmp/laya-routing.test.jsonl",
		loadConfig: () => ({ config, warnings: [], exists: true }),
		client: options.client ?? okClient({ ok: true, decision: decision() }, calls),
		appendEvent: (event) => events.push(event),
		probe: options.probe ?? (async () => ({ available: false, compliant: false, reason: "unavailable" })),
		newId: () => `event-${++idCounter}`,
		now: () => 1_800_000_000_000,
	})
	const settle = async () => {
		await fire(pi, "agent_settled", { type: "agent_settled" })
		await Bun.sleep(1)
	}
	return { pi, events, calls, config, settle }
}

const USER_MESSAGE = { role: "user", content: "hello" }

// ================================================================ intent

describe("explicit intent", () => {
	test("named specialists and subagents count as explicit delegation", () => {
		expect(explicitIntent("use the reviewer")).toBe("explicit_delegation")
		expect(explicitIntent("ask research to look it up")).toBe("explicit_delegation")
		expect(explicitIntent("spawn explore for this")).toBe("explicit_delegation")
		expect(explicitIntent("use architect for this")).toBe("explicit_delegation")
		expect(explicitIntent("delegate this to a subagent")).toBe("explicit_delegation")
		expect(explicitIntent("launch a subagent")).toBe("explicit_delegation")
	})
	test("no-delegation instructions win and are recognised conservatively", () => {
		expect(explicitIntent("don't use subagents")).toBe("explicit_no_delegation")
		expect(explicitIntent("do not spawn explore")).toBe("explicit_no_delegation")
		expect(explicitIntent("no subagents please")).toBe("explicit_no_delegation")
		expect(explicitIntent("without a reviewer")).toBe("explicit_no_delegation")
		expect(explicitIntent("don't use explore")).toBe("explicit_no_delegation")
	})
	test("ordinary prose is not treated as explicit intent", () => {
		expect(explicitIntent("review this PR")).toBeNull()
		expect(explicitIntent("research the docs later")).toBeNull()
		expect(explicitIntent("fix the failing test")).toBeNull()
		expect(explicitIntent("implement the change and update the docs")).toBeNull()
	})
})

// ================================================================ mapping

describe("purpose mapping", () => {
	test("maps purposes to specialists deterministically", () => {
		expect(specialistFor("none")).toBeNull()
		expect(specialistFor("local_context")).toBe("explore")
		expect(specialistFor("external_context")).toBe("research")
		expect(specialistFor("architecture")).toBe("architect")
	})
	test("the classifier schema uses purposes, not agent names", () => {
		const enumValues = PURPOSE_SCHEMA.properties.purpose.enum
		expect([...enumValues]).toEqual(["none", "local_context", "external_context", "architecture"])
		for (const specialist of ["explore", "research", "architect", "verify", "review"]) {
			expect(enumValues.includes(specialist as never)).toBe(false)
		}
	})
	test("advice only for non-none purposes above the confidence gate", () => {
		expect(isAdviceWorthy(decision({ purpose: "none", answerConfidence: 0.99 }), 0.8)).toBe(false)
		expect(isAdviceWorthy(decision({ purpose: "local_context", answerConfidence: 0.8 }), 0.8)).toBe(true)
		expect(isAdviceWorthy(decision({ purpose: "local_context", answerConfidence: 0.79 }), 0.8)).toBe(false)
	})
})

// ================================================================ hint

describe("hint message", () => {
	test("is compact, advisory and carries the deterministic mapping", () => {
		const message = buildHintMessage(decision(), "explore", 123)
		expect(message.role).toBe("custom")
		expect(message.customType).toBe("laya-routing-hint")
		expect(message.display).toBe(false)
		expect(message.content).toContain("<delegation_hint>")
		expect(message.content).toContain("purpose: local_context")
		expect(message.content).toContain("suggested_agent: explore")
		expect(message.content).toContain("confidence: 0.91")
		expect(message.content).toContain("advisory: true")
		expect(message.content).toContain("</delegation_hint>")
	})
})

// ================================================================ sanitize

describe("prompt hygiene", () => {
	test("collapses control characters and whitespace and bounds the size", () => {
		expect(sanitizePrompt("  a\u0000b\u001fc\n\nd  ")).toBe("a b c d")
		expect(sanitizePrompt("x".repeat(MAX_PROMPT_CHARS + 500)).length).toBe(MAX_PROMPT_CHARS)
	})
})

// ================================================================ config

describe("config parsing", () => {
	test("defaults to a shadow rollout", () => {
		const { config, warnings } = parseConfig(undefined)
		expect(config.mode).toBe("shadow")
		expect(config.confidenceThreshold).toBe(0.8)
		expect(warnings).toEqual([])
	})
	test("accepts a valid file and keeps valid fields when others are invalid", () => {
		const { config, warnings } = parseConfig({ mode: "advise", confidenceThreshold: 0.5, timeoutMs: 1000, advisoryBudgetMs: 0, python: "/usr/bin/python3" })
		expect(config).toEqual({ mode: "advise", confidenceThreshold: 0.5, timeoutMs: 1000, advisoryBudgetMs: 0, python: "/usr/bin/python3" })
		expect(warnings).toEqual([])

		const mixed = parseConfig({ mode: "turbo", confidenceThreshold: 2, timeoutMs: -1, advisoryBudgetMs: 1.5, python: "" })
		expect(mixed.config).toEqual(DEFAULT_CONFIG)
		expect(mixed.warnings.length).toBe(5)
	})
	test("env mode overrides the file and unknown env values warn", () => {
		const dir = mkdtempSync(join(tmpdir(), "laya-routing-"))
		try {
			const path = join(dir, "laya-routing.json")
			writeFileSync(path, JSON.stringify({ mode: "shadow", confidenceThreshold: 0.6 }))
			const overridden = loadConfig(path, { LAYA_ROUTING_MODE: "off" })
			expect(overridden.config.mode).toBe("off")
			expect(overridden.config.confidenceThreshold).toBe(0.6)
			expect(loadConfig(path, { LAYA_ROUTING_MODE: "nope" }).warnings.length).toBe(1)
			expect(loadConfig(join(dir, "missing.json"), {}).exists).toBe(false)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
	test("saveConfig round-trips and telemetry stays under XDG state", () => {
		const dir = mkdtempSync(join(tmpdir(), "laya-routing-"))
		try {
			const path = join(dir, "config", "laya-routing.json")
			saveConfig(path, { ...DEFAULT_CONFIG, mode: "advise" })
			expect(JSON.parse(readFileSync(path, "utf8")).mode).toBe("advise")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
		expect(defaultTelemetryPath({ XDG_STATE_HOME: "/state" }, "/home/u")).toBe("/state/pi/laya-routing/decisions.jsonl")
		expect(defaultTelemetryPath({}, "/home/u")).toBe("/home/u/.local/state/pi/laya-routing/decisions.jsonl")
	})
})

// ================================================================ parsing

describe("bridge response validation", () => {
	test("accepts a well-formed decision", () => {
		const result = validateDecisionPayload(
			{
				ok: true,
				purpose: "architecture",
				answer_confidence: 0.84,
				confidence: 0.31,
				probabilities: { architecture: 0.84 },
				package_version: "0.3.20",
				model: "m",
				revision: "r",
			},
			12,
		)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.decision.purpose).toBe("architecture")
			expect(result.decision.answerConfidence).toBe(0.84)
			expect(result.decision.latencyMs).toBe(12)
			expect(result.decision.classifier.packageVersion).toBe("0.3.20")
		}
	})
	test("rejects invalid enums and confidences", () => {
		expect(validateDecisionPayload({ ok: true, purpose: "explore", answer_confidence: 0.9 }, 1)).toMatchObject({ ok: false, reason: "invalid_enum" })
		expect(validateDecisionPayload({ ok: true, purpose: "none" }, 1)).toMatchObject({ ok: false, reason: "invalid_confidence" })
		expect(validateDecisionPayload({ ok: true, purpose: "none", answer_confidence: 1.5 }, 1)).toMatchObject({ ok: false, reason: "invalid_confidence" })
		expect(validateDecisionPayload({ ok: true, purpose: "none", answer_confidence: "0.5" }, 1)).toMatchObject({ ok: false, reason: "invalid_confidence" })
		expect(validateDecisionPayload(null, 1)).toMatchObject({ ok: false, reason: "malformed" })
	})
	test("maps bridge failures and transport failures", () => {
		const run = (overrides: Partial<BridgeRun>): BridgeRun => ({ stdout: "", stderr: "", code: 0, timedOut: false, ...overrides })
		expect(parseBridgeOutput(run({ stdout: JSON.stringify({ ok: false, error: "unavailable", detail: "not installed" }) }), 1)).toMatchObject({
			ok: false,
			reason: "unavailable",
		})
		expect(parseBridgeOutput(run({ stdout: JSON.stringify({ ok: false, error: "version_mismatch" }) }), 1)).toMatchObject({ ok: false, reason: "version_mismatch" })
		expect(parseBridgeOutput(run({ stdout: JSON.stringify({ ok: false, error: "wild" }) }), 1)).toMatchObject({ ok: false, reason: "malformed" })
		expect(parseBridgeOutput(run({ stdout: "not json" }), 1)).toMatchObject({ ok: false, reason: "malformed" })
		expect(parseBridgeOutput(run({ timedOut: true }), 1)).toMatchObject({ ok: false, reason: "timeout" })
		expect(parseBridgeOutput(run({ spawnError: "ENOENT" }), 1)).toMatchObject({ ok: false, reason: "spawn_error" })
	})
	test("client sends the purpose schema, sanitized text and configured runtime", async () => {
		let seen: { request: string; python: string; timeoutMs: number } | undefined
		const exec: BridgeExec = async (input) => {
			seen = { request: input.request, python: input.python, timeoutMs: input.timeoutMs }
			return { stdout: JSON.stringify({ ok: true, purpose: "external_context", answer_confidence: 0.9 }), stderr: "", code: 0, timedOut: false }
		}
		const client = createLayaProcessClient({
			bridgePath: "/bridge.py",
			config: () => ({ ...DEFAULT_CONFIG, python: "/venv/python", timeoutMs: 1234 }),
			exec,
			now: () => 10_000,
		})
		const result = await client.decide({ text: "plain prompt", repositorySession: true })
		expect(result.ok).toBe(true)
		const request = JSON.parse(seen?.request ?? "{}")
		expect(request.text).toBe("plain prompt")
		expect(request.schema.properties.purpose.enum).toEqual(["none", "local_context", "external_context", "architecture"])
		expect(JSON.stringify(request.schema)).not.toContain("explore")
		expect(seen?.python).toBe("/venv/python")
		expect(seen?.timeoutMs).toBe(1234)
	})
	test("client failures never throw", async () => {
		const exec: BridgeExec = async () => {
			throw new Error("boom")
		}
		const client = createLayaProcessClient({ bridgePath: "/bridge.py", config: () => DEFAULT_CONFIG, exec })
		expect(await client.decide({ text: "x", repositorySession: false })).toMatchObject({ ok: false, reason: "exception" })
	})
})

// ================================================================ telemetry

describe("telemetry privacy", () => {
	test("records only the documented fields and never prompt content", () => {
		const event = buildDecisionEvent({
			id: "e1",
			at: 1_800_000_000_000,
			mode: "shadow",
			repositorySession: true,
			threshold: 0.8,
			result: { ok: true, decision: decision() },
			injected: false,
			agents: ["explore"],
			delegated: true,
		})
		expect(Object.keys(event).sort()).toEqual(
			["actual", "bypass", "classifier", "event_id", "failure", "hint", "laya", "mode", "repository_session", "schema_version", "ts"].sort(),
		)
		const raw = JSON.stringify(event)
		expect(raw).not.toContain("/home/")
		expect(raw).not.toContain("prompt")
		expect(raw).not.toContain("content")
		expect(event.actual).toEqual({ delegated: true, agents: ["explore"] })
		expect(event.hint).toEqual({ threshold: 0.8, injected: false })
		expect(summarizeEvent(event)).toContain("purpose=local_context")
	})
	test("records bypass and failure without a classifier payload", () => {
		const bypass = buildDecisionEvent({ id: "e2", at: 0, mode: "advise", repositorySession: false, threshold: 0.8, bypass: "explicit_delegation", injected: false, agents: [], delegated: false })
		expect(bypass.classifier).toBeNull()
		expect(bypass.laya).toBeNull()
		expect(bypass.bypass).toBe("explicit_delegation")
		const failure = buildDecisionEvent({ id: "e3", at: 0, mode: "shadow", repositorySession: false, threshold: 0.8, result: { ok: false, reason: "timeout" }, injected: false, agents: [], delegated: false })
		expect(failure.failure).toBe("timeout")
		expect(failure.laya).toBeNull()
	})
})

// ================================================================ wiring

describe("registration boundary", () => {
	test("delegated sessions register nothing", () => {
		const pi = fakePi()
		registerLayaRouting(pi as never, { env: { PI_SUBAGENT_DEPTH: "1" } })
		expect(pi.handlers.size).toBe(0)
		expect(pi.commands.size).toBe(0)
		expect(isSubagentProcess({ PI_SUBAGENT_DEPTH: "2" })).toBe(true)
		expect(isSubagentProcess({ PI_SUBAGENT_DEPTH: "0" })).toBe(false)
		expect(isSubagentProcess({ PI_SUBAGENT_DEPTH: "nope" })).toBe(false)
	})
	test("root sessions register handlers and the command", () => {
		const { pi } = harness()
		expect(pi.handlers.has("input")).toBe(true)
		expect(pi.handlers.has("context")).toBe(true)
		expect(pi.handlers.has("tool_call")).toBe(true)
		expect(pi.handlers.has("agent_settled")).toBe(true)
		expect(pi.commands.has("laya-routing")).toBe(true)
	})
	test("detects a repository session from the session directory", () => {
		expect(isRepositorySession(process.cwd())).toBe(true)
		expect(isRepositorySession(tmpdir())).toBe(false)
	})
	test("extracts requested agents from a subagent tool call", () => {
		expect(subagentAgents({ calls: [{ agent: "explore" }, { agent: "review", prompt: "x" }] })).toEqual(["explore", "review"])
		expect(subagentAgents({ calls: "nope" })).toEqual([])
		expect(subagentAgents(null)).toEqual([])
	})
})

describe("modes", () => {
	test("off performs no classification and writes no telemetry", async () => {
		const { pi, calls, events, settle } = harness({ mode: "off" })
		await fire(pi, "input", { type: "input", text: "hello", source: "interactive" }, { cwd: "/tmp" })
		expect(await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })).toBeUndefined()
		await settle()
		expect(calls).toEqual([])
		expect(events).toEqual([])
	})
	test("shadow classifies but never injects", async () => {
		const { pi, calls, events, settle } = harness({ mode: "shadow" })
		await fire(pi, "input", { type: "input", text: "find where auth is handled", source: "interactive" }, { cwd: "/repo" })
		expect(await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })).toBeUndefined()
		await settle()
		expect(calls.length).toBe(1)
		expect(events.length).toBe(1)
		expect(events[0].mode).toBe("shadow")
		expect((events[0].hint as Record<string, unknown>).injected).toBe(false)
		expect(events[0].laya).toMatchObject({ purpose: "local_context", answer_confidence: 0.91 })
	})
	test("shadow records a valid low-confidence result", async () => {
		const client = okClient({ ok: true, decision: decision({ answerConfidence: 0.21 }) })
		const { pi, events, settle } = harness({ mode: "shadow", client })
		await fire(pi, "input", { type: "input", text: "maybe context helps", source: "interactive" }, { cwd: "/repo" })
		await settle()
		expect(events.length).toBe(1)
		expect(events[0].laya).toMatchObject({ purpose: "local_context", answer_confidence: 0.21 })
		expect((events[0].hint as Record<string, unknown>).injected).toBe(false)
	})
	test("advise injects a request-local hint above the threshold", async () => {
		const { pi, events, settle } = harness({ mode: "advise", threshold: 0.8 })
		await fire(pi, "input", { type: "input", text: "check the installed api behavior", source: "interactive" }, { cwd: "/repo" })
		const result = await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })
		expect(result.messages.length).toBe(2)
		expect(result.messages[1].customType).toBe("laya-routing-hint")
		expect(result.messages[1].display).toBe(false)
		expect(result.messages[1].content).toContain("suggested_agent: explore")
		// Second request in the same turn never repeats the hint.
		expect(await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })).toBeUndefined()
		await settle()
		expect((events[0].hint as Record<string, unknown>).injected).toBe(true)
	})
test("the status command reports the effective configuration", async () => {
		const { pi } = harness({ mode: "advise" })
		const notifications: Array<[string, string | undefined]> = []
		await pi.commands.get("laya-routing")?.handler("status", { ui: { notify: (message: string, type?: string) => notifications.push([message, type]) } })
		expect(notifications.length).toBe(1)
		expect(notifications[0][0]).toContain("mode=advise")
		expect(notifications[0][0]).toContain("telemetry:")
		expect(notifications[0][0]).toContain("last event:")
	})
	test("the mode command writes the config file and rejects unknown modes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "laya-routing-mode-"))
		try {
			const configFile = join(dir, "laya-routing.json")
			const { pi } = harness({ mode: "shadow", configFile })
			const notifications: string[] = []
			const ctx = { ui: { notify: (message: string) => notifications.push(message) } }
			await pi.commands.get("laya-routing")?.handler("mode turbo", ctx)
			expect(notifications[0]).toContain("usage: /laya-routing mode")
			await pi.commands.get("laya-routing")?.handler("mode advise", ctx)
			expect(notifications[1]).toContain("mode=advise")
			expect(JSON.parse(readFileSync(configFile, "utf8")).mode).toBe("advise")
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
	test("advise injects nothing below the threshold", async () => {
		const client = okClient({ ok: true, decision: decision({ answerConfidence: 0.42 }) })
		const { pi, events, settle } = harness({ mode: "advise", threshold: 0.8, client })
		await fire(pi, "input", { type: "input", text: "check the api", source: "interactive" }, { cwd: "/repo" })
		expect(await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })).toBeUndefined()
		await settle()
		expect((events[0].hint as Record<string, unknown>).injected).toBe(false)
	})
	test("advise injects nothing for a none purpose", async () => {
		const client = okClient({ ok: true, decision: decision({ purpose: "none", answerConfidence: 0.99 }) })
		const { pi } = harness({ mode: "advise", client })
		await fire(pi, "input", { type: "input", text: "just answer", source: "interactive" }, { cwd: "/repo" })
		expect(await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })).toBeUndefined()
	})
})

describe("explicit intent bypass", () => {
	test("named delegation skips the classifier and records the bypass", async () => {
		const { pi, calls, events, settle } = harness({ mode: "advise" })
		await fire(pi, "input", { type: "input", text: "use the reviewer on my diff", source: "interactive" }, { cwd: "/repo" })
		expect(await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })).toBeUndefined()
		expect(calls).toEqual([])
		await fire(pi, "tool_call", { type: "tool_call", toolName: "subagent", input: { calls: [{ agent: "review" }] } })
		await settle()
		expect(events[0].bypass).toBe("explicit_delegation")
		expect(events[0].actual).toEqual({ delegated: true, agents: ["review"] })
	})
	test("no-delegation instructions suppress advice", async () => {
		const { pi, calls, events, settle } = harness({ mode: "advise" })
		await fire(pi, "input", { type: "input", text: "don't use subagents, do it yourself", source: "interactive" }, { cwd: "/repo" })
		expect(await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })).toBeUndefined()
		expect(calls).toEqual([])
		await settle()
		expect(events[0].bypass).toBe("explicit_no_delegation")
		expect(events[0].actual).toEqual({ delegated: false, agents: [] })
	})
	test("extension-originated input is ignored", async () => {
		const { pi, calls } = harness({ mode: "advise" })
		await fire(pi, "input", { type: "input", text: "use architect", source: "extension" }, { cwd: "/repo" })
		expect(await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })).toBeUndefined()
		expect(calls).toEqual([])
	})
})

describe("fail-open", () => {
	test("a failed classification injects nothing and records the reason", async () => {
		for (const reason of ["timeout", "unavailable"] as const) {
			const client = okClient({ ok: false, reason })
			const { pi, events, settle } = harness({ mode: "advise", client })
			await fire(pi, "input", { type: "input", text: "anything", source: "interactive" }, { cwd: "/repo" })
			expect(await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })).toBeUndefined()
			await settle()
			expect(events[0].failure).toBe(reason)
		}
	})
	test("a client that throws never reaches the model", async () => {
		const client: DecisionClient = {
			async decide() {
				throw new Error("classifier exploded")
			},
		}
		const { pi, events, settle } = harness({ mode: "advise", client })
		await fire(pi, "input", { type: "input", text: "anything", source: "interactive" }, { cwd: "/repo" })
		expect(await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })).toBeUndefined()
		await settle()
		expect(events[0].failure).toBe("exception")
	})
	test("a slow classifier only ever delays the first request by the budget", async () => {
		let resolveDecision: (value: DecisionResult) => void = () => {}
		const pending = new Promise<DecisionResult>((resolve) => {
			resolveDecision = resolve
		})
		const client: DecisionClient = { decide: () => pending }
		const { pi, events, settle } = harness({ mode: "advise", client, budgetMs: 10 })
		await fire(pi, "input", { type: "input", text: "slow decision", source: "interactive" }, { cwd: "/repo" })

		const started = Date.now()
		const first = await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })
		expect(first).toBeUndefined()
		expect(Date.now() - started).toBeLessThan(1000)

		// A later request in the same turn picks up the completed decision.
		resolveDecision({ ok: true, decision: decision() })
		await Bun.sleep(1)
		const second = await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })
		expect(second.messages[1].content).toContain("suggested_agent: explore")
		await settle()
		expect((events[0].hint as Record<string, unknown>).injected).toBe(true)
	})
	test("withBudget resolves undefined on timeout and the value otherwise", async () => {
		expect(await withBudget(Promise.resolve(7), 50)).toBe(7)
		expect(await withBudget(new Promise<number>(() => {}), 5)).toBeUndefined()
	})
})

// ================================================================ bridge

describe("python bridge", () => {
	test("selftest passes deterministically", () => {
		const run = spawnSync("python3", [BRIDGE_PATH, "--selftest"], { encoding: "utf8", timeout: 30_000 })
		expect(run.status).toBe(0)
		expect(JSON.parse(run.stdout)).toEqual({ ok: true, checks: 5, failed: [] })
	})
	test("fake-response mode round-trips through the protocol parser", () => {
		const payload = { ok: true, purpose: "external_context", answer_confidence: 0.93, confidence: 0.5, probabilities: { external_context: 0.93 }, package_version: "0.3.20", model: "convaiinnovations/laya", revision: "55cf4c4e" }
		const run = spawnSync("python3", [BRIDGE_PATH], {
			input: JSON.stringify({ text: "look up the api docs", schema: PURPOSE_SCHEMA }),
			encoding: "utf8",
			timeout: 30_000,
			env: { ...process.env, LAYA_BRIDGE_TEST_FAKE_JSON: JSON.stringify(payload) },
		})
		expect(run.status).toBe(0)
		const parsed = parseBridgeOutput({ stdout: run.stdout, stderr: run.stderr, code: run.status, timedOut: false }, 5)
		expect(parsed.ok).toBe(true)
		if (parsed.ok) expect(parsed.decision.purpose).toBe("external_context")
	})
	test("malformed stdin and error payloads stay fail-open", () => {
		const malformed = spawnSync("python3", [BRIDGE_PATH], { input: "not json", encoding: "utf8", timeout: 30_000 })
		expect(parseBridgeOutput({ stdout: malformed.stdout, stderr: "", code: 0, timedOut: false }, 1)).toMatchObject({ ok: false, reason: "malformed" })

		const unavailable = spawnSync("python3", [BRIDGE_PATH], {
			input: JSON.stringify({ text: "x", schema: PURPOSE_SCHEMA }),
			encoding: "utf8",
			timeout: 30_000,
			env: { ...process.env, LAYA_BRIDGE_TEST_FAKE_JSON: JSON.stringify({ ok: false, error: "unavailable" }) },
		})
		expect(parseBridgeOutput({ stdout: unavailable.stdout, stderr: "", code: 0, timedOut: false }, 1)).toMatchObject({ ok: false, reason: "unavailable" })
	})
	test("probe reports a stable shape whether or not Laya is installed", () => {
		const run = spawnSync("python3", [BRIDGE_PATH, "--probe"], { encoding: "utf8", timeout: 60_000 })
		expect(run.status).toBe(0)
		const probe = JSON.parse(run.stdout)
		expect(typeof probe.available).toBe("boolean")
		expect(typeof probe.compliant).toBe("boolean")
		expect(typeof probe.model).toBe("string")
		expect(typeof probe.revision).toBe("string")
	})
})
