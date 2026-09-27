/**
 * Semantic classifier contract: schema, prompt hygiene, confidence gate and
 * the request-local hint.
 *
 * Laya only ever sees task purposes. The deterministic purpose -> specialist
 * mapping below is the single place where Pi agent names meet the classifier.
 */

import type { Purpose, RoutingDecision, Specialist } from "./types";
import { PURPOSES, PURPOSE_TO_SPECIALIST } from "./types";

/** Bound on the raw prompt sent to the local classifier. */
export const MAX_PROMPT_CHARS = 1200;

/**
 * Schema for the single typed decision. Descriptions carry the semantics;
 * no specialist name appears in the schema, so the classifier cannot learn
 * to imitate the delegation vocabulary.
 */
export const PURPOSE_SCHEMA = {
	type: "object",
	properties: {
		purpose: {
			type: "string",
			enum: [...PURPOSES],
			description:
				"Which auxiliary context, if any, would materially help before this request is completed? " +
				"none: the request is self-contained and can be handled directly. " +
				"local_context: reading or searching this repository's own files would materially help. " +
				"external_context: current documentation, library or API behavior, or web lookup is needed that cannot be answered from the repository alone. " +
				"architecture: the request needs systemic design, cross-layer analysis, or blast-radius reasoning.",
		},
	},
} as const;

/** Collapse control characters/whitespace and bound the size sent to Laya. */
export function sanitizePrompt(text: string): string {
	return text
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_PROMPT_CHARS);
}

/** Deterministic mapping; `none` deliberately yields no recommendation. */
export function specialistFor(purpose: Purpose): Specialist | null {
	return PURPOSE_TO_SPECIALIST[purpose];
}

export function isAdviceWorthy(decision: RoutingDecision, threshold: number): boolean {
	return specialistFor(decision.purpose) !== null && decision.answerConfidence >= threshold;
}

export interface HintMessage {
	role: "custom";
	customType: "laya-routing-hint";
	content: string;
	display: false;
	timestamp: number;
}

/**
 * Request-local advisory message. Shaped like the todo extension's
 * `role: "custom"` message, which Pi projects into provider requests for one
 * request only and never writes back to the session transcript.
 */
export function buildHintMessage(decision: RoutingDecision, specialist: Specialist, timestamp: number): HintMessage {
	const lines = [
		"<delegation_hint>",
		`purpose: ${decision.purpose}`,
		`suggested_agent: ${specialist}`,
		`confidence: ${decision.answerConfidence.toFixed(2)}`,
		"advisory: true",
		"</delegation_hint>",
	];
	return {
		role: "custom",
		customType: "laya-routing-hint",
		content: lines.join("\n"),
		display: false,
		timestamp,
	};
}
