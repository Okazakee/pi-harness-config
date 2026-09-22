import { TODO_ENTRY_TYPE, TODO_TOOL_NAME, VALID_STATUSES } from "./constants"
import { labelKey, normalizeLabel } from "./text"
import type { BranchEntryLike, LocatedTask, TodoItem, TodoPhase, TodoStats, TodoStatus } from "./types"

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

// ---------------------------------------------------------------- reconstruction

export function isRecord(value: unknown): value is Record<string, unknown> {
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
