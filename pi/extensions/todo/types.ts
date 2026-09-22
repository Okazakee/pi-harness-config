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
