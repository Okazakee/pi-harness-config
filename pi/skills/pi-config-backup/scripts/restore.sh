#!/usr/bin/env bash
# ============================================================
# restore.sh — rebuild the Pi harness from this backup.
#
# Config restore is a snapshot reconciliation, not an overlay: required
# sources must exist in the snapshot, optional sources absent from the
# snapshot are removed from live, and mirrored directories are synchronized
# with --delete. The pre-restore recovery copy covers every destination that
# may be reconciled destructively.
#
# Restores the declarative config, then best-effort reinstalls the
# non-config pieces a fresh machine needs:
#   1. Pi packages from settings.json      (pi update --extensions)
#   2. the obscura MCP binary              (deps/obscura.lock.json:
#                                           exact release + asset + SHA-256)
#   3. the TUI renderer patch + guard      (patch-pi-renderer.py;
#                                           systemd --user path unit)
#
# A checksum mismatch, an unusable Obscura lock, or an unsupported
# platform is an INTEGRITY failure: restore reports it loudly and exits
# non-zero. Network and extraction failures stay best-effort.
#
# Never touches secrets: auth.json is not backed up and is never
# written. The local .secrets/ store is not touched either.
#
# Usage: restore.sh [--yes] [--no-packages] [--no-obscura] [--no-patch]
# ============================================================
set -uo pipefail

REPO_DIR="${PI_BACKUP_REPO:-$HOME/Desktop/Projects/pi-harness-config}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
MCP_DST="$HOME/.config/mcp/mcp.json"
SHARED_SKILLS_DST="$HOME/.agents/skills"
BIN_DST="${PI_BIN_DIR:-$HOME/.local/bin}"
OBSCURA_LOCK="$REPO_DIR/deps/obscura.lock.json"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

HAVE_OBSCURA_LIB=0
if [ -f "$SCRIPT_DIR/obscura-lib.sh" ]; then
  # shellcheck source=obscura-lib.sh
  . "$SCRIPT_DIR/obscura-lib.sh" && HAVE_OBSCURA_LIB=1
fi

# Shared live version discovery (single source of truth for Pi detection).
if [ -f "$SCRIPT_DIR/versions-lib.sh" ]; then
  # shellcheck source=versions-lib.sh disable=SC1091
  . "$SCRIPT_DIR/versions-lib.sh"
fi

INTEGRITY_FAILURES=0

ASSUME_YES=0 DO_PACKAGES=1 DO_OBSCURA=1 DO_PATCH=1
for arg in "$@"; do
  case "$arg" in
    -y|--yes)       ASSUME_YES=1 ;;
    --no-packages)  DO_PACKAGES=0 ;;
    --no-obscura)   DO_OBSCURA=0 ;;
    --no-patch)     DO_PATCH=0 ;;
    -h|--help)      sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "restore: unknown option: $arg" >&2; exit 2 ;;
  esac
done

log()  { printf 'restore: %s\n' "$*"; }
warn() { printf 'restore: WARN: %s\n' "$*" >&2; }
fail() { printf 'restore: ERROR: %s\n' "$*" >&2; exit 1; }

# Strict wrappers for the config/recovery path: restore must never report
# success after a failed copy, sync or removal. The later package/Obscura/
# patch steps remain explicitly best-effort.
must_mkdir() { mkdir -p "$@" || fail "could not create directory: $*"; }
must_cp()    { cp "$@" || fail "copy failed: $*"; }
must_rsync() { rsync "$@" || fail "snapshot reconciliation failed: $*"; }
must_rm()    { rm "$@" || fail "could not remove stale live config: $*"; }

[ -d "$REPO_DIR/pi" ] || fail "no snapshot found at $REPO_DIR/pi"

# --- 0. Validate the snapshot (read-only, before any mutation) ---
for f in settings.json patch-pi-renderer.py; do
  [ -f "$REPO_DIR/pi/$f" ] || fail "snapshot is missing required config: pi/$f"
