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

## Never backed up

- `auth.json` — OAuth tokens and API keys
- `sessions/` — conversation history
- `install/`, `npm/`, `bin/`, `git/` — binaries and package trees
- `models-store.json`, `mcp-cache.json` — regenerable caches
- `__pycache__/`, `*.pyc`

## Secrets — `.secrets/` (local, gitignored)

Secrets live in `.secrets/` at the backup-repo root, one secret per file:
**filename** = secret name, **content** = value. The folder is gitignored and
must never be committed.

- Read a secret only inside the command that needs it, e.g.
  `curl -H "Authorization: Bearer $(cat ~/Desktop/Projects/pi-harness-config/.secrets/TOKEN)"`.
- Never echo, print, log, or copy a secret value into chat or files.
- The backup script refuses to run if `.secrets/` is ever tracked by git.

## Safety rules

- The allowlist in `scripts/backup.sh` is authoritative; `.gitignore` is only
  a second line of defense.
- Never stage or commit `auth.json` or anything under `sessions/`.
- Pushing is an external action: only push with explicit user authorization.
- This remote is **public**: nothing secret may ever be staged or committed.
  Confirm visibility before pushing:
  `gh repo view Okazakee/pi-harness-config --json visibility`.
- Never force-push or rewrite history in the backup repo.

## Restore

```bash
bash ~/.pi/agent/skills/pi-config-backup/scripts/restore.sh
```

Restores config, then best-effort reinstalls the non-config pieces: Pi packages
(`pi update --extensions`), the `obscura` MCP binary (latest GitHub release for
the detected platform), and the TUI renderer patch. Backs up existing live
config first; never writes `auth.json`.

- Flags: `--yes`, `--no-packages`, `--no-obscura`, `--no-patch`.
- Still manual: install Pi itself, then `pi login`.
