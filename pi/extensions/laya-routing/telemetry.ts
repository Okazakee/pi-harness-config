/**
 * Shadow telemetry: one privacy-safe JSONL event per root turn, stored
 * outside the agent dir and the backup repository.
 *
 * Location: `$XDG_STATE_HOME/pi/laya-routing/decisions.jsonl`
 * (default `~/.local/state/pi/laya-routing/decisions.jsonl`).
 *
 * Recorded: mode, the classifier result, the confidence gate outcome, the
 * bypass/failure reason, and the specialist delegation observed in the same
 * agent run. Never recorded: prompts, summaries, file names, tool payloads,
 * source, secrets, environment values.
 *
 * `changed_course` is deliberately absent: Pi exposes no reliable signal for
 * "the hint changed the model's decision", and inventing one would be worse
 * than not measuring it.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { LayaRoutingMode } from "./config";
import type { BypassReason, DecisionResult } from "./types";

export interface DecisionEventInput {
	id: string;
	at: number;
	mode: LayaRoutingMode;
	repositorySession: boolean;
	threshold: number;
	bypass?: BypassReason;
	result?: DecisionResult;
	injected: boolean;
	agents: string[];
	delegated: boolean;
}

/** Pure builder so the privacy contract is directly testable. */
export function buildDecisionEvent(input: DecisionEventInput): Record<string, unknown> {
	const ok = input.result?.ok === true ? input.result.decision : undefined;
	return {
		schema_version: 2,
		ts: new Date(input.at).toISOString(),
		event_id: input.id,
		mode: input.mode,
		repository_session: input.repositorySession,
		bypass: input.bypass ?? null,
		failure: input.result && !input.result.ok ? input.result.reason : null,
		classifier: ok
			? {
					name: ok.classifier.name,
					package_version: ok.classifier.packageVersion ?? null,
					model: ok.classifier.model ?? null,
					revision: ok.classifier.revision ?? null,
				}
			: null,
		runtime: { daemon_id: ok?.daemonId ?? null },
		laya: ok
			? {
					purpose: ok.purpose,
					answer_confidence: ok.answerConfidence,
					confidence: ok.confidence ?? null,
					language: ok.language ?? null,
					checkpoint: ok.checkpoint ?? null,
					latency_ms: ok.latencyMs,
					transport_ms: ok.transportMs ?? null,
				}
			: null,
		hint: { threshold: input.threshold, injected: input.injected },
		actual: { delegated: input.delegated, agents: [...input.agents].sort() },
	};
}

/** One-line summary for `/laya-routing status`; never includes prompt content. */
export function summarizeEvent(event: Record<string, unknown>): string {
	const laya = event.laya as Record<string, unknown> | null | undefined;
	const actual = event.actual as Record<string, unknown> | undefined;
	const parts: string[] = [`mode=${String(event.mode)}`];
	if (event.bypass) parts.push(`bypass=${String(event.bypass)}`);
	if (event.failure) parts.push(`failure=${String(event.failure)}`);
	if (laya) {
		if (laya.language) parts.push(`language=${String(laya.language)}`);
		if (laya.checkpoint) parts.push(`checkpoint=${String(laya.checkpoint)}`);
		parts.push(`purpose=${String(laya.purpose)}`);
		parts.push(`answer_confidence=${String(laya.answer_confidence)}`);
		parts.push(`latency_ms=${String(laya.latency_ms)}`);
	}
	if (actual) parts.push(`delegated=${String(actual.delegated)}${Array.isArray(actual.agents) && actual.agents.length > 0 ? ` (${actual.agents.join(",")})` : ""}`);
	return parts.join(" ");
}

/** Append-only writer. Any failure is swallowed: telemetry never blocks Pi. */
export function appendDecisionEvent(path: string, event: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
	} catch {
		// Best-effort: a missing dataset must not affect the session.
	}
}

/** Last recorded event, if any. Used by `/laya-routing status` after a reload. */
export function readLastEvent(path: string): Record<string, unknown> | undefined {
	try {
		const lines = readFileSync(path, "utf8").trimEnd().split("\n");
		const last = lines[lines.length - 1];
		return last ? (JSON.parse(last) as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** Event count for the status line; undefined when the dataset is unreadable. */
export function countEvents(path: string): number | undefined {
	try {
		const data = readFileSync(path, "utf8");
		if (data.length === 0) return 0;
		return data.trimEnd().split("\n").length;
	} catch {
		return undefined;
	}
}
