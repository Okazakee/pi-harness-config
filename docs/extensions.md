# Extensions and context management

Session-behavior extensions and the context-management policy shipped with
this harness. The backed-up file mapping is owned by
[`provenance.md`](provenance.md).

## Context management (RTK + DCP + native compaction)

Three independent layers reduce context cost; none replaces another:

- **RTK** rewrites shell commands and shrinks tool output *before* it enters
  session history.
- **DCP** (`pi-dcp`) prunes stale, redundant, and oversized *historical tool
  payloads* only in the request-local context sent to the model. It never
  mutates the canonical Pi session history.
- **Pi native compaction** stays enabled and remains the semantic long-term
  history mechanism.

DCP is configured conservatively in [`pi/dcp.jsonc`](../pi/dcp.jsonc) — the
package is pinned to an exact commit (not floating `main`), recent turns and
autonomous steps are protected, `subagent` results are permanently protected,
and the riskier strategies (`supersedeWrites`, experimental `distillTool`,
`compressTool`, `llmAutonomy`) stay disabled.

## Effective working directory (`/cd`)

Pi fixes the session working directory at process start and exposes no setter
for it, and `!cd …` in the shell cannot persist either — every shell command
runs in its own `bash -c` process. [`pi/extensions/cwd-switch.ts`](../pi/extensions/cwd-switch.ts)
therefore adds an **effective** directory alongside the session one:

```text
/cd <path>    set it (~, relative paths, and - for the previous one)
/cd           show the effective and session directory
/cd reset     drop the override
```

While an override is active, tool inputs are rewritten:

- `bash` commands get a `cd <dir> || exit 1` line. It is a separate line rather
  than an `&&` join, so multi-line scripts and heredocs still run entirely
  inside the directory, and a failed `cd` aborts instead of silently running in
  the wrong place.
- `read` / `write` / `edit` resolve a relative `path` against the effective
  directory.
- `grep` / `find` / `ls` resolve `path`, or default their scope to it.
- Absolute paths are never touched.

The session directory itself does not change, so the footer would otherwise
show the wrong directory. `statusline.ts` renders the effective directory as an
extra segment whenever an override is active.

Limits worth knowing: tools registered by other extensions (lsp, subagent, mcp)
are not rewritten, and the git branch in the footer still reflects the session
directory. Tests: `scripts/test-cwd-switch.sh`.

## Execution scoping (`/todo`)

[`pi/extensions/todo.ts`](../pi/extensions/todo.ts) adds a bounded execution
working set for long, multi-step work. It is deliberately not another
scheduler — the layers stay separate:

```text
AGENTS.md    durable engineering policy
plan mode    approach and exploration
pi-goal      high-level persistent objective
todo         bounded execution working set (phases + one active task)
subagent     delegated specialist work
```

The model creates and advances the board through a `todo` tool (`init`,
`start`, `done`, `drop`, `block`, `unblock`, `append`, `rm`, `clear`, `view`).
Short, specific task labels are the stable identity; exactly one task is
`in_progress` at a time and the next pending task is promoted automatically,
while blocked tasks never promote until unblocked. The tool guidance asks the
model to use the board for work with three or more genuinely distinct steps
and to keep every item of an explicit user checklist as its own task.

Manual control:

```text
/todo                              show the full board
/todo help                         list the command surface
/todo append [phase] <task>        add a task
/todo start <task>                 make one task active
/todo done <task|phase>            complete a task or every open task in a phase
/todo drop <task|phase>            abandon work
/todo block <task|phase> [reason]  mark work blocked
/todo unblock <task|phase>         return blocked work to pending
/todo rm <task|phase>              remove a task or phase
/todo clear                        clear the board
```

Command targets accept case-insensitive exact matches or a unique substring;
ambiguous matches are rejected. While a board is open, a compact
`<todo_context>` pointer (progress, active phase, active task, next task,
open/blocked counts) is injected into every model request — it is
request-local and never appended to the transcript — and a small widget above
the editor shows the same pointer.

For prompts that locally look multi-step (an action checklist, three or more
distinct engineering actions, checklist wording, or a long execution brief),
the extension injects **one** request-local `<todo_nudge>` on the first model
request of that turn, encouraging the model to initialize or reconcile the
board. It is a deterministic local heuristic — no model call, no forced tool
call — and the reminder is never persisted into session history. Prompts that
read as explanation requests are biased against nudging unless they also
carry clear task structure.

State belongs to the **Pi session**, not to the filesystem: model tool results
and manual `/todo` snapshots reconstruct the board from the active session
branch, so it follows branch navigation, survives resume, and is unaffected by
`/cd`. There is no `TODO.md`, no `todo.json`, and no state file; nothing
todo-related is backed up because it is runtime session data. Delegated
`pi-subagent` children intentionally register no todo tool, command, context
injection, or widget — the board belongs to the parent/director session only.
DCP keeps `todo` results protected, so their model-facing text stays small.

Tests: `scripts/test-todo.sh`.

## Provider usage in the footer

[`pi/extensions/statusline.ts`](../pi/extensions/statusline.ts) renders the
active subscription provider's windows as a compact `tier · label X% (reset)`
segment, right-aligned in the custom footer. The parsers and the request shape
live in [`pi/extensions/statusline/usage.ts`](../pi/extensions/statusline/usage.ts):

- **OpenCode Go** (`opencode-go`) — `GET <baseUrl>/v1/usage`, rendering the
  rolling / weekly / monthly windows as `5h` / `7d` / `mo`.
- **OpenAI Codex** (`openai-codex`) — the pinned ChatGPT
  `https://chatgpt.com/backend-api/wham/usage` route, rendering the primary and
  secondary rate-limit windows with labels derived from their reported length.
- **Command Code** (`commandcode`) — the pinned
  `https://api.commandcode.ai/alpha/billing/credits` route, rendering the
  five-hour and weekly credit windows (`used`/`cap`) as `5h` / `7d`.

Fetches are best-effort and reuse the credential Pi already stores for the
provider; on any failure the segment is hidden and the last good snapshot is
kept. Each credential is only ever sent to its provider's pinned origin,
redirects are refused, and the ChatGPT account id is read from the OAuth
token's `chatgpt_account_id` claim. No credential is ever printed.

Tests: `scripts/test-statusline.sh`.

## Agent-dir secret loading (`secret-loader`)

[`pi/extensions/secret-loader.ts`](../pi/extensions/secret-loader.ts) bridges the
agent-dir secret store (`$PI_CODING_AGENT_DIR/.secrets/`, default
`~/.pi/agent/.secrets/`) to the process environment that
`@counterposition/pi-web-search` reads.

- Only `BRAVE_API_KEY`, `TAVILY_API_KEY`, `EXA_API_KEY`, and `JINA_API_KEY`
  are loaded; other files in the store stay file-only until the allowlist is
  extended deliberately.
- An already-set environment variable always wins, so shell/CI overrides keep
  working.
- Values are never logged, and a missing or blank file is simply skipped.
- The store itself is never backed up; the repository contract fails if a
  `.secrets/` directory ever appears inside the clone.

Tests: `scripts/test-secret-loader.sh`.
