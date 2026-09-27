// Tests for the Laya delegation-advisor extension
// (pi/extensions/laya-routing.ts + pi/extensions/laya-routing/*).
//
// Run with:  bun test scripts/laya-routing.test.ts
// or via:    scripts/test-laya-routing.sh
//
// Pure modules run offline with fakes. The runtime lifecycle tests spawn the
// real daemon with its deterministic fake backend (no model, no network) and
// exercise the real Unix-socket transport: singleton race, multi-client
// sharing, language routing, grace shutdown, reconnect and crash recovery.

import { afterEach, describe, expect, test } from "bun:test"

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { createDaemonDecisionClient, mapDaemonError } from "../pi/extensions/laya-routing/client"
import { DEFAULT_CONFIG, defaultPythonPath, defaultTelemetryPath, loadConfig, parseConfig, saveConfig } from "../pi/extensions/laya-routing/config"
import type { LayaRoutingConfig, LayaRoutingMode } from "../pi/extensions/laya-routing/config"
import { explicitIntent, lowInformation } from "../pi/extensions/laya-routing/intent"
import { MAX_PROMPT_CHARS, PURPOSE_SCHEMA, buildHintMessage, isAdviceWorthy, sanitizePrompt, specialistFor } from "../pi/extensions/laya-routing/routing"
import { buildDecisionEvent, summarizeEvent } from "../pi/extensions/laya-routing/telemetry"
import { LayaDaemonTransport, resolveRuntimePaths, type ClassifyResult, type DaemonWelcome } from "../pi/extensions/laya-routing/transport"
import type { DecisionClient, DecisionResult, RoutingDecision } from "../pi/extensions/laya-routing/types"
import { isRepositorySession, isSubagentProcess, registerLayaRouting, subagentAgents, withBudget } from "../pi/extensions/laya-routing"

// ---------------------------------------------------------------- helpers

const DAEMON_PATH = fileURLToPath(new URL("../pi/extensions/laya-routing/daemon.py", import.meta.url))
const FIXTURE_PATH = fileURLToPath(new URL("./laya-routing-fixture.json", import.meta.url))
const PYTHON = process.env.LAYA_TEST_PYTHON ?? "python3"

const tempDirs: string[] = []
afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		// Kill any daemon the test left behind before removing its runtime dir.
		try {
			const pid = Number(readFileSync(join(dir, "laya.pid"), "utf8").trim())
			if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGKILL")
		} catch {
			// No pid file: nothing to kill.
		}
		rmSync(dir, { recursive: true, force: true })
	}
})

function tempRuntime(): string {
	const dir = mkdtempSync(join(tmpdir(), "laya-routing-test-"))
	tempDirs.push(dir)
	return dir
}

async function waitFor(predicate: () => boolean, timeoutMs = 6000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (predicate()) return true
		await Bun.sleep(25)
	}
	return predicate()
}

function daemonTransport(dir: string, options: { graceMs?: number; spawnCooldownMs?: number; connectTimeoutMs?: number } = {}) {
	const env = {
		LAYA_ROUTING_RUNTIME_DIR: dir,
		// Deterministic backend: no model download, no network, no Laya install.
		LAYA_ROUTING_TEST_BACKEND: "fake",
		LAYA_ROUTING_LANGUAGE_ROUTER: "heuristic",
	}
	return new LayaDaemonTransport({
		daemonPath: DAEMON_PATH,
		paths: resolveRuntimePaths({ ...process.env, ...env }),
		env,
		python: () => PYTHON,
		graceMs: () => options.graceMs ?? 400,
		connectTimeoutMs: options.connectTimeoutMs ?? 6000,
		spawnCooldownMs: options.spawnCooldownMs ?? 0,
	})
}

function spawnDaemon(dir: string, graceMs: number) {
	return spawn(PYTHON, [DAEMON_PATH, "--backend", "fake", "--language-router", "heuristic", "--grace-ms", String(graceMs)], {
		env: { ...process.env, LAYA_ROUTING_RUNTIME_DIR: dir },
		stdio: "ignore",
		detached: true,
	})
}

