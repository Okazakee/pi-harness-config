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
 * The implementation lives in `pi/extensions/todo/*` helper modules; this file
 * stays the discoverable entrypoint. Runtime imports are limited to those local
 * modules, and type-only imports are erased, so `scripts/todo/` can exercise
 * the pure state machine under Bun without a node_modules tree.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

import { reconstructBoard } from "./todo/board"
import { TODO_ENTRY_TYPE, TODO_TOOL_NAME, TODO_WIDGET_KEY } from "./todo/constants"
import {
	buildTodoNudgeMessage,
	formatTodoNudge,
	nudgeKindFor,
	shouldSuggestTodo,
	type TodoNudgeKind,
} from "./todo/nudge"
import { applyTodoOperation, resolveTodoTarget, splitBlockTarget } from "./todo/operations"
import {
	buildTodoContextMessage,
	describeToolCall,
	formatFullView,
	formatTodoContext,
	formatWidgetLines,
	textComponent,
	textFromToolContent,
} from "./todo/presentation"
import {
	TODO_HELP,
	TODO_TOOL_DESCRIPTION,
	TODO_TOOL_GUIDELINES,
	TODO_TOOL_PARAMETERS,
} from "./todo/schema"
import type { TodoDetails, TodoOperation, TodoParams, TodoPhase } from "./todo/types"

// Re-export the public surface so `pi/extensions/todo.ts` stays the single
// discoverable entrypoint for the extension and for `scripts/todo/`. `board.ts`
// and `constants.ts` additionally export names the split needed across modules
// (`isRecord`, `VALID_STATUSES`); explicit re-exports omit those internals so
// the facade surface stays exactly what it was before the split.
export * from "./todo/types"
export {
	BLOCKER_MAX_CHARS,
	LONG_PROMPT_CHARS,
	TODO_CONTEXT_MAX_CHARS,
	TODO_CONTEXT_TYPE,
	TODO_ENTRY_TYPE,
	TODO_NUDGE_MAX_CHARS,
	TODO_NUDGE_THRESHOLD,
	TODO_NUDGE_TYPE,
	TODO_OPERATIONS,
	TODO_TOOL_NAME,
	TODO_WIDGET_KEY,
	WIDGET_LABEL_MAX_CHARS,
	WIDGET_NEXT_TASKS,
} from "./todo/constants"
export * from "./todo/text"
export {
	activeTask,
	boardStats,
	cloneBoard,
	firstBlockedTask,
	firstPendingTask,
	locatePhase,
	locateTask,
	normalizeBoard,
	parseBoardSnapshot,
	reconstructBoard,
} from "./todo/board"
export * from "./todo/nudge"
export * from "./todo/operations"
export * from "./todo/presentation"
export * from "./todo/schema"

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
