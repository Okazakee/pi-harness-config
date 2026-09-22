# Provenance

Live source path of every backed-up file. The backup is allowlist-based; paths
not listed here are intentionally excluded.

| Backup path | Live source |
| --- | --- |
| `pi/AGENTS.md` | `~/.pi/agent/AGENTS.md` |
| `pi/settings.json` | `~/.pi/agent/settings.json` |
| `pi/dcp.jsonc` | `~/.pi/agent/dcp.jsonc` |
| `pi/pi-lsp.json` | `~/.pi/agent/pi-lsp.json` |
| `pi/keybindings.json` | `~/.pi/agent/keybindings.json` |
| `pi/patch-pi-renderer.py` | `~/.pi/agent/patch-pi-renderer.py` |
| `pi/logo.png` | `~/.pi/agent/logo.png` |
| `pi/agents/` | `~/.pi/agent/agents/` (`*.md`) |
| `pi/extensions/` | `~/.pi/agent/extensions/` (recursive; `todo.ts` plus the `todo/` helper modules) |
| `pi/themes/` | `~/.pi/agent/themes/` (`*.json`) |
| `pi/skills/` | `~/.pi/agent/skills/` (recursive) |
| `mcp/mcp.json` | `~/.config/mcp/mcp.json` |
| `shared-skills/` | `~/.agents/skills/` (recursive) |

## Deliberately excluded (live, not backed up)

| Live path | Reason |
| --- | --- |
| `~/.pi/agent/auth.json` | OAuth tokens and API keys — secret |
| `~/.pi/agent/sessions/` | Conversation history — sensitive runtime state |
| `~/.pi/agent/install/` | Installed Pi releases — reinstall |
| `~/.pi/agent/npm/` | Installed npm packages — reinstall from `settings.json` |
| `~/.pi/agent/bin/` | Downloaded helper binaries (fd, rg) — auto-downloaded |
| `~/.pi/agent/git/` | Git package cache — re-cloned |
| `~/.pi/agent/models-store.json` | Regenerable model catalog cache |
| `~/.pi/agent/mcp-cache.json` | Regenerable MCP tool-metadata cache |
| `~/.local/bin/obscura`, `obscura-worker` | obscura MCP browser binaries — reinstalled by `restore.sh` from the exact release pinned in `deps/obscura.lock.json` (SHA-256 verified before extraction) |
| `~/.pi/agent/__pycache__/` | Python bytecode |

## Repository tooling (not part of the Pi config backup)

These paths live only in the Git repository. They are integrity and rebuild
infrastructure for this repository; they are **not** copied into
`~/.pi/agent` by `backup.sh` or `restore.sh`, and they have no live
counterpart to restore.

| Repository path | Purpose |
| --- | --- |
| `deps/obscura.lock.json` | Authoritative Obscura pin: exact release, exact asset name and SHA-256 per platform. Consumed by `restore.sh` and `scripts/update-obscura-lock.py`. |
| `deps/tools.lock.json` | Authoritative tool pins: TruffleHog version plus per-platform SHA-256. Consumed by `scripts/install-trufflehog.sh` and `scripts/check-secrets.sh`. |
| `.githooks/` | Tracked `pre-commit` and `pre-push` validators. Activated per clone with `scripts/install-hooks.sh` (or automatically by `restore.sh` when restoring into a Git checkout). |
| `scripts/` | Repository checks, secret scanning, pinned installers, the Obscura lock updater, and the isolated test scripts. |
| `docs/` | Scoped repository documentation: this provenance map, extensions/context management, backup and restore, reproducibility, and repository integrity. Repo-only; no live counterpart. |
| `pi/versions.json` | Generated, non-secret inventory of the live harness versions/revisions observed during the last **successful** backup (Pi, tools, direct npm packages, git checkouts, runtimes). A historical snapshot for drift reporting, **not** a lock file: hard pins stay in `deps/*.lock.json` and `pi/settings.json`, and it is never copied into `~/.pi/agent` nor used by `restore.sh`. Refreshed by `backup.sh` only after verification succeeds. |
| `systemd/` | `systemd --user` path unit + service that re-apply `pi/patch-pi-renderer.py` whenever the managed Pi version changes. Installed by `scripts/install-renderer-guard.sh` into `~/.config/systemd/user/`; not part of the config backup. |
| `.github/workflows/verify.yml` | Independent CI verification. Actions pinned to exact commit SHAs; runs the same checks as the local hooks. |

The one file in this repository that both lives under `pi/` **and** is
backed up is `pi/skills/pi-config-backup/scripts/` itself, which is the
backup/restore implementation (`backup.sh`, `restore.sh`, `obscura-lib.sh`).

## Notes

- `pi/dcp.jsonc` is declarative global DCP (Dynamic Context Pruning) policy —
  a human-edited config file, not runtime state. DCP itself performs only
  request-local pruning and never persists context edits.
- `.secrets/` (repo root) is a local, gitignored secret store: **filename** =
  secret name, **content** = value. It is intentionally absent from git and
  from the backup; agents read values from it without printing them.
- `pi/extensions/todo.ts` owns the session todo board used for long execution
  scopes; the implementation is split into `pi/extensions/todo/*` helper
  modules, with `todo.ts` remaining the discoverable entrypoint. The board
  itself is **runtime session data** (stored in Pi session entries under
  `~/.pi/agent/sessions/`, which is deliberately not backed up); only the
  extension code and its tests (`scripts/todo/`, `scripts/test-todo.sh`) live
  in this repository.
- `~/.agents/skills/agentskill` is a git clone of a public upstream skill.
  `shared-skills/` keeps a copy so the harness survives even if upstream moves;
  the nested `.git/` directory and the dev-only `examples/` and `tests/` trees
  are excluded (they carry dependency manifests that trigger Dependabot for no
  runtime benefit).
- `~/.config/opencode/skills/ponytail` is an OpenCode skill that Pi does not
  currently load. It is not backed up here; migrate it into
  `~/.pi/agent/skills/` if Pi should load it.
