#!/usr/bin/env bash
# ============================================================
# backup.sh — snapshot the live Pi configuration into the
# pi-harness-config backup repository.
#
# ALLOWLIST-BASED. Never copies ~/.pi/agent wholesale, never
# reads or copies auth.json, sessions, or runtime state.
# Idempotent. Performs NO git operations — commit and push stay
# explicit, separately authorized user actions.
#
# ORDER: a live version preflight (versions-lib.sh) runs BEFORE any
# file is copied. The snapshot must describe what is actually installed;
# backup never trusts the previously recorded Pi version, never checks
# upstream for newer releases, and never upgrades anything.
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

# --- 0. Live version preflight (must precede any copy) --------
# Discover what is actually installed, compare it with the repository
# snapshot, report drift, and refresh snapshot metadata. Blocking
# inconsistencies abort before the repository is touched.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSIONS_LIB="$SCRIPT_DIR/versions-lib.sh"
[ -f "$VERSIONS_LIB" ] || fail "missing version preflight helper: $VERSIONS_LIB"
# shellcheck source=versions-lib.sh disable=SC1091
. "$VERSIONS_LIB"

preflight_rc=0
versions_preflight "$AGENT_DIR" "$REPO_DIR" --refresh || preflight_rc=$?
case "$preflight_rc" in
  0) ;;
  2) fail "live version preflight found blocking inconsistencies — backup aborted before copying" ;;
  *) fail "live version preflight failed unexpectedly (exit $preflight_rc)" ;;
esac

# A real Pi version transition additionally runs the lightweight local
# compatibility checks against the CURRENT install (renderer signatures,
# extension loading, extension suites) before anything is snapshotted.
if versions_pi_drifted; then
  versions_pi_transition_checks "$AGENT_DIR" "$REPO_DIR" \
    || fail "Pi version transition compatibility checks failed — resolve before snapshotting"
fi

# Stage the candidate version snapshot now (from the preflight discovery),
# but do NOT commit it: the tracked pi/versions.json may only advance after
# the copy and every verification step have succeeded.
mkdir -p "$REPO_DIR"
SNAPSHOT_STAGED=""
SNAPSHOT_PREV=""
SNAPSHOT_STAGED="$(versions_snapshot_stage "$REPO_DIR")" \
  || fail "could not stage the version snapshot candidate"
trap 'rm -f "${SNAPSHOT_STAGED:-}" "${SNAPSHOT_PREV:-}"' EXIT

mkdir -p "$REPO_DIR/pi" "$REPO_DIR/mcp" "$REPO_DIR/shared-skills"

# --- 1. Scalar config files (explicit allowlist) --------------
for f in AGENTS.md settings.json keybindings.json patch-pi-renderer.py logo.png dcp.jsonc pi-lsp.json; do
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
  --exclude='examples/' --exclude='tests/' --delete-excluded

# --- 5. Defense in depth --------------------------------------
# 5a. Hard-fail if any forbidden (secret/runtime) path landed.
for forbidden in auth.json sessions install npm bin git models-store.json mcp-cache.json; do
  if [ -e "$REPO_DIR/pi/$forbidden" ] || [ -e "$REPO_DIR/$forbidden" ]; then
    fail "forbidden path present in repo: $forbidden — review and remove before committing"
  fi
done

# 5a-bis. The local .secrets/ store must never be tracked by git.
if git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  if git -C "$REPO_DIR" ls-files --error-unmatch .secrets >/dev/null 2>&1; then
    fail ".secrets/ is tracked by git — it must stay gitignored and uncommitted"
  fi
fi

# 5b. Warn (do not fail) on secret-like patterns so a human reviews.
hits="$(grep -rInE '(sk-[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY)' \
  "$REPO_DIR/pi" "$REPO_DIR/mcp" "$REPO_DIR/shared-skills" 2>/dev/null || true)"

if [ -n "$hits" ]; then
  log "WARNING: secret-like patterns found — review before committing:"
  printf '%s\n' "$hits"
fi

# --- 6. Post-copy verification + transactional snapshot -------
# No false clean backup: after copying, the repository snapshot metadata
# must agree with the live Pi version discovered in step 0. The tracked
# version snapshot advances only when every step below succeeds; a failed
# backup never moves it (the staged candidate is discarded by the trap).
if ! versions_verify_snapshot "$AGENT_DIR" "$REPO_DIR"; then
  fail "snapshot metadata still disagrees with the live Pi version"
fi

SNAPSHOT_PATH="$REPO_DIR/$VERSIONS_SNAPSHOT_REL"
if [ -f "$SNAPSHOT_PATH" ]; then
  SNAPSHOT_PREV="$(mktemp "$REPO_DIR/.versions.json.prev.XXXXXX" 2>/dev/null)" \
    || fail "could not stage a rollback copy of the version snapshot"
  cp -f "$SNAPSHOT_PATH" "$SNAPSHOT_PREV"
fi

rollback_snapshot() {
  if [ -n "$SNAPSHOT_PREV" ] && [ -f "$SNAPSHOT_PREV" ]; then
    mv -f "$SNAPSHOT_PREV" "$SNAPSHOT_PATH"
    SNAPSHOT_PREV=""
  else
    rm -f "$SNAPSHOT_PATH"
  fi
}

if ! versions_snapshot_commit "$SNAPSHOT_STAGED" "$REPO_DIR"; then
  rollback_snapshot
  fail "could not write the version snapshot"
fi
SNAPSHOT_STAGED=""

if [ -f "$REPO_DIR/scripts/check-repo.sh" ]; then
  log "running repository contract after snapshot copy"
  if ! "$REPO_DIR/scripts/check-repo.sh"; then
    rollback_snapshot
    fail "repository contract failed after snapshot copy — version snapshot rolled back"
  fi
fi

rm -f "$SNAPSHOT_PREV"
SNAPSHOT_PREV=""
log "version snapshot updated: $VERSIONS_SNAPSHOT_REL"
log "version preflight: snapshot metadata matches live Pi"

log "snapshot synced into $REPO_DIR"
log "next: review 'git -C \"$REPO_DIR\" status', then commit and push explicitly"
