import {
	activeTask,
	boardStats,
	firstBlockedTask,
	firstPendingTask,
	isRecord,
} from "./board"
import { TODO_CONTEXT_MAX_CHARS, TODO_CONTEXT_TYPE, WIDGET_LABEL_MAX_CHARS, WIDGET_NEXT_TASKS } from "./constants"
import { labelKey, normalizeLabel, truncateLabel } from "./text"
import type { TodoItem, TodoParams, TodoPhase, TodoStatus, TodoTextComponent } from "./types"

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
