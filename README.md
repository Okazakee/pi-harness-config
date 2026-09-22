# Pi Harness Config

Declarative, reproducible backup of the **Pi** coding-agent configuration —
the parts needed to rebuild the harness on a fresh machine. This is
**configuration-as-code**, not a dump of runtime state.

This repository is the single source of truth for the Pi harness now that the
former `omp-harness-config` repo is retired.

- Pi version at backup time: **0.87.1**
- Full source-path mapping: [`docs/provenance.md`](docs/provenance.md)

## Repository layout

```text
pi-harness-config/
├── README.md
├── .gitignore
├── pi/                         # curated snapshot of ~/.pi/agent
│   ├── AGENTS.md               # global agent policy
│   ├── settings.json           # Pi settings (theme, models, TUI, packages)
│   ├── dcp.jsonc               # global DCP policy (conservative context pruning)
│   ├── keybindings.json
│   ├── patch-pi-renderer.py    # re-apply TUI renderer patches after updates
│   ├── logo.png
│   ├── agents/                 # subagent definitions (explore, review, ...)
│   ├── extensions/             # rtk, statusline, cwd-switch, welcome-header, markdown-tweaks
│   ├── themes/                 # okazakee.json
│   └── skills/                 # global Pi skills (incl. pi-config-backup)
├── mcp/
│   └── mcp.json                # MCP servers Pi reads (~/.config/mcp/mcp.json)
├── shared-skills/              # ~/.agents/skills (skills Pi loads globally)
├── deps/                       # pinned dependency declarations (locks)
│   ├── obscura.lock.json       # exact Obscura release, asset name and SHA-256
│   └── tools.lock.json         # pinned TruffleHog version + per-platform SHA-256
├── scripts/                    # repository tooling: checks, tests, installers
├── systemd/                    # user path unit: re-apply the renderer patch after updates
├── .githooks/                  # tracked pre-commit / pre-push hooks
├── .github/workflows/          # independent CI verification
├── .secrets/                   # LOCAL secret store — gitignored, never committed
└── docs/
    └── provenance.md           # live source path of every backed-up file
```

## Purpose

If the machine or Pi is reinstalled, this repository rebuilds the harness:
global policy, settings, custom subagents, extensions, themes, skills, and MCP
server definitions. Credentials and runtime state are deliberately absent.

## Context management (RTK + DCP + native compaction)

Three independent layers reduce context cost; none replaces another:

- **RTK** rewrites shell commands and shrinks tool output *before* it enters
  session history.
- **DCP** (`pi-dcp`) prunes stale, redundant, and oversized *historical tool
  payloads* only in the request-local context sent to the model. It never
  mutates the canonical Pi session history.
- **Pi native compaction** stays enabled and remains the semantic long-term
  history mechanism.

DCP is configured conservatively in [`pi/dcp.jsonc`](pi/dcp.jsonc) — the
package is pinned to an exact commit (not floating `main`), recent turns and
autonomous steps are protected, `subagent` results are permanently protected,
and the riskier strategies (`supersedeWrites`, experimental `distillTool`,
`compressTool`, `llmAutonomy`) stay disabled.

## Effective working directory (`/cd`)

Pi fixes the session working directory at process start and exposes no setter
for it, and `!cd …` in the shell cannot persist either — every shell command
runs in its own `bash -c` process. [`pi/extensions/cwd-switch.ts`](pi/extensions/cwd-switch.ts)
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

[`pi/extensions/todo.ts`](pi/extensions/todo.ts) adds a bounded execution
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

## What is backed up (allowlist)

`~/.pi/agent`: `AGENTS.md`, `settings.json`, `dcp.jsonc`,
`keybindings.json`, `patch-pi-renderer.py`, `logo.png`, and the `agents/`,
`extensions/`, `themes/`, `skills/` directories. Plus `~/.config/mcp/mcp.json`
and `~/.agents/skills/`.

## What is never backed up

- `auth.json` — OAuth tokens and API keys
- `sessions/` — conversation history
- `install/`, `npm/`, `bin/`, `git/` — binaries and package trees
- `models-store.json`, `mcp-cache.json` — regenerable caches
- `__pycache__/`, `*.pyc`

## Secrets — `.secrets/` (local, gitignored)

Secrets are **not** stored in this repository. They live in a local, gitignored
`.secrets/` folder at the repo root, one secret per file:

- **filename** = the secret's name (e.g. `OPENCODE_GO_API_KEY`)
- **file content** = the secret value

The folder is a core part of the working setup but is never committed. Agents
read a value only inside the command that needs it (e.g.
`curl -H "Authorization: Bearer $(cat .secrets/TOKEN)"`) and never print it to
chat, logs, or files. See [`.secrets/README.md`](.secrets/README.md).

