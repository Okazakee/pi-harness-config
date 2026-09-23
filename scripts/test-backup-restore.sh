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
# and auth.json are never copied, restore backs up the existing config
# before replacing it, and the live version preflight runs before the copy
# phase, reports Pi drift, refreshes snapshot metadata, runs the local Pi
# transition compatibility checks, and runs the repository contract afterwards.
# The pre-copy guard blocks repository-only edits that differ from live
# unless --overwrite-repo-edits is passed.
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
mkdir -p "$AGENT/agents" "$AGENT/extensions" "$AGENT/extensions/todo" "$AGENT/themes" "$AGENT/skills/demo" \
         "$(dirname "$MCP")" "$SHARED/agentskill/scripts" \
         "$AGENT/sessions" "$AGENT/install" "$AGENT/npm" "$AGENT/bin" "$AGENT/git"

printf '# AGENTS\n' >"$AGENT/AGENTS.md"
printf '{\n  "theme": "fixture",\n  "lastChangelogVersion": "0.87.2",\n  "packages": []\n}\n' >"$AGENT/settings.json"
printf '{\n  "bindings": {}\n}\n' >"$AGENT/keybindings.json"
printf '#!/usr/bin/env python3\nprint("fixture")\n' >"$AGENT/patch-pi-renderer.py"
printf '\x89PNG\r\n\x1a\n fixture-logo' >"$AGENT/logo.png"
printf '{\n  // declarative DCP policy\n  "enabled": true,\n  "keepRecent": 3\n}\n' >"$AGENT/dcp.jsonc"
printf '{\n  "biome": {\n    "command": ["biome", "lsp-proxy"],\n    "extensions": [".ts"]\n  }\n}\n' >"$AGENT/pi-lsp.json"
printf 'agent fixture\n' >"$AGENT/agents/reviewer.md"
printf 'export default 1\n' >"$AGENT/extensions/fixture.ts"
printf 'export const helperFixture = 1\n' >"$AGENT/extensions/todo/helper.ts"
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