function decision(overrides: Partial<RoutingDecision> = {}): RoutingDecision {
	return {
		purpose: "local_context",
		answerConfidence: 0.91,
		confidence: 0.4,
		probabilities: { local_context: 0.91, none: 0.09 },
		language: "en",
		checkpoint: "english",
		daemonId: "daemon-1",
		transportMs: 3,
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

interface FakeTransport {
	ensureConnectedCalls: number
	closeCalls: number
	statusCalls: number
	transport: LayaDaemonTransport
}

function fakeTransport(): FakeTransport {
	const state = { ensureConnectedCalls: 0, closeCalls: 0, statusCalls: 0 }
	const transport = {
		welcome: undefined,
		connected: false,
		async ensureConnected() {
			state.ensureConnectedCalls += 1
			return undefined
		},
		close() {
			state.closeCalls += 1
		},
		async status() {
			state.statusCalls += 1
			return undefined
		},
		async classify(): Promise<ClassifyResult> {
			return { ok: false, error: "unavailable" }
		},
	} as unknown as LayaDaemonTransport
	return { ...state, transport, get ensureConnectedCalls() { return state.ensureConnectedCalls }, get closeCalls() { return state.closeCalls }, get statusCalls() { return state.statusCalls } }
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
}

function harness(options: HarnessOptions = {}) {
	const events: Array<Record<string, unknown>> = []
	const calls: string[] = []
	const pi = fakePi()
	const fake = fakeTransport()
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
		transport: fake.transport,
		appendEvent: (event) => events.push(event),
		newId: () => `event-${++idCounter}`,
		now: () => 1_800_000_000_000,
	})
	const settle = async () => {
		await fire(pi, "agent_settled", { type: "agent_settled" })
		await Bun.sleep(1)
	}
	return { pi, events, calls, config, transport: fake, settle }
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
	})
	test("no-delegation instructions win and are recognised conservatively", () => {
		expect(explicitIntent("don't use subagents")).toBe("explicit_no_delegation")
		expect(explicitIntent("do not spawn explore")).toBe("explicit_no_delegation")
		expect(explicitIntent("without a reviewer")).toBe("explicit_no_delegation")
		expect(explicitIntent("don't use explore")).toBe("explicit_no_delegation")
	})
	test("ordinary prose is not treated as explicit intent", () => {
		expect(explicitIntent("review this PR")).toBeNull()
		expect(explicitIntent("research the docs later")).toBeNull()
		expect(explicitIntent("fix the failing test")).toBeNull()
	})
	test("low-information continuations are detected without parsing prose", () => {
		for (const text of ["yes", "ok", "continue", "go ahead", "do it", "sure", "sì", "vai avanti", "fallo", "certo"]) {
			expect(lowInformation(text), text).toBe(true)
		}
		expect(lowInformation("fix the failing test")).toBe(false)
		expect(lowInformation("dove viene validato il token?")).toBe(false)
		expect(lowInformation("ok now implement the daemon lifecycle")).toBe(false)
		expect(lowInformation("please review the pull request carefully")).toBe(false)
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
	test("defaults to a shadow rollout with a five minute grace", () => {
		const { config, warnings } = parseConfig(undefined)
		expect(config.mode).toBe("shadow")
		expect(config.confidenceThreshold).toBe(0.8)
		expect(config.shutdownGraceMs).toBe(300_000)
		expect(warnings).toEqual([])
	})
	test("accepts a valid file and keeps valid fields when others are invalid", () => {
		const { config } = parseConfig({
			mode: "advise",
			confidenceThreshold: 0.5,
			timeoutMs: 1000,
			advisoryBudgetMs: 0,
			python: "/usr/bin/python3",
			shutdownGraceMs: 1_000,
		})
		expect(config).toEqual({ mode: "advise", confidenceThreshold: 0.5, timeoutMs: 1000, advisoryBudgetMs: 0, python: "/usr/bin/python3", shutdownGraceMs: 1_000 })

		const mixed = parseConfig({ mode: "turbo", confidenceThreshold: 2, timeoutMs: -1, advisoryBudgetMs: 1.5, python: "", shutdownGraceMs: -5 })
		expect(mixed.config).toEqual(DEFAULT_CONFIG)
		expect(mixed.warnings.length).toBe(6)
	})
	test("env mode overrides the file and unknown env values warn", () => {
		const dir = tempRuntime()
		const path = join(dir, "laya-routing.json")
		writeFileSync(path, JSON.stringify({ mode: "shadow", confidenceThreshold: 0.6 }))
		const overridden = loadConfig(path, { LAYA_ROUTING_MODE: "off" })
		expect(overridden.config.mode).toBe("off")
		expect(overridden.config.confidenceThreshold).toBe(0.6)
		expect(loadConfig(path, { LAYA_ROUTING_MODE: "nope" }).warnings.length).toBe(1)
		expect(loadConfig(join(dir, "missing.json"), {}).exists).toBe(false)
	})
	test("saveConfig round-trips and telemetry stays under XDG state", () => {
		const dir = tempRuntime()
		const path = join(dir, "config", "laya-routing.json")
		saveConfig(path, { ...DEFAULT_CONFIG, mode: "advise" })
		expect(JSON.parse(readFileSync(path, "utf8")).mode).toBe("advise")
		expect(defaultTelemetryPath({ XDG_STATE_HOME: "/state" }, "/home/u")).toBe("/state/pi/laya-routing/decisions.jsonl")
		expect(defaultTelemetryPath({}, "/home/u")).toBe("/home/u/.local/state/pi/laya-routing/decisions.jsonl")
	})
	test("derives the interpreter from XDG data home with a portable fallback", () => {
		expect(defaultPythonPath({ XDG_DATA_HOME: "/xdg/data" }, "/home/u")).toBe("/xdg/data/pi-laya/venv/bin/python")
		expect(defaultPythonPath({}, "/home/u")).toBe("/home/u/.local/share/pi-laya/venv/bin/python")
		expect(defaultPythonPath({ XDG_DATA_HOME: "  " }, "/home/u")).toBe("/home/u/.local/share/pi-laya/venv/bin/python")
		// The loader derives the default from the load environment, not the module env.
		expect(loadConfig(join(tempRuntime(), "missing.json"), { XDG_DATA_HOME: "/xdg/data" }).config.python).toBe("/xdg/data/pi-laya/venv/bin/python")
	})
	test("an explicit interpreter overrides the derived default", () => {
		const dir = tempRuntime()
		const path = join(dir, "laya-routing.json")
		writeFileSync(path, JSON.stringify({ mode: "shadow", python: "/opt/laya/python" }))
		expect(parseConfig({ python: "/opt/laya/python" }).config.python).toBe("/opt/laya/python")
		expect(loadConfig(path, { XDG_DATA_HOME: "/xdg/data" }).config.python).toBe("/opt/laya/python")
	})
	test("the tracked config stays portable (no machine-specific home path)", () => {
		const raw = readFileSync(new URL("../pi/laya-routing.json", import.meta.url), "utf8")
		expect(raw).not.toMatch(/\/home\//)
		expect(raw).not.toMatch(/\/Users\//)
		expect(Object.hasOwn(JSON.parse(raw), "python")).toBe(false)
	})
})

// ================================================================ transport paths

describe("runtime paths", () => {
	test("prefers the explicit override, then XDG runtime, then /tmp", () => {
		expect(resolveRuntimePaths({ LAYA_ROUTING_RUNTIME_DIR: "/custom/run" }).socket).toBe("/custom/run/laya.sock")
		expect(resolveRuntimePaths({ XDG_RUNTIME_DIR: "/run/user/42" }).socket).toBe("/run/user/42/pi-laya/laya.sock")
		expect(resolveRuntimePaths({}, "/home/u", 7).dir).toBe("/tmp/pi-laya-7")
	})
})

// ================================================================ daemon responses

describe("daemon decision client", () => {
	function stubTransport(result: ClassifyResult, welcome?: Partial<DaemonWelcome>): LayaDaemonTransport {
		return {
			welcome: welcome ? { protocol: 1, daemonId: "d1", pid: 1, state: "ready", graceMs: 300000, checkpoints: [], ...welcome } : undefined,
			connected: true,
			async classify() {
				return result
			},
			async ensureConnected() {
				return undefined
			},
			async status() {
				return undefined
			},
			close() {},
		} as unknown as LayaDaemonTransport
	}

	test("maps a daemon result onto a decision with runtime metadata", async () => {
		const transport = stubTransport(
			{ ok: true, purpose: "external_context", answerConfidence: 0.9, confidence: 0.4, language: "en", checkpoint: "english", latencyMs: 12 },
			{ daemonId: "d1", packageVersion: "0.3.20", repo: "convaiinnovations/laya", revision: "55cf4c4e" },
		)
		const client = createDaemonDecisionClient({ transport, config: () => DEFAULT_CONFIG, now: (() => { let t = 0; return () => (t += 5) })() })
		const result = await client.decide({ text: "look up the docs", repositorySession: true })
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.decision.purpose).toBe("external_context")
			expect(result.decision.language).toBe("en")
			expect(result.decision.checkpoint).toBe("english")
			expect(result.decision.daemonId).toBe("d1")
			expect(result.decision.classifier.packageVersion).toBe("0.3.20")
			expect(result.decision.latencyMs).toBe(12)
		}
	})
	test("rejects invalid enums and confidences even from a buggy daemon", async () => {
		const enumClient = createDaemonDecisionClient({
			transport: stubTransport({ ok: true, purpose: "explore", answerConfidence: 0.9, latencyMs: 1 }),
			config: () => DEFAULT_CONFIG,
		})
		expect(await enumClient.decide({ text: "x", repositorySession: false })).toMatchObject({ ok: false, reason: "invalid_enum" })
		const confidenceClient = createDaemonDecisionClient({
			transport: stubTransport({ ok: true, purpose: "none", answerConfidence: 2, latencyMs: 1 }),
			config: () => DEFAULT_CONFIG,
		})
		expect(await confidenceClient.decide({ text: "x", repositorySession: false })).toMatchObject({ ok: false, reason: "invalid_confidence" })
	})
	test("maps daemon errors onto fail-open reasons", () => {
		expect(mapDaemonError("loading")).toMatchObject({ ok: false, reason: "unavailable" })
		expect(mapDaemonError("degraded", "no model")).toMatchObject({ ok: false, reason: "unavailable", detail: "no model" })
		expect(mapDaemonError("version_mismatch")).toMatchObject({ ok: false, reason: "version_mismatch" })
		expect(mapDaemonError("timeout")).toMatchObject({ ok: false, reason: "timeout" })
		expect(mapDaemonError("daemon_disconnected")).toMatchObject({ ok: false, reason: "spawn_error" })
		expect(mapDaemonError("wild")).toMatchObject({ ok: false, reason: "malformed" })
	})
})

