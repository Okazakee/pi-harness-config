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

The session directory itself does not change, so the statusline would otherwise
show the wrong directory. `statusline.ts` renders the effective directory as an
extra segment in the top bar whenever an override is active.

Limits worth knowing: tools registered by other extensions (lsp, subagent, mcp)
are not rewritten, and the git branch in the top bar still reflects the session
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

## Statusline layout

[`pi/extensions/statusline.ts`](../pi/extensions/statusline.ts) builds a
two-row statusline. The top bar is a widget above the editor and stays visible
while the footer is replaced by the pinned rows below the editor:

```text
<spinner> 3m 07s        <folder> ~/proj <branch> main     (working)
<pi> 24m <history> 3m   <folder> ~/proj <branch> main     (idle: total + last run)
Command Code · DeepSeek V4.1 Flash · max · 2.4%/1M · CH87%    <bolt> 5h 0% (4h 51m) · 7d 5% (5d 14h) · mo 5% (25d)
```

- Top bar, left: while working, a single value — the spinner plus the current
  run's timer. When idle, the pi glyph plus the accumulated agent-work time
  (the sum of every run, so idle time while Pi sits open never counts),
  followed by a history glyph plus the last completed run's duration. The
  timer state lives on `globalThis`, so `/reload` keeps the totals and a
  running task's start time instead of resetting them.
- Top bar, right: a folder glyph before the session directory, the `/cd`
  effective directory when active (same glyph, accent color), and a
  git-branch glyph before the branch.
- Footer, left: provider label (the usage snapshot's tier — the provider for
  Command Code / OpenCode Go, the plan name for Codex — or the provider id when
  no usage endpoint applies), model name, thinking level, context-window usage
  and cache-hit rate. Command Code's `(CC)` catalog suffix is dropped because
  the provider is already named.
- Footer, right: the usage glyph followed by the active provider's windows.

Pi's built-in working row is hidden; the top bar already shows the spinner next
to the timings, so keeping both would render two spinners.

## Provider usage in the statusline

[`pi/extensions/statusline.ts`](../pi/extensions/statusline.ts) renders the
active subscription provider's windows as compact `label X% (reset)` groups
with the usage glyph, right-aligned in the footer; the snapshot's tier is
rendered to the left as the provider label. The parsers and the request shape
live in [`pi/extensions/statusline/usage.ts`](../pi/extensions/statusline/usage.ts):

- **OpenCode Go** (`opencode-go`) — `GET <baseUrl>/v1/usage`, rendering the
  rolling / weekly / monthly windows as `5h` / `7d` / `mo`.
- **OpenAI Codex** (`openai-codex`) — the pinned ChatGPT
  `https://chatgpt.com/backend-api/wham/usage` route, rendering the primary and
  secondary rate-limit windows with labels derived from their reported length.
- **Command Code** (`commandcode`) — the pinned
  `https://api.commandcode.ai/alpha/billing/credits` route renders the
  five-hour and weekly credit windows (`used`/`cap`) as `5h` / `7d`. The
  monthly window is derived from two more pinned routes fetched in parallel:
  `/alpha/usage/summary` (credits spent in the billing period) and
  `/alpha/billing/subscriptions` (period end for the countdown). Its cap is
  `spent + remaining monthly/purchased/free credits`, the same "used of pool"
  shape the provider package reports, so it renders as `mo X% (reset)`.

Fetches are best-effort and reuse the credential Pi already stores for the
provider; on any failure the affected window (or the whole segment) is hidden,
the last good snapshot is kept, and a missing summary/renewal route only drops
the derived monthly window. Each credential is only ever sent to its provider's
pinned origin, redirects are refused, and the ChatGPT account id is read from
the OAuth token's `chatgpt_account_id` claim. No credential is ever printed.

Tests: `scripts/test-statusline.sh`.

## Laya routing advisor (`/laya-routing`)

[`pi/extensions/laya-routing.ts`](../pi/extensions/laya-routing.ts) adds a
small advisory classifier for discretionary specialist delegation in root
sessions. Laya is not an agent: it makes one typed decision per user turn —
would auxiliary context help, and of what kind — and Pi stays free to ignore
it.

```text
user prompt
    |
    +--> deterministic bypass?  (explicit delegation / no-delegation /
    |                            low-information continuation / delegated
    |                            session / off mode / unusable input)
    |
    +--> language routing (Laya detect_language; uncertain -> English)
             |
             v
       shared warm daemon: english checkpoints | multilingual checkpoint
             |
             v
       typed purpose decision
             |
             v
       confidence gate (answer_confidence)
             |
             v
   request-local <delegation_hint> in advise mode
             |
             v
   the model decides: explore / research / architect / nobody
```

