/**
 * todo — a Pi-native execution working set for long, multi-step work.
 *
 * Purpose
 * -------
 * Long autonomous sessions drift: the user states a large request, the model
 * starts implementing, and by the third subsystem it has silently dropped
 * half of the requested scope. This extension gives the model one bounded,
 * explicit execution pointer:
 *
 *   large request -> phased todo board -> one active scope -> work
 *                 -> advance active scope -> verification
 *
 * It deliberately mirrors OMP's todo *semantics* (phases, one active task,
 * task content as the stable identity, blocked work) without OMP's
 * orchestration machinery: there is no automatic continuation, no stop-time
 * reminder loop, no eager first-turn initialization, and no disk state.
 *
 * Persistence
 * -----------
 * The canonical board lives in the Pi session, never on disk:
 *
 *   - model `todo` tool calls persist their full board in the tool result
 *     `details` (Pi's official todo-example architecture);
 *   - manual `/todo` mutations append a `okazakee:todo-state` custom session
 *     entry with a full board snapshot.
 *
 * Reconstruction scans the active session branch in order and lets the latest
 * valid snapshot win, so the board is branch-aware: navigating to a branch
 * before a completion shows the older board; resuming a session restores the
 * board from that branch. Session entries are the only storage; there is no
 * `TODO.md`, no `~/.pi/todos`, no database.
 *
 * Request-local scope injection
 * -----------------------------
 * Before every model request (Pi's `context` event) a compact `<todo_context>`
 * pointer is appended as a request-local `custom` message. Pi 0.87 projects
 * `custom` agent messages into the provider request as user-visible text
 * (see `convertToLlm` in the installed `pi-coding-agent`), and the transformed
 * list is used for that request only — it is never written back to the
 * session. Recomputing the pointer on every `context` event keeps it fresh
 * after tool calls inside the same user turn. The full board never rides
 * along; DCP keeps `todo` results protected, so their model-facing text is
 * deliberately small.
 *
 * Delegated subagents
 * -------------------
 * `pi-subagent` children inherit extensions. The board belongs to the
 * parent/director session only, so when `PI_SUBAGENT_DEPTH > 0` this
 * extension registers nothing: no tool, no command, no context injection, no
 * widget. Missing/invalid/zero depth is treated as the root session.
 *
 * This file intentionally imports nothing at runtime — only types, which are
 * erased — so `scripts/todo.test.ts` can exercise the pure state machine
 * under Bun without a node_modules tree.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

// ---------------------------------------------------------------- types

export type TodoStatus =
	| "pending"
	| "in_progress"
	| "completed"
	| "abandoned"
	| "blocked"

export interface TodoItem {
	content: string
	status: TodoStatus
	blocker?: string
}

export interface TodoPhase {
	name: string
	tasks: TodoItem[]
}

export type TodoOperation =
	| "init"
	| "start"
	| "done"
	| "drop"
	| "block"
	| "unblock"
	| "append"
	| "rm"
	| "clear"
	| "view"

export interface TodoParams {
	op?: TodoOperation
	list?: Array<{ phase: string; items: string[] }>
	phase?: string
	task?: string
	items?: string[]
	reason?: string
}

/** Structured snapshot persisted in `todo` tool-result details. */
export interface TodoDetails {
	op: TodoOperation
	phases: TodoPhase[]
}

export interface TodoStats {
	total: number
	completed: number
	abandoned: number
	pending: number
	active: number
	blocked: number
	open: number
}

export interface LocatedTask {
	phase: TodoPhase
	task: TodoItem
}

export type TodoTargetKind = "task" | "phase"

export interface TodoTarget {
	kind: TodoTargetKind
	name: string
}

export type TodoApplyResult =
	| { ok: true; phases: TodoPhase[]; message: string }
	| { ok: false; error: string }

/** Minimal structural component, compatible with Pi's TUI `Component`. */
export interface TodoTextComponent {
	render(width: number): string[]
	invalidate(): void
}

/** Structural subset of session entries needed for reconstruction. */
export interface BranchEntryLike {
	type?: string
	customType?: string
	data?: unknown
	message?: {
		role?: string
		toolName?: string
		details?: unknown
	}
}

// ---------------------------------------------------------------- constants

export const TODO_TOOL_NAME = "todo"
export const TODO_ENTRY_TYPE = "okazakee:todo-state"
export const TODO_CONTEXT_TYPE = "okazakee:todo-context"
export const TODO_WIDGET_KEY = "todo"
export const TODO_CONTEXT_MAX_CHARS = 300
export const WIDGET_NEXT_TASKS = 2
export const WIDGET_LABEL_MAX_CHARS = 80
export const BLOCKER_MAX_CHARS = 200

// Complex-prompt nudge (advisory only; see the heuristic section below).
export const TODO_NUDGE_TYPE = "okazakee:todo-nudge"
export const TODO_NUDGE_THRESHOLD = 3
export const LONG_PROMPT_CHARS = 800
export const TODO_NUDGE_MAX_CHARS = 220

export const TODO_OPERATIONS: readonly TodoOperation[] = [
	"init",
	"start",
	"done",
	"drop",
	"block",
	"unblock",
	"append",
	"rm",
	"clear",
	"view",
]

const VALID_STATUSES: readonly TodoStatus[] = [
	"pending",
	"in_progress",
	"completed",
	"abandoned",
	"blocked",
]

// ---------------------------------------------------------------- environment gate

/**
 * Parse `PI_SUBAGENT_DEPTH` robustly. Only a positive integer (surrounding
 * whitespace allowed) marks a delegated child. Missing, empty, zero, negative,
 * or non-numeric values are treated as the root session so a malformed
 * environment never quietly disables the board in the parent.
 */
export function parseSubagentDepth(raw: string | undefined): number {
	if (raw === undefined) return 0
	const trimmed = raw.trim()
	if (!/^\d+$/.test(trimmed)) return 0
	const value = Number(trimmed)
	return Number.isSafeInteger(value) && value > 0 ? value : 0
}

