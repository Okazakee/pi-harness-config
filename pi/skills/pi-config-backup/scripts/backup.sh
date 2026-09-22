#!/usr/bin/env bash
# ============================================================
# backup.sh — snapshot the live Pi configuration into the
# pi-harness-config backup repository.
#
# ALLOWLIST-BASED. Never copies ~/.pi/agent wholesale, never
# reads or copies auth.json, sessions, or runtime state.
# Idempotent. Performs NO git operations — commit and push stay
# explicit, separately authorized user actions.
# ============================================================
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="${PI_BACKUP_REPO:-$HOME/Desktop/Projects/pi-harness-config}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
MCP_SRC="$HOME/.config/mcp/mcp.json"
SHARED_SKILLS_SRC="$HOME/.agents/skills"

log()  { printf 'backup: %s\n' "$*"; }
fail() { printf 'backup: ERROR: %s\n' "$*" >&2; exit 1; }

[ -d "$AGENT_DIR" ] || fail "Pi agent dir missing: $AGENT_DIR"

# Safety: never allow the destination inside a live config tree.
case "$REPO_DIR" in
  "$AGENT_DIR"|"$AGENT_DIR"/*) fail "refusing: repo dir is inside the live Pi agent dir ($REPO_DIR)" ;;
  "$HOME/.agents"|"$HOME/.agents"/*) fail "refusing: repo dir is inside the live shared skills dir ($REPO_DIR)" ;;
esac

mkdir -p "$REPO_DIR/pi" "$REPO_DIR/mcp" "$REPO_DIR/shared-skills"

# --- 1. Scalar config files (explicit allowlist) --------------
for f in AGENTS.md settings.json keybindings.json patch-pi-renderer.py logo.png; do
  if [ -f "$AGENT_DIR/$f" ]; then
    cp -f "$AGENT_DIR/$f" "$REPO_DIR/pi/$f"
    log "copied pi/$f"
  else
    log "skip (absent): pi/$f"
  fi
done

# --- 2. Declarative directories (mirror; stale files removed) --
sync_dir() { # src dst label [extra rsync args...]
  local src="$1" dst="$2" label="$3"
  shift 3
  if [ -d "$src" ]; then
    mkdir -p "$dst"
    rsync -a --delete \
      --exclude='.git/' --exclude='__pycache__/' --exclude='*.pyc' --exclude='node_modules/' \
      "$@" \
      "$src/" "$dst/"
    log "synced $label ($(find "$dst" -type f | wc -l | tr -d ' ') files)"
  else
    log "skip (absent): $label"
  fi
}

sync_dir "$AGENT_DIR/agents"     "$REPO_DIR/pi/agents"     "pi/agents"
sync_dir "$AGENT_DIR/extensions" "$REPO_DIR/pi/extensions" "pi/extensions"
sync_dir "$AGENT_DIR/themes"     "$REPO_DIR/pi/themes"     "pi/themes"
sync_dir "$AGENT_DIR/skills"     "$REPO_DIR/pi/skills"     "pi/skills"

# --- 3. MCP server config (single file) -----------------------
if [ -f "$MCP_SRC" ]; then
  cp -f "$MCP_SRC" "$REPO_DIR/mcp/mcp.json"
  log "copied mcp/mcp.json"
else
  log "skip (absent): $MCP_SRC"
fi

# --- 4. Shared skills Pi loads globally -----------------------
# The third-party agentskill clone ships dev-only `examples/` and `tests/`
# trees whose dependency manifests trip Dependabot for no real benefit; the
# skill itself only needs SKILL.md, SYSTEM.md, scripts/ and references/.
sync_dir "$SHARED_SKILLS_SRC" "$REPO_DIR/shared-skills" "shared-skills" \
  --exclude='examples/' --exclude='tests/'

# --- 5. Defense in depth --------------------------------------
# 5a. Hard-fail if any forbidden (secret/runtime) path landed.
for forbidden in auth.json sessions install npm bin git models-store.json mcp-cache.json; do
  if [ -e "$REPO_DIR/pi/$forbidden" ] || [ -e "$REPO_DIR/$forbidden" ]; then
    fail "forbidden path present in repo: $forbidden — review and remove before committing"
  fi
done

# 5b. Warn (do not fail) on secret-like patterns so a human reviews.
hits="$(grep -rInE '(sk-[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY)' \
  "$REPO_DIR/pi" "$REPO_DIR/mcp" "$REPO_DIR/shared-skills" 2>/dev/null || true)"

if [ -n "$hits" ]; then
  log "WARNING: secret-like patterns found — review before committing:"
  printf '%s\n' "$hits"
fi

log "snapshot synced into $REPO_DIR"
log "next: review 'git -C \"$REPO_DIR\" status', then commit and push explicitly"
