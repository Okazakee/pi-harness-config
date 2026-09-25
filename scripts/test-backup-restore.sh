#!/usr/bin/env bash
# ============================================================
# test-backup-restore.sh — isolated backup/restore round-trip.
#
# Runs the real backup.sh and restore.sh against throwaway HOME,
# PI_CODING_AGENT_DIR and PI_BACKUP_REPO values. The live
# ~/.pi/agent, ~/.config/mcp and ~/.agents are never written to.
#
# Verifies: allowlisted scalars round-trip, dcp.jsonc and the MCP config
# round-trip byte-identically, forbidden paths are never copied, the agent-dir
# secret store and auth.json are never copied, a repository-side .secrets/
# store blocks the copy, restore backs up the existing config before replacing
# it, and the live version preflight runs before the copy
# phase, reports Pi drift, refreshes snapshot metadata, runs the local Pi
# transition compatibility checks, and runs the repository contract afterwards.
# The pre-copy guard blocks repository-only edits that differ from live
# unless --overwrite-repo-edits is passed. Absence is mirrored for optional
# sources, required sources abort the backup when missing, and a failure
# before the copy phase leaves the repository unchanged.
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

# The agent-dir secret store must never be picked up by the snapshot.
mkdir -p "$AGENT/.secrets"
printf 'secret store fixture\n' >"$AGENT/.secrets/EXA_API_KEY"

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

# ---------------------------------------------------------------- 1d. transactional pre-copy failure
# A Pi transition whose compatibility checks fail must leave the repository
# byte-identical: no README refresh, no copy, no snapshot advance.
cp "$REPO/README.md" "$WORK/repo-readme.bak"
cp "$REPO/pi/settings.json" "$WORK/repo-settings.bak"
git -C "$REPO" checkout -- README.md pi/settings.json
# Make every mirrored repository file clean so the live renderer change below
# cannot trip the overwrite guard.
git -C "$REPO" add -A
git -C "$REPO" -c user.email=fixture@test -c user.name=fixture commit -q -m "pre-transition fixture"
printf '#!/usr/bin/env python3\nimport sys\nsys.exit(1)\n' >"$AGENT/patch-pi-renderer.py"
snapshot_before_transition="$(sha256sum "$REPO/pi/versions.json" | awk '{print $1}')"
rc=0
bash "$BACKUP_SH" >"$WORK/backup-transition-fail.log" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'renderer patch signatures are not provable' "$WORK/backup-transition-fail.log"; then
  pass "backup: failed Pi transition aborts the backup"
else
  fail "backup: failed Pi transition did not abort (rc=$rc)"
fi
if grep -q '0.87.1' "$REPO/README.md"; then
  pass "backup: failed transition leaves README metadata unrefreshed"
else
  fail "backup: failed transition refreshed README metadata"
fi
if grep -q 'copied pi/settings.json' "$WORK/backup-transition-fail.log"; then
  fail "backup: failed transition copied files"
else
  pass "backup: failed transition performed no copy"
fi
if [ "$snapshot_before_transition" = "$(sha256sum "$REPO/pi/versions.json" | awk '{print $1}')" ]; then
  pass "backup: failed transition leaves the version snapshot unchanged"
else
  fail "backup: failed transition advanced the version snapshot"
fi
# Restore the healthy fixtures.
printf '#!/usr/bin/env python3\nprint("fixture")\n' >"$AGENT/patch-pi-renderer.py"
cp "$WORK/repo-readme.bak" "$REPO/README.md"
cp "$WORK/repo-settings.bak" "$REPO/pi/settings.json"

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

# A secret store inside the repository clone is rejected before any copy.
mkdir -p "$REPO/.secrets"
printf 'repository-side store\n' >"$REPO/.secrets/EXA_API_KEY"
rc=0
bash "$BACKUP_SH" >"$WORK/backup-repo-secrets.log" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'secret store found at' "$WORK/backup-repo-secrets.log"; then
  pass "backup: secret store inside the clone blocks the copy"
else
  fail "backup: secret store inside the clone did not block (rc=$rc)"
fi
if grep -q 'copied pi/AGENTS.md' "$WORK/backup-repo-secrets.log"; then
  fail "backup: secret-store guard ran after copying"
