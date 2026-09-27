/**
 * Shared types for the Laya delegation advisor.
 *
 * The classifier speaks in task purposes, never in Pi agent names; the
 * deterministic purpose -> specialist mapping lives in `routing.ts`.
 */

/** What, if anything, would help the parent before it finishes this work. */
export type Purpose = "none" | "local_context" | "external_context" | "architecture";

export const PURPOSES: readonly Purpose[] = ["none", "local_context", "external_context", "architecture"];

/** Specialists the parent may choose to consult. Names stay out of the classifier schema. */
export type Specialist = "explore" | "research" | "architect";

export const PURPOSE_TO_SPECIALIST: Readonly<Record<Purpose, Specialist | null>> = {
	none: null,
	local_context: "explore",
	external_context: "research",
	architecture: "architect",
};

/** Why a classification did not produce a decision. Every one of these fails open. */
export type FailureReason =
	| "unavailable"
	| "version_mismatch"
	| "timeout"
	| "spawn_error"
	| "malformed"
	| "invalid_enum"
	| "invalid_confidence"
	| "exception";

/** Reasons a turn never reaches the classifier. */
export type BypassReason = "explicit_delegation" | "explicit_no_delegation" | "unusable_input";

export interface RoutingInput {
	/** Bounded, sanitized raw user prompt. */
	text: string;
	/** True when the session directory is a repository root (`.git` present). */
	repositorySession: boolean;
}

export interface ClassifierInfo {
	name: "laya";
	packageVersion?: string;
	model?: string;
	revision?: string;
}

export interface RoutingDecision {
	purpose: Purpose;
	/** Laya's `answer_confidence`: probability mass on the reported answer. */
	answerConfidence: number;
	/** Laya's entropy-derived `confidence`. Recorded for comparison, never gated on. */
	confidence?: number;
	probabilities?: Record<string, number>;
	classifier: ClassifierInfo;
	/** Wall time of the whole bridge invocation, interpreter start included. */
	latencyMs: number;
}

export type DecisionResult =
	| { ok: true; decision: RoutingDecision }
	| { ok: false; reason: FailureReason; detail?: string };

/**
 * Boundary that keeps Laya initialization and inference out of the routing
 * wiring. Implementations never throw: every failure becomes `ok: false`.
 */
export interface DecisionClient {
	decide(input: RoutingInput): Promise<DecisionResult>;
}