done
for d in extensions skills; do
  [ -d "$REPO_DIR/pi/$d" ] || fail "snapshot is missing required config directory: pi/$d"
done

# --- 1. Preflight: is Pi itself installed? -------------------
PI_BIN="$(command -v pi || true)"
if [ -n "$PI_BIN" ]; then
  if command -v versions_pi_runtime_version >/dev/null 2>&1; then
    log "found pi: $PI_BIN ($(versions_pi_runtime_version))"
  else
    log "found pi: $PI_BIN ($(pi --version 2>/dev/null | head -1))"
  fi
else
  warn "pi is not on PATH — install Pi first, then re-run. Config will still be restored."
fi

# --- 2. Confirm ----------------------------------------------
printf 'restore: write Pi config from:\n  %s\ninto:\n  %s\n  %s\n  %s\n' \
  "$REPO_DIR" "$AGENT_DIR" "$MCP_DST" "$SHARED_SKILLS_DST"
if [ "$ASSUME_YES" != 1 ]; then
  read -r -p "Proceed? [y/N] " ans
  case "$ans" in [Yy]*) ;; *) echo "restore: aborted"; exit 1 ;; esac
fi

# --- 3. Back up existing live config -------------------------
# The recovery copy covers every destination that restore may reconcile
# destructively, including MCP and shared skills.
backup_needed=0
[ -d "$AGENT_DIR" ] && [ -n "$(ls -A "$AGENT_DIR" 2>/dev/null)" ] && backup_needed=1
{ [ -f "$MCP_DST" ] || [ -d "$SHARED_SKILLS_DST" ]; } && backup_needed=1
if [ "$backup_needed" = 1 ]; then
  backup="$AGENT_DIR/backups/restore-$(date +%Y%m%d-%H%M%S)"
  must_mkdir "$backup"
  for f in AGENTS.md settings.json keybindings.json patch-pi-renderer.py logo.png dcp.jsonc pi-lsp.json; do
    [ -f "$AGENT_DIR/$f" ] && must_cp -a "$AGENT_DIR/$f" "$backup/"
  done
  for d in agents extensions themes skills; do
    [ -d "$AGENT_DIR/$d" ] && must_cp -a "$AGENT_DIR/$d" "$backup/"
  done
  if [ -f "$MCP_DST" ]; then
    must_mkdir "$backup/mcp"
    must_cp -a "$MCP_DST" "$backup/mcp/mcp.json"
  fi
  if [ -d "$SHARED_SKILLS_DST" ]; then
    must_cp -a "$SHARED_SKILLS_DST" "$backup/shared-skills"
  fi
  log "backed up existing config to $backup"
fi

must_mkdir "$AGENT_DIR" "$(dirname "$MCP_DST")" "$SHARED_SKILLS_DST"

# --- 4. Reconcile config files --------------------------------
# Restore is the inverse of backup mirroring; the snapshot was validated in
# step 0 and every copy, sync and removal below must succeed.
for f in settings.json patch-pi-renderer.py; do
  must_cp -f "$REPO_DIR/pi/$f" "$AGENT_DIR/$f"
  log "restored $f"
done
for f in AGENTS.md keybindings.json logo.png dcp.jsonc pi-lsp.json; do
  if [ -f "$REPO_DIR/pi/$f" ]; then
    must_cp -f "$REPO_DIR/pi/$f" "$AGENT_DIR/$f"
    log "restored $f"
  elif [ -e "$AGENT_DIR/$f" ]; then
    must_rm -f "$AGENT_DIR/$f"
    log "removed $f (absent from snapshot)"
  fi
done
for d in extensions skills; do
  must_mkdir "$AGENT_DIR/$d"
  must_rsync -a --delete --exclude='__pycache__/' --exclude='*.pyc' "$REPO_DIR/pi/$d/" "$AGENT_DIR/$d/"
  log "restored $d/"
