// Tests for the statusline provider-usage module (pi/extensions/statusline/usage.ts).
//
// Run with:  bun test scripts/statusline.test.ts
// or via:    scripts/test-statusline.sh
//
// The module is pure (or takes an injectable fetch), so everything below is
// deterministic and offline: no Pi runtime, no network, no node_modules.

import { describe, expect, test } from "bun:test"

import { existsSync } from "node:fs"

import {
	COMMANDCODE_CREDITS_URL,
	COMMANDCODE_TIER,
	ICON_USAGE,
	OPENAI_CODEX_USAGE_URL,
	OPENCODE_GO_TIER,
	codexAccountId,
	fetchCodexUsage,
	fetchCommandCodeUsage,
	fetchOpencodeGoUsage,
	formatReset,
	isUsageProvider,
	parseCodexUsage,
	parseCommandCodeUsage,
	parseOpencodeGoUsage,
	planTypeDisplay,
	readCodexWindow,
	readCommandCodeWindow,
	readWindow,
	renderUsage,
	windowLabel,
	type UsageSnapshot,
} from "../pi/extensions/statusline/usage"

// ---------------------------------------------------------------- helpers

/** base64url JWT with an arbitrary payload (no signature verification here). */
function jwt(payload: unknown): string {
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
	return `${encode({ alg: "none" })}.${encode(payload)}.sig`
}

const ACCOUNT_CLAIM = "https://api.openai.com/auth"

interface FetchCall {
	url: string
	init?: RequestInit
}

function fakeFetch(body: unknown, ok = true): { impl: typeof fetch; calls: FetchCall[] } {
	const calls: FetchCall[] = []
	const impl = (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init })
		return { ok, status: ok ? 200 : 401, json: async () => body } as Response
	}) as typeof fetch
	return { impl, calls }
}

interface RecordedTheme {
	theme: never
	calls: Array<[string, string]>
}

function recordingTheme(): RecordedTheme {
	const calls: Array<[string, string]> = []
	const theme = {
		fg(color: string, text: string) {
			calls.push([color, text])
			return text
		},
	}
	return { theme: theme as never, calls }
}

/** Run `body` with Date.now pinned so reset countdowns are deterministic. */
function withFixedNow<T>(nowMs: number, body: () => T): T {
	const original = Date.now
	Date.now = () => nowMs
	try {
		return body()
	} finally {
		Date.now = original
	}
}

const NOW = Date.parse("2026-01-01T00:00:00.000Z")
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

// ================================================================ window labels

describe("windowLabel", () => {
	test("maps the known Codex window lengths", () => {
		expect(windowLabel(18_000)).toBe("5h")
		expect(windowLabel(86_400)).toBe("1d")
		expect(windowLabel(604_800)).toBe("7d")
		expect(windowLabel(2_592_000)).toBe("mo")
		expect(windowLabel(31_536_000)).toBe("1y")
	})
	test("tolerates the ±5% window drift the backend reports", () => {
		expect(windowLabel(17_500)).toBe("5h")
		expect(windowLabel(18_400)).toBe("5h")
	})
	test("falls back to the nearest whole hour, day or month", () => {
		expect(windowLabel(900)).toBe("1h")
		expect(windowLabel(43_200)).toBe("12h")
		expect(windowLabel(259_200)).toBe("3d")
		expect(windowLabel(7_776_000)).toBe("3mo")
	})
	test("rejects non-positive and non-finite lengths", () => {
		expect(windowLabel(0)).toBeUndefined()
		expect(windowLabel(-60)).toBeUndefined()
		expect(windowLabel(Number.NaN)).toBeUndefined()
		expect(windowLabel(Number.POSITIVE_INFINITY)).toBeUndefined()
	})
})

// ================================================================ plan labels

describe("planTypeDisplay", () => {
	test("uses the documented display remaps", () => {
		expect(planTypeDisplay("team")).toBe("Business")
		expect(planTypeDisplay("business")).toBe("Enterprise")
		expect(planTypeDisplay("prolite")).toBe("Pro Lite")
		expect(planTypeDisplay("self_serve_business_prolite")).toBe("Business Premium")
		expect(planTypeDisplay("enterprise_cbp_automation")).toBe("Enterprise (Automation)")
		expect(planTypeDisplay("edu_pro")).toBe("Edu Pro")
	})
	test("title-cases unknown values", () => {
		expect(planTypeDisplay("plus")).toBe("Plus")
		expect(planTypeDisplay("free_workspace")).toBe("Free Workspace")
	})
	test("hides missing and unknown plans", () => {
		expect(planTypeDisplay(undefined)).toBeUndefined()
		expect(planTypeDisplay("")).toBeUndefined()
		expect(planTypeDisplay("unknown")).toBeUndefined()
		expect(planTypeDisplay(42)).toBeUndefined()
	})
})