export function isSubagentProcess(env: Record<string, string | undefined>): boolean {
	return parseSubagentDepth(env.PI_SUBAGENT_DEPTH) > 0
}

// ---------------------------------------------------------------- text helpers

/** Collapse all whitespace to single spaces and trim. */
export function normalizeLabel(text: string): string {
	return text.replace(/\s+/g, " ").trim()
}

/** Case-insensitive identity key for tasks and phases. */
export function labelKey(text: string): string {
	return normalizeLabel(text).toLowerCase()
}

/** Truncate on code-point boundaries, appending a single ellipsis. */
export function truncateLabel(text: string, maxChars: number): string {
	if (maxChars <= 0) return ""
	const chars = [...text]
	if (chars.length <= maxChars) return text
	if (maxChars === 1) return chars[0]
	return `${chars.slice(0, maxChars - 1).join("")}…`
}

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

// ---------------------------------------------------------------- board helpers

export function cloneBoard(phases: readonly TodoPhase[]): TodoPhase[] {
	return phases.map((phase) => ({
		name: phase.name,
		tasks: phase.tasks.map((task) =>
			task.blocker === undefined
				? { content: task.content, status: task.status }
				: { content: task.content, status: task.status, blocker: task.blocker },
		),
	}))
}

/**
 * Enforce the single-active invariant without touching blocked, completed or
 * abandoned work:
 *
 *   - more than one in_progress -> keep the first in phase/task order, demote
 *     the rest to pending;
 *   - zero active and at least one pending -> promote the earliest pending;
 *   - zero active with no pending (everything closed or blocked) -> valid.
 */
export function normalizeBoard(phases: readonly TodoPhase[]): TodoPhase[] {
	const board = cloneBoard(phases)
	let active: TodoItem | undefined
	for (const phase of board) {
		for (const task of phase.tasks) {
			if (task.status !== "in_progress") continue
			if (active === undefined) {
				active = task
			} else {
				task.status = "pending"
			}
		}
	}
	if (active === undefined) {
		outer: for (const phase of board) {
			for (const task of phase.tasks) {
				if (task.status === "pending") {
					task.status = "in_progress"
					break outer
				}
			}
		}
	}
	return board
}

export function boardStats(phases: readonly TodoPhase[]): TodoStats {
	const stats: TodoStats = {
		total: 0,
		completed: 0,
		abandoned: 0,
		pending: 0,
		active: 0,
		blocked: 0,
		open: 0,
	}
	for (const phase of phases) {
		for (const task of phase.tasks) {
			stats.total += 1
			switch (task.status) {
				case "completed":
					stats.completed += 1
					break
				case "abandoned":
					stats.abandoned += 1
					break
				case "pending":
					stats.pending += 1
					stats.open += 1
					break
				case "in_progress":
					stats.active += 1
					stats.open += 1
					break
				case "blocked":
					stats.blocked += 1
					break
			}
		}
	}
	return stats
}

export function activeTask(phases: readonly TodoPhase[]): LocatedTask | null {
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "in_progress") return { phase, task }
		}
	}
	return null
}

export function firstPendingTask(phases: readonly TodoPhase[]): LocatedTask | null {
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "pending") return { phase, task }
		}
	}
	return null
}

export function firstBlockedTask(phases: readonly TodoPhase[]): LocatedTask | null {
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status === "blocked") return { phase, task }
		}
	}
	return null
}

/** Exact, case-insensitive task lookup. The model-facing tool never guesses. */
export function locateTask(phases: readonly TodoPhase[], content: string): LocatedTask | null {
	const key = labelKey(content)
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (labelKey(task.content) === key) return { phase, task }
		}
	}
	return null
}

/** Exact, case-insensitive phase lookup. */
export function locatePhase(phases: readonly TodoPhase[], name: string): TodoPhase | null {
	const key = labelKey(name)
	for (const phase of phases) {
		if (labelKey(phase.name) === key) return phase
	}
	return null
}

// ---------------------------------------------------------------- command target resolution

function describeTargets(targets: readonly TodoTarget[]): string {
	const shown = targets.slice(0, 3).map((t) => `${t.kind} "${t.name}"`)
	if (targets.length > shown.length) shown.push(`and ${targets.length - shown.length} more`)
	return shown.join(", ")
}

/**
 * Conservative manual-command target matching: exact case-insensitive first,
 * then a unique substring. Multiple matches are always an error — a command
 * never silently chooses between ambiguous targets.
 */
export function resolveTodoTarget(
	phases: readonly TodoPhase[],
	query: string,
): { target: TodoTarget } | { error: string } {
	const q = labelKey(query)
	if (!q) return { error: "empty target" }

	const exact: TodoTarget[] = []
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (labelKey(task.content) === q) exact.push({ kind: "task", name: task.content })
		}
	}
	for (const phase of phases) {
		if (labelKey(phase.name) === q) exact.push({ kind: "phase", name: phase.name })
	}
	if (exact.length === 1) return { target: exact[0] }
	if (exact.length > 1) return { error: `ambiguous target "${query}": matches ${describeTargets(exact)}` }

	const partial: TodoTarget[] = []
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (labelKey(task.content).includes(q)) partial.push({ kind: "task", name: task.content })
		}
	}
	for (const phase of phases) {
		if (labelKey(phase.name).includes(q)) partial.push({ kind: "phase", name: phase.name })
	}
	if (partial.length === 1) return { target: partial[0] }
	if (partial.length > 1) return { error: `ambiguous target "${query}": matches ${describeTargets(partial)}` }
	return { error: `no task or phase matches "${query}"` }
}

/**
 * Split `/todo block <target> [reason]` into target and reason by finding the
 * longest word prefix that resolves to exactly one target. Encountering an
 * ambiguous prefix stops the search instead of shortening past the ambiguity.
 */