done
for d in agents themes; do
  if [ -d "$REPO_DIR/pi/$d" ]; then
    must_mkdir "$AGENT_DIR/$d"
    must_rsync -a --delete --exclude='__pycache__/' --exclude='*.pyc' "$REPO_DIR/pi/$d/" "$AGENT_DIR/$d/"
    log "restored $d/"
  elif [ -d "$AGENT_DIR/$d" ]; then
    must_rm -rf "$AGENT_DIR/$d"
    log "removed $d/ (absent from snapshot)"
  fi
done
if [ -f "$REPO_DIR/mcp/mcp.json" ]; then
  must_cp -f "$REPO_DIR/mcp/mcp.json" "$MCP_DST"
  log "restored mcp/mcp.json"
elif [ -e "$MCP_DST" ]; then
  must_rm -f "$MCP_DST"
  log "removed mcp/mcp.json (absent from snapshot)"
fi
if [ -d "$REPO_DIR/shared-skills" ]; then
  must_mkdir "$SHARED_SKILLS_DST"
  must_rsync -a --delete --exclude='__pycache__/' --exclude='*.pyc' \
    --exclude='examples/' --exclude='tests/' \
    "$REPO_DIR/shared-skills/" "$SHARED_SKILLS_DST/"
  log "restored shared-skills/"
elif [ -d "$SHARED_SKILLS_DST" ]; then
  # The snapshot deliberately excludes dev-only examples/ and tests/, so the
  # absent-directory branch removes only snapshot-managed content and leaves
  # those trees in place.
  empty_dir="$(mktemp -d)"
  must_rsync -a --delete --exclude='examples/' --exclude='tests/' "$empty_dir/" "$SHARED_SKILLS_DST/"
  rmdir "$empty_dir"
  rmdir "$SHARED_SKILLS_DST" 2>/dev/null || true
  log "removed shared-skills/ (absent from snapshot)"
fi

# --- 5. Pi packages (best effort) ----------------------------
if [ "$DO_PACKAGES" = 1 ] && [ -n "$PI_BIN" ]; then
  log "reconciling Pi packages (pi update --extensions)…"
  if timeout 600 pi update --extensions >/dev/null 2>&1; then
    log "packages reconciled"
  else
    warn "package reconcile failed — Pi will install missing packages on next startup"
  fi
fi

# --- 6. obscura MCP binary (lock-pinned, checksum-verified) --
# deps/obscura.lock.json is the single source of truth: exact release,
# exact asset name and exact SHA-256. The archive is never extracted
# before its digest matches, and "latest" is never used.
if [ "$DO_OBSCURA" = 1 ]; then
  if [ "$HAVE_OBSCURA_LIB" != 1 ]; then
    warn "obscura-lib.sh missing next to restore.sh — cannot verify an obscura install (integrity failure)"
    INTEGRITY_FAILURES=$((INTEGRITY_FAILURES + 1))
  else
    platform="$(obscura_platform_key || true)"
    if [ -z "$platform" ]; then
      warn "unsupported platform for obscura ($(uname -s)/$(uname -m)) — the lock covers linux/macos on x86_64/aarch64 (integrity failure)"
      INTEGRITY_FAILURES=$((INTEGRITY_FAILURES + 1))
    else
      entry="$(obscura_lock_entry "$OBSCURA_LOCK" "$platform")"
      entry_rc=$?
      if [ "$entry_rc" -ne 0 ]; then
        warn "cannot resolve the obscura lock for $platform: $(obscura_failure_label "$entry_rc") (integrity failure)"
        INTEGRITY_FAILURES=$((INTEGRITY_FAILURES + 1))
      else
        OBSCURA_REPO="${entry%%$'\t'*}"
        rest="${entry#*$'\t'}"
        OBSCURA_VERSION="${rest%%$'\t'*}"
        rest="${rest#*$'\t'}"
        OBSCURA_ASSET="${rest%%$'\t'*}"
        OBSCURA_SHA="${rest##*$'\t'}"
        locked_version="${OBSCURA_VERSION#v}"

        installed_version="$(obscura_installed_version || true)"
        if [ "$installed_version" = "$locked_version" ]; then
          log "obscura $installed_version matches the locked $OBSCURA_VERSION"
        else
          if [ -n "$installed_version" ]; then
            warn "obscura $installed_version differs from the locked $OBSCURA_VERSION — reinstalling the locked release"
          fi
          url="$(obscura_download_url "$OBSCURA_REPO" "$OBSCURA_VERSION" "$OBSCURA_ASSET")"
          log "installing obscura $OBSCURA_VERSION (sha256 ${OBSCURA_SHA:0:12}…) from $url"
          obscura_install_from_url "$url" "$OBSCURA_SHA" "$OBSCURA_ASSET" "$BIN_DST"
          install_rc=$?
          if [ "$install_rc" -ne 0 ]; then
            warn "obscura install failed: $(obscura_failure_label "$install_rc")"
            if obscura_is_integrity_failure "$install_rc"; then
              INTEGRITY_FAILURES=$((INTEGRITY_FAILURES + 1))
            else
              warn "install manually: https://github.com/${OBSCURA_REPO}/releases"
            fi
          else
            log "installed $BIN_DST/obscura (SHA-256 verified against the lock)"
          fi
        fi
      fi
    fi
  fi
