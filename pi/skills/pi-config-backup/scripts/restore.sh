#!/usr/bin/env bash
# ============================================================
# restore.sh — apply the backed-up Pi configuration onto a
# machine. Requires explicit confirmation. Never touches
# secrets: auth.json is not backed up and is never written.
# ============================================================
set -euo pipefail

REPO_DIR="${PI_BACKUP_REPO:-$HOME/Desktop/Projects/pi-harness-config}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
MCP_DST="$HOME/.config/mcp/mcp.json"
SHARED_SKILLS_DST="$HOME/.agents/skills"

fail() { printf 'restore: ERROR: %s\n' "$*" >&2; exit 1; }

[ -d "$REPO_DIR/pi" ] || fail "no snapshot found at $REPO_DIR/pi"

printf 'restore: about to write Pi config from:\n  %s\ninto live paths:\n  %s\n  %s\n  %s\n' \
  "$REPO_DIR" "$AGENT_DIR" "$MCP_DST" "$SHARED_SKILLS_DST"
read -r -p "Proceed? [y/N] " ans
case "$ans" in
  [Yy]*) ;;
  *) echo "restore: aborted"; exit 1 ;;
esac

mkdir -p "$AGENT_DIR" "$(dirname "$MCP_DST")" "$SHARED_SKILLS_DST"

# Scalar config files
for f in AGENTS.md settings.json keybindings.json patch-pi-renderer.py logo.png; do
  [ -f "$REPO_DIR/pi/$f" ] && cp -f "$REPO_DIR/pi/$f" "$AGENT_DIR/$f" && echo "restore: $f"
done

# Declarative directories
for d in agents extensions themes skills; do
  if [ -d "$REPO_DIR/pi/$d" ]; then
    mkdir -p "$AGENT_DIR/$d"
    rsync -a --exclude='__pycache__/' --exclude='*.pyc' "$REPO_DIR/pi/$d/" "$AGENT_DIR/$d/"
    echo "restore: $d/"
  fi
done

# MCP config
[ -f "$REPO_DIR/mcp/mcp.json" ] && cp -f "$REPO_DIR/mcp/mcp.json" "$MCP_DST" && echo "restore: mcp/mcp.json"

# Shared skills
if [ -d "$REPO_DIR/shared-skills" ]; then
  rsync -a --exclude='__pycache__/' --exclude='*.pyc' "$REPO_DIR/shared-skills/" "$SHARED_SKILLS_DST/"
  echo "restore: shared-skills/"
fi

cat <<'EOF'
restore: done.

Remaining manual steps (not backed up by design):
  - Re-authenticate providers:  pi login
  - Reinstall packages listed in settings.json (npm:/install/ trees excluded)
  - Re-apply any TUI renderer patches:  python3 ~/.pi/agent/patch-pi-renderer.py
EOF