export function splitBlockTarget(
	phases: readonly TodoPhase[],
	text: string,
): { target: TodoTarget; reason?: string } | { error: string } {
	const words = text.split(/\s+/).filter(Boolean)
	for (let count = words.length; count >= 1; count -= 1) {
		const candidate = words.slice(0, count).join(" ")
		const resolved = resolveTodoTarget(phases, candidate)
		if ("target" in resolved) {
			const reason = words.slice(count).join(" ").trim()
			return reason ? { target: resolved.target, reason } : { target: resolved.target }
		}
		if (resolved.error.startsWith("ambiguous")) return { error: resolved.error }
	}
	return { error: `no task or phase matches "${text}"` }
}

// ---------------------------------------------------------------- operations

function ok(phases: readonly TodoPhase[], message: string): TodoApplyResult {
	return { ok: true, phases: cloneBoard(phases), message }
}

function err(error: string): TodoApplyResult {
	return { ok: false, error }
}

function requireSingleTarget(
	params: TodoParams,
	op: TodoOperation,
): { ok: true; kind: TodoTargetKind } | { ok: false; error: string } {
	const hasTask = typeof params.task === "string" && normalizeLabel(params.task) !== ""
	const hasPhase = typeof params.phase === "string" && normalizeLabel(params.phase) !== ""
	if (hasTask && hasPhase) return { ok: false, error: `${op} needs either task or phase, not both` }
	if (!hasTask && !hasPhase) return { ok: false, error: `${op} requires an explicit task or phase` }
	return { ok: true, kind: hasTask ? "task" : "phase" }
}

function blockerFromReason(reason: unknown): string | undefined {
	if (typeof reason !== "string") return undefined
	const collapsed = truncateLabel(normalizeLabel(reason), BLOCKER_MAX_CHARS)
	return collapsed === "" ? undefined : collapsed
}

function countTasks(phases: readonly TodoPhase[]): number {
	return phases.reduce((sum, phase) => sum + phase.tasks.length, 0)
}

/** Common concise tail appended to mutation results. */
export function formatBoardStatus(phases: readonly TodoPhase[]): string {
	const stats = boardStats(phases)
	const lines: string[] = []
	const active = activeTask(phases)
	if (active) lines.push(`Active: ${active.task.content}`)
	const next = firstPendingTask(phases)
	if (next) lines.push(`Next: ${next.task.content}`)
	lines.push(`Progress: ${stats.completed}/${stats.total}`)
	if (stats.blocked > 0) lines.push(`Blocked: ${stats.blocked}`)
	return lines.join("\n")
}

const MUTATING_OPS: readonly TodoOperation[] = [
	"start",
	"done",
	"drop",
	"block",
	"unblock",
	"rm",
]

/**
 * Apply one operation to a clone of the board. Canonical state is only
 * replaced when the whole operation validates and the resulting board holds
 * the single-active invariant; every failure returns before the clone is
 * returned, so a failed mutation can never leave partial state behind.
 */
