/**
 * DecisionClient boundary and the pinned Laya bridge invocation.
 *
 * One `python3 bridge.py` process per decision — the simplest runtime Laya
 * supports cleanly. No daemon, socket, lease or warm process exists in v1;
 * telemetry records the full latency so that decision can be revisited with
 * data. Every failure path returns `{ ok: false }` and never throws.
 */

import { spawn } from "node:child_process";

import type { LayaRoutingConfig } from "./config";
import { PURPOSE_SCHEMA } from "./routing";
import type { DecisionClient, DecisionResult, FailureReason, Purpose, RoutingInput } from "./types";
import { PURPOSES } from "./types";

export interface BridgeRun {
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
	spawnError?: string;
}

export interface BridgeExecInput {
	python: string;
	bridgePath: string;
	/** One JSON request written to the child's stdin (empty for flag-only runs). */
	request: string;
	/** Extra CLI arguments, e.g. `--probe`. */
	args?: string[];
	timeoutMs: number;
}

export type BridgeExec = (input: BridgeExecInput) => Promise<BridgeRun>;

function payloadRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function probabilitiesOf(value: unknown): Record<string, number> | undefined {
	const record = payloadRecord(value);
	if (!record) return undefined;
	const out: Record<string, number> = {};
	for (const [key, raw] of Object.entries(record)) {
		const num = finiteNumber(raw);
		if (num !== undefined) out[key] = num;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validates one bridge success payload. Invalid enums/confidences are
 * failures, not hints: a malformed decision is never injected.
 */
export function validateDecisionPayload(payload: unknown, latencyMs: number): DecisionResult {
	const record = payloadRecord(payload);
	if (!record) return { ok: false, reason: "malformed", detail: "payload is not an object" };

	const purpose = record.purpose;
	if (typeof purpose !== "string" || !(PURPOSES as readonly string[]).includes(purpose)) {
		return { ok: false, reason: "invalid_enum", detail: `purpose=${JSON.stringify(purpose)}` };
	}
	const answerConfidence = finiteNumber(record.answer_confidence);
	if (answerConfidence === undefined || answerConfidence < 0 || answerConfidence > 1) {
		return { ok: false, reason: "invalid_confidence", detail: `answer_confidence=${JSON.stringify(record.answer_confidence)}` };
	}
	const confidence = finiteNumber(record.confidence);
	const classifier: { name: "laya"; packageVersion?: string; model?: string; revision?: string } = { name: "laya" };
	if (typeof record.package_version === "string") classifier.packageVersion = record.package_version;
	if (typeof record.model === "string") classifier.model = record.model;
	if (typeof record.revision === "string") classifier.revision = record.revision;

	return {
		ok: true,
		decision: {
			purpose: purpose as Purpose,
			answerConfidence,
			...(confidence !== undefined ? { confidence } : {}),
			...(probabilitiesOf(record.probabilities) ? { probabilities: probabilitiesOf(record.probabilities) } : {}),
			classifier,
			latencyMs,
		},
	};
}

const FAILURE_REASONS: readonly FailureReason[] = [
	"unavailable",
	"version_mismatch",
	"timeout",
	"spawn_error",
	"malformed",
	"invalid_enum",
	"invalid_confidence",
	"exception",
];

/** Parses the single JSON line the bridge prints on stdout. */
export function parseBridgeOutput(run: BridgeRun, latencyMs: number): DecisionResult {
	if (run.spawnError !== undefined) return { ok: false, reason: "spawn_error", detail: run.spawnError };
	if (run.timedOut) return { ok: false, reason: "timeout" };

	let payload: unknown;
	try {
		payload = JSON.parse(run.stdout.trim());
	} catch (cause) {
		return { ok: false, reason: "malformed", detail: cause instanceof Error ? cause.message : String(cause) };
	}

	const record = payloadRecord(payload);
	if (!record) return { ok: false, reason: "malformed", detail: "payload is not an object" };
	if (record.ok === false) {
		const error = record.error;
		const reason = typeof error === "string" && (FAILURE_REASONS as readonly string[]).includes(error) ? (error as FailureReason) : "malformed";
		const detail = typeof record.detail === "string" ? record.detail : undefined;
		return { ok: false, reason, ...(detail !== undefined ? { detail } : {}) };
	}
	if (record.ok !== true) return { ok: false, reason: "malformed", detail: "missing ok flag" };
	return validateDecisionPayload(record, latencyMs);
}

/** Spawn-based exec: one child, request on stdin, bounded by `timeoutMs`. */
export function execBridge(input: BridgeExecInput): Promise<BridgeRun> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (run: BridgeRun) => {
			if (settled) return;
			settled = true;
			resolve(run);
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(input.python, [input.bridgePath, ...(input.args ?? [])], { stdio: ["pipe", "pipe", "pipe"], shell: false });
		} catch (cause) {
			finish({ stdout: "", stderr: "", code: null, timedOut: false, spawnError: cause instanceof Error ? cause.message : String(cause) });
			return;
		}

		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				// The child is already gone.
			}
			finish({ stdout, stderr, code: null, timedOut: true });
		}, input.timeoutMs);
		timer.unref?.();

		child.on("error", (cause) => {
			clearTimeout(timer);
			finish({ stdout, stderr, code: null, timedOut: false, spawnError: cause.message });
		});
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			finish({ stdout, stderr, code, timedOut: false });
		});

		try {
			child.stdin?.end(input.request.length > 0 ? input.request : undefined);
		} catch {
			// The error/close handlers report the real failure.
		}
	});
}

export interface LayaProcessClientOptions {
	bridgePath: string;
	/** Config is read per decision so `/reload`-free edits take effect. */
	config: () => LayaRoutingConfig;
	exec?: BridgeExec;
	now?: () => number;
}

/**
 * The only production DecisionClient. `python` and `timeoutMs` come from the
 * live config on every call; the request carries the sanitized prompt and the
 * fixed purpose schema.
 */
export function createLayaProcessClient(options: LayaProcessClientOptions): DecisionClient {
	const exec = options.exec ?? execBridge;
	const now = options.now ?? (() => Date.now());

	return {
		async decide(input: RoutingInput): Promise<DecisionResult> {
			const started = now();
			try {
				const config = options.config();
				const request = JSON.stringify({ text: input.text, schema: PURPOSE_SCHEMA });
				const run = await exec({
					python: config.python,
					bridgePath: options.bridgePath,
					request,
					timeoutMs: config.timeoutMs,
				});
				return parseBridgeOutput(run, Math.max(0, now() - started));
			} catch (cause) {
				return { ok: false, reason: "exception", detail: cause instanceof Error ? cause.message : String(cause) };
			}
		},
	};
}