## Backup and restore

Backup is driven by the `pi-config-backup` skill
(`~/.pi/agent/skills/pi-config-backup/`):

```bash
bash ~/.pi/agent/skills/pi-config-backup/scripts/backup.sh   # sync (no git ops)
git -C ~/Desktop/Projects/pi-harness-config status           # review
git -C ~/Desktop/Projects/pi-harness-config add -A && \
  git -C ~/Desktop/Projects/pi-harness-config commit -m "pi config: ..."
git -C ~/Desktop/Projects/pi-harness-config push             # requires authorization
```

Restore on a new machine (after installing Pi itself):

```bash
bash ~/.pi/agent/skills/pi-config-backup/scripts/restore.sh
```

`restore.sh` restores the config, then best-effort reinstalls the pieces that
are **not** config: Pi packages (`pi update --extensions`), the `obscura` MCP
binary (the exact release pinned in `deps/obscura.lock.json`, verified by
SHA-256 before extraction), and the TUI renderer patch (plus its `systemd
--user` update guard). It backs up any
existing live config first, never touches `auth.json`, and activates the
tracked Git hooks when it is restoring into a real Git checkout.

- Flags: `--yes` (no prompt), `--no-packages`, `--no-obscura`, `--no-patch`.
- Still manual: install Pi itself, then run `pi login` to store credentials.

### Version preflight (backup only)

Every backup starts by discovering the live versions/revisions of the harness
— Pi (runtime plus the managed `install/current-version` marker, which must
agree), RTK, every declared Pi package (`npm:` versions, `git:` commit pins),
DCP's pinned commit, Obscura (installed vs `deps/obscura.lock.json`),
TruffleHog (installed vs `deps/tools.lock.json`), Bun and Node. Discovery is
local and offline: it reads local binaries, settings, lock files and git
checkouts, never the network.

The repository is compared against that inventory **before any file is
copied**. Version drift is reported explicitly (`Pi 0.87.1 → 0.87.2`) and
current snapshot metadata is refreshed — the README backup-time line in place,
`pi/settings.json` through the normal copy. Drift alone never fails a backup.
Blocking inconsistencies abort before the repository is touched: runtime Pi
version vs the managed marker, installed TruffleHog vs the pinned version,
installed Obscura vs the lock, a floating DCP pin, malformed lock metadata, or
an undiscoverable required component. A final post-copy pass verifies that the
snapshot describes the live Pi version and runs the repository contract.

When Pi itself has changed since the previous snapshot, backup also runs the
existing lightweight transition checks against the current install before
copying: the renderer patcher's non-mutating `--check` signature proof,
headless extension loading (including the repo's todo extension when it is not
yet restored live), and the `cwd-switch`/`todo` suites when Bun is available.

The preflight also compares the live inventory with `pi/versions.json`, the
snapshot of the last **successful** backup. Unpinned component changes (RTK,
Pi npm extensions, git sources, Bun/Node) are reported as `~ old → new`,
`+ added`, or `- removed` but never block — they are history, not
requirements. The snapshot is replaced only after the copy and every
verification step succeeds, so a failed backup never advances it; the first
coherent backup reports a baseline instead of fake drift. Hard locks and pins
(`deps/*.lock.json`, the DCP commit) remain the only things that block, and
`pi/versions.json` is never used to install anything.

Backup never checks upstream for newer releases and never upgrades any
dependency. It records what the machine actually has; intentional live changes
are detected and snapshotted, upstream updates alone change nothing. Tests:
`scripts/test-versions.sh`, `scripts/test-backup-restore.sh`.

## Reproducibility (pinned dependencies)

Obscura is **version pinned, asset pinned, and SHA-256 verified before
extraction**. There are no floating `releases/latest` executable downloads
anywhere in the restore path.

`deps/obscura.lock.json` is the authoritative declaration:

```text
repository + version (vX.Y.Z) + asset name + sha256, per supported platform
(linux-x86_64, linux-aarch64, macos-x86_64, macos-aarch64)
```

`restore.sh` detects the platform, reads the matching lock entry, downloads
`releases/download/<VERSION>/<ASSET>`, hashes it locally, and only then
extracts and installs. A checksum mismatch, an unusable lock, or an
unsupported platform prints an explicit `ERROR`, installs nothing, and makes
`restore.sh` exit non-zero. There is no fallback to `latest`, to an
unverified asset, or to a build from `main`.

If an existing `obscura` binary reports a different version than the lock, the
locked release is reinstalled. The installed executable is never hashed
against the archive digest — those are different artifacts.

### Updating Obscura

Updating the pin is an explicit, reviewed operation. It never runs during
restore, backup, commit, push or CI:

```bash
python3 scripts/update-obscura-lock.py --check    # report only
python3 scripts/update-obscura-lock.py --write    # rewrite the lock
```

The tool reads structured GitHub release metadata (no HTML scraping), requires
all four supported assets to expose SHA-256 digest metadata, refuses draft or
prerelease builds unless `--include-prerelease` is passed, and fails on a
missing asset or an ambiguous duplicate. The resulting lock diff is a normal
repository change: review it and commit it deliberately.

## TUI renderer patch

Pi's bundled renderer hardcodes a literal fence line above and below every code
block and scrolls one line per mouse-wheel event (kitty's system default is 5).
[`pi/patch-pi-renderer.py`](pi/patch-pi-renderer.py) removes the fence lines
and raises the wheel scroll to 5 lines. It locates the bundle chunk and the
`pi-tui` markdown module **by signature** — Pi renames hashed chunk files on
every release — is idempotent, and fails loudly when a pattern is unprovable
instead of silently skipping.

A Pi update replaces the release directory, so the patch must be re-applied.
`scripts/install-renderer-guard.sh` installs and enables a `systemd --user`
path unit (`systemd/pi-renderer-patch.{path,service}`) that watches
`~/.pi/agent/install/current-version` and re-runs the patch script whenever the
managed version changes:

```bash
scripts/install-renderer-guard.sh              # install + enable
scripts/install-renderer-guard.sh --uninstall  # remove
```

`restore.sh` applies the patch and installs the guard as part of its
best-effort post-restore steps (skippable with `--no-patch`). On machines
without a systemd user manager (for example macOS), run
`python3 ~/.pi/agent/patch-pi-renderer.py` after each update instead.

## Repository integrity: hooks, checks and CI

Three layers, none of which replaces another:

```text
pre-commit                    fast local prevention      repository invariants + staged secret scan
pre-push                      stronger local prevention  scanner self-test + full history scan + integration tests
required GitHub CI + ruleset  remote publication gate    the same checks in a clean environment
```

Hooks are tracked in `.githooks/` and are not active until you point Git at
them:

```bash
scripts/install-hooks.sh          # sets core.hooksPath=.githooks (local config only)
```

`restore.sh` applies the same local configuration automatically when it
restores into a directory containing `.git/`, and skips it (without failing)
for a plain snapshot.

Hooks are **feedback, not authority**: they can be bypassed with `--no-verify`.
`.github/workflows/verify.yml` is the independent layer and runs the same
checks on a clean runner, with every action pinned to an exact commit SHA.
CI also installs the exact TruffleHog version pinned in `deps/tools.lock.json`
and verifies its checksum before use.

Individual checks can be run directly:

```bash
scripts/check-repo.sh              # deterministic, offline repository contract
scripts/check-secret-scanner.sh    # prove the scanner still detects a canary
scripts/check-secrets.sh --staged  # scan exactly the staged blobs
scripts/check-secrets.sh --history # scan the full Git history
scripts/test-backup-restore.sh     # isolated backup/restore round-trip
scripts/test-renderer-patch.sh     # isolated renderer-patch fixtures
scripts/test-obscura-restore.sh    # Obscura lock + checksum logic
scripts/test-cwd-switch.sh         # /cd extension unit + wiring tests
```

`main` is protected by the active repository ruleset `Protect main`: changes
must arrive through a pull request, the `repository contract` check from
`.github/workflows/verify.yml` must pass tested against the current base,
force-pushes are rejected, deletion is blocked, and no bypass actors are
configured. `--no-verify` can bypass the local hooks, but it cannot publish
directly to protected `main`.

## Secret scanning

`.gitignore` and the backup allowlist are the primary structural defenses.
Secret scanning is an additional, independent layer, not a replacement:

- `scripts/check-secrets.sh --staged` scans exactly the blobs about to be
  committed, copied into an isolated temporary tree. Untracked files,
  `.secrets/`, and the live working tree are never scanned. It runs with
  `--no-verification`, so it has no network dependency and stays fast enough
  for every commit.
- `scripts/check-secrets.sh --history` scans every commit in the repository
  (with credential verification enabled).
- `scripts/check-secret-scanner.sh` proves the scanner still detects a
  credential canary generated at runtime. A clean scan from a scanner that
  silently stopped detecting means nothing, so this runs before the history
  scan in both pre-push and CI.

Findings are printed with a field allowlist; **raw secret values are never
printed**. The scanner version is pinned in `deps/tools.lock.json`; a missing
or mismatched scanner is a hard failure, never a silent skip. Install it with
`scripts/install-trufflehog.sh`.

A scanner cannot prove the complete absence of secrets. Treat a clean result
as one signal among several, and keep the structural defenses narrow.