export function applyTodoOperation(
	current: readonly TodoPhase[],
	params: TodoParams,
): TodoApplyResult {
	const op = params.op
	if (op === undefined) return err("todo requires an explicit op")

	if (current.length === 0 && MUTATING_OPS.includes(op)) {
		return err("no todo board; initialize one with the init op first")
	}

	switch (op) {
		case "init": {
			const list = params.list
			if (!Array.isArray(list) || list.length === 0) {
				return err("init requires a non-empty list of phases")
			}
			const phaseKeys = new Set<string>()
			const taskOwners = new Map<string, string>()
			const phases: TodoPhase[] = []
			for (const entry of list) {
				const name = typeof entry?.phase === "string" ? normalizeLabel(entry.phase) : ""
				if (!name) return err("every phase needs a non-empty name")
				const phaseKey = labelKey(name)
				if (phaseKeys.has(phaseKey)) return err(`duplicate phase "${name}"`)
				phaseKeys.add(phaseKey)

				if (!Array.isArray(entry?.items) || entry.items.length === 0) {
					return err(`phase "${name}" has no tasks`)
				}
				const tasks: TodoItem[] = []
				for (const raw of entry.items) {
					const content = typeof raw === "string" ? normalizeLabel(raw) : ""
					if (!content) return err(`phase "${name}" has an empty task label`)
					const key = labelKey(content)
					const owner = taskOwners.get(key)
					if (owner !== undefined) {
						return err(`duplicate task "${content}" (already in "${owner}")`)
					}
					taskOwners.set(key, name)
					tasks.push({ content, status: "pending" })
				}
				phases.push({ name, tasks })
			}
			const board = normalizeBoard(phases)
			return ok(
				board,
				`Initialized ${phases.length} phase(s), ${countTasks(phases)} task(s)\n${formatBoardStatus(board)}`,
			)
		}

		case "start": {
			if (typeof params.phase === "string" && normalizeLabel(params.phase) !== "") {
				return err("start targets one task; provide task only")
			}
			const taskParam = typeof params.task === "string" ? normalizeLabel(params.task) : ""
			if (!taskParam) return err("start requires an explicit task")
			const found = locateTask(current, taskParam)
			if (!found) return err(`no task matches "${taskParam}"`)
			if (found.task.status === "blocked") {
				return err(`"${found.task.content}" is blocked; unblock it first`)
			}
			if (found.task.status === "completed" || found.task.status === "abandoned") {
				return err(`"${found.task.content}" is already ${found.task.status}`)
			}
			const board = cloneBoard(current)
			for (const phase of board) {
				for (const task of phase.tasks) {
					if (task.status === "in_progress") task.status = "pending"
				}
			}
			const target = locateTask(board, taskParam)
			/* istanbul ignore next -- the target was located in `current` above */
			if (!target) return err(`no task matches "${taskParam}"`)
			target.task.status = "in_progress"
			const normalized = normalizeBoard(board)
			return ok(normalized, `Started: ${target.task.content}\n${formatBoardStatus(normalized)}`)
		}

		case "done": {
			const target = requireSingleTarget(params, op)
			if (!target.ok) return err(target.error)
			const board = cloneBoard(current)
			let label: string
			if (target.kind === "task") {
				const found = locateTask(board, params.task ?? "")
				if (!found) return err(`no task matches "${params.task ?? ""}"`)
				if (found.task.status === "completed") {
					return ok(board, `Already completed: ${found.task.content}`)
				}
				if (found.task.status === "abandoned") {
					return err(
						`"${found.task.content}" is abandoned; add it again with append if it is back in scope`,
					)
				}
				found.task.status = "completed"
				delete found.task.blocker
				label = `Completed: ${found.task.content}`
			} else {
				const phase = locatePhase(board, params.phase ?? "")
				if (!phase) return err(`no phase matches "${params.phase ?? ""}"`)
				let changed = 0
				for (const task of phase.tasks) {
					if (task.status === "pending" || task.status === "in_progress" || task.status === "blocked") {
						task.status = "completed"
						delete task.blocker
						changed += 1
					}
				}
				if (changed === 0) return ok(board, `Nothing open to complete in phase "${phase.name}"`)
				label = `Completed ${changed} task(s) in phase "${phase.name}"`
			}
			const normalized = normalizeBoard(board)
			return ok(normalized, `${label}\n${formatBoardStatus(normalized)}`)
		}

		case "drop": {
			const target = requireSingleTarget(params, op)
			if (!target.ok) return err(target.error)
			const board = cloneBoard(current)
			let label: string
			if (target.kind === "task") {
				const found = locateTask(board, params.task ?? "")
				if (!found) return err(`no task matches "${params.task ?? ""}"`)
				if (found.task.status === "completed" || found.task.status === "abandoned") {
					return ok(board, `Already ${found.task.status}: ${found.task.content}`)
				}
				found.task.status = "abandoned"
				delete found.task.blocker
				label = `Abandoned: ${found.task.content}`
			} else {
				const phase = locatePhase(board, params.phase ?? "")
				if (!phase) return err(`no phase matches "${params.phase ?? ""}"`)
				let changed = 0
				for (const task of phase.tasks) {
					if (task.status === "pending" || task.status === "in_progress" || task.status === "blocked") {
						task.status = "abandoned"
						delete task.blocker
						changed += 1
					}
				}
				if (changed === 0) return ok(board, `Nothing open to abandon in phase "${phase.name}"`)
				label = `Abandoned ${changed} task(s) in phase "${phase.name}"`
			}
			const normalized = normalizeBoard(board)
			return ok(normalized, `${label}\n${formatBoardStatus(normalized)}`)
		}

		case "block": {
			const target = requireSingleTarget(params, op)
			if (!target.ok) return err(target.error)
			const reason = blockerFromReason(params.reason)
			const board = cloneBoard(current)
			let label: string
			if (target.kind === "task") {
				const found = locateTask(board, params.task ?? "")
				if (!found) return err(`no task matches "${params.task ?? ""}"`)
				if (found.task.status === "completed" || found.task.status === "abandoned") {
					return ok(board, `Already ${found.task.status}: ${found.task.content}`)
				}
				found.task.status = "blocked"
				if (reason !== undefined) found.task.blocker = reason
				label = reason ? `Blocked: ${found.task.content} — ${reason}` : `Blocked: ${found.task.content}`
			} else {
				const phase = locatePhase(board, params.phase ?? "")
				if (!phase) return err(`no phase matches "${params.phase ?? ""}"`)
				let changed = 0
				for (const task of phase.tasks) {
					if (task.status !== "pending" && task.status !== "in_progress") continue
					task.status = "blocked"
					if (reason !== undefined) task.blocker = reason
					changed += 1
				}
				if (changed === 0) return ok(board, `Nothing open to block in phase "${phase.name}"`)
				label = reason
					? `Blocked ${changed} task(s) in phase "${phase.name}" — ${reason}`
					: `Blocked ${changed} task(s) in phase "${phase.name}"`
			}
			const normalized = normalizeBoard(board)
			return ok(normalized, `${label}\n${formatBoardStatus(normalized)}`)
		}

		case "unblock": {
			const target = requireSingleTarget(params, op)
			if (!target.ok) return err(target.error)
			const board = cloneBoard(current)
			let label: string
			if (target.kind === "task") {
				const found = locateTask(board, params.task ?? "")
				if (!found) return err(`no task matches "${params.task ?? ""}"`)
				if (found.task.status !== "blocked") {
					return ok(board, `Not blocked: ${found.task.content}`)
				}
				found.task.status = "pending"
				delete found.task.blocker
				label = `Unblocked: ${found.task.content}`
			} else {
				const phase = locatePhase(board, params.phase ?? "")
				if (!phase) return err(`no phase matches "${params.phase ?? ""}"`)
				let changed = 0
				for (const task of phase.tasks) {
					if (task.status !== "blocked") continue
					task.status = "pending"
					delete task.blocker
					changed += 1
				}
				if (changed === 0) return ok(board, `Nothing blocked in phase "${phase.name}"`)
				label = `Unblocked ${changed} task(s) in phase "${phase.name}"`
			}
			const normalized = normalizeBoard(board)
			return ok(normalized, `${label}\n${formatBoardStatus(normalized)}`)
		}

		case "append": {
			const phaseName = typeof params.phase === "string" ? normalizeLabel(params.phase) : ""
			if (!phaseName) return err("append requires a phase name")
			if (!Array.isArray(params.items) || params.items.length === 0) {
				return err("append requires at least one task")
			}
			const board = cloneBoard(current)
			const known = new Set<string>()
			for (const phase of board) {
				for (const task of phase.tasks) known.add(labelKey(task.content))
			}
			const clean: string[] = []
			for (const raw of params.items) {
				const content = typeof raw === "string" ? normalizeLabel(raw) : ""
				if (!content) return err("append has an empty task label")
				const key = labelKey(content)
				if (known.has(key)) return err(`duplicate task "${content}"`)
				known.add(key)
				clean.push(content)
			}
			const existing = locatePhase(board, phaseName)
			if (existing) {
				for (const content of clean) existing.tasks.push({ content, status: "pending" })
			} else {
				board.push({
					name: phaseName,
					tasks: clean.map((content) => ({ content, status: "pending" })),
				})
			}
			const normalized = normalizeBoard(board)
			return ok(
				normalized,
				`Appended ${clean.length} task(s) to "${phaseName}"\n${formatBoardStatus(normalized)}`,
			)
		}

		case "rm": {
			const target = requireSingleTarget(params, op)
			if (!target.ok) return err(target.error)
			const board = cloneBoard(current)
			let label: string
			if (target.kind === "task") {
				let removed: string | null = null
				for (const phase of board) {
					const index = phase.tasks.findIndex((task) => labelKey(task.content) === labelKey(params.task ?? ""))
					if (index !== -1) {
						removed = phase.tasks[index].content
						phase.tasks.splice(index, 1)
						break
					}
				}
				if (removed === null) return err(`no task matches "${params.task ?? ""}"`)
				label = `Removed: ${removed}`
			} else {
				const key = labelKey(params.phase ?? "")
				const index = board.findIndex((phase) => labelKey(phase.name) === key)
				if (index === -1) return err(`no phase matches "${params.phase ?? ""}"`)
				const [removed] = board.splice(index, 1)
				label = `Removed phase "${removed.name}" (${removed.tasks.length} task(s))`
			}
			const normalized = normalizeBoard(board)
			return ok(normalized, `${label}\n${formatBoardStatus(normalized)}`)
		}

		case "clear":
			return ok([], "Board cleared")

		case "view":
			if (current.length === 0) return ok([], "No todo board.")
			return ok(cloneBoard(current), formatFullView(current))
	}
}

