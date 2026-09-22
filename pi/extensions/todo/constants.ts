import type { TodoOperation, TodoStatus } from "./types"

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

export const VALID_STATUSES: readonly TodoStatus[] = [
	"pending",
	"in_progress",
	"completed",
	"abandoned",
	"blocked",
]