else
  pass "backup: secret-store guard performed no copy"
fi
rm -rf "$REPO/.secrets"

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

# ---------------------------------------------------------------- 3c. deletion and absence semantics
# Commit the mirrored fixture so the absence tests start from a clean checkout.
git -C "$REPO" add -A
git -C "$REPO" -c user.email=fixture@test -c user.name=fixture commit -q -m "snapshot fixture"

# Repository deletion with live present is a conflict: the copy would
# resurrect the file and discard the repository's deletion.
rm "$REPO/pi/agents/reviewer.md"
rc=0
bash "$BACKUP_SH" >"$WORK/backup-guard-deleted.log" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'pi/agents/reviewer.md' "$WORK/backup-guard-deleted.log"; then
  pass "backup: repository deletion with live present blocks the copy"
else
  fail "backup: repository deletion with live present did not block (rc=$rc)"
fi
git -C "$REPO" checkout -- pi/agents/reviewer.md

# Repository and live deletion of the same path is the same state: allowed.
rm "$REPO/pi/agents/reviewer.md"
rm "$AGENT/agents/reviewer.md"
rc=0
bash "$BACKUP_SH" >"$WORK/backup-guard-both-gone.log" 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "backup: matching repository and live deletion is not a conflict"
else
  fail "backup: matching deletion blocked the backup (rc=$rc)"
fi
printf 'agent fixture\n' >"$AGENT/agents/reviewer.md"
git -C "$REPO" checkout -- pi/agents/reviewer.md

# Optional scalar removed from live: the stale repository copy is removed.
rm "$AGENT/keybindings.json"
rc=0
bash "$BACKUP_SH" >"$WORK/backup-remove-scalar.log" 2>&1 || rc=$?
if [ "$rc" -eq 0 ] && [ ! -e "$REPO/pi/keybindings.json" ] && grep -q 'removed pi/keybindings.json' "$WORK/backup-remove-scalar.log"; then
  pass "backup: optional scalar removal is mirrored"
else
  fail "backup: optional scalar removal was not mirrored (rc=$rc)"
fi
printf '{\n  "bindings": {}\n}\n' >"$AGENT/keybindings.json"
git -C "$REPO" checkout -- pi/keybindings.json

# Optional directory removed from live: the stale repository copy is removed.
rm -rf "$AGENT/themes"
rc=0
bash "$BACKUP_SH" >"$WORK/backup-remove-dir.log" 2>&1 || rc=$?
if [ "$rc" -eq 0 ] && [ ! -e "$REPO/pi/themes" ] && grep -q 'removed pi/themes' "$WORK/backup-remove-dir.log"; then
  pass "backup: optional directory removal is mirrored"
else
  fail "backup: optional directory removal was not mirrored (rc=$rc)"
fi
mkdir -p "$AGENT/themes"
printf '{"name":"fixture-theme"}\n' >"$AGENT/themes/fixture.json"
git -C "$REPO" checkout -- pi/themes

# Required source missing from live: abort before the repository is touched.
cp "$REPO/README.md" "$WORK/readme-before-required.bak"
rm -f "$AGENT/settings.json"
rc=0
bash "$BACKUP_SH" >"$WORK/backup-required-scalar.log" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'required live config is missing: .*settings.json' "$WORK/backup-required-scalar.log"; then
  pass "backup: missing required settings.json blocks before copying"
else
  fail "backup: missing required settings.json did not block (rc=$rc)"
fi
if cmp -s "$WORK/readme-before-required.bak" "$REPO/README.md"; then
  pass "backup: required-source failure leaves the repository untouched"
else
  fail "backup: required-source failure mutated the repository"
fi
printf '{\n  "theme": "fixture",\n  "lastChangelogVersion": "0.87.2",\n  "packages": []\n}\n' >"$AGENT/settings.json"

# Required directory missing from live: same pre-copy block.
rm -rf "$AGENT/extensions"
rc=0
bash "$BACKUP_SH" >"$WORK/backup-required-dir.log" 2>&1 || rc=$?
if [ "$rc" -ne 0 ] && grep -q 'required live config directory is missing: .*extensions' "$WORK/backup-required-dir.log"; then
  pass "backup: missing required extensions/ blocks before copying"