// ---------------------------------------------------------------- presentation

const STATUS_GLYPHS: Record<TodoStatus, string> = {
	pending: "○",
	in_progress: "→",
	completed: "✓",
	abandoned: "−",
	blocked: "!",
}

/** Full multi-line board, used by `/todo` and the expanded tool view. */
export function formatFullView(phases: readonly TodoPhase[]): string {
	if (phases.length === 0) return "No todo board."
	const lines: string[] = []
	let first = true
	for (const phase of phases) {
		if (phase.tasks.length === 0) continue
		if (!first) lines.push("")
		first = false
		const completed = phase.tasks.filter((task) => task.status === "completed").length
		lines.push(`${phase.name.padEnd(32)} ${completed}/${phase.tasks.length}`.trimEnd())
		for (const task of phase.tasks) {
			const suffix = task.status === "blocked" && task.blocker ? `  (${task.blocker})` : ""
			lines.push(`  ${STATUS_GLYPHS[task.status]} ${task.content}${suffix}`)
		}
	}
	return lines.length > 0 ? lines.join("\n") : "No todo board."
}

/**
 * Compact persistent widget: current phase, progress, the active task, at
 * most two next pending tasks, and a blocked count when non-zero. Completed
 * and abandoned work stays in canonical state but never shows here.
 */
export function formatWidgetLines(phases: readonly TodoPhase[]): string[] {
	if (phases.length === 0) return []
	const stats = boardStats(phases)
	if (stats.open === 0 && stats.blocked === 0) return []
	const active = activeTask(phases)
	const currentPhase =
		active?.phase ??
		phases.find((phase) => phase.tasks.some((task) => task.status === "pending" || task.status === "blocked")) ??
		phases[0]
	const lines: string[] = [
		`${truncateLabel(currentPhase.name, 40)} · ${stats.completed}/${stats.total}`,
	]
	if (active) lines.push(`→ ${truncateLabel(active.task.content, WIDGET_LABEL_MAX_CHARS)}`)
	const next: TodoItem[] = []
	const activeKey = active ? labelKey(active.task.content) : null
	for (const phase of phases) {
		for (const task of phase.tasks) {
			if (task.status !== "pending") continue
			if (activeKey !== null && labelKey(task.content) === activeKey) continue
			next.push(task)
			if (next.length >= WIDGET_NEXT_TASKS) break
		}
		if (next.length >= WIDGET_NEXT_TASKS) break
	}
	for (const task of next) lines.push(`  ${truncateLabel(task.content, WIDGET_LABEL_MAX_CHARS)}`)
	if (stats.blocked > 0) lines.push(`! ${stats.blocked} blocked`)
	return lines
}

interface ContextCaps {
	phase: number
	task: number
	blocker: number
	next: boolean
	blocked: boolean
}

const CONTEXT_CAPS: readonly ContextCaps[] = [
	{ phase: 40, task: 80, blocker: 60, next: true, blocked: true },
	{ phase: 24, task: 48, blocker: 40, next: true, blocked: true },
	{ phase: 20, task: 36, blocker: 28, next: false, blocked: true },
	{ phase: 16, task: 24, blocker: 20, next: false, blocked: false },
]

function buildTodoContext(phases: readonly TodoPhase[], caps: ContextCaps): string {
	const stats = boardStats(phases)
	const active = activeTask(phases)
	const currentPhase =
		active?.phase ??
		phases.find((phase) => phase.tasks.some((task) => task.status === "pending" || task.status === "blocked")) ??
		phases[0]
	const body: string[] = []
	const phaseSuffix = currentPhase ? ` · phase: ${truncateLabel(currentPhase.name, caps.phase)}` : ""
	body.push(`${stats.completed}/${stats.total} done${phaseSuffix}`)
	if (active) {
		body.push(`active: ${truncateLabel(active.task.content, caps.task)}`)
		const next = firstPendingTask(phases)
		if (caps.next && next) body.push(`next: ${truncateLabel(next.task.content, caps.task)}`)
	} else if (caps.blocked) {
		const blocked = firstBlockedTask(phases)
		if (blocked) {
			const reason = blocked.task.blocker
				? ` — ${truncateLabel(blocked.task.blocker, caps.blocker)}`
				: ""
			body.push(`blocked: ${truncateLabel(blocked.task.content, caps.task)}${reason}`)
		}
	}
	body.push(`${stats.open} open${stats.blocked > 0 ? ` · ${stats.blocked} blocked` : ""}`)
	return `<todo_context>\n${body.join("\n")}\n</todo_context>`
}