// ================================================================ credentials

describe("codexAccountId", () => {
	test("reads the chatgpt_account_id claim", () => {
		const token = jwt({ [ACCOUNT_CLAIM]: { chatgpt_account_id: "workspace-123" } })
		expect(codexAccountId(token)).toBe("workspace-123")
	})
	test("rejects tokens without the claim", () => {
		expect(codexAccountId(jwt({ sub: "user" }))).toBeUndefined()
		expect(codexAccountId(jwt({ [ACCOUNT_CLAIM]: {} }))).toBeUndefined()
		expect(codexAccountId(jwt({ [ACCOUNT_CLAIM]: { chatgpt_account_id: "" } }))).toBeUndefined()
	})
	test("rejects malformed tokens without throwing", () => {
		expect(codexAccountId("not-a-jwt")).toBeUndefined()
		expect(codexAccountId("a.!!!.c")).toBeUndefined()
		expect(codexAccountId("")).toBeUndefined()
	})
})

describe("isUsageProvider", () => {
	test("accepts exactly the rendered providers", () => {
		expect(isUsageProvider("opencode-go")).toBe(true)
		expect(isUsageProvider("openai-codex")).toBe(true)
		expect(isUsageProvider("commandcode")).toBe(true)
		expect(isUsageProvider("openai")).toBe(false)
		expect(isUsageProvider(undefined)).toBe(false)
	})
})

// ================================================================ OpenCode Go

describe("parseOpencodeGoUsage", () => {
	test("maps rolling/weekly/monthly onto 5h/7d/mo", () => {
		const snapshot = parseOpencodeGoUsage({
			usage: {
				rolling: { percent: 12.6, resetsAt: iso(3 * 3_600_000), status: "ok" },
				weekly: { percent: 36, resetsAt: iso(5 * 86_400_000) },
				monthly: { percent: 65.9, resetsAt: iso(16 * 86_400_000) },
			},
		})
		expect(snapshot?.tier).toBe(OPENCODE_GO_TIER)
		expect(snapshot?.windows.map((entry) => [entry.label, entry.unit, entry.floor])).toEqual([
			["5h", "m", false],
			["7d", "h", false],
			["mo", "h", true],
		])
		expect(snapshot?.windows[0].window.percent).toBe(12.6)
		expect(snapshot?.windows[1].window.status).toBe("ok")
	})
	test("skips malformed windows and rejects an empty payload", () => {
		const partial = parseOpencodeGoUsage({
			usage: {
				rolling: { percent: 500, resetsAt: iso(0) },
				weekly: { percent: 10, resetsAt: "not-a-date" },
				monthly: { percent: 10, resetsAt: iso(0) },
			},
		})
		expect(partial?.windows.map((entry) => entry.label)).toEqual(["mo"])
		expect(parseOpencodeGoUsage({ usage: {} })).toBeUndefined()
		expect(parseOpencodeGoUsage({})).toBeUndefined()
		expect(parseOpencodeGoUsage(null)).toBeUndefined()
	})
})

describe("readWindow", () => {
	test("validates percent bounds and the reset timestamp", () => {
		expect(readWindow({ percent: 0, resetsAt: iso(0) })).toEqual({ percent: 0, resetsAt: iso(0), status: "ok" })
		expect(readWindow({ percent: -1, resetsAt: iso(0) })).toBeUndefined()
		expect(readWindow({ percent: 101, resetsAt: iso(0) })).toBeUndefined()
		expect(readWindow({ percent: 5, resetsAt: "nope" })).toBeUndefined()
		expect(readWindow({ percent: "5", resetsAt: iso(0) })).toBeUndefined()
		expect(readWindow(undefined)).toBeUndefined()
	})
})