fi

# --- 7. TUI renderer patch + update guard (best effort) ------
if [ "$DO_PATCH" = 1 ] && [ -f "$AGENT_DIR/patch-pi-renderer.py" ]; then
  log "applying TUI renderer patch…"
  python3 "$AGENT_DIR/patch-pi-renderer.py" || warn "renderer patch failed — run it manually after install/update"
  if [ -x "$REPO_DIR/scripts/install-renderer-guard.sh" ]; then
    log "installing the renderer update guard…"
    "$REPO_DIR/scripts/install-renderer-guard.sh" \
      || warn "guard install failed — run scripts/install-renderer-guard.sh manually"
  fi
fi

# --- 8. Auth reminder ----------------------------------------
if [ ! -s "$AGENT_DIR/auth.json" ]; then
  warn "no auth.json — authenticate before use:  pi login   (providers: opencode-go, openai-codex)"
fi

# --- 9. Activate the tracked git hooks (best effort) ---------
# Git does not activate repository hooks just because .githooks/ exists.
# Only a real Git checkout can carry local config; a plain snapshot
# restore must not fail because of this.
if [ -d "$REPO_DIR/.git" ] && [ -d "$REPO_DIR/.githooks" ]; then
  if git -C "$REPO_DIR" config --local core.hooksPath .githooks 2>/dev/null; then
    log "activated repository hooks: core.hooksPath=$(git -C "$REPO_DIR" config --local --get core.hooksPath)"
  else
    warn "could not set core.hooksPath in $REPO_DIR — run scripts/install-hooks.sh manually"
  fi
else
  log "hooks not activated (no .git/ and .githooks/ under $REPO_DIR)"
fi

# --- 10. Integrity summary -----------------------------------
if [ "$INTEGRITY_FAILURES" -ne 0 ]; then
  cat >&2 <<EOF

restore: ============================================================
restore: ERROR: $INTEGRITY_FAILURES obscura integrity failure(s).
restore: ERROR: The locked obscura release was NOT installed and no
restore: ERROR: unverified binary was extracted or installed.
restore: ERROR: Fix deps/obscura.lock.json (or the download source) and
restore: ERROR: re-run. Config restoration above is unaffected.
restore: ============================================================
EOF
  exit 1
fi

cat <<'EOF'
restore: done.

Notes:
  - Secrets are never restored (auth.json is not backed up): run `pi login`.
  - Local secret store: <repo>/.secrets/ (gitignored; filename = secret name).
  - obscura comes from deps/obscura.lock.json (exact release + SHA-256).
    Update it deliberately with scripts/update-obscura-lock.py.
  - Repository hooks were activated via core.hooksPath where possible.
  - Skip steps with --no-packages / --no-obscura / --no-patch.
EOF
