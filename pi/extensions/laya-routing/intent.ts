/**
 * Conservative explicit-intent detection.
 *
 * Explicit user delegation always wins, so this only needs to catch clear
 * phrasing; missing a case costs nothing (the classifier still runs and the
 * hint stays advisory). Both heuristics avoid natural-language parsing
 * beyond the small pattern lists below.
 */

import type { BypassReason } from "./types";

const AGENT_WORDS = "explore|research|architect|verify|review|reviewer";
const DELEGATION_VERBS = "use|ask|spawn|call|invoke|delegate to|hand (?:it )?to|have";

/** "use the reviewer", "ask research", "spawn explore", "use architect for this". */
const EXPLICIT_DELEGATION = [
	new RegExp(`\\b(?:${DELEGATION_VERBS})\\s+(?:the\\s+)?(?:${AGENT_WORDS})\\b`, "i"),
	new RegExp(`\\b(?:use|spawn|run|launch|call)\\s+(?:a\\s+|an?\\s+)?subagents?\\b`, "i"),
	/\bdelegate\b/i,
];

/** "don't use subagents", "without a reviewer", "do not spawn explore", "no delegation". */
const EXPLICIT_NO_DELEGATION = [
	new RegExp(`\\b(?:don'?t|do not|never|avoid|without|no)\\s+(?:use|using|spawn|spawning|call|calling|delegate|delegating|ask|asking)\\b`, "i"),
	new RegExp(`\\b(?:no|without|avoid)\\s+(?:a\\s+|any\\s+)?(?:subagents?|${AGENT_WORDS})\\b`, "i"),
	/\bno delegation\b/i,
];

/**
 * Returns the bypass reason for clearly explicit prompts, or `null` when the
 * classifier should decide. No-delegation is checked first so "don't use
 * explore" can never read as a delegation request.
 */
export function explicitIntent(text: string): BypassReason | null {
	for (const pattern of EXPLICIT_NO_DELEGATION) {
		if (pattern.test(text)) return "explicit_no_delegation";
	}
	for (const pattern of EXPLICIT_DELEGATION) {
		if (pattern.test(text)) return "explicit_delegation";
	}
	return null;
}