describe("fetchOpencodeGoUsage", () => {
	test("normalizes the base URL and sends the bearer credential", async () => {
		const { impl, calls } = fakeFetch({ usage: { rolling: { percent: 1, resetsAt: iso(0) } } })
		await fetchOpencodeGoUsage("secret-key", "https://opencode.ai/zen/go/v1/", { fetchImpl: impl, timeoutMs: 50 })
		expect(calls[0].url).toBe("https://opencode.ai/zen/go/v1/usage")
		expect(calls[0].init?.headers).toEqual({
			accept: "application/json",
			authorization: "Bearer secret-key",
		})
	})
	test("falls back to the documented base URL", async () => {
		const { impl, calls } = fakeFetch({})
		await fetchOpencodeGoUsage("secret-key", undefined, { fetchImpl: impl, timeoutMs: 50 })
		expect(calls[0].url).toBe("https://opencode.ai/zen/go/v1/usage")
	})
	test("hides the segment on a non-OK response", async () => {
		const { impl } = fakeFetch({}, false)
		expect(await fetchOpencodeGoUsage("secret-key", undefined, { fetchImpl: impl, timeoutMs: 50 })).toBeUndefined()
	})
})

// ================================================================ OpenAI Codex

describe("readCodexWindow", () => {
	test("converts epoch reset seconds to an ISO timestamp", () => {
		const window = readCodexWindow({ used_percent: 42, limit_window_seconds: 18_000, reset_at: NOW / 1000 })
		expect(window).toEqual({ percent: 42, seconds: 18_000, resetsAt: iso(0), status: "ok" })
	})
	test("keeps a window whose reset timestamp is missing", () => {
		const window = readCodexWindow({ used_percent: 42, limit_window_seconds: 18_000 })
		expect(window?.resetsAt).toBeUndefined()
	})
	test("rejects unusable windows", () => {
		expect(readCodexWindow({ used_percent: 101, limit_window_seconds: 18_000 })).toBeUndefined()
		expect(readCodexWindow({ used_percent: 10, limit_window_seconds: 0 })).toBeUndefined()
		expect(readCodexWindow({ used_percent: 10 })).toBeUndefined()
		expect(readCodexWindow(undefined)).toBeUndefined()
	})
})

describe("parseCodexUsage", () => {
	const payload = {
		plan_type: "plus",
		rate_limit: {
			allowed: true,
			primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: NOW / 1000 + 3_600 },
			secondary_window: { used_percent: 84, limit_window_seconds: 604_800, reset_at: NOW / 1000 + 86_400 },
		},
	}
	test("maps primary/secondary onto the footer's window vocabulary", () => {
		const snapshot = parseCodexUsage(payload)
		expect(snapshot?.tier).toBe("Plus")
		expect(snapshot?.windows.map((entry) => [entry.label, entry.unit, entry.floor, entry.window.percent])).toEqual([
			["5h", "m", false, 42],
			["7d", "h", false, 84],
		])
	})
	test("requires at least one usable window", () => {
		expect(parseCodexUsage({ plan_type: "plus", rate_limit: {} })).toBeUndefined()
		expect(parseCodexUsage({ plan_type: "plus" })).toBeUndefined()
		expect(parseCodexUsage(null)).toBeUndefined()
	})
	test("falls back to the generic tier for an unknown plan", () => {
		expect(parseCodexUsage({ ...payload, plan_type: "unknown" })?.tier).toBe("OpenAI Codex")
	})
})

describe("fetchCodexUsage", () => {
	test("pins the ChatGPT origin, refuses redirects and sends both credentials", async () => {
		const token = jwt({ [ACCOUNT_CLAIM]: { chatgpt_account_id: "workspace-123" } })
		const { impl, calls } = fakeFetch({ plan_type: "plus", rate_limit: {} })
		await fetchCodexUsage(token, { fetchImpl: impl, timeoutMs: 50 })
		expect(calls[0].url).toBe(OPENAI_CODEX_USAGE_URL)
		expect(calls[0].url.startsWith("https://chatgpt.com/backend-api/")).toBe(true)
		expect(calls[0].init?.headers).toEqual({
			accept: "application/json",
			authorization: `Bearer ${token}`,
			"chatgpt-account-id": "workspace-123",
		})
		expect(calls[0].init?.redirect).toBe("error")
	})
	test("never calls the network without an account claim", async () => {
		const { impl, calls } = fakeFetch({})
		expect(await fetchCodexUsage(jwt({ sub: "user" }), { fetchImpl: impl, timeoutMs: 50 })).toBeUndefined()
		expect(calls.length).toBe(0)
	})
	test("hides the segment on a non-OK response", async () => {
		const token = jwt({ [ACCOUNT_CLAIM]: { chatgpt_account_id: "workspace-123" } })
		const { impl } = fakeFetch({}, false)
		expect(await fetchCodexUsage(token, { fetchImpl: impl, timeoutMs: 50 })).toBeUndefined()
	})
})

