import {
	activeTask,
	boardStats,
	cloneBoard,
	firstPendingTask,
	locatePhase,
	locateTask,
	normalizeBoard,
} from "./board"
import { BLOCKER_MAX_CHARS } from "./constants"
import { formatFullView } from "./presentation"
import { labelKey, normalizeLabel, truncateLabel } from "./text"
import type {
	TodoApplyResult,
	TodoItem,
	TodoOperation,
	TodoParams,
	TodoPhase,
	TodoTarget,
	TodoTargetKind,
} from "./types"

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