// ================================================================ telemetry

describe("telemetry privacy", () => {
	test("records only documented fields, including language and runtime reuse ids", () => {
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
			["actual", "bypass", "classifier", "event_id", "failure", "hint", "laya", "mode", "repository_session", "runtime", "schema_version", "ts"].sort(),
		)
		expect(event.schema_version).toBe(2)
		expect(event.runtime).toEqual({ daemon_id: "daemon-1" })
		expect(event.laya).toMatchObject({ language: "en", checkpoint: "english", transport_ms: 3 })
		const raw = JSON.stringify(event)
		expect(raw).not.toContain("/home/")
		expect(raw).not.toContain("prompt")
		expect(summarizeEvent(event)).toContain("language=en")
		expect(summarizeEvent(event)).toContain("checkpoint=english")
	})
	test("records bypass and failure without a classifier payload", () => {
		const bypass = buildDecisionEvent({ id: "e2", at: 0, mode: "advise", repositorySession: false, threshold: 0.8, bypass: "low_information", injected: false, agents: [], delegated: false })
		expect(bypass.classifier).toBeNull()
		expect(bypass.laya).toBeNull()
		expect(bypass.bypass).toBe("low_information")
		const failure = buildDecisionEvent({ id: "e3", at: 0, mode: "shadow", repositorySession: false, threshold: 0.8, result: { ok: false, reason: "timeout" }, injected: false, agents: [], delegated: false })
		expect(failure.failure).toBe("timeout")
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
	test("root sessions register handlers, the command and the lifecycle hooks", () => {
		const { pi } = harness()
		for (const event of ["input", "context", "tool_call", "agent_settled", "session_start", "session_shutdown"]) {
			expect(pi.handlers.has(event), event).toBe(true)
		}
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
	test("off performs no classification, writes no telemetry and never connects", async () => {
		const { pi, calls, events, transport, settle } = harness({ mode: "off" })
		await fire(pi, "session_start", { type: "session_start" }, {})
		await fire(pi, "input", { type: "input", text: "hello", source: "interactive" }, { cwd: "/tmp" })
		expect(await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })).toBeUndefined()
		await settle()
		expect(calls).toEqual([])
		expect(events).toEqual([])
		expect(transport.ensureConnectedCalls).toBe(0)
	})
	test("shadow connects and classifies but never injects", async () => {
		const { pi, calls, events, transport, settle } = harness({ mode: "shadow" })
		await fire(pi, "session_start", { type: "session_start" }, {})
		await fire(pi, "input", { type: "input", text: "find where auth is handled", source: "interactive" }, { cwd: "/repo" })
		expect(await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })).toBeUndefined()
		await settle()
		expect(transport.ensureConnectedCalls).toBe(1)
		expect(calls.length).toBe(1)
		expect(events.length).toBe(1)
		expect((events[0].hint as Record<string, unknown>).injected).toBe(false)
	})
	test("advise injects a request-local hint above the threshold", async () => {
		const { pi, events, settle } = harness({ mode: "advise", threshold: 0.8 })
		await fire(pi, "input", { type: "input", text: "check the installed api behavior", source: "interactive" }, { cwd: "/repo" })
		const result = await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })
		expect(result.messages.length).toBe(2)
		expect(result.messages[1].customType).toBe("laya-routing-hint")
		expect(result.messages[1].content).toContain("suggested_agent: explore")
		expect(await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })).toBeUndefined()
		await settle()
		expect((events[0].hint as Record<string, unknown>).injected).toBe(true)
	})
	test("advise injects nothing below the threshold or for none", async () => {
		const low = harness({ mode: "advise", threshold: 0.8, client: okClient({ ok: true, decision: decision({ answerConfidence: 0.42 }) }) })
		await fire(low.pi, "input", { type: "input", text: "check the api", source: "interactive" }, { cwd: "/repo" })
		expect(await fire(low.pi, "context", { type: "context", messages: [USER_MESSAGE] })).toBeUndefined()
		await low.settle()
		expect((low.events[0].hint as Record<string, unknown>).injected).toBe(false)

		const none = harness({ mode: "advise", client: okClient({ ok: true, decision: decision({ purpose: "none", answerConfidence: 0.99 }) }) })
		await fire(none.pi, "input", { type: "input", text: "just answer", source: "interactive" }, { cwd: "/repo" })
		expect(await fire(none.pi, "context", { type: "context", messages: [USER_MESSAGE] })).toBeUndefined()
	})
	test("session_shutdown closes the connection idempotently", async () => {
		const { pi, transport } = harness({ mode: "shadow" })
		await fire(pi, "session_shutdown", { type: "session_shutdown", reason: "quit" })
		await fire(pi, "session_shutdown", { type: "session_shutdown", reason: "quit" })
		expect(transport.closeCalls).toBe(2)
	})
})

