import { boardStats } from "./board"
import { LONG_PROMPT_CHARS, TODO_NUDGE_THRESHOLD, TODO_NUDGE_TYPE } from "./constants"
import { normalizeLabel } from "./text"
import type { TodoPhase } from "./types"

// ---------------------------------------------------------------- complexity heuristic

/**
 * Small deterministic heuristic deciding whether a newly submitted user
 * prompt looks like a multi-step engineering request worth one advisory todo
 * reminder. It is local, cheap and conservative: it never calls a model and
 * only reads the prompt text. Fenced code is ignored so pasted code or logs
 * cannot masquerade as a complex request.
 *
 * Weights (documented so future tuning is deliberate):
 *
 *   task-like list items >= 3       +3   explicit action checklist
 *   other 3+ list items             +1   structure without clear actions
 *   checklist wording               +2   "todo", "tasks", "requirements", ...
 *   distinct action verbs           +1 each, capped at +3
 *   meaningful length >= 800        +1   long prose (never sufficient alone)
 *   sequencing language             +1   "then", "finally", "also", ...
 *   question without task evidence  -1   explanation requests bias against todo
 *
 * Trigger at >= TODO_NUDGE_THRESHOLD (3). A question that still carries task
 * evidence (3+ action verbs, an action checklist, checklist wording) is not
 * penalized: "Can you inspect X, fix Y, add tests and update docs?" triggers.
 */

const ACTION_VERBS = new Set([
	"add",
	"change",
	"fix",
	"implement",
	"remove",
	"update",
	"migrate",
	"inspect",
	"research",
	"verify",
	"test",
	"document",
	"refactor",
	"compare",
	"check",
	"create",
	"replace",
	"configure",
	"run",
	"write",
])

const CHECKLIST_RE = /\b(?:todo|to-?do list|checklist|tasks|steps|requirements?|things to do)\b/i
const SEQUENCING_RE = /\b(?:and then|after that|afterwards?|finally|lastly|subsequently|then|also|first|next)\b/i
const QUESTION_RE = /\?/
const STATEMENT_RE = /\b(?:is|are|was|were|has|have|had|will|would|can|could|should)\b/i

/** Drop fenced code blocks so pasted code contributes no signal. */
export function stripFencedBlocks(prompt: string): string {
	return prompt.replace(/```[\s\S]*?```/g, " ").replace(/~~~[\s\S]*?~~~/g, " ")
}

/** Reduce a word to a known action-verb stem, or null. */
function actionVerbStem(word: string): string | null {
	const lower = word.toLowerCase().replace(/[^a-z]/g, "")
	if (!lower) return null
	if (ACTION_VERBS.has(lower)) return lower
	for (const suffix of ["ing", "ed", "es", "s"]) {
		if (lower.length > suffix.length + 2 && lower.endsWith(suffix)) {
			const stem = lower.slice(0, -suffix.length)
			if (ACTION_VERBS.has(stem)) return stem
			if (ACTION_VERBS.has(`${stem}e`)) return `${stem}e`
		}
	}
	return null
}

/** Count distinct action verbs in prose. */
export function countActionVerbs(text: string): number {
	const seen = new Set<string>()
	for (const match of text.matchAll(/[A-Za-z]+/g)) {
		const stem = actionVerbStem(match[0])
		if (stem !== null) seen.add(stem)
	}
	return seen.size
}

export interface PromptListItem {
	text: string
	taskLike: boolean
}

function looksTaskLike(item: string): boolean {
	const firstWord = item.split(/\s+/)[0] ?? ""
	if (actionVerbStem(firstWord) === null) return false
	// "Update latency is 50ms" starts with a verb but is a statement, not an
	// instruction. Only the first few words decide, so an imperative that
	// mentions "is" later still counts.
	const head = item.split(/\s+/).slice(0, 3).join(" ")
	return !STATEMENT_RE.test(head)
}

/** Extract markdown bullet / numbered list items from prose. */
export function analyzeListItems(prompt: string): PromptListItem[] {
	const items: PromptListItem[] = []
	for (const line of stripFencedBlocks(prompt).split(/\r?\n/)) {
		const match = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/)
		if (!match) continue
		const text = normalizeLabel(match[1])
		if (text.length < 4) continue
		items.push({ text, taskLike: looksTaskLike(text) })
	}
	return items
}

/** Transparent additive score; see the weight table above. */
export function todoComplexityScore(prompt: string): number {
	const prose = stripFencedBlocks(prompt)
	const items = analyzeListItems(prompt)
	const taskLikeItems = items.filter((item) => item.taskLike).length
	const verbs = countActionVerbs(prose)
	const hasChecklistWording = CHECKLIST_RE.test(prose)

	let score = 0
	if (taskLikeItems >= 3) score += 3
	else if (items.length >= 3) score += 1
	if (hasChecklistWording) score += 2
	score += Math.min(3, verbs)
	if (normalizeLabel(prose).length >= LONG_PROMPT_CHARS) score += 1
	if (SEQUENCING_RE.test(prose)) score += 1

	const hasTaskEvidence = taskLikeItems >= 3 || hasChecklistWording || verbs >= 3
	if (QUESTION_RE.test(prose) && !hasTaskEvidence) score -= 1
	return Math.max(0, score)
}

/** True when a prompt should receive one advisory todo reminder. */
export function shouldSuggestTodo(prompt: string): boolean {
	return todoComplexityScore(prompt) >= TODO_NUDGE_THRESHOLD
}

// ---------------------------------------------------------------- todo nudge

export type TodoNudgeKind = "initialize" | "reconcile"

const TODO_NUDGE_INITIALIZE = [
	"<todo_nudge>",
	"This request appears multi-step. Consider initializing a concise phased todo board before substantial work so all requested scopes remain tracked.",
	"</todo_nudge>",
].join("\n")

const TODO_NUDGE_RECONCILE = [
	"<todo_nudge>",
	"This prompt appears to add substantial multi-step work. Reconcile the current todo board with the new requirements before substantial work if needed.",
	"</todo_nudge>",
].join("\n")

/** Nudge wording: initialize a new board, or reconcile an existing one. */
export function formatTodoNudge(kind: TodoNudgeKind): string {
	return kind === "reconcile" ? TODO_NUDGE_RECONCILE : TODO_NUDGE_INITIALIZE
}

/** A board is actionable while open or blocked work remains. */
export function nudgeKindFor(phases: readonly TodoPhase[]): TodoNudgeKind {
	const stats = boardStats(phases)
	return stats.open + stats.blocked > 0 ? "reconcile" : "initialize"
}

export interface TodoNudgeMessage {
	role: "custom"
	customType: string
	content: string
	display: false
	timestamp: number
}

/** Request-local custom message; never persisted to session history. */
export function buildTodoNudgeMessage(text: string, timestamp: number = Date.now()): TodoNudgeMessage {
	return {
		role: "custom",
		customType: TODO_NUDGE_TYPE,
		content: text,
		display: false,
		timestamp,
	}
}
