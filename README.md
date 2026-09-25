# Pi Harness Config

Declarative, reproducible backup of the **Pi** coding-agent configuration —
the parts needed to rebuild the harness on a fresh machine. This is
**configuration-as-code**, not a dump of runtime state.

This repository is the canonical versioned snapshot of the Pi harness now
that the former `omp-harness-config` repo is retired.

- Pi version at backup time: **0.87.1**
- Full source-path mapping: [`docs/provenance.md`](docs/provenance.md)

## Purpose

If the machine or Pi is reinstalled, this repository rebuilds the harness:
global policy, settings, custom subagents, extensions, themes, skills, and MCP
server definitions. Credentials and runtime state are deliberately absent.

## Scope and safety

- **Backed up:** the allowlisted `~/.pi/agent` configuration (policy, settings,
  LSP routing, subagents, extensions, themes, skills) plus the MCP config and
  shared skills.
- **Never backed up:** `auth.json`, session transcripts, regenerable caches,
  and the `install/`, `npm/`, `bin/` and `git/` trees.
- **Secrets stay local:** real values live only in the agent-dir store
  (`~/.pi/agent/.secrets/`); the snapshot holds no credentials.

The authoritative allowlist, exclusions and secret handling live in
[`docs/backup-restore.md`](docs/backup-restore.md); repository-owned files such
as the `deps/` pins are mapped in [`docs/provenance.md`](docs/provenance.md).

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

`backup.sh` refuses to overwrite uncommitted repository edits in
live-mirrored paths that differ from the live config; pass
`--overwrite-repo-edits` to discard them deliberately. Optional sources
removed from live are removed from the snapshot too; required sources
(`settings.json`, `extensions/`, `patch-pi-renderer.py`, `skills/`) abort the
backup when missing, and a failure before the copy phase leaves the
repository unchanged.

Restore on a new machine (after installing Pi itself, clone the repo first —
the live `~/.pi/agent/skills/...` path only exists after a restore):

```bash
git clone git@github.com:Okazakee/pi-harness-config.git ~/Desktop/Projects/pi-harness-config
bash ~/Desktop/Projects/pi-harness-config/pi/skills/pi-config-backup/scripts/restore.sh
```

Pi package declarations in `pi/settings.json` are exact pins (npm versions and
git commits), so a restore rebuilds the pinned extension graph; `pi/versions.json`
additionally records observed toolchain versions. Deliberately moving a pin is
documented in [`docs/reproducibility.md`](docs/reproducibility.md).

Flags: `--yes` (no prompt), `--no-packages`, `--no-obscura`, `--no-patch`.
Restore still requires installing Pi and running `pi login` by hand. Details,
including the backup-only version preflight, are in
[`docs/backup-restore.md`](docs/backup-restore.md).

## Checks

```bash
scripts/check-repo.sh              # deterministic, offline repository contract
scripts/test-backup-restore.sh     # isolated backup/restore round-trip
scripts/test-renderer-patch.sh     # isolated renderer-patch fixtures
scripts/test-obscura-restore.sh    # Obscura lock + checksum logic
scripts/test-cwd-switch.sh         # /cd extension unit + wiring tests
scripts/test-statusline.sh         # provider-usage parsers + footer rendering
scripts/test-todo.sh               # /todo extension unit + wiring tests
scripts/test-secret-loader.sh       # agent-dir secret loader tests
scripts/test-versions.sh           # version drift and preflight logic
```

Hooks are tracked in `.githooks/`; enable them with `scripts/install-hooks.sh`.
CI in `.github/workflows/verify.yml` is the independent gate that runs the same
checks on a clean runner. See [`docs/integrity.md`](docs/integrity.md).

## Documentation

- [`docs/extensions.md`](docs/extensions.md) — context management, `/cd`, `/todo`.
- [`docs/backup-restore.md`](docs/backup-restore.md) — allowlist, exclusions, secrets, restore, version preflight.
- [`docs/reproducibility.md`](docs/reproducibility.md) — pinned dependencies and the Obscura update workflow.
- [`docs/integrity.md`](docs/integrity.md) — renderer patch, hooks, CI, secret scanning.
- [`docs/provenance.md`](docs/provenance.md) — authoritative source-path mapping.