else
  fail "backup: missing required extensions/ did not block (rc=$rc)"
fi
mkdir -p "$AGENT/extensions/todo"
printf 'export default 1\n' >"$AGENT/extensions/fixture.ts"
printf 'export const helperFixture = 1\n' >"$AGENT/extensions/todo/helper.ts"

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

if [ -f "$AGENT/.secrets/EXA_API_KEY" ] && [ "$(cat "$AGENT/.secrets/EXA_API_KEY")" = "secret store fixture" ]; then
  pass "restore: agent-dir secret store content untouched"
else
  fail "restore: restore modified the agent-dir secret store"
fi

if [ "$(stat -c %a "$AGENT/.secrets")" = "700" ]; then
  pass "restore: secret store directory mode is 700"
else
  fail "restore: secret store directory mode is $(stat -c %a "$AGENT/.secrets" 2>/dev/null)"
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

# ---------------------------------------------------------------- 5b. restore symmetry
# Restore reconciles the snapshot instead of overlaying it: optional sources
# absent from the snapshot are removed from live, and mirrored directories
# are synchronized with --delete.
rm -f "$REPO/pi/keybindings.json"
rm -rf "$REPO/pi/themes"
mv "$REPO/mcp/mcp.json" "$WORK/mcp.snapshot"
printf 'stale extension\n' >"$AGENT/extensions/old-extension.ts"
printf 'stale shared skill\n' >"$SHARED/agentskill/stale.md"
printf 'stale secret\n' >"$AGENT/.secrets/stale-secret"
printf '{"bindings":{}}\n' >"$AGENT/keybindings.json"
mkdir -p "$AGENT/themes"
printf '{"name":"stale-theme"}\n' >"$AGENT/themes/stale.json"
printf '{"mcpServers":{}}\n' >"$MCP"
rc=0
bash "$RESTORE_SH" --yes --no-packages --no-obscura --no-patch >"$WORK/restore-symmetry.log" 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "restore: symmetry run completes"
else
  fail "restore: symmetry run exited $rc"
  sed 's/^/        /' "$WORK/restore-symmetry.log" >&2
fi
if [ ! -e "$AGENT/keybindings.json" ]; then
  pass "restore: snapshot-absent optional scalar removed from live"
else
  fail "restore: snapshot-absent optional scalar was not removed"
fi
if [ ! -e "$AGENT/themes" ]; then
  pass "restore: snapshot-absent optional directory removed from live"
else
  fail "restore: snapshot-absent optional directory was not removed"
fi
if [ ! -e "$MCP" ]; then
  pass "restore: snapshot-absent MCP config removed from live"
else
  fail "restore: snapshot-absent MCP config was not removed"
fi
if [ ! -e "$AGENT/extensions/old-extension.ts" ]; then
  pass "restore: stale file inside a mirrored directory removed"
else
  fail "restore: stale file inside a mirrored directory survived"
fi
if [ ! -e "$SHARED/agentskill/stale.md" ]; then
  pass "restore: stale shared skill removed"
else
  fail "restore: stale shared skill survived"
fi

if [ -f "$AGENT/.secrets/stale-secret" ] && [ "$(cat "$AGENT/.secrets/stale-secret")" = "stale secret" ]; then
  pass "restore: agent-dir secret store is outside reconciliation"
else
  fail "restore: restore touched the agent-dir secret store"
fi
newest_backup="$(ls -1dt "$AGENT/backups"/restore-* 2>/dev/null | head -n1)"
if [ -n "$newest_backup" ] && [ -f "$newest_backup/mcp/mcp.json" ] && [ -d "$newest_backup/shared-skills" ]; then
  pass "restore: pre-restore backup includes MCP and shared skills"
else
  fail "restore: pre-restore backup is missing MCP or shared skills"
fi

# Put the snapshot back for the remaining checks.
git -C "$REPO" checkout -- pi/keybindings.json pi/themes mcp/mcp.json