# Version preflight fixtures: stub binaries (prepended to PATH, so the real
# machine's tools are never used) plus the managed install marker.
mkdir -p "$WORK/stubs"
printf '#!/bin/sh\nprintf "%%s\\n" "0.87.2"\n' >"$WORK/stubs/pi"
printf '#!/bin/sh\nprintf "%%s\\n" "rtk 0.49.0"\n' >"$WORK/stubs/rtk"
printf '#!/bin/sh\nprintf "%%s\\n" "trufflehog 3.97.6"\n' >"$WORK/stubs/trufflehog"
printf '#!/bin/sh\nprintf "%%s\\n" "obscura 0.2.3"\n' >"$WORK/stubs/obscura"
chmod +x "$WORK"/stubs/*
export PATH="$WORK/stubs:$PATH"
printf '0.87.2' >"$AGENT/install/current-version"

git -C "$WORK" init -q -b main "$REPO" 2>/dev/null || { mkdir -p "$REPO"; git -C "$REPO" init -q -b main; }

# Pre-existing repository snapshot metadata, one Pi version behind live, plus
# a repository-contract stub that records having run.
mkdir -p "$REPO/pi" "$REPO/scripts"
printf '{\n  "lastChangelogVersion": "0.87.1"\n}\n' >"$REPO/pi/settings.json"
printf '# Fixture repository\n\n- Pi version at backup time: **0.87.1**\n' >"$REPO/README.md"
cat >"$REPO/scripts/check-repo.sh" <<'SH'
#!/usr/bin/env bash
touch "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/.check-repo-ran"
exit 0
SH
chmod +x "$REPO/scripts/check-repo.sh"

# The repository starts as a clean checkout; the guard must not mistake the
# committed fixture metadata for uncommitted repository-only edits.
git -C "$REPO" add -A
git -C "$REPO" -c user.email=fixture@test -c user.name=fixture commit -q -m "fixture snapshot"

# ---------------------------------------------------------------- 1. backup
rc=0
bash "$BACKUP_SH" >"$WORK/backup.log" 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "backup.sh completes against an isolated HOME"
else
  fail "backup.sh exited $rc"
  sed 's/^/        /' "$WORK/backup.log" >&2
fi

# ---------------------------------------------------------------- 1b. version preflight
preflight_line="$(grep -n 'Live version preflight' "$WORK/backup.log" | head -n1 | cut -d: -f1)"
copy_line="$(grep -n 'copied pi/settings.json' "$WORK/backup.log" | head -n1 | cut -d: -f1)"
if [ -n "$preflight_line" ] && [ -n "$copy_line" ] && [ "$preflight_line" -lt "$copy_line" ]; then
  pass "backup: version preflight runs before the copy phase"
else
  fail "backup: version preflight ordering not proven (preflight=${preflight_line:-none} copy=${copy_line:-none})"
fi

if grep -q 'Version drift detected: Pi 0.87.1 → 0.87.2' "$WORK/backup.log"; then
  pass "backup: Pi drift is detected and reported before copying"
else
  fail "backup: Pi drift was not reported"
fi

if grep -q '0.87.2' "$REPO/README.md"; then
  pass "backup: README snapshot metadata refreshed to live Pi"
else
  fail "backup: README snapshot metadata was not refreshed"
fi

if [ -f "$REPO/.check-repo-ran" ]; then
  pass "backup: repository contract ran after the copy phase"
else
  fail "backup: repository contract did not run after copying"
fi

if grep -q 'Pi version transition: running local compatibility checks' "$WORK/backup.log"; then
  pass "backup: Pi transition triggers local compatibility checks"
else
  fail "backup: Pi transition checks did not run"
fi

if [ -f "$REPO/pi/versions.json" ]; then
  pass "backup: version snapshot created after the first successful backup"
else
  fail "backup: version snapshot missing after a successful backup"
fi
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("schemaVersion")==1 and d.get("pi")=="0.87.2" else 1)' "$REPO/pi/versions.json" 2>/dev/null; then
  pass "backup: version snapshot records the live Pi version"
else
  fail "backup: version snapshot content is wrong"
fi
if grep -q 'version snapshot updated: pi/versions.json' "$WORK/backup.log"; then
  pass "backup: snapshot commit is reported after verification"
else
  fail "backup: snapshot commit was not reported"
fi
if ls "$REPO"/.versions.json.staged.* "$REPO"/.versions.json.prev.* >/dev/null 2>&1; then
  fail "backup: staging leftovers remain after a successful run"
else
  pass "backup: no staging leftovers after a successful run"
fi

# A second successful run replaces the snapshot and must leave no rollback
# temps behind (this is the success path that owns a previous snapshot).
snapshot_first="$(sha256sum "$REPO/pi/versions.json" | awk '{print $1}')"
rc=0
bash "$BACKUP_SH" >"$WORK/backup-second.log" 2>&1 || rc=$?
snapshot_second="$(sha256sum "$REPO/pi/versions.json" | awk '{print $1}')"
if [ "$rc" -eq 0 ]; then
  pass "backup: second unchanged run exits 0 (stable fixed point)"
else
  fail "backup: second unchanged run exited $rc"
fi
if [ "$snapshot_first" = "$snapshot_second" ]; then
  pass "backup: second unchanged run leaves the snapshot content identical"
else
  fail "backup: second unchanged run changed the snapshot content"
fi
if ls "$REPO"/.versions.json.staged.* "$REPO"/.versions.json.prev.* >/dev/null 2>&1; then
  fail "backup: staging leftovers remain after a second successful run"
else
  pass "backup: no staging leftovers after a second successful run"
fi

# ---------------------------------------------------------------- 1c. transactional snapshot
snapshot_before="$(sha256sum "$REPO/pi/versions.json" | awk '{print $1}')"
cat >"$REPO/scripts/check-repo.sh" <<'SH'
#!/usr/bin/env bash
exit 1
SH
chmod +x "$REPO/scripts/check-repo.sh"
rc=0
bash "$BACKUP_SH" >"$WORK/backup-fail.log" 2>&1 || rc=$?
snapshot_after="$(sha256sum "$REPO/pi/versions.json" | awk '{print $1}')"
if [ "$rc" -ne 0 ]; then
  pass "backup: failing post-copy verification exits non-zero"
else
  fail "backup: verification failure did not fail the backup"
fi
if [ "$snapshot_before" = "$snapshot_after" ]; then
  pass "backup: failed verification leaves the version snapshot unchanged"
else
  fail "backup: failed verification advanced the version snapshot"
fi
if ls "$REPO"/.versions.json.staged.* "$REPO"/.versions.json.prev.* >/dev/null 2>&1; then
  fail "backup: staging leftovers remain after a failed run"
else
  pass "backup: no staging leftovers after a failed run"
fi

# Restore the contract stub for the remaining checks.
cat >"$REPO/scripts/check-repo.sh" <<'SH'
#!/usr/bin/env bash
touch "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/.check-repo-ran"
exit 0
SH
chmod +x "$REPO/scripts/check-repo.sh"

# ---------------------------------------------------------------- 2. allowlisted round-trip
for f in AGENTS.md settings.json keybindings.json patch-pi-renderer.py logo.png dcp.jsonc pi-lsp.json; do
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

if cmp -s "$AGENT/extensions/todo/helper.ts" "$REPO/pi/extensions/todo/helper.ts"; then
  pass "backup: nested extension helper directory copied"
else
  fail "backup: nested extension helper directory was not copied"
fi

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

# ---------------------------------------------------------------- 3b. dirty-repo guard
# A tracked repository-only edit that differs from live must block before any
# copy, and must be preserved.
git -C "$REPO" add pi/agents/reviewer.md
git -C "$REPO" -c user.email=fixture@test -c user.name=fixture commit -q -m "track reviewer fixture"
printf 'repository-only edit\n' >"$REPO/pi/agents/reviewer.md"
rc=0
bash "$BACKUP_SH" >"$WORK/backup-guard.log" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'local edits in live-mirrored paths' "$WORK/backup-guard.log"; then
  pass "backup: repository-only edit blocks the copy"
else
  fail "backup: repository-only edit did not block (rc=$rc)"
fi
if grep -q 'repository-only edit' "$REPO/pi/agents/reviewer.md"; then
  pass "backup: blocked run preserved the repository edit"
else
  fail "backup: blocked run overwrote the repository edit"
fi
if grep -q 'copied pi/AGENTS.md' "$WORK/backup-guard.log"; then
  fail "backup: blocked run copied files despite the guard"
else
  pass "backup: blocked run performed no copy"
fi

# An untracked repository-only file is the same hazard.
printf 'untracked repository-only file\n' >"$REPO/pi/agents/untracked.md"
rc=0
bash "$BACKUP_SH" >"$WORK/backup-guard-untracked.log" 2>&1 || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "backup: untracked repository-only file blocks the copy"
else
  fail "backup: untracked repository-only file did not block (rc=$rc)"
fi
rm -f "$REPO/pi/agents/untracked.md"

# The escape hatch deliberately discards the conflicting edit.
rc=0
bash "$BACKUP_SH" --overwrite-repo-edits >"$WORK/backup-overwrite.log" 2>&1 || rc=$?
if [ "$rc" -eq 0 ] && cmp -s "$AGENT/agents/reviewer.md" "$REPO/pi/agents/reviewer.md"; then
  pass "backup: --overwrite-repo-edits discards the repository edit and copies live"
else
  fail "backup: --overwrite-repo-edits did not complete (rc=$rc)"
fi

# A dirty tree identical to live is benign (previous backup output).
rc=0
bash "$BACKUP_SH" >"$WORK/backup-benign.log" 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "backup: dirty tree identical to live is not a conflict"
else
  fail "backup: benign dirty state blocked the backup (rc=$rc)"
fi

# ---------------------------------------------------------------- 4. restore round-trip
DCP_SUM_BEFORE="$(sha256sum "$REPO/pi/dcp.jsonc" | awk '{print $1}')"
MCP_SUM_BEFORE="$(sha256sum "$REPO/mcp/mcp.json" | awk '{print $1}')"

# Corrupt the live config so restore has something to put back.
printf 'corrupted\n' >"$AGENT/settings.json"
printf 'corrupted\n' >"$AGENT/dcp.jsonc"
rm -f "$AGENT/AGENTS.md"
rm -rf "$AGENT/extensions/todo"
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

if [ -f "$AGENT/extensions/todo/helper.ts" ] && cmp -s "$REPO/pi/extensions/todo/helper.ts" "$AGENT/extensions/todo/helper.ts"; then
  pass "restore: nested extension helper directory round-trips"
else
  fail "restore: nested extension helper directory was not restored"
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
