/**
 * DecisionClient boundary backed by the shared warm daemon.
 *
 * The extension only sees this interface; the daemon transport, language
 * routing, checkpoint selection and model lifetime stay behind it. Every
 * failure path returns `{ ok: false }` and never throws.
 */

import type { LayaRoutingConfig } from "./config";
import { PURPOSE_SCHEMA } from "./routing";
import type { LayaDaemonTransport } from "./transport";
import type { DecisionClient, DecisionResult, FailureReason, Purpose, RoutingInput } from "./types";
import { PURPOSES } from "./types";

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

/** Daemon-level failures collapse onto the extension's fail-open reasons. */
export function mapDaemonError(error: string, detail?: string): DecisionResult {
	if (error === "loading" || error === "degraded" || error === "unavailable") {
		return { ok: false, reason: "unavailable", ...(detail !== undefined ? { detail } : {}) };
	}
	if (error === "daemon_disconnected" || error === "closed") {
		return { ok: false, reason: "spawn_error", ...(detail !== undefined ? { detail } : {}) };
	}
	if ((FAILURE_REASONS as readonly string[]).includes(error)) {
		return { ok: false, reason: error as FailureReason, ...(detail !== undefined ? { detail } : {}) };
	}
	return { ok: false, reason: "malformed", ...(detail !== undefined ? { detail } : {}) };
}

export interface DaemonDecisionClientOptions {
	transport: LayaDaemonTransport;
	config: () => LayaRoutingConfig;
	now?: () => number;
}

/**
 * The production DecisionClient. `transport.classify` already validates the
 * payload shape; the enum and confidence are re-checked here so a buggy or
 * compromised daemon can still never inject a malformed decision.
 */
export function createDaemonDecisionClient(options: DaemonDecisionClientOptions): DecisionClient {
	const now = options.now ?? (() => Date.now());
	return {
		async decide(input: RoutingInput): Promise<DecisionResult> {
			const started = now();
			try {
				const config = options.config();
				const result = await options.transport.classify(input.text, PURPOSE_SCHEMA, config.timeoutMs);
				const transportMs = Math.max(0, now() - started);
				if (!result.ok) return mapDaemonError(result.error, result.detail);
				if (!(PURPOSES as readonly string[]).includes(result.purpose)) {
					return { ok: false, reason: "invalid_enum", detail: `purpose=${result.purpose}` };
				}
				if (!Number.isFinite(result.answerConfidence) || result.answerConfidence < 0 || result.answerConfidence > 1) {
					return { ok: false, reason: "invalid_confidence", detail: `answer_confidence=${result.answerConfidence}` };
				}
				const welcome = options.transport.welcome;
				return {
					ok: true,
					decision: {
						purpose: result.purpose as Purpose,
						answerConfidence: result.answerConfidence,
						...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
						...(result.probabilities !== undefined ? { probabilities: result.probabilities } : {}),
						...(result.language !== undefined ? { language: result.language } : {}),
						...(result.checkpoint !== undefined ? { checkpoint: result.checkpoint } : {}),
						...(welcome !== undefined ? { daemonId: welcome.daemonId } : {}),
						transportMs,
						classifier: {
							name: "laya",
							...(welcome?.packageVersion !== undefined ? { packageVersion: welcome.packageVersion } : {}),
							...(welcome?.repo !== undefined ? { model: welcome.repo } : {}),
							...(welcome?.revision !== undefined ? { revision: welcome.revision } : {}),
						},
						latencyMs: result.latencyMs,
					},
				};
			} catch (cause) {
				return { ok: false, reason: "exception", detail: cause instanceof Error ? cause.message : String(cause) };
			}
		},
	};
}