# ---------------------------------------------------------------- 5c. shared-skills absence policy
# The secret store is absent here too: restore must recreate the directory
# (mode 700) without inventing content.
rm -rf "$AGENT/.secrets"
mkdir -p "$SHARED/agentskill/examples" "$SHARED/agentskill/tests"
printf 'dev example\n' >"$SHARED/agentskill/examples/keep.md"
printf 'dev test\n' >"$SHARED/agentskill/tests/keep.md"
printf 'managed skill\n' >"$SHARED/agentskill/stale-managed.md"
mv "$REPO/shared-skills" "$WORK/shared-skills.snapshot"
rc=0
bash "$RESTORE_SH" --yes --no-packages --no-obscura --no-patch >"$WORK/restore-shared-absent.log" 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "restore: shared-skills absence run completes"
else
  fail "restore: shared-skills absence run exited $rc"
fi

if [ -d "$AGENT/.secrets" ] && [ "$(stat -c %a "$AGENT/.secrets")" = "700" ] && [ -z "$(ls -A "$AGENT/.secrets")" ]; then
  pass "restore: missing secret store recreated empty with mode 700"
else
  fail "restore: secret store directory was not recreated correctly"
fi
if [ -f "$SHARED/agentskill/examples/keep.md" ] && [ -f "$SHARED/agentskill/tests/keep.md" ]; then
  pass "restore: shared-skills absence preserves excluded dev trees"
else
  fail "restore: shared-skills absence clobbered excluded dev trees"
fi
if [ ! -e "$SHARED/agentskill/stale-managed.md" ]; then
  pass "restore: shared-skills absence removes managed content"
else
  fail "restore: shared-skills absence left managed content"
fi
mv "$WORK/shared-skills.snapshot" "$REPO/shared-skills"

# ---------------------------------------------------------------- 5d. strict failure handling
# A failing recovery copy must abort before any reconciliation.
REAL_CP="$(command -v cp)"
cat >"$WORK/stubs/cp" <<SH
#!/usr/bin/env bash
for arg in "\$@"; do
  case "\$arg" in
    */backups/restore-*) echo "stub cp: refusing \$arg" >&2; exit 1 ;;
  esac
done
exec "$REAL_CP" "\$@"
SH
chmod +x "$WORK/stubs/cp"
printf 'sentinel settings\n' >"$AGENT/settings.json"
rc=0
bash "$RESTORE_SH" --yes --no-packages --no-obscura --no-patch >"$WORK/restore-recovery-fail.log" 2>&1 || rc=$?
rm -f "$WORK/stubs/cp"
if [ "$rc" -ne 0 ]; then
  pass "restore: failed recovery copy aborts"
else
  fail "restore: failed recovery copy did not abort (rc=$rc)"
fi
if grep -q 'copy failed' "$WORK/restore-recovery-fail.log" && ! grep -q 'backed up existing config' "$WORK/restore-recovery-fail.log"; then
  pass "restore: failed recovery copy is not logged as success"
else
  fail "restore: failed recovery copy was falsely logged"
fi
if grep -q 'sentinel settings' "$AGENT/settings.json" && ! grep -q 'restored settings.json' "$WORK/restore-recovery-fail.log"; then
  pass "restore: failed recovery copy prevents reconciliation"
else
  fail "restore: reconciliation ran after a failed recovery copy"
fi

# A failing rsync during reconciliation must abort non-zero.
cat >"$WORK/stubs/rsync" <<'SH'
#!/usr/bin/env bash
echo "stub rsync: failing" >&2
exit 1
SH
chmod +x "$WORK/stubs/rsync"
rc=0
bash "$RESTORE_SH" --yes --no-packages --no-obscura --no-patch >"$WORK/restore-rsync-fail.log" 2>&1 || rc=$?
rm -f "$WORK/stubs/rsync"
if [ "$rc" -ne 0 ]; then
  pass "restore: failed reconciliation sync aborts"
else
  fail "restore: failed reconciliation sync did not abort (rc=$rc)"
fi
if grep -q 'snapshot reconciliation failed' "$WORK/restore-rsync-fail.log"; then
  pass "restore: failed sync reports the reconciliation error"
else
  fail "restore: failed sync error not reported"
fi
if grep -q 'restore: done' "$WORK/restore-rsync-fail.log" || grep -q 'restored extensions/' "$WORK/restore-rsync-fail.log"; then
  fail "restore: failed sync was falsely logged as success"
else
  pass "restore: failed sync is never logged as success"
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