/**
 * Compact request-local pointer. Returns null when there is no open work:
 * a cleared board, a fully completed board, and an all-abandoned board inject
 * nothing. The result is bounded by `maxChars`; progressively tighter caps
 * drop the next-task line and blocker detail before a final hard truncation.
 */
export function formatTodoContext(
	phases: readonly TodoPhase[],
	maxChars: number = TODO_CONTEXT_MAX_CHARS,
): string | null {
	const stats = boardStats(phases)
	if (stats.total === 0 || stats.open + stats.blocked === 0) return null
	for (const caps of CONTEXT_CAPS) {
		const text = buildTodoContext(phases, caps)
		if ([...text].length <= maxChars) return text
	}
	const strict = buildTodoContext(phases, CONTEXT_CAPS[CONTEXT_CAPS.length - 1])
	const chars = [...strict]
	if (chars.length <= maxChars) return strict
	const openTag = "<todo_context>\n"
	const closeTag = "\n</todo_context>"
	const wrapperLength = [...openTag].length + [...closeTag].length
	// A cap too small to hold the wrapper is honored by cutting the whole
	// string: better an oversized-free fragment than a violated bound.
	if (maxChars <= wrapperLength) return chars.slice(0, Math.max(0, maxChars)).join("")
	const budget = maxChars - wrapperLength - 1
	return `${openTag}${chars.slice([...openTag].length, [...openTag].length + budget).join("")}…${closeTag}`
}

export interface TodoContextMessage {
	role: "custom"
	customType: string
	content: string
	display: false
	timestamp: number
}

/** Request-local custom message; Pi 0.87 projects `custom` role as user text. */
export function buildTodoContextMessage(
	text: string,
	timestamp: number = Date.now(),
): TodoContextMessage {
	return {
		role: "custom",
		customType: TODO_CONTEXT_TYPE,
		content: text,
		display: false,
		timestamp,
	}
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

// ---------------------------------------------------------------- reconstruction

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Validate and normalize one persisted snapshot ({ phases: [...] }). Anything
 * malformed returns null and is skipped by reconstruction, so a bad entry can
 * never poison the board.
 */
export function parseBoardSnapshot(value: unknown): TodoPhase[] | null {
	if (!isRecord(value)) return null
	const phasesValue = value.phases
	if (!Array.isArray(phasesValue)) return null
	const phases: TodoPhase[] = []
	for (const rawPhase of phasesValue) {
		if (!isRecord(rawPhase)) return null
		const name = typeof rawPhase.name === "string" ? normalizeLabel(rawPhase.name) : ""
		if (!name) return null
		if (!Array.isArray(rawPhase.tasks)) return null
		const tasks: TodoItem[] = []
		for (const rawTask of rawPhase.tasks) {
			if (!isRecord(rawTask)) return null
			const content = typeof rawTask.content === "string" ? normalizeLabel(rawTask.content) : ""
			const status = rawTask.status
			if (!content || typeof status !== "string" || !VALID_STATUSES.includes(status as TodoStatus)) {
				return null
			}
			const task: TodoItem = { content, status: status as TodoStatus }
			if (typeof rawTask.blocker === "string") {
				const blocker = normalizeLabel(rawTask.blocker)
				if (blocker) task.blocker = blocker
			}
			tasks.push(task)
		}
		phases.push({ name, tasks })
	}
	return normalizeBoard(phases)
}

/**
 * Rebuild the board from the active branch, in order. Both model tool results
 * (`details.phases`) and manual `okazakee:todo-state` custom entries carry a
 * full snapshot; whichever valid snapshot is latest on the branch wins. The
 * scan is pure, so branch navigation and resume reconstruct correctly and no
 * disk state can leak across sessions.
 */
export function reconstructBoard(entries: readonly BranchEntryLike[]): TodoPhase[] {
	let board: TodoPhase[] = []
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue
		if (entry.type === "custom" && entry.customType === TODO_ENTRY_TYPE) {
			const parsed = parseBoardSnapshot(entry.data)
			if (parsed !== null) board = parsed
			continue
		}
		if (
			entry.type === "message" &&
			entry.message?.role === "toolResult" &&
			entry.message.toolName === TODO_TOOL_NAME
		) {
			const parsed = parseBoardSnapshot(entry.message.details)
			if (parsed !== null) board = parsed
		}
	}
	return board
}

// ---------------------------------------------------------------- tool presentation

export function describeToolCall(params: TodoParams): string {
	const op = params.op ?? "?"
	if (op === "init") {
		const list = Array.isArray(params.list) ? params.list : []
		const tasks = list.reduce((sum, entry) => sum + (Array.isArray(entry?.items) ? entry.items.length : 0), 0)
		return `todo init · ${list.length} phase(s), ${tasks} task(s)`
	}
	if (op === "append") {
		const count = Array.isArray(params.items) ? params.items.length : 0
		return `todo append · ${params.phase ?? "?"} (+${count})`
	}
	if (op === "clear") return "todo clear"
	if (op === "view") return "todo view"
	const target = params.task ?? params.phase
	if (op === "block" && typeof params.reason === "string" && normalizeLabel(params.reason)) {
		return `todo block ${target ?? "?"} · ${truncateLabel(normalizeLabel(params.reason), 40)}`
	}
	return `todo ${op}${target ? ` ${target}` : ""}`
}

