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
#
# GUARD: a Git repository with uncommitted edits in live-mirrored paths
# whose content differs from the live config aborts before any copy
# (--overwrite-repo-edits discards them deliberately).
#
# Usage: backup.sh [--overwrite-repo-edits]
# ============================================================
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="${PI_BACKUP_REPO:-$HOME/Desktop/Projects/pi-harness-config}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
MCP_SRC="$HOME/.config/mcp/mcp.json"
SHARED_SKILLS_SRC="$HOME/.agents/skills"

log()  { printf 'backup: %s\n' "$*"; }
fail() { printf 'backup: ERROR: %s\n' "$*" >&2; exit 1; }

ALLOW_OVERWRITE_REPO_EDITS=0
for arg in "$@"; do
  case "$arg" in
    --overwrite-repo-edits) ALLOW_OVERWRITE_REPO_EDITS=1 ;;
    -h|--help) printf 'usage: backup.sh [--overwrite-repo-edits]\n'; exit 0 ;;
    *) echo "backup: unknown option: $arg" >&2; exit 2 ;;
  esac
done

[ -d "$AGENT_DIR" ] || fail "Pi agent dir missing: $AGENT_DIR"

# Safety: never allow the destination inside a live config tree.
case "$REPO_DIR" in
  "$AGENT_DIR"|"$AGENT_DIR"/*) fail "refusing: repo dir is inside the live Pi agent dir ($REPO_DIR)" ;;
  "$HOME/.agents"|"$HOME/.agents"/*) fail "refusing: repo dir is inside the live shared skills dir ($REPO_DIR)" ;;
esac

# --- 0a. Required source validation ---------------------------
# Required sources must exist before anything is read, refreshed or copied;
# their absence is a repository-contract problem, not a snapshot operation.
[ -f "$AGENT_DIR/settings.json" ] \
  || fail "required live config is missing: $AGENT_DIR/settings.json (recreate it, or change the repository contract deliberately)"
[ -d "$AGENT_DIR/extensions" ] \
  || fail "required live config directory is missing: $AGENT_DIR/extensions (recreate it, or change the repository contract deliberately)"
[ -f "$AGENT_DIR/patch-pi-renderer.py" ] \
  || fail "required live config is missing: $AGENT_DIR/patch-pi-renderer.py (recreate it, or change the repository contract deliberately)"
[ -d "$AGENT_DIR/skills" ] \
  || fail "required live config directory is missing: $AGENT_DIR/skills (recreate it, or change the repository contract deliberately)"

# --- 0a-bis. Secret store direction ---------------------------
# Secrets belong to the agent dir ($AGENT_DIR/.secrets), never to the
# repository clone; a store here is a stale pre-migration layout.
if [ -e "$REPO_DIR/.secrets" ]; then
  fail "secret store found at $REPO_DIR/.secrets — it belongs in the agent dir ($AGENT_DIR/.secrets); move it and remove the directory"
fi

# --- 0b. Repository overwrite guard ---------------------------
# The copy phase mirrors the live config over the repository, including
# removing stale copies of optional sources that disappeared from live.
# Refuse to destroy uncommitted repository content that differs from its
# live counterpart; a benign dirty tree (previous backup output, already
# identical to live) is allowed. --overwrite-repo-edits bypasses it.
repo_mirror_live_path() { # <repo-relative-path> -> live path, or return 1
  case "$1" in
    pi/AGENTS.md|pi/settings.json|pi/keybindings.json|pi/patch-pi-renderer.py|pi/logo.png|pi/dcp.jsonc|pi/pi-lsp.json|pi/agents/*|pi/extensions/*|pi/themes/*|pi/skills/*)
      printf '%s' "$AGENT_DIR/${1#pi/}" ;;
    mcp/mcp.json)
      printf '%s' "$MCP_SRC" ;;
    shared-skills/*)
      printf '%s' "$SHARED_SKILLS_SRC/${1#shared-skills/}" ;;
    *)
      return 1 ;;
  esac
}

repo_dirty_mirrored_files() { # <repo> <pathspec...> -> NUL-separated paths
  local repo="$1"
  shift
  if git -C "$repo" rev-parse --verify -q HEAD >/dev/null 2>&1; then
    git -C "$repo" diff --name-only -z HEAD -- "$@"
  fi
  git -C "$repo" ls-files --others --exclude-standard -z -- "$@"
}

# True when the repository and live paths are in the same state: both
# absent, or both present with identical content (symlinks compared by
# target). Distinguishes an uncommitted repository-only edit from the
# previous backup's own output.
same_mirror_state() { # <repo-path> <live-path>
  local repo="$1" live="$2"
  if [ -L "$repo" ] || [ -L "$live" ]; then
    [ -L "$repo" ] && [ -L "$live" ] && [ "$(readlink -- "$repo")" = "$(readlink -- "$live")" ]
  elif [ -e "$repo" ]; then
    [ -e "$live" ] && cmp -s -- "$repo" "$live"
  else
    [ ! -e "$live" ]
  fi
}

if [ "$ALLOW_OVERWRITE_REPO_EDITS" != 1 ] && git -C "$REPO_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  MIRRORED_PATHS=(pi/AGENTS.md pi/settings.json pi/keybindings.json pi/patch-pi-renderer.py \
    pi/logo.png pi/dcp.jsonc pi/pi-lsp.json pi/agents pi/extensions pi/themes pi/skills \
    mcp/mcp.json shared-skills)
  repo_conflicts=()
  while IFS= read -r -d '' rel; do
    [ -n "$rel" ] || continue
    live="$(repo_mirror_live_path "$rel")" || continue
    if ! same_mirror_state "$REPO_DIR/$rel" "$live"; then
      repo_conflicts+=("$rel")
    fi
  done < <(repo_dirty_mirrored_files "$REPO_DIR" "${MIRRORED_PATHS[@]}")
  if [ "${#repo_conflicts[@]}" -gt 0 ]; then
    {
      printf 'backup: ERROR: repository has local edits in live-mirrored paths that differ from the live config:\n'
      printf '          %s\n' "${repo_conflicts[@]}"
      printf 'backup: ERROR: sync them to the live config, or re-run with --overwrite-repo-edits to discard them.\n'
    } >&2
    exit 1
  fi
fi

# --- 0c. Live version preflight (read-only) -------------------
# Discover what is actually installed, compare it with the repository
# snapshot and report drift. This step never writes to the repository;
# snapshot metadata is refreshed only after every pre-copy check passed.
# Blocking inconsistencies abort before the repository is touched.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSIONS_LIB="$SCRIPT_DIR/versions-lib.sh"
[ -f "$VERSIONS_LIB" ] || fail "missing version preflight helper: $VERSIONS_LIB"
# shellcheck source=versions-lib.sh disable=SC1091
. "$VERSIONS_LIB"

preflight_rc=0
versions_preflight "$AGENT_DIR" "$REPO_DIR" || preflight_rc=$?
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

# Every pre-copy check passed: only now may the repository be mutated.
# Refreshing README metadata earlier would leave the repository changed by
# a backup that later aborted.
versions_refresh_snapshot_metadata "$REPO_DIR"

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
# Required sources were validated in step 0a. Optional sources mirror live
# absence: a stale repository copy is removed instead of resurrected.
cp -f "$AGENT_DIR/settings.json" "$REPO_DIR/pi/settings.json"
log "copied pi/settings.json"
cp -f "$AGENT_DIR/patch-pi-renderer.py" "$REPO_DIR/pi/patch-pi-renderer.py"
log "copied pi/patch-pi-renderer.py"
for f in AGENTS.md keybindings.json logo.png dcp.jsonc pi-lsp.json; do
  if [ -f "$AGENT_DIR/$f" ]; then
    cp -f "$AGENT_DIR/$f" "$REPO_DIR/pi/$f"
    log "copied pi/$f"
  elif [ -e "$REPO_DIR/pi/$f" ]; then
    rm -f "$REPO_DIR/pi/$f"
    log "removed pi/$f (absent from live config)"
  else
    log "skip (absent): pi/$f"
  fi
done

# --- 2. Declarative directories (mirror; stale files removed) --
# Optional directories mirror live absence: a stale repository copy is
# removed. Required directories were validated in step 0a.
sync_dir() { # src dst label required|optional [extra rsync args...]
  local src="$1" dst="$2" label="$3" required="$4"
  shift 4
  if [ -d "$src" ]; then
    mkdir -p "$dst"
    rsync -a --delete \
      --exclude='.git/' --exclude='__pycache__/' --exclude='*.pyc' --exclude='node_modules/' \
      "$@" \
      "$src/" "$dst/"
    log "synced $label ($(find "$dst" -type f | wc -l | tr -d ' ') files)"
  elif [ "$required" = required ]; then
    fail "required live config directory is missing: $src"
  elif [ -e "$dst" ]; then
    rm -rf "$dst"
    log "removed $label (absent from live config)"
  else
    log "skip (absent): $label"
  fi
}

sync_dir "$AGENT_DIR/agents"     "$REPO_DIR/pi/agents"     "pi/agents"     optional
sync_dir "$AGENT_DIR/extensions" "$REPO_DIR/pi/extensions" "pi/extensions" required
sync_dir "$AGENT_DIR/themes"     "$REPO_DIR/pi/themes"     "pi/themes"     optional
sync_dir "$AGENT_DIR/skills"     "$REPO_DIR/pi/skills"     "pi/skills"     required

# --- 3. MCP server config (optional single file) ----------------
if [ -f "$MCP_SRC" ]; then
  cp -f "$MCP_SRC" "$REPO_DIR/mcp/mcp.json"
  log "copied mcp/mcp.json"
elif [ -e "$REPO_DIR/mcp/mcp.json" ]; then
  rm -f "$REPO_DIR/mcp/mcp.json"
  log "removed mcp/mcp.json (absent from live config)"
else
  log "skip (absent): $MCP_SRC"
fi

# --- 4. Shared skills Pi loads globally -----------------------
# The third-party agentskill clone ships dev-only `examples/` and `tests/`
# trees whose dependency manifests trip Dependabot for no real benefit; the
# skill itself only needs SKILL.md, SYSTEM.md, scripts/ and references/.
sync_dir "$SHARED_SKILLS_SRC" "$REPO_DIR/shared-skills" "shared-skills" optional \
  --exclude='examples/' --exclude='tests/' --delete-excluded

# --- 5. Defense in depth --------------------------------------
# 5a. Hard-fail if any forbidden (secret/runtime) path landed.
for forbidden in auth.json sessions install npm bin git models-store.json mcp-cache.json; do
  if [ -e "$REPO_DIR/pi/$forbidden" ] || [ -e "$REPO_DIR/$forbidden" ]; then
    fail "forbidden path present in repo: $forbidden — review and remove before committing"
  fi
done

# 5a-bis. The secret store lives in the agent dir, never in the repo.
if [ -e "$REPO_DIR/.secrets" ] \
  || git -C "$REPO_DIR" ls-files --error-unmatch .secrets >/dev/null 2>&1; then
  fail ".secrets/ present in the repository — the store belongs in the agent dir ($AGENT_DIR/.secrets)"
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
