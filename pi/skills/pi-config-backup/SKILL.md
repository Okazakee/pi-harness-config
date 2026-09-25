---
name: pi-config-backup
description: Back up the Pi coding-agent configuration (settings, agents, extensions, skills, themes, MCP servers, shared skills) into the public GitHub repo pi-harness-config. Use after editing any Pi config under ~/.pi/agent or ~/.config/mcp/mcp.json, or when the user asks to snapshot, back up, or push the Pi config.
---

# Pi Config Backup

Snapshot the live Pi configuration into the public backup repository
`pi-harness-config`, and — on authorization — commit and push it.

This is **configuration-as-code**, not a dump of runtime state. Credentials
and runtime state are deliberately absent.

## When to use

- After editing any file under `~/.pi/agent/` (settings, agents, extensions,
  skills, themes) or `~/.config/mcp/mcp.json`.
- When the user says "back up the pi config", "snapshot config", "push config",
  "sync config".
- Before or after a risky config change.

## Paths

| Item | Path |
| --- | --- |
| Live Pi agent dir | `~/.pi/agent` |
| Live secret store | `$PI_CODING_AGENT_DIR/.secrets/` (default `~/.pi/agent/.secrets/`) — never backed up |
| Live MCP config | `~/.config/mcp/mcp.json` |
| Live shared skills | `~/.agents/skills` |
| Backup repo | `~/Desktop/Projects/pi-harness-config` |
| Remote (public) | `git@github.com:Okazakee/pi-harness-config.git` |

Override the repo location with `PI_BACKUP_REPO`, and the agent dir with
`PI_CODING_AGENT_DIR`.

## Procedure

1. Sync the snapshot (allowlist only; performs **no** git operations):

   ```bash
   bash ~/.pi/agent/skills/pi-config-backup/scripts/backup.sh
   ```

2. Review what changed:

   ```bash
   git -C ~/Desktop/Projects/pi-harness-config status
   git -C ~/Desktop/Projects/pi-harness-config diff
   ```

3. Confirm no secrets are staged. The script hard-fails if `auth.json`,
   `sessions/`, `install/`, `npm/`, `bin/`, `git/`, `models-store.json`, or
   `mcp-cache.json` ever appear inside the repo, and prints any secret-like
   pattern hits for review. Read that output before committing.

4. Commit (requires user authorization):

   ```bash
   git -C ~/Desktop/Projects/pi-harness-config add -A
   git -C ~/Desktop/Projects/pi-harness-config commit -m "pi config: <what changed>"
   ```

5. Push (requires explicit user authorization):

   ```bash
   git -C ~/Desktop/Projects/pi-harness-config push
   ```

## What is backed up (allowlist)

- `~/.pi/agent`: `AGENTS.md`, `settings.json`, `dcp.jsonc`,
  `keybindings.json`, `patch-pi-renderer.py`, `logo.png`, `pi-lsp.json`
- `~/.pi/agent/agents/`, `extensions/`, `themes/`, `skills/` (recursive)
- `~/.config/mcp/mcp.json`
- `~/.agents/skills/` (shared skills Pi loads globally)

Absence is mirrored: an optional source removed from live is removed from the
snapshot too, so a restore cannot resurrect it. Required sources must exist —
`settings.json`, `extensions/`, `patch-pi-renderer.py` and `skills/` — and
abort the backup before any copy when missing. Optional sources: `AGENTS.md`,
`keybindings.json`, `logo.png`, `dcp.jsonc`, `pi-lsp.json`, `agents/`,
`themes/`, `mcp/mcp.json` and `shared-skills/`.

## Never backed up

- `~/.pi/agent/.secrets/` — agent-dir secret store (outside the repository)
- `auth.json` — OAuth tokens and API keys
- `sessions/` — conversation history
- `install/`, `npm/`, `bin/`, `git/` — binaries and package trees
- `models-store.json`, `mcp-cache.json` — regenerable caches
- `__pycache__/`, `*.pyc`

## Secrets — agent-dir store (never backed up)

Secrets live as one file per secret in the Pi agent dir:
`$PI_CODING_AGENT_DIR/.secrets/` (default `~/.pi/agent/.secrets/`),
**filename** = secret name, **content** = value. Directory mode 700, files
mode 600. The store is outside the repository and outside the backup
allowlist: it is never copied, committed, or restored.