export function textFromToolContent(content: unknown): string {
	if (!Array.isArray(content)) return ""
	const parts: string[] = []
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text)
	}
	return parts.join("\n")
}

export function textComponent(lines: string[]): TodoTextComponent {
	return {
		render: () => lines,
		invalidate: () => {
			// No cached state.
		},
	}
}

// ---------------------------------------------------------------- tool schema

export const TODO_TOOL_DESCRIPTION =
	"Track the bounded execution working set for a multi-step task as ordered phases of tasks. " +
	"Task content is the stable identifier: labels are unique across the whole board and must not be renamed. " +
	"Ops: init replaces the board from a list of phases/items; start/done/drop/block/unblock/rm act on one explicit task or phase; " +
	"append adds tasks; clear empties the board; view prints it read-only. Exactly one task is in progress at a time; " +
	"the next pending task is promoted automatically, and blocked tasks never promote until unblocked."

export const TODO_TOOL_GUIDELINES: string[] = [
	"Use the todo tool when work has 3 or more genuinely distinct execution steps, when the user explicitly asks for a checklist or task list, when the user supplies multiple implementation requirements, or when new requirements arrive mid-task.",
	"If the user gives an explicit numbered or bulleted list of requested items, call todo init with every item as its own task unless items are literally the same operation; never collapse a multi-item request into one generic task.",
	"Do not create a todo board for ordinary questions, one-line fixes, trivial shell or system actions, or simple factual lookups.",
	"Task labels are stable identifiers: about 5-10 specific words, unique across the whole board, never renamed mid-flight.",
	"Keep exploratory plan-mode work free of a competing execution board unless the user asks for one; once a plan is executable, initialize the board from it.",
	"The todo board is the current execution breakdown only; it does not replace plan mode, a high-level goal, or delegated subagent work.",
]

export const TODO_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		op: {
			type: "string",
			enum: [...TODO_OPERATIONS],
			description: "Operation to perform.",
		},
		list: {
			type: "array",
			description: "init: ordered phases, each with its task labels.",
			items: {
				type: "object",
				properties: {
					phase: { type: "string" },
					items: { type: "array", items: { type: "string" } },
				},
				required: ["phase", "items"],
				additionalProperties: false,
			},
		},
		phase: {
			type: "string",
			description: "Phase name for done/drop/block/unblock/rm/append.",
		},
		task: {
			type: "string",
			description: "Exact task content for start/done/drop/block/unblock/rm.",
		},
		items: {
			type: "array",
			items: { type: "string" },
			description: "append: task labels to add to the phase.",
		},
		reason: {
			type: "string",
			description: "block: optional one-line reason.",
		},
	},
	required: ["op"],
	additionalProperties: false,
} as const

export const TODO_HELP = [
	"/todo                          show the full board",
	"/todo help                     this help",
	"/todo append [phase] <task>    add a task (default phase: Tasks)",
	"/todo start <task>             make one task active",
	"/todo done <task|phase>        complete a task or every open task in a phase",
	"/todo drop <task|phase>        abandon a task or phase",
	"/todo block <task|phase> [reason]  mark work blocked",
	"/todo unblock <task|phase>     return blocked work to pending",
	"/todo rm <task|phase>          remove a task or phase",
	"/todo clear                    clear the board",
	"",
	"Targets accept case-insensitive exact matches or a unique substring.",
].join("\n")

// ---------------------------------------------------------------- extension

