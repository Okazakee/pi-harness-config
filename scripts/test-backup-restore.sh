#!/usr/bin/env bash
# ============================================================
# test-backup-restore.sh — isolated backup/restore round-trip.
#
# Runs the real backup.sh and restore.sh against throwaway HOME,
# PI_CODING_AGENT_DIR and PI_BACKUP_REPO values. The live
# ~/.pi/agent, ~/.config/mcp and ~/.agents are never written to.
#
# Verifies: allowlisted scalars round-trip, dcp.jsonc and the MCP config
# round-trip byte-identically, forbidden paths are never copied, .secrets/
# and auth.json are never copied, and restore backs up the existing config
# before replacing it.
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_SH="$REPO_ROOT/pi/skills/pi-config-backup/scripts/backup.sh"
RESTORE_SH="$REPO_ROOT/pi/skills/pi-config-backup/scripts/restore.sh"

FAILURES=0
pass() { printf 'ok      %s\n' "$1"; }
fail() { printf 'FAIL    %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

for script in "$BACKUP_SH" "$RESTORE_SH"; do
  [ -f "$script" ] || { printf 'FAIL    missing %s\n' "$script" >&2; exit 1; }
done

# Record the real config's mtimes so we can prove the test stayed isolated.
REAL_AGENT="${HOME}/.pi/agent"
REAL_MCP="${HOME}/.config/mcp/mcp.json"
real_stamp() { stat -c '%Y %n' "$1" 2>/dev/null || true; }
REAL_BEFORE="$(real_stamp "$REAL_AGENT/settings.json"; real_stamp "$REAL_MCP")"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAKE_HOME="$WORK/home"
AGENT="$FAKE_HOME/.pi/agent"
MCP="$FAKE_HOME/.config/mcp/mcp.json"
SHARED="$FAKE_HOME/.agents/skills"
REPO="$WORK/backup-repo"

export HOME="$FAKE_HOME"
export PI_CODING_AGENT_DIR="$AGENT"
export PI_BACKUP_REPO="$REPO"
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_NOSYSTEM=1

# ---------------------------------------------------------------- fake live config
mkdir -p "$AGENT/agents" "$AGENT/extensions" "$AGENT/themes" "$AGENT/skills/demo" \
         "$(dirname "$MCP")" "$SHARED/agentskill/scripts" \
         "$AGENT/sessions" "$AGENT/install" "$AGENT/npm" "$AGENT/bin" "$AGENT/git"

printf '# AGENTS\n' >"$AGENT/AGENTS.md"
printf '{\n  "theme": "fixture",\n  "packages": []\n}\n' >"$AGENT/settings.json"
printf '{\n  "bindings": {}\n}\n' >"$AGENT/keybindings.json"
printf '#!/usr/bin/env python3\nprint("fixture")\n' >"$AGENT/patch-pi-renderer.py"
printf '\x89PNG\r\n\x1a\n fixture-logo' >"$AGENT/logo.png"
printf '{\n  // declarative DCP policy\n  "enabled": true,\n  "keepRecent": 3\n}\n' >"$AGENT/dcp.jsonc"
printf 'agent fixture\n' >"$AGENT/agents/reviewer.md"
printf 'export default 1\n' >"$AGENT/extensions/fixture.ts"
printf '{"name":"fixture-theme"}\n' >"$AGENT/themes/fixture.json"
printf 'skill fixture\n' >"$AGENT/skills/demo/SKILL.md"
printf '{"mcpServers":{"context7":{"url":"https://example.invalid/mcp"}}}\n' >"$MCP"
printf 'shared skill fixture\n' >"$SHARED/agentskill/SKILL.md"
printf '#!/bin/sh\necho fixture\n' >"$SHARED/agentskill/scripts/run.sh"

# Secret/runtime material that must never be copied.
printf '{"token":"super-secret-fixture-value"}\n' >"$AGENT/auth.json"
printf 'session transcript fixture\n' >"$AGENT/sessions/session.jsonl"
printf 'regenerable cache\n' >"$AGENT/models-store.json"
printf 'regenerable cache\n' >"$AGENT/mcp-cache.json"
printf 'installed runtime\n' >"$AGENT/install/marker"
printf 'npm marker\n' >"$AGENT/npm/marker"
printf 'bin marker\n' >"$AGENT/bin/marker"
printf 'git cache marker\n' >"$AGENT/git/marker"

# A local secret store next to the live config must never be picked up either.
printf 'secret store fixture\n' >"$AGENT/.secrets-fixture-marker"

git -C "$WORK" init -q -b main "$REPO" 2>/dev/null || { mkdir -p "$REPO"; git -C "$REPO" init -q -b main; }

# ---------------------------------------------------------------- 1. backup
rc=0
bash "$BACKUP_SH" >"$WORK/backup.log" 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "backup.sh completes against an isolated HOME"
else
  fail "backup.sh exited $rc"
  sed 's/^/        /' "$WORK/backup.log" >&2
fi

# ---------------------------------------------------------------- 2. allowlisted round-trip
for f in AGENTS.md settings.json keybindings.json patch-pi-renderer.py logo.png dcp.jsonc; do
  if cmp -s "$AGENT/$f" "$REPO/pi/$f"; then
    pass "backup: pi/$f copied"
  else
    fail "backup: pi/$f missing or different"
  fi
done

for d in agents extensions themes skills; do
  if [ -d "$REPO/pi/$d" ]; then
    pass "backup: pi/$d/ mirrored"
  else
    fail "backup: pi/$d/ not mirrored"
  fi
done

if cmp -s "$MCP" "$REPO/mcp/mcp.json"; then
  pass "backup: mcp/mcp.json copied"
else
  fail "backup: mcp/mcp.json missing or different"
fi

if cmp -s "$SHARED/agentskill/SKILL.md" "$REPO/shared-skills/agentskill/SKILL.md"; then
  pass "backup: shared-skills mirrored"
else
  fail "backup: shared-skills not mirrored"
fi

# ---------------------------------------------------------------- 3. forbidden material
for forbidden in auth.json sessions install npm bin git models-store.json mcp-cache.json; do
  if [ -e "$REPO/pi/$forbidden" ] || [ -e "$REPO/$forbidden" ]; then
    fail "backup: forbidden path copied into the snapshot: $forbidden"
  fi
done
pass "backup: no forbidden path copied"

if find "$REPO" -name '.secrets' -o -name '*.secret*' | grep -q .; then
  fail "backup: secret store material found in the snapshot"
else
  pass "backup: no .secrets material in the snapshot"
fi

if grep -rIl 'super-secret-fixture-value' "$REPO" >/dev/null 2>&1; then
  fail "backup: auth.json content leaked into the snapshot"
else
  pass "backup: auth.json content absent from the snapshot"
fi

# ---------------------------------------------------------------- 4. restore round-trip
DCP_SUM_BEFORE="$(sha256sum "$REPO/pi/dcp.jsonc" | awk '{print $1}')"
MCP_SUM_BEFORE="$(sha256sum "$REPO/mcp/mcp.json" | awk '{print $1}')"

# Corrupt the live config so restore has something to put back.
printf 'corrupted\n' >"$AGENT/settings.json"
printf 'corrupted\n' >"$AGENT/dcp.jsonc"
rm -f "$AGENT/AGENTS.md"
printf 'corrupted\n' >"$MCP"

rc=0
bash "$RESTORE_SH" --yes --no-packages --no-obscura --no-patch >"$WORK/restore.log" 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "restore.sh completes with --yes --no-packages --no-obscura --no-patch"
else
  fail "restore.sh exited $rc"
  sed 's/^/        /' "$WORK/restore.log" >&2
fi

if cmp -s "$REPO/pi/settings.json" "$AGENT/settings.json"; then
  pass "restore: settings.json round-trips"
else
  fail "restore: settings.json was not restored"
fi

if [ -f "$AGENT/AGENTS.md" ] && cmp -s "$REPO/pi/AGENTS.md" "$AGENT/AGENTS.md"; then
  pass "restore: AGENTS.md restored after deletion"
else
  fail "restore: AGENTS.md was not restored"
fi

DCP_SUM_AFTER="$(sha256sum "$AGENT/dcp.jsonc" | awk '{print $1}')"
if [ "$DCP_SUM_AFTER" = "$DCP_SUM_BEFORE" ]; then
  pass "restore: dcp.jsonc round-trips byte-identically"
else
  fail "restore: dcp.jsonc changed across the round-trip"
fi

MCP_SUM_AFTER="$(sha256sum "$MCP" | awk '{print $1}')"
if [ "$MCP_SUM_AFTER" = "$MCP_SUM_BEFORE" ]; then
  pass "restore: mcp/mcp.json round-trips byte-identically"
else
  fail "restore: mcp/mcp.json changed across the round-trip"
fi

# ---------------------------------------------------------------- 5. pre-replacement backup
BACKUP_DIR="$(find "$AGENT/backups" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | head -n1)"
if [ -n "$BACKUP_DIR" ]; then
  pass "restore: existing config backed up to $(basename "$BACKUP_DIR")"
  if [ -f "$BACKUP_DIR/settings.json" ] && grep -q 'corrupted' "$BACKUP_DIR/settings.json"; then
    pass "restore: pre-restore content preserved in the backup"
  else
    fail "restore: pre-restore content not captured in the backup"
  fi
else
  fail "restore: no pre-replacement backup directory was created"
fi

# ---------------------------------------------------------------- 6. isolation
REAL_AFTER="$(real_stamp "$REAL_AGENT/settings.json"; real_stamp "$REAL_MCP")"
if [ "$REAL_BEFORE" = "$REAL_AFTER" ]; then
  pass "isolation: real live config was not touched"
else
  fail "isolation: real live config appears to have been modified"
fi

echo
if [ "$FAILURES" -ne 0 ]; then
  printf 'test-backup-restore: %d failure(s)\n' "$FAILURES" >&2
  exit 1
fi
printf 'test-backup-restore: all checks passed\n'
