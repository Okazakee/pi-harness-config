# Pi Harness Config

Declarative, reproducible backup of the **Pi** coding-agent configuration —
the parts needed to rebuild the harness on a fresh machine. This is
**configuration-as-code**, not a dump of runtime state.

This repository is the single source of truth for the Pi harness now that the
former `omp-harness-config` repo is retired.

- Pi version at backup time: **0.87.0**
- Full source-path mapping: [`docs/provenance.md`](docs/provenance.md)

## Repository layout

```text
pi-harness-config/
├── README.md
├── .gitignore
├── pi/                         # curated snapshot of ~/.pi/agent
│   ├── AGENTS.md               # global agent policy
│   ├── settings.json           # Pi settings (theme, models, TUI, packages)
│   ├── keybindings.json
│   ├── patch-pi-renderer.py    # re-apply TUI renderer patches after updates
│   ├── logo.png
│   ├── agents/                 # subagent definitions (explore, review, ...)
│   ├── extensions/             # rtk, statusline, welcome-header, markdown-tweaks
│   ├── themes/                 # okazakee.json
│   └── skills/                 # global Pi skills (incl. pi-config-backup)
├── mcp/
│   └── mcp.json                # MCP servers Pi reads (~/.config/mcp/mcp.json)
├── shared-skills/              # ~/.agents/skills (skills Pi loads globally)
├── .secrets/                   # LOCAL secret store — gitignored, never committed
└── docs/
    └── provenance.md           # live source path of every backed-up file
```

## Purpose

If the machine or Pi is reinstalled, this repository rebuilds the harness:
global policy, settings, custom subagents, extensions, themes, skills, and MCP
server definitions. Credentials and runtime state are deliberately absent.

## What is backed up (allowlist)

`~/.pi/agent`: `AGENTS.md`, `settings.json`, `keybindings.json`,
`patch-pi-renderer.py`, `logo.png`, and the `agents/`, `extensions/`,
`themes/`, `skills/` directories. Plus `~/.config/mcp/mcp.json` and
`~/.agents/skills/`.

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

Restore on a new machine:

```bash
bash ~/.pi/agent/skills/pi-config-backup/scripts/restore.sh
```

Then re-authenticate (`pi login`), reinstall the packages listed in
`settings.json`, and re-run `python3 ~/.pi/agent/patch-pi-renderer.py`.