describe("explicit intent and continuation bypass", () => {
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
	})
	test("low-information continuations skip inference entirely", async () => {
		const { pi, calls, events, settle } = harness({ mode: "advise" })
		await fire(pi, "input", { type: "input", text: "continue", source: "interactive" }, { cwd: "/repo" })
		expect(await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })).toBeUndefined()
		expect(calls).toEqual([])
		await settle()
		expect(events[0].bypass).toBe("low_information")
	})
	test("extension-originated input is ignored", async () => {
		const { pi, calls } = harness({ mode: "advise" })
		await fire(pi, "input", { type: "input", text: "use architect", source: "extension" }, { cwd: "/repo" })
		expect(calls).toEqual([])
	})
})

describe("fail-open", () => {
	test("a failed classification injects nothing and records the reason", async () => {
		for (const reason of ["timeout", "unavailable", "version_mismatch"] as const) {
			const client = okClient({ ok: false, reason })
			const { pi, events, settle } = harness({ mode: "advise", client })
			await fire(pi, "input", { type: "input", text: "anything", source: "interactive" }, { cwd: "/repo" })
			expect(await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })).toBeUndefined()
			await settle()
			expect(events[0].failure).toBe(reason)
		}
	})
	test("a classifier that throws never reaches the model", async () => {
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
		expect(await fire(pi, "context", { type: "context", messages: [USER_MESSAGE] })).toBeUndefined()
		expect(Date.now() - started).toBeLessThan(1000)

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

describe("status command", () => {
	test("off status never touches the transport and cannot start the daemon", async () => {
		const { pi, transport } = harness({ mode: "off" })
		const notifications: string[] = []
		await pi.commands.get("laya-routing")?.handler("status", { ui: { notify: (message: string) => notifications.push(message) } })
		expect(notifications[0]).toContain("mode=off")
		expect(notifications[0]).toContain("not connected (mode=off)")
		expect(transport.ensureConnectedCalls).toBe(0)
		expect(transport.statusCalls).toBe(0)
	})
	test("status in shadow mode may inspect the daemon", async () => {
		const { pi, transport } = harness({ mode: "shadow" })
		await pi.commands.get("laya-routing")?.handler("status", { ui: { notify: () => {} } })
		expect(transport.statusCalls).toBe(1)
	})
	test("reports mode, daemon state and telemetry", async () => {
		const { pi } = harness({ mode: "advise" })
		const notifications: string[] = []
		await pi.commands.get("laya-routing")?.handler("status", { ui: { notify: (message: string) => notifications.push(message) } })
		expect(notifications[0]).toContain("mode=advise")
		expect(notifications[0]).toContain("daemon:")
		expect(notifications[0]).toContain("telemetry:")
	})
	test("mode command writes the file and toggles the connection", async () => {
		const dir = tempRuntime()
		const configFile = join(dir, "laya-routing.json")
		const { pi, transport } = harness({ mode: "shadow", configFile })
		const notifications: string[] = []
		const ctx = { ui: { notify: (message: string) => notifications.push(message) } }
		await pi.commands.get("laya-routing")?.handler("mode turbo", ctx)
		expect(notifications[0]).toContain("usage: /laya-routing mode")
		await pi.commands.get("laya-routing")?.handler("mode off", ctx)
		expect(JSON.parse(readFileSync(configFile, "utf8")).mode).toBe("off")
		expect(transport.closeCalls).toBe(1)
		await pi.commands.get("laya-routing")?.handler("mode shadow", ctx)
		expect(transport.ensureConnectedCalls).toBeGreaterThan(0)
	})
})

// ================================================================ python bridge/daemon

describe("python daemon", () => {
	test("selftest passes deterministically", () => {
		const run = spawnSync(PYTHON, [DAEMON_PATH, "--selftest"], { encoding: "utf8", timeout: 30_000 })
		expect(run.status).toBe(0)
		const payload = JSON.parse(run.stdout)
		expect(payload.ok).toBe(true)
		expect(payload.failed).toEqual([])
		expect(payload.checks).toBeGreaterThanOrEqual(13)
	})
})

// ================================================================ daemon integration

describe("daemon lifecycle (real process, fake backend)", () => {
	test("one daemon serves multiple clients, then exits after the last disconnect", async () => {
		const dir = tempRuntime()
		const graceMs = 400
		const first = daemonTransport(dir, { graceMs })
		const welcome = await first.ensureConnected()
		expect(welcome?.state).toBe("ready")
		expect(welcome?.checkpoints.map((checkpoint) => checkpoint.id)).toEqual(["english", "multilingual"])
		expect(welcome?.packageVersion).toBe("0.3.20")

		const second = daemonTransport(dir, { graceMs })
		const secondWelcome = await second.ensureConnected()
		expect(secondWelcome?.daemonId).toBe(welcome?.daemonId)

		const status = await first.status(3_000)
		expect(status?.clientCount).toBe(2)
		expect(status?.daemonId).toBe(welcome?.daemonId)

		first.close()
		await Bun.sleep(150)
		const afterOne = await second.status(3_000)
		expect(afterOne?.clientCount).toBe(1)
		expect(afterOne?.grace.pending).toBe(false)

		second.close()
		const exited = await waitFor(() => !existsSync(join(dir, "laya.sock")), 4000)
		expect(exited).toBe(true)
	})

	test("a reconnect inside the grace window cancels the shutdown", async () => {
		const dir = tempRuntime()
		const graceMs = 600
		const first = daemonTransport(dir, { graceMs })
		const welcome = await first.ensureConnected()
		first.close()

		// Wait most of the grace, then reconnect: the daemon must still be the same.
		await Bun.sleep(250)
		const second = daemonTransport(dir, { graceMs })
		const secondWelcome = await second.ensureConnected()
		expect(secondWelcome?.daemonId).toBe(welcome?.daemonId)
		await Bun.sleep(graceMs + 200)
		const status = await second.status(3_000)
		expect(status?.daemonId).toBe(welcome?.daemonId)
		expect(status?.clientCount).toBe(1)
		second.close()
	})

	test("startup race leaves exactly one daemon", async () => {
		const dir = tempRuntime()
		const children = [spawnDaemon(dir, 5_000), spawnDaemon(dir, 5_000), spawnDaemon(dir, 5_000)]
		await waitFor(() => existsSync(join(dir, "laya.sock")), 5_000)
		await Bun.sleep(500)
		const alive = children.filter((child) => child.exitCode === null && child.signalCode === null)
		expect(alive.length).toBe(1)

		const transport = daemonTransport(dir, { graceMs: 400 })
		const welcome = await transport.ensureConnected()
		expect(welcome?.pid).toBe(alive[0].pid)
		const status = await transport.status(3_000)
		expect(status?.clientCount).toBe(1)
		transport.close()
	})

	test("language routing picks the English and Italian checkpoints, defaulting to English", async () => {
		const dir = tempRuntime()
		const transport = daemonTransport(dir, { graceMs: 400 })
		const english = await transport.classify("please scan LOCAL repository files", PURPOSE_SCHEMA, 5_000)
		expect(english).toMatchObject({ ok: true, checkpoint: "english", purpose: "local_context" })
		const italian = await transport.classify("Dove viene validato il token di questo repository? ARCH", PURPOSE_SCHEMA, 5_000)
		expect(italian).toMatchObject({ ok: true, checkpoint: "multilingual", language: "it" })
		const uncertain = await transport.classify("EXTERNAL lookup", PURPOSE_SCHEMA, 5_000)
		expect(uncertain).toMatchObject({ ok: true, checkpoint: "english", purpose: "external_context" })
		transport.close()
	})

	test("a daemon crash is recovered on the next classification", async () => {
		const dir = tempRuntime()
		const transport = daemonTransport(dir, { graceMs: 400 })
		const welcome = await transport.ensureConnected()
		const pid = welcome?.pid ?? 0
		process.kill(pid, "SIGKILL")
		await Bun.sleep(150)

		// The transport must reconnect on demand and never throw; the restarted
		// daemon has a new pid but the same runtime contract.
		const recovered = await transport.classify("LOCAL scan", PURPOSE_SCHEMA, 8_000)
		expect(recovered).toMatchObject({ ok: true, purpose: "local_context" })
		const status = await transport.status(3_000)
		expect(status?.pid).not.toBe(pid)
		expect(status?.clientCount).toBe(1)
		transport.close()
	})

	test("an unavailable runtime fails open without looping", async () => {
		const dir = tempRuntime()
		const env = { LAYA_ROUTING_RUNTIME_DIR: dir }
		// A spawn failure (no interpreter) and a runtime that starts but never
		// listens must both fail open within the connect budget, without throwin
		// or retrying forever.
		const brokenSpawn = new LayaDaemonTransport({
			daemonPath: DAEMON_PATH,
			paths: resolveRuntimePaths({ ...process.env, ...env }),
			env,
			python: () => PYTHON,
			spawnImpl: () => {
				throw new Error("spawn failed")
			},
			graceMs: () => 400,
			connectTimeoutMs: 400,
			spawnCooldownMs: 0,
		})
		const started = Date.now()
		expect(await brokenSpawn.classify("LOCAL scan", PURPOSE_SCHEMA, 2_000)).toMatchObject({ ok: false })
		expect(await brokenSpawn.status(1_000)).toBeUndefined()
		expect(Date.now() - started).toBeLessThan(3_000)

		const deadRuntime = new LayaDaemonTransport({
			daemonPath: DAEMON_PATH,
			paths: resolveRuntimePaths({ ...process.env, ...env }),
			env,
			python: () => "/bin/false",
			graceMs: () => 400,
			connectTimeoutMs: 400,
			spawnCooldownMs: 0,
		})
		expect(await deadRuntime.classify("LOCAL scan", PURPOSE_SCHEMA, 2_000)).toMatchObject({ ok: false })
	})

	test("model reuse: consecutive decisions share one daemon instance and loaded state", async () => {
		const dir = tempRuntime()
		const transport = daemonTransport(dir, { graceMs: 400 })
		const welcome = await transport.ensureConnected()
		const daemonIds = new Set<string>()
		for (let index = 0; index < 5; index += 1) {
			const result = await transport.classify("LOCAL scan", PURPOSE_SCHEMA, 5_000)
			expect(result.ok).toBe(true)
			const status = await transport.status(3_000)
			expect(status?.daemonId).toBe(welcome?.daemonId)
			daemonIds.add(status?.daemonId ?? "")
		}
		expect(daemonIds.size).toBe(1)
		const status = await transport.status(3_000)
		expect(status?.uptimeMs).toBeGreaterThan(0)
		transport.close()
	})
})

// ================================================================ fixture

describe("evaluation fixture", () => {
	test("is a complete, synthetic EN/IT taxonomy fixture", () => {
		const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"))
		expect(fixture.schema).toBe(1)
		expect(Object.keys(fixture.categories).sort()).toEqual(["architecture", "direct", "external_context", "local_context", "low_information"])
		const items = fixture.items as Array<{ id: string; lang: string; category: string; expect: string; text: string }>
		expect(items.length).toBeGreaterThanOrEqual(40)
		for (const item of items) {
			expect(item.text.trim().length).toBeGreaterThan(0)
			expect(["en", "it"]).toContain(item.lang)
			expect(Object.keys(fixture.categories)).toContain(item.category)
		}
		const expectedPurpose: Record<string, string> = {
			direct: "none",
			local_context: "local_context",
			external_context: "external_context",
			architecture: "architecture",
			low_information: "bypass",
		}
		for (const item of items) {
			expect(item.expect).toBe(expectedPurpose[item.category])
		}
		// Every classified category exists in both languages.
		for (const category of ["direct", "local_context", "external_context", "architecture"]) {
			expect(items.some((item) => item.category === category && item.lang === "en")).toBe(true)
			expect(items.some((item) => item.category === category && item.lang === "it")).toBe(true)
		}
	})
})
