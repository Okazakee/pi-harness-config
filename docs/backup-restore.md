# Backup and restore

## What is backed up (allowlist)

`~/.pi/agent`: `AGENTS.md`, `settings.json`, `dcp.jsonc`,
`keybindings.json`, `patch-pi-renderer.py`, `logo.png`, `pi-lsp.json`, and the
`agents/`, `extensions/`, `themes/`, `skills/` directories. Plus
`~/.config/mcp/mcp.json` and `~/.agents/skills/`.

### Required and optional sources

Absence is mirrored: when an optional source is removed from live, the stale
repository copy is removed too, so a restore cannot resurrect it. Required
sources abort the backup before any copy when they are missing.

- **Required:** `settings.json`, `extensions/`, `patch-pi-renderer.py`,
  `skills/`. The repository contract and its test suites depend on these.
- **Optional:** `AGENTS.md`, `keybindings.json`, `logo.png`, `dcp.jsonc`,
  `pi-lsp.json`, `agents/`, `themes/`, `mcp/mcp.json`, `shared-skills/`.

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
chat, logs, or files. See [`.secrets/README.md`](../.secrets/README.md).

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

Before copying anything, `backup.sh` checks a Git repository for uncommitted
edits in live-mirrored paths (`pi/AGENTS.md`, `pi/settings.json`, `pi/agents/`,
`pi/extensions/`, `pi/skills/`, `mcp/mcp.json`, `shared-skills/`, …). If such a
file differs from its live counterpart, the backup aborts instead of
destroying it; a dirty tree identical to live (the previous backup's own
output) is allowed, and a path absent on both sides counts as identical
state. `--overwrite-repo-edits` discards the conflicting edits deliberately.

Restore on a new machine (after installing Pi itself; clone the repo first,
because the live `~/.pi/agent/skills/...` path only exists after a restore):

```bash
git clone git@github.com:Okazakee/pi-harness-config.git ~/Desktop/Projects/pi-harness-config
bash ~/Desktop/Projects/pi-harness-config/pi/skills/pi-config-backup/scripts/restore.sh
```

`restore.sh` reconciles the snapshot rather than overlaying it. Required
sources must exist in the snapshot; optional sources present in the snapshot
are copied and optional sources absent from it are removed from live; mirrored
directories (`extensions/`, `skills/`, `agents/`, `themes/`, `shared-skills/`)
are synchronized with `--delete`. Restore is therefore the inverse of backup
mirroring: restoring over an existing install reproduces the snapshot instead
of keeping stale files, and the pre-restore recovery copy covers the Pi agent
tree, the MCP config and the shared skills. The config and recovery steps are
strict: a failed recovery copy or reconciliation step aborts restore rather
than reporting success. The shared-skills `examples/`/`tests/` trees are
outside the snapshot and are preserved even when the snapshot contains no
shared-skills directory.

After the config, it best-effort reinstalls the pieces that are **not**
config: Pi packages (exact pins from `pi/settings.json`; `pi update
--extensions` reconciles pinned git refs, and pinned or missing npm packages
install at the next Pi start), the `obscura` MCP binary (the exact release
pinned in `deps/obscura.lock.json`, verified by SHA-256 before extraction),
and the TUI renderer patch (plus its `systemd --user` update guard). It never
touches `auth.json`, and activates the tracked Git hooks when it is restoring
into a real Git checkout.

- Flags: `--yes` (no prompt), `--no-packages`, `--no-obscura`, `--no-patch`.
- Still manual: install Pi itself, then run `pi login` to store credentials.

### Version preflight (backup only)

Every backup starts by discovering the live versions/revisions of the harness
— Pi (runtime plus the managed `install/current-version` marker, which must
agree), RTK, every declared Pi package (exact `npm:` versions and `git:`
commit pins, each checked against the live install), Obscura (installed vs
`deps/obscura.lock.json`), TruffleHog (installed vs `deps/tools.lock.json`),
Bun and Node. Discovery is
local and offline: it reads local binaries, settings, lock files and git
checkouts, never the network.

The repository is compared against that inventory **before any file is
copied**, and the pre-copy phase is read-only: a backup that aborts before the
copy phase leaves the repository byte-identical. Version drift is reported
explicitly (`Pi 0.87.1 → 0.87.2`); only after every pre-copy check has passed
is the README backup-time line refreshed in place, and `pi/settings.json`
advances through the normal copy. Drift alone never fails a backup.
Blocking inconsistencies abort before the repository is touched: runtime Pi
version vs the managed marker, installed TruffleHog vs the pinned version,
installed Obscura vs the lock, a non-exact or mismatched package declaration
(an npm range or tag, a floating git ref, a bare GitHub URL, or a live install
that disagrees with its pin), malformed lock metadata, or an undiscoverable
required component. The same exact-pin invariant is enforced by
`scripts/check-repo.sh` after the copy, but the preflight makes the failure
pre-copy. A final post-copy pass verifies that the
snapshot describes the live Pi version and runs the repository contract.

When Pi itself has changed since the previous snapshot, backup also runs the
existing lightweight transition checks against the current install before
copying or refreshing metadata: the renderer patcher's non-mutating `--check`
signature proof,
headless extension loading (including the repo's todo extension when it is not
yet restored live), and the `cwd-switch`/`todo` suites when Bun is available.

The preflight also compares the live inventory with `pi/versions.json`, the
snapshot of the last **successful** backup. Unpinned component changes (RTK,
Bun/Node) are reported as `~ old → new`, `+ added`, or `- removed` but never
block — they are history, not requirements. The snapshot is replaced only
after the copy and every verification step succeeds, so a failed backup never
advances it; the first coherent backup reports a baseline instead of fake
drift. Hard locks and pins (`deps/*.lock.json`, every exact npm version and
git commit declared in `pi/settings.json`) block on any mismatch, and
`pi/versions.json` is never used to install anything.

Backup never checks upstream for newer releases and never upgrades any
dependency. It records what the machine actually has; intentional live changes
are detected and snapshotted, upstream updates alone change nothing. Tests:
`scripts/test-versions.sh`, `scripts/test-backup-restore.sh`.
