#!/usr/bin/env bash
# ============================================================
# restore.sh — rebuild the Pi harness from this backup.
#
# Restores the declarative config, then best-effort reinstalls the
# non-config pieces a fresh machine needs:
#   1. Pi packages from settings.json      (pi update --extensions)
#   2. the obscura MCP binary              (deps/obscura.lock.json:
#                                           exact release + asset + SHA-256)
#   3. the TUI renderer patch              (patch-pi-renderer.py)
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

[ -d "$REPO_DIR/pi" ] || fail "no snapshot found at $REPO_DIR/pi"

# --- 1. Preflight: is Pi itself installed? -------------------
PI_BIN="$(command -v pi || true)"
if [ -n "$PI_BIN" ]; then
  log "found pi: $PI_BIN ($(pi --version 2>/dev/null | head -1))"
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
if [ -d "$AGENT_DIR" ] && [ -n "$(ls -A "$AGENT_DIR" 2>/dev/null)" ]; then
  backup="$AGENT_DIR/backups/restore-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup"
  for f in AGENTS.md settings.json keybindings.json patch-pi-renderer.py logo.png dcp.jsonc; do
    [ -f "$AGENT_DIR/$f" ] && cp -a "$AGENT_DIR/$f" "$backup/" 2>/dev/null
  done
  for d in agents extensions themes skills; do
    [ -d "$AGENT_DIR/$d" ] && cp -a "$AGENT_DIR/$d" "$backup/" 2>/dev/null
  done
  log "backed up existing config to $backup"
fi

mkdir -p "$AGENT_DIR" "$(dirname "$MCP_DST")" "$SHARED_SKILLS_DST"

# --- 4. Restore config files ---------------------------------
for f in AGENTS.md settings.json keybindings.json patch-pi-renderer.py logo.png dcp.jsonc; do
  [ -f "$REPO_DIR/pi/$f" ] && cp -f "$REPO_DIR/pi/$f" "$AGENT_DIR/$f" && log "restored $f"
done
for d in agents extensions themes skills; do
  if [ -d "$REPO_DIR/pi/$d" ]; then
    mkdir -p "$AGENT_DIR/$d"
    rsync -a --exclude='__pycache__/' --exclude='*.pyc' "$REPO_DIR/pi/$d/" "$AGENT_DIR/$d/"
    log "restored $d/"
  fi
done
[ -f "$REPO_DIR/mcp/mcp.json" ] && cp -f "$REPO_DIR/mcp/mcp.json" "$MCP_DST" && log "restored mcp/mcp.json"
if [ -d "$REPO_DIR/shared-skills" ]; then
  rsync -a --exclude='__pycache__/' --exclude='*.pyc' "$REPO_DIR/shared-skills/" "$SHARED_SKILLS_DST/"
  log "restored shared-skills/"
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

# --- 7. TUI renderer patch (best effort) ---------------------
if [ "$DO_PATCH" = 1 ] && [ -f "$AGENT_DIR/patch-pi-renderer.py" ]; then
  log "applying TUI renderer patch…"
  python3 "$AGENT_DIR/patch-pi-renderer.py" || warn "renderer patch failed — run it manually after install/update"
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