// ================================================================ Command Code

const COMMANDCODE_PAYLOAD = {
	credits: { monthlyCredits: 70, purchasedCredits: 0, freeCredits: 0 },
	windowLimits: {
		fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 },
		weekly: { used: 1.6993372239, cap: 35, exceeded: false, resetAt: NOW + 3 * 86_400_000 },
	},
}

describe("readCommandCodeWindow", () => {
	test("derives the percent from used/cap and converts the ms reset", () => {
		const window = readCommandCodeWindow({ used: 7, cap: 14, resetAt: NOW + 3_600_000 })
		expect(window?.percent).toBe(50)
		expect(window?.resetsAt).toBe(iso(3_600_000))
		expect(window?.status).toBe("ok")
	})
	test("treats resetAt 0 as no countdown and clamps overage to 100%", () => {
		expect(readCommandCodeWindow({ used: 0, cap: 14, resetAt: 0 })?.resetsAt).toBeUndefined()
		const over = readCommandCodeWindow({ used: 40, cap: 35, exceeded: true, resetAt: NOW })
		expect(over?.percent).toBe(100)
		expect(over?.status).toBe("exceeded")
	})
	test("accepts epoch-second resets from older payloads", () => {
		expect(readCommandCodeWindow({ used: 1, cap: 14, resetAt: NOW / 1000 })?.resetsAt).toBe(iso(0))
	})
	test("rejects unusable windows", () => {
		expect(readCommandCodeWindow({ used: -1, cap: 14 })).toBeUndefined()
		expect(readCommandCodeWindow({ used: 1, cap: 0 })).toBeUndefined()
		expect(readCommandCodeWindow({ used: 1 })).toBeUndefined()
		expect(readCommandCodeWindow("nope")).toBeUndefined()
		expect(readCommandCodeWindow(undefined)).toBeUndefined()
	})
})

describe("parseCommandCodeUsage", () => {
	test("maps fiveHour/weekly onto the footer's 5h/7d vocabulary", () => {
		const snapshot = parseCommandCodeUsage(COMMANDCODE_PAYLOAD)
		expect(snapshot?.tier).toBe(COMMANDCODE_TIER)
		expect(snapshot?.windows.map((entry) => [entry.label, entry.unit, entry.floor])).toEqual([
			["5h", "m", false],
			["7d", "h", false],
		])
		expect(snapshot?.windows[0].window.percent).toBe(0)
		expect(snapshot?.windows[1].window.percent).toBeCloseTo(4.855249211, 6)
	})
	test("skips malformed windows and rejects an empty payload", () => {
		expect(parseCommandCodeUsage({ windowLimits: { fiveHour: { used: 500, cap: 0, resetAt: 0 } } })).toBeUndefined()
		expect(
			parseCommandCodeUsage({ windowLimits: { weekly: { used: 1, cap: 35, resetAt: NOW } } })?.windows[0]?.label,
		).toBe("7d")
		expect(parseCommandCodeUsage({ windowLimits: {} })).toBeUndefined()
		expect(parseCommandCodeUsage({ credits: {} })).toBeUndefined()
		expect(parseCommandCodeUsage(null)).toBeUndefined()
	})
})

describe("fetchCommandCodeUsage", () => {
	test("pins the Command Code origin, refuses redirects and sends the bearer credential", async () => {
		const { impl, calls } = fakeFetch(COMMANDCODE_PAYLOAD)
		await fetchCommandCodeUsage("secret-key", { fetchImpl: impl, timeoutMs: 50 })
		expect(calls[0].url).toBe(COMMANDCODE_CREDITS_URL)
		expect(calls[0].url.startsWith("https://api.commandcode.ai/alpha/")).toBe(true)
		expect(calls[0].init?.headers).toEqual({
			accept: "application/json",
			authorization: "Bearer secret-key",
		})
		expect(calls[0].init?.redirect).toBe("error")
	})
	test("hides the segment on a non-OK response", async () => {
		const { impl } = fakeFetch({}, false)
		expect(await fetchCommandCodeUsage("secret-key", { fetchImpl: impl, timeoutMs: 50 })).toBeUndefined()
	})
})