- Read a secret only inside the command that needs it, e.g.
  `curl -H "Authorization: Bearer $(cat ~/.pi/agent/.secrets/TOKEN)"`.
- Never echo, print, log, or copy a secret value into chat or files. Refer to
  secrets by name.
- `pi/extensions/secret-loader.ts` bridges `BRAVE_API_KEY`, `TAVILY_API_KEY`,
  `EXA_API_KEY`, and `JINA_API_KEY` from the store into the process
  environment so `pi-web-search` can use them. Other names stay file-only
  until the allowlist is extended deliberately.
- A `.secrets/` directory inside the repository clone is forbidden: backup
  aborts before copying anything when one exists, and `check-repo.sh` fails
  on one too.
- `restore.sh` ensures the store directory exists (mode 700) and never writes
  or removes store content.

## Safety rules

- The allowlist in `scripts/backup.sh` is authoritative; `.gitignore` is only
  a second line of defense.
- Never stage or commit `auth.json` or anything under `sessions/`.
- The agent-dir secret store is never backed up; a `.secrets/` directory
  inside the clone aborts the backup before any copy.
- Pushing is an external action: only push with explicit user authorization.
- This remote is **public**: nothing secret may ever be staged or committed.
  Confirm visibility before pushing:
  `gh repo view Okazakee/pi-harness-config --json visibility`.
- Never force-push or rewrite history in the backup repo.
- The backup refuses to overwrite uncommitted repository edits in
  live-mirrored paths that differ from the live config. Sync them to the live
  config, or pass `--overwrite-repo-edits` deliberately.
- The pre-copy phase is read-only: a backup that aborts before the copy
  phase leaves the repository byte-identical.

## Pinned packages

`pi/settings.json` declares exact pins: every `npm:` entry carries an exact
version and every `git:` entry an exact commit. The version preflight blocks
the backup when an installed package or checkout does not match its pin, so a
restore rebuilds the pinned graph instead of pulling new upstream releases.
A declaration that is not exactly pinned (an npm range, an unpinned URL, a
floating ref) also blocks before anything is copied. Accepted source classes
are exact `npm:` versions, pinned `git:github.com/...@<40-hex>` and pinned
`https://github.com/...@<40-hex>`; Pi's object form (`{"source": "..."}`) is
normalized to its source, while local paths and other protocols (`ssh://`,
`git://`, non-GitHub hosts) block as non-portable.

To move a pin deliberately: edit `packages` in `~/.pi/agent/settings.json` and
run `pi update --extensions` (this reconciles pinned git refs). A changed npm
pin is installed the next time Pi resolves extensions, such as the next
session start. `pi update --extensions` never upgrades an exact npm pin.

## Restore

On a fresh machine, clone the backup repo first and run the repository copy of
the script — the live `~/.pi/agent/skills/...` path only exists after a
restore:

```bash
git clone git@github.com:Okazakee/pi-harness-config.git ~/Desktop/Projects/pi-harness-config
bash ~/Desktop/Projects/pi-harness-config/pi/skills/pi-config-backup/scripts/restore.sh
```

Afterwards the live `~/.pi/agent/skills/pi-config-backup/scripts/restore.sh`
can be used again.

Restore reconciles the snapshot rather than overlaying it: required sources
must exist in the snapshot, optional sources absent from the snapshot are
removed from live, and mirrored directories (`extensions/`, `skills/`,
`agents/`, `themes/`, `shared-skills/`) are synchronized with `--delete`.
The pre-restore recovery copy covers the Pi agent tree, MCP config and
shared skills. The config and recovery steps are strict: if the recovery
copy or a reconciliation step fails, restore aborts instead of reporting
success. The shared-skills `examples/`/`tests/` trees are excluded from the
snapshot and are preserved even when the snapshot has no shared-skills
directory.

After the config, it best-effort reinstalls the non-config pieces: Pi
packages (`pi update --extensions`; pinned and missing npm packages install
at the next Pi start), the `obscura` MCP binary (the release and per-platform
SHA-256 in `deps/obscura.lock.json`), and the TUI renderer patch. Never
writes `auth.json`, and never copies or removes agent-dir secret-store
content (it only ensures the store directory exists with mode 700).

- Flags: `--yes`, `--no-packages`, `--no-obscura`, `--no-patch`.
- Still manual: install Pi itself, then `pi login`.