export default function todoExtension(pi: ExtensionAPI): void {
	// Delegated pi-subagent children must never own or mutate the parent board.
	if (isSubagentProcess(process.env)) return

	let board: TodoPhase[] = []
	// One advisory reminder per user submission: armed by before_agent_start,
	// consumed (and cleared) by the first context event of that run.
	let pendingTodoNudge: TodoNudgeKind | null = null
	// Raw text of the most recent interactive/RPC submission. The complexity
	// heuristic must classify what the user actually typed, not the expanded
	// prompt: skill/template/extension expansion can add task-shaped text that
	// the user never wrote. Null means no user candidate is pending (extension
	// input, already consumed, or cleared by a session boundary).
	let pendingRawUserPrompt: string | null = null

	const updateWidget = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return
		try {
			const lines = formatWidgetLines(board)
			ctx.ui.setWidget(TODO_WIDGET_KEY, lines.length > 0 ? lines : undefined)
		} catch {
			// The widget is cosmetic; never break the agent over it.
		}
	}

	const restoreFromBranch = (ctx: ExtensionContext, leafId?: string | null): void => {
		try {
			board = reconstructBoard(ctx.sessionManager.getBranch(leafId ?? undefined))
		} catch {
			board = []
		}
		updateWidget(ctx)
	}

	const persistManual = (phases: TodoPhase[], ctx: ExtensionContext, message: string): void => {
		pi.appendEntry(TODO_ENTRY_TYPE, { phases })
		board = phases
		updateWidget(ctx)
		ctx.ui.notify(message, "info")
	}

	pi.registerTool({
		name: TODO_TOOL_NAME,
		label: "todo",
		description: TODO_TOOL_DESCRIPTION,
		promptSnippet: "Manage the session todo board for multi-step execution scopes.",
		promptGuidelines: TODO_TOOL_GUIDELINES,
		executionMode: "sequential",
		parameters: TODO_TOOL_PARAMETERS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = applyTodoOperation(board, params as TodoParams)
			if (!result.ok) throw new Error(result.error)
			board = result.phases
			updateWidget(ctx)
			return {
				content: [{ type: "text" as const, text: result.message }],
				details: {
					op: (params.op ?? "view") as TodoOperation,
					phases: result.phases,
				},
			}
		},
		renderCall(args) {
			return textComponent([describeToolCall(args as TodoParams)])
		},
		renderResult(result, options) {
			if (options.expanded && result.details) {
				return textComponent(formatFullView((result.details as TodoDetails).phases))
			}
			return textComponent(textFromToolContent(result.content).split("\n"))
		},
	})

	pi.registerCommand("todo", {
		description: "Show or edit the session todo board",
		handler: async (rawArgs, ctx) => {
			const args = (rawArgs ?? "").trim()
			if (args === "" || args === "view") {
				ctx.ui.notify(formatFullView(board), "info")
				return
			}

			const space = args.search(/\s/)
			const sub = (space === -1 ? args : args.slice(0, space)).toLowerCase()
			const rest = (space === -1 ? "" : args.slice(space + 1)).trim()

			const usage = (text: string): void => {
				ctx.ui.notify(`${text}\n\n${TODO_HELP}`, "warning")
			}

			switch (sub) {
				case "help":
					ctx.ui.notify(TODO_HELP, "info")
					return

				case "clear": {
					if (rest) {
						usage("clear takes no arguments.")
						return
					}
					const result = applyTodoOperation(board, { op: "clear" })
					if (!result.ok) {
						ctx.ui.notify(result.error, "warning")
						return
					}
					persistManual(result.phases, ctx, result.message)
					return
				}

				case "append": {
					if (!rest) {
						usage("usage: /todo append [phase] <task>")
						return
					}
					const parts = rest.split(/\s+/)
					const phase = parts.length === 1 ? "Tasks" : parts[0]
					const task = parts.length === 1 ? parts[0] : parts.slice(1).join(" ")
					const result = applyTodoOperation(board, { op: "append", phase, items: [task] })
					if (!result.ok) {
						ctx.ui.notify(result.error, "warning")
						return
					}
					persistManual(result.phases, ctx, result.message)
					return
				}

				case "start": {
					if (!rest) {
						usage("usage: /todo start <task>")
						return
					}
					const resolved = resolveTodoTarget(board, rest)
					if ("error" in resolved) {
						ctx.ui.notify(resolved.error, "warning")
						return
					}
					if (resolved.target.kind !== "task") {
						ctx.ui.notify("start needs a task, not a phase.", "warning")
						return
					}
					const result = applyTodoOperation(board, { op: "start", task: resolved.target.name })
					if (!result.ok) {
						ctx.ui.notify(result.error, "warning")
						return
					}
					persistManual(result.phases, ctx, result.message)
					return
				}

				case "done":
				case "drop":
				case "unblock":
				case "rm": {
					if (!rest) {
						usage(`usage: /todo ${sub} <task|phase>`)
						return
					}
					const resolved = resolveTodoTarget(board, rest)
					if ("error" in resolved) {
						ctx.ui.notify(resolved.error, "warning")
						return
					}
					const params: TodoParams =
						resolved.target.kind === "task"
							? { op: sub, task: resolved.target.name }
							: { op: sub, phase: resolved.target.name }
					const result = applyTodoOperation(board, params)
					if (!result.ok) {
						ctx.ui.notify(result.error, "warning")
						return
					}
					persistManual(result.phases, ctx, result.message)
					return
				}

				case "block": {
					if (!rest) {
						usage("usage: /todo block <task|phase> [reason]")
						return
					}
					const resolved = splitBlockTarget(board, rest)
					if ("error" in resolved) {
						ctx.ui.notify(resolved.error, "warning")
						return
					}
					const params: TodoParams =
						resolved.target.kind === "task"
							? { op: "block", task: resolved.target.name, reason: resolved.reason }
							: { op: "block", phase: resolved.target.name, reason: resolved.reason }
					const result = applyTodoOperation(board, params)
					if (!result.ok) {
						ctx.ui.notify(result.error, "warning")
						return
					}
					persistManual(result.phases, ctx, result.message)
					return
				}

				default:
					usage(`unknown /todo subcommand "${sub}".`)
					return
			}
		},
	})

	pi.on("session_start", (_event, ctx) => {
		pendingTodoNudge = null
		pendingRawUserPrompt = null
		restoreFromBranch(ctx)
	})

	pi.on("session_tree", (event, ctx) => {
		restoreFromBranch(ctx, event.newLeafId)
	})

	// Capture the raw user prompt here: `input` carries the pre-expansion text
	// and the source. Only genuine user prompts (interactive/RPC) are retained;
	// extension-sent prompts (pi-goal continuations etc.) clear the candidate.
	pi.on("input", (event) => {
		pendingRawUserPrompt =
			event.source === "interactive" || event.source === "rpc" ? event.text : null
	})

	// Arm from the retained raw prompt. The expanded event.prompt is
	// deliberately ignored: expansion can inject task-shaped text.
	pi.on("before_agent_start", () => {
		const rawPrompt = pendingRawUserPrompt
		pendingRawUserPrompt = null
		if (rawPrompt === null) {
			pendingTodoNudge = null
			return
		}
		pendingTodoNudge = shouldSuggestTodo(rawPrompt) ? nudgeKindFor(board) : null
	})

	// A nudge or raw candidate that never reached a provider request (aborted
	// run) must not leak into a later turn. agent_end fires once per agent run,
	// after any context consumption; clearing here is a no-op in the normal path.
	pi.on("agent_end", () => {
		pendingTodoNudge = null
		pendingRawUserPrompt = null
	})

	// Request-local scope injection. Runs before every model request, so the
	// active pointer always reflects state changes made earlier in the turn.
	// The nudge is consumed on the first request; todo_context keeps refreshing.
	pi.on("context", (event) => {
		const messages = [...event.messages]
		let changed = false
		if (pendingTodoNudge !== null) {
			messages.push(buildTodoNudgeMessage(formatTodoNudge(pendingTodoNudge)))
			pendingTodoNudge = null
			changed = true
		}
		const text = formatTodoContext(board)
		if (text !== null) {
			messages.push(buildTodoContextMessage(text))
			changed = true
		}
		return changed ? { messages } : undefined
	})
}