// ================================================================ formatting

describe("formatReset", () => {
	test("formats the minute unit", () => {
		withFixedNow(NOW, () => {
			expect(formatReset(iso(45 * 60_000), "m")).toBe("45m")
			expect(formatReset(iso(3 * 3_600_000), "m")).toBe("3h")
			expect(formatReset(iso(3 * 3_600_000 + 25 * 60_000), "m")).toBe("3h 25m")
		})
	})
	test("formats the hour unit", () => {
		withFixedNow(NOW, () => {
			expect(formatReset(iso(5 * 3_600_000), "h")).toBe("5h")
			expect(formatReset(iso(30 * 3_600_000), "h")).toBe("1d 6h")
			expect(formatReset(iso(16 * 86_400_000), "h")).toBe("16d")
		})
	})
	test("clamps past timestamps and tolerates missing or invalid input", () => {
		withFixedNow(NOW, () => {
			expect(formatReset(iso(-60_000), "m")).toBe("0m")
			expect(formatReset(undefined, "m")).toBeUndefined()
			expect(formatReset("nope", "m")).toBeUndefined()
		})
	})
})

describe("renderUsage", () => {
	const opencode = (): UsageSnapshot =>
		parseOpencodeGoUsage({
			usage: {
				rolling: { percent: 12.6, resetsAt: iso(3 * 3_600_000) },
				weekly: { percent: 36, resetsAt: iso(5 * 86_400_000) },
				monthly: { percent: 65.9, resetsAt: iso(16 * 86_400_000) },
			},
		}) as UsageSnapshot

	const codex = (): UsageSnapshot =>
		parseCodexUsage({
			plan_type: "plus",
			rate_limit: {
				primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: NOW / 1000 + 3_600 },
				secondary_window: { used_percent: 84, limit_window_seconds: 604_800, reset_at: NOW / 1000 + 86_400 },
			},
		}) as UsageSnapshot

	const commandcode = (): UsageSnapshot => parseCommandCodeUsage(COMMANDCODE_PAYLOAD) as UsageSnapshot

	test("renders the OpenCode Go segment in the original style", () => {
		withFixedNow(NOW, () => {
			const { theme } = recordingTheme()
			expect(renderUsage(theme, opencode())).toBe(
				`${ICON_USAGE} · OpenCode Go · 5h 13% (3h) · 7d 36% (5d) · mo 65% (16d)`,
			)
		})
	})
	test("renders the Codex segment in the same style", () => {
		withFixedNow(NOW, () => {
			const { theme } = recordingTheme()
			expect(renderUsage(theme, codex())).toBe(`${ICON_USAGE} · Plus · 5h 42% (1h) · 7d 84% (1d)`)
		})
	})
	test("renders the Command Code segment in the same style", () => {
		withFixedNow(NOW, () => {
			const { theme } = recordingTheme()
			expect(renderUsage(theme, commandcode())).toBe(`${ICON_USAGE} · Command Code · 5h 0% · 7d 5% (3d)`)
		})
	})
	test("colors usage by threshold and floors only month-scale windows", () => {
		withFixedNow(NOW, () => {
			const { theme, calls } = recordingTheme()
			renderUsage(theme, opencode())
			expect(calls).toContainEqual(["muted", "13%"])
			expect(calls).toContainEqual(["muted", "36%"])
			// 65.9% crosses the 50% warning threshold but still floors to 65%.
			expect(calls).toContainEqual(["warning", "65%"])
			const high = recordingTheme()
			renderUsage(high.theme, codex())
			expect(high.calls).toContainEqual(["error", "84%"])
			expect(high.calls).toContainEqual(["muted", "42%"])
		})
	})
	test("returns undefined when nothing is renderable", () => {
		const { theme } = recordingTheme()
		expect(renderUsage(theme, { windows: [], fetchedAt: 0 })).toBeUndefined()
	})
})

// ================================================================ module layout

describe("helper module layout", () => {
	test("the helper directory is not an independently discoverable extension", () => {
		const dir = new URL("../pi/extensions/statusline/", import.meta.url)
		for (const forbidden of ["index.ts", "index.js", "index.d.ts", "package.json"]) {
			expect(existsSync(new URL(forbidden, dir)), `${forbidden} must not exist`).toBe(false)
		}
	})
})
