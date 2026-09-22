#!/usr/bin/env bash
# ============================================================
# restore.sh — rebuild the Pi harness from this backup.
#
# Restores the declarative config, then best-effort reinstalls the
# non-config pieces a fresh machine needs:
#   1. Pi packages from settings.json      (pi update --extensions)
#   2. the obscura MCP binary              (GitHub release)
#   3. the TUI renderer patch              (patch-pi-renderer.py)
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
BIN_DST="$HOME/.local/bin"
OBSCURA_REPO="h4ckf0r0day/obscura"

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

# --- 6. obscura MCP binary (best effort) ---------------------
if [ "$DO_OBSCURA" = 1 ]; then
  if command -v obscura >/dev/null 2>&1; then
    log "obscura already present: $(command -v obscura)"
  else
    case "$(uname -s)" in Linux) os=linux ;; Darwin) os=macos ;; *) os="" ;; esac
    case "$(uname -m)" in
      x86_64|amd64) arch=x86_64 ;;
      aarch64|arm64) arch=aarch64 ;;
      *) arch="" ;;
    esac
    if [ -n "$os" ] && [ -n "$arch" ]; then
      asset="obscura-${arch}-${os}.tar.gz"
      url="https://github.com/${OBSCURA_REPO}/releases/latest/download/${asset}"
      tmp="$(mktemp -d)"
      log "installing obscura from $url"
      if curl -fsSL "$url" -o "$tmp/$asset" && tar xzf "$tmp/$asset" -C "$tmp"; then
        mkdir -p "$BIN_DST"
        for b in obscura obscura-worker; do
          if [ -f "$tmp/$b" ]; then
            install -m 755 "$tmp/$b" "$BIN_DST/$b"
            log "installed $BIN_DST/$b"
          fi
        done
      else
        warn "obscura download/extract failed — install manually: https://github.com/${OBSCURA_REPO}/releases"
      fi
      rm -rf "$tmp"
    else
      warn "unsupported platform for obscura ($(uname -s)/$(uname -m)) — install manually"
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

cat <<'EOF'
restore: done.

Notes:
  - Secrets are never restored (auth.json is not backed up): run `pi login`.
  - Local secret store: <repo>/.secrets/ (gitignored; filename = secret name).
  - Skip steps with --no-packages / --no-obscura / --no-patch.
EOF
