# Provenance

Live source path of every backed-up file. The backup is allowlist-based; paths
not listed here are intentionally excluded.

| Backup path | Live source |
| --- | --- |
| `pi/AGENTS.md` | `~/.pi/agent/AGENTS.md` |
| `pi/settings.json` | `~/.pi/agent/settings.json` |
| `pi/keybindings.json` | `~/.pi/agent/keybindings.json` |
| `pi/patch-pi-renderer.py` | `~/.pi/agent/patch-pi-renderer.py` |
| `pi/logo.png` | `~/.pi/agent/logo.png` |
| `pi/agents/` | `~/.pi/agent/agents/` (`*.md`) |
| `pi/extensions/` | `~/.pi/agent/extensions/` (`*.ts`) |
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
| `~/.pi/agent/__pycache__/` | Python bytecode |

## Notes

- `.secrets/` (repo root) is a local, gitignored secret store: **filename** =
  secret name, **content** = value. It is intentionally absent from git and
  from the backup; agents read values from it without printing them.
- `~/.agents/skills/agentskill` is a git clone of a public upstream skill.
  `shared-skills/` keeps a copy so the harness survives even if upstream moves;
  the nested `.git/` directory and the dev-only `examples/` and `tests/` trees
  are excluded (they carry dependency manifests that trigger Dependabot for no
  runtime benefit).
- `~/.config/opencode/skills/ponytail` is an OpenCode skill that Pi does not
  currently load. It is not backed up here; migrate it into
  `~/.pi/agent/skills/` if Pi should load it.
