import { TODO_OPERATIONS } from "./constants"

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
