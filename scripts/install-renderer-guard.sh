#!/usr/bin/env bash
# ============================================================
# install-renderer-guard.sh — keep the Pi TUI renderer patch applied
# across `pi update` runs.
#
# A Pi update replaces the whole release directory, so the patched
# bundle disappears. This installs a systemd --user path unit that
# watches ~/.pi/agent/install/current-version and re-runs
# patch-pi-renderer.py whenever the managed version changes. The
# patch script discovers its targets by signature and is idempotent,
# so repeated triggers are harmless.
#
# Usage:
#   scripts/install-renderer-guard.sh              install + enable
#   scripts/install-renderer-guard.sh --uninstall  disable + remove
#
# Machines without a systemd user manager (e.g. macOS): the script
# reports the limitation and exits non-zero; run the patch script
# manually after each update there, or let restore.sh do it.
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SYSTEMD_DIR="$REPO_ROOT/systemd"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNITS=(pi-renderer-patch.service pi-renderer-patch.path)

log()  { printf 'renderer-guard: %s\n' "$*"; }
warn() { printf 'renderer-guard: WARN: %s\n' "$*" >&2; }
fail() { printf 'renderer-guard: ERROR: %s\n' "$*" >&2; exit 1; }

ACTION="${1:-install}"
case "$ACTION" in
  install|--install) ;;
  uninstall|--uninstall)
    command -v systemctl >/dev/null 2>&1 || fail "systemctl not found"
    systemctl --user disable --now pi-renderer-patch.path 2>/dev/null || true
    for unit in "${UNITS[@]}"; do rm -f "$UNIT_DIR/$unit"; done
    systemctl --user daemon-reload 2>/dev/null || true
    log "renderer guard removed"
    exit 0
    ;;
  *) fail "unknown option: $ACTION (use --uninstall)" ;;
esac

for unit in "${UNITS[@]}"; do
  [ -f "$SYSTEMD_DIR/$unit" ] || fail "missing $SYSTEMD_DIR/$unit"
done

command -v systemctl >/dev/null 2>&1 \
  || fail "systemctl not found — this guard needs a systemd user manager"
systemctl --user show-environment >/dev/null 2>&1 \
  || fail "no systemd user manager — run 'scripts/install-renderer-guard.sh' in a normal desktop session, or patch manually after updates"

mkdir -p "$UNIT_DIR"
for unit in "${UNITS[@]}"; do
  install -m 644 "$SYSTEMD_DIR/$unit" "$UNIT_DIR/$unit"
done

systemctl --user daemon-reload || fail "systemctl --user daemon-reload failed"
systemctl --user enable --now pi-renderer-patch.path \
  || fail "could not enable pi-renderer-patch.path"

# Catch-up run: patch the release that is already installed so enabling the
# guard never leaves the current version unpatched until the next update.
if systemctl --user start pi-renderer-patch.service; then
  log "enabled pi-renderer-patch.path and patched the current release"
else
  fail "guard enabled, but the catch-up patch run failed — inspect: journalctl --user -u pi-renderer-patch.service"
fi

systemctl --user is-active --quiet pi-renderer-patch.path || warn "path unit is not active"
log "done: the Pi renderer patch re-applies automatically after every update"