- **Modes** (`pi/laya-routing.json`, `off` / `shadow` / `advise`, default
  `shadow`): `off` is genuinely inert — no connect, no spawn, no models, no
  telemetry (and `/laya-routing mode off` disconnects a running instance);
  `shadow` classifies and records telemetry without injecting anything;
  `advise` injects the hint when `answer_confidence` clears the gate.
  `/laya-routing status` shows mode, daemon state, checkpoints, grace and the
  last classification; `/laya-routing mode <x>` writes the config file.
- **Semantics stay abstract from agent names.** The classifier answers a
  `purpose` enum (`none`, `local_context`, `external_context`, `architecture`)
  and the deterministic mapping lives in code: `local_context -> explore`,
  `external_context -> research`, `architecture -> architect`, `none -> no
  recommendation`.
- **Request-local only.** The hint is a `role: "custom"`, `display: false`
  message appended in the `context` event — the same mechanism as the todo
  nudge — so it is never written back to the session transcript. Explicit user
  intent always wins, and a hint can never trigger delegation by itself.
- **Runtime: one shared warm daemon per user.**
  [`pi/extensions/laya-routing/daemon.py`](../pi/extensions/laya-routing/daemon.py)
  is started by the first root Pi that needs it and owns a user-private Unix
  socket under `$XDG_RUNTIME_DIR/pi-laya` (fallback `/tmp/pi-laya-<uid>`; dir
  0700, socket 0600). It loads both checkpoints once and serializes inference.
  The socket connection *is* the lease: `session_start` connects (starting the
  daemon on first use), `session_shutdown` (quit, reload or session
  replacement) closes idempotently, and the daemon counts connected clients.
  With zero clients it arms the shutdown timer (`shutdownGraceMs`, default
  `300000`); a reconnect cancels it; expiry frees all model RAM and removes
  the socket. Idle Pi sessions keep the models resident, every Pi instance
  shares the same daemon, and no Pi ever reloads a model per prompt.
  A flock singleton plus the socket bind handle startup races; stale sockets
  are unlinked only while holding the lock.
- **Language routing and checkpoints.** Both stay resident for the daemon
  lifetime: `english` = `typed-decisions/`, `multilingual` = `multilingual/`.
  Selection uses Laya's own dependency-free `detect_language`; uncertain or
  short prompts default to English. `scripts/laya-routing-eval.py` scored the
  candidates on the synthetic 44-prompt fixture
  (`scripts/laya-routing-fixture.json`), English accuracy first: the
  `typed-decisions` checkpoint won 12/16 vs 11/16 (base root) and 10/16
  (multilingual), so it is the English checkpoint, while `multilingual`
  remains the Italian-capable one. Zero-shot accuracy is modest
  (`external_context` is the weakest class), which is exactly why the rollout
  default is `shadow`: the hints are measured before they influence anything.
- **Integrity.** The pinned revision is enforced: the daemon downloads
  `convaiinnovations/laya` at the lock's revision through
  `huggingface_hub` and loads the local snapshot path. Each checkpoint's
  `model.safetensors` sha256 is hashed before load and a mismatch degrades the
  daemon instead of serving. The installed `laya` version must equal the pin.
  The wheel digest in the lock is informational: pip resolves the pinned
  version from PyPI without hash mode, because locking the whole torch graph
  is out of scope. Weights stay in the huggingface cache and are never copied
  into the repository.
- **Fail-open.** A missing runtime or model, wrong pinned version, timeout,
  malformed payload, invalid enum, language-routing failure or unexpected
  exception produces no hint and a telemetry reason. A daemon crash is
  reconnected (or restarted) on the next classification attempt, bounded by a
  spawn cooldown so a broken runtime cannot loop.
- **Shadow telemetry.** One JSONL event per root turn (schema 2) under
  `$XDG_STATE_HOME/pi/laya-routing/decisions.jsonl` (default
  `~/.local/state/pi/laya-routing/decisions.jsonl`) — outside the agent dir
  and the backup repository. It records mode, language, checkpoint, daemon id,
  inference and transport latency, the confidence-gate outcome, the
  bypass/failure reason, and whether a `subagent` tool call was observed in
  the same agent run, so repeated `daemon_id` values prove warm reuse. It
  never records prompts, summaries, file names, tool payloads, source or
  environment values. `changed_course` is not measured: Pi exposes no reliable
  signal for it.
- **Measured locally** (Ryzen AI 9 HX 370, CPU): socket ready in 61 ms; both
  checkpoints ready in 5.3 s (`english` 2.97 s, `multilingual` 2.04 s);
  3.36 GB RSS with both resident; warm round trip EN ~300 ms and IT ~111 ms,
  comfortably inside the 800 ms advisory budget. `$XDG_RUNTIME_DIR/pi-laya/laya.log`
  records load times, client connects/disconnects and grace arm/exit events.

Tests: `scripts/test-laya-routing.sh`.

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
