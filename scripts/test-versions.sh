#!/usr/bin/env bash
# ============================================================
# test-versions.sh — isolated tests for versions-lib.sh.
#
# Builds throwaway agent/repo fixtures and stub binaries (prepended to
# PATH); the real ~/.pi/agent, the real lock files and the real
# installed packages are never touched. Fully offline: only local
# files and stubs are consulted.
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$REPO_ROOT/pi/skills/pi-config-backup/scripts/versions-lib.sh"
[ -f "$LIB" ] || {
  printf 'test-versions: missing %s\n' "$LIB" >&2
  exit 1
}

FAILURES=0
pass() { printf 'ok      %s\n' "$1"; }
fail() { printf 'FAIL    %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STUBS="$WORK/bin"
mkdir -p "$STUBS"

write_stub() { # <name> <output line>
  printf '#!/bin/sh\nprintf "%%s\\n" "%s"\n' "$2" >"$STUBS/$1"
  chmod +x "$STUBS/$1"
}
write_failing_stub() { # <name>
  printf '#!/bin/sh\nexit 1\n' >"$STUBS/$1"
  chmod +x "$STUBS/$1"
}

write_stub pi "0.87.1"
write_stub rtk "rtk 0.49.0"
write_stub trufflehog "trufflehog 3.97.6"
write_stub obscura "obscura 0.2.3"
write_stub node "v22.22.0"
export PATH="$STUBS:$PATH"

# shellcheck source=versions-lib.sh disable=SC1091
. "$LIB"

AGENT=""
REPO=""
CASE=""

write_live_settings() { # [packages-json]
  cat >"$AGENT/settings.json" <<EOF
{ "lastChangelogVersion": "0.87.1", "packages": ${1:-[]} }
EOF
}

write_repo_metadata() { # [pi-version]
  local version="${1:-0.87.1}"
  cat >"$REPO/pi/settings.json" <<EOF
{ "lastChangelogVersion": "$version", "packages": [] }
EOF
  cat >"$REPO/README.md" <<EOF
# fixture

- Pi version at backup time: **$version**
EOF
  cat >"$REPO/deps/obscura.lock.json" <<'EOF'
{ "version": "v0.2.3", "assets": {} }
EOF
  cat >"$REPO/deps/tools.lock.json" <<'EOF'
{ "trufflehog": { "version": "3.97.6" } }
EOF
}

new_case() {
  CASE="$(mktemp -d -p "$WORK")"
  AGENT="$CASE/agent"
  REPO="$CASE/repo"
  mkdir -p "$AGENT/install" "$AGENT/npm/node_modules" "$AGENT/git/github.com/PSU3D0" \
    "$REPO/pi" "$REPO/deps" "$REPO/docs"
  printf '0.87.1' >"$AGENT/install/current-version"
  write_live_settings
  write_repo_metadata
}

discover() { versions_discover "$AGENT" "$REPO"; }

row_status() { # <component>
  local component="$1" row name status
  for row in "${VERSIONS_ROWS[@]}"; do
    IFS='|' read -r name _ _ status _ <<<"$row"
    if [ "$name" = "$component" ]; then
      printf '%s' "$status"
      return 0
    fi
  done
  printf 'ABSENT'
}

expect_status() { # <description> <component> <status>
  local got
  got="$(row_status "$2")"
  if [ "$got" = "$3" ]; then
    pass "$1"
  else
    fail "$1 (got $got, want $3)"
  fi
}

expect_blocked() { # <description>
  if [ "${#VERSIONS_BLOCKERS[@]}" -gt 0 ]; then
    pass "$1"
  else
    fail "$1 (no blockers reported)"
  fi
}

expect_clear() { # <description>
  if [ "${#VERSIONS_BLOCKERS[@]}" -eq 0 ]; then
    pass "$1"
  else
    fail "$1 (blockers: ${VERSIONS_BLOCKERS[*]})"
  fi
}

make_checkout() { # <owner/repo> -> prints installed SHA
  local dir="$AGENT/git/github.com/$1"
  mkdir -p "$dir"
  git init -q "$dir"
  git -C "$dir" -c user.email=fixture@test -c user.name=fixture commit -q --allow-empty -m fixture
  git -C "$dir" rev-parse HEAD
}

# ---------------------------------------------------------------- probes
if [ "$(versions_probe node --version)" = "22.22.0" ]; then
  pass "semver probe keeps multi-digit components (v22.22.0)"
else
  fail "semver probe mangled v22.22.0: got '$(versions_probe node --version)'"
fi

# ---------------------------------------------------------------- Pi unchanged
new_case
discover
expect_status "Pi unchanged is OK" "Pi" "OK"
expect_clear "Pi unchanged has no blockers"
if [ "${#VERSIONS_DRIFTS[@]}" -eq 0 ]; then
  pass "Pi unchanged reports no drift"
else
  fail "Pi unchanged reported drift: ${VERSIONS_DRIFTS[*]}"
fi
expect_status "TruffleHog match is OK" "TruffleHog" "OK"
expect_status "Obscura match is OK" "Obscura" "OK"
expect_status "RTK is discovered" "RTK" "OK"

# ---------------------------------------------------------------- Pi upgraded
new_case
write_stub pi "0.87.2"
printf '0.87.2' >"$AGENT/install/current-version"
discover
expect_status "Pi upgrade is DRIFT" "Pi" "DRIFT"
expect_clear "Pi upgrade is not blocked"
if [ "${#VERSIONS_DRIFTS[@]}" -gt 0 ]; then
  pass "Pi upgrade reports drift"
else
  fail "Pi upgrade did not report drift"
fi
rc=0
versions_preflight "$AGENT" "$REPO" --refresh >"$WORK/upgrade.log" 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "Pi upgrade preflight exits 0 (drift is not an error)"
else
  fail "Pi upgrade preflight exited $rc"
fi
if grep -q '0.87.2' "$REPO/README.md"; then
  pass "Pi upgrade refreshes README snapshot metadata"
else
  fail "README was not refreshed to 0.87.2"
fi
if grep -q 'Version drift detected: Pi 0.87.1 → 0.87.2' "$WORK/upgrade.log"; then
  pass "Pi upgrade drift is reported explicitly"
else
  fail "drift line missing from preflight output"
fi
write_stub pi "0.87.1"

# ---------------------------------------------------------------- Pi inconsistency
new_case
write_stub pi "0.87.2"
# managed marker stays 0.87.1
discover
expect_status "runtime/marker mismatch is BLOCK" "Pi" "BLOCK"
expect_blocked "runtime/marker mismatch blocks backup"

new_case
write_failing_stub pi
rm -f "$AGENT/install/current-version"
discover
expect_status "undiscoverable Pi is BLOCK" "Pi" "BLOCK"
expect_blocked "undiscoverable Pi blocks backup"
write_stub pi "0.87.1"

# ---------------------------------------------------------------- pinned tools
new_case
write_stub trufflehog "trufflehog 3.97.5"
discover
expect_status "TruffleHog mismatch is BLOCK" "TruffleHog" "BLOCK"
expect_blocked "TruffleHog mismatch blocks backup"
write_stub trufflehog "trufflehog 3.97.6"

new_case
write_failing_stub trufflehog
discover
expect_status "required TruffleHog missing is BLOCK" "TruffleHog" "BLOCK"
expect_blocked "required TruffleHog missing blocks backup"
write_stub trufflehog "trufflehog 3.97.6"

new_case
printf '{ not json' >"$REPO/deps/tools.lock.json"
discover
expect_status "malformed tools lock is BLOCK" "TruffleHog" "BLOCK"
expect_blocked "malformed tools lock blocks backup"

new_case
write_stub obscura "obscura 0.2.2"
discover
expect_status "Obscura mismatch is BLOCK" "Obscura" "BLOCK"
expect_blocked "Obscura mismatch blocks backup"
write_stub obscura "obscura 0.2.3"

new_case
write_failing_stub obscura
discover
expect_status "Obscura missing is MISSING" "Obscura" "MISSING"
expect_clear "Obscura missing does not block (restore installs it)"
write_stub obscura "obscura 0.2.3"

# ---------------------------------------------------------------- git pins
new_case
sha="$(make_checkout PSU3D0/pi-dcp)"
write_live_settings "[\"git:github.com/PSU3D0/pi-dcp@$sha\"]"
discover
expect_status "DCP exact pin verifies installed commit" "git:github.com/PSU3D0/pi-dcp" "OK"
expect_clear "DCP exact pin does not block"

new_case
write_live_settings '["git:github.com/PSU3D0/pi-dcp"]'
discover
expect_status "floating DCP pin is BLOCK" "git:github.com/PSU3D0/pi-dcp" "BLOCK"
expect_blocked "floating DCP pin blocks backup"

new_case
make_checkout PSU3D0/pi-dcp >/dev/null
write_live_settings '["git:github.com/PSU3D0/pi-dcp@0000000000000000000000000000000000000000"]'
discover
expect_status "DCP pin/commit mismatch is BLOCK" "git:github.com/PSU3D0/pi-dcp" "BLOCK"
expect_blocked "DCP pin/commit mismatch blocks backup"

# ---------------------------------------------------------------- npm packages
new_case
mkdir -p "$AGENT/npm/node_modules/@narumitw/pi-goal"
printf '{ "version": "0.54.8" }' >"$AGENT/npm/node_modules/@narumitw/pi-goal/package.json"
write_live_settings '["npm:@narumitw/pi-goal"]'
discover
expect_status "npm package version is discovered" "npm:@narumitw/pi-goal" "OK"
expect_clear "npm package discovery does not block"

# ---------------------------------------------------------------- stale refs
new_case
write_repo_metadata "0.87.0"
write_stub pi "0.87.1"
printf '0.87.1' >"$AGENT/install/current-version"
printf 'Pi 0.87.0 introduced the migration pipeline.\n' >"$REPO/docs/history.md"
before="$(cat "$REPO/docs/history.md")"
preflight_out="$(versions_preflight "$AGENT" "$REPO" --refresh 2>&1)"
after="$(cat "$REPO/docs/history.md")"
if [ "$before" = "$after" ]; then
  pass "historical version reference is not rewritten"
else
  fail "historical version reference was rewritten"
fi
if printf '%s' "$preflight_out" | grep -q 'docs/history.md.*review'; then
  pass "historical version reference is reported for review"
else
  fail "historical reference missing from the stale-reference report"
fi
if printf '%s' "$preflight_out" | grep -q 'Version drift detected: Pi 0.87.0 → 0.87.1'; then
  pass "stale snapshot field is detected as drift"
else
  fail "stale snapshot drift not detected"
fi
if grep -q '0.87.1' "$REPO/README.md" && grep -q '0.87.0' "$REPO/pi/settings.json"; then
  pass "README refreshed; repo settings left for the copy phase"
else
  fail "snapshot metadata refresh path is wrong"
fi

# ---------------------------------------------------------------- transition checks
new_case
cat >"$AGENT/patch-pi-renderer.py" <<'SH'
#!/usr/bin/env python3
import sys
sys.exit(0)
SH
chmod +x "$AGENT/patch-pi-renderer.py"
if versions_pi_transition_checks "$AGENT" "$REPO" >/dev/null 2>&1; then
  pass "Pi transition checks pass on a healthy renderer check"
else
  fail "Pi transition checks failed on a healthy fixture"
fi

new_case
cat >"$AGENT/patch-pi-renderer.py" <<'SH'
#!/usr/bin/env python3
import sys
sys.exit(1)
SH
chmod +x "$AGENT/patch-pi-renderer.py"
if versions_pi_transition_checks "$AGENT" "$REPO" >/dev/null 2>&1; then
  fail "Pi transition checks should fail when the renderer check fails"
else
  pass "Pi transition checks fail when the renderer check fails"
fi

# ---------------------------------------------------------------- version snapshot
new_case
baseline_out="$(versions_compare_snapshot "$REPO" 2>&1)"
if printf '%s' "$baseline_out" | grep -q 'baseline'; then
  pass "snapshot: absent snapshot reports a baseline, not drift"
else
  fail "snapshot: baseline was not reported"
fi
if printf '%s' "$baseline_out" | grep -qE '^  [~+-] '; then
  fail "snapshot: baseline fabricated drift entries"
else
  pass "snapshot: baseline fabricates no drift"
fi

discover
staged="$(versions_snapshot_stage "$REPO")" || fail "snapshot: staging failed"
if [ -n "$staged" ] && [ -f "$staged" ]; then
  pass "snapshot: candidate staged outside the tracked path"
else
  fail "snapshot: no staged candidate"
fi
if [ ! -f "$REPO/pi/versions.json" ]; then
  pass "snapshot: staging does not touch the tracked file"
else
  fail "snapshot: tracked file changed before commit"
fi
versions_snapshot_commit "$staged" "$REPO" || fail "snapshot: commit failed"
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["schemaVersion"]==1 and d["pi"]=="0.87.1" and d["tools"]["obscura"]=="0.2.3" else 1)' "$REPO/pi/versions.json" 2>/dev/null; then
  pass "snapshot: schema, Pi and tool versions recorded deterministically"
else
  fail "snapshot: recorded content is wrong"
fi

no_drift_out="$(versions_preflight "$AGENT" "$REPO" 2>&1)"
if printf '%s' "$no_drift_out" | grep -q 'no changes since the last successful backup'; then
  pass "snapshot: unchanged inventory reports no changes"
else
  fail "snapshot: unchanged inventory reported changes"
fi

# ---- unpinned package drift, addition, removal --------------------------
mkdir -p "$AGENT/npm/node_modules/@narumitw/pi-goal"
printf '{ "version": "0.54.8" }' >"$AGENT/npm/node_modules/@narumitw/pi-goal/package.json"
write_live_settings '["npm:@narumitw/pi-goal"]'
discover
staged="$(versions_snapshot_stage "$REPO")" && versions_snapshot_commit "$staged" "$REPO"
printf '{ "version": "0.55.0" }' >"$AGENT/npm/node_modules/@narumitw/pi-goal/package.json"
drift_out="$(versions_preflight "$AGENT" "$REPO" 2>&1)"
if printf '%s' "$drift_out" | grep -q '~ packages.@narumitw/pi-goal 0.54.8 → 0.55.0'; then
  pass "snapshot: unpinned package drift is reported OLD → NEW"
else
  fail "snapshot: package drift not reported"
fi
rc=0
versions_preflight "$AGENT" "$REPO" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "snapshot: unpinned package drift does not block"
else
  fail "snapshot: package drift blocked backup (rc=$rc)"
fi

write_live_settings '["npm:@narumitw/pi-goal","npm:@narumitw/pi-lsp"]'
mkdir -p "$AGENT/npm/node_modules/@narumitw/pi-lsp"
printf '{ "version": "0.49.8" }' >"$AGENT/npm/node_modules/@narumitw/pi-lsp/package.json"
added_out="$(versions_preflight "$AGENT" "$REPO" 2>&1)"
if printf '%s' "$added_out" | grep -q '+ packages.@narumitw/pi-lsp 0.49.8'; then
  pass "snapshot: added package is reported"
else
  fail "snapshot: added package not reported"
fi
discover
staged="$(versions_snapshot_stage "$REPO")" && versions_snapshot_commit "$staged" "$REPO"

write_live_settings '["npm:@narumitw/pi-goal"]'
removed_out="$(versions_preflight "$AGENT" "$REPO" 2>&1)"
if printf '%s' "$removed_out" | grep -q -- '- packages.@narumitw/pi-lsp 0.49.8'; then
  pass "snapshot: removed package is reported"
else
  fail "snapshot: removed package not reported"
fi

# Configured but missing stays visible as MISSING while history reports the
# removal — it is not silently omitted.
write_live_settings '["npm:@narumitw/pi-goal","npm:@narumitw/pi-lsp"]'
rm -f "$AGENT/npm/node_modules/@narumitw/pi-lsp/package.json"
discover
expect_status "snapshot: configured-but-missing package stays MISSING" "npm:@narumitw/pi-lsp" "MISSING"
missing_out="$(versions_preflight "$AGENT" "$REPO" 2>&1)"
if printf '%s' "$missing_out" | grep -q -- '- packages.@narumitw/pi-lsp 0.49.8'; then
  pass "snapshot: configured-but-missing package is reported as removed from history"
else
  fail "snapshot: configured-but-missing package not reported"
fi
write_live_settings

# ---- RTK and git SHA drift are informational ----------------------------
new_case
discover
staged="$(versions_snapshot_stage "$REPO")" && versions_snapshot_commit "$staged" "$REPO"
write_stub rtk "rtk 0.50.0"
rtk_out="$(versions_preflight "$AGENT" "$REPO" 2>&1)"
if printf '%s' "$rtk_out" | grep -q '~ tools.rtk 0.49.0 → 0.50.0'; then
  pass "snapshot: RTK drift is reported"
else
  fail "snapshot: RTK drift not reported"
fi
rc=0
versions_preflight "$AGENT" "$REPO" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 0 ] && pass "snapshot: RTK drift does not block (no hard pin)" || fail "snapshot: RTK drift blocked (rc=$rc)"
write_stub rtk "rtk 0.49.0"

new_case
sha_a="$(make_checkout ayghri/i-have-adhd)"
write_live_settings '["https://github.com/ayghri/i-have-adhd"]'
discover
staged="$(versions_snapshot_stage "$REPO")" && versions_snapshot_commit "$staged" "$REPO"
git -C "$AGENT/git/github.com/ayghri/i-have-adhd" -c user.email=fixture@test -c user.name=fixture commit -q --allow-empty -m second
sha_b="$(git -C "$AGENT/git/github.com/ayghri/i-have-adhd" rev-parse HEAD)"
git_out="$(versions_preflight "$AGENT" "$REPO" 2>&1)"
if [ "$sha_a" != "$sha_b" ] && printf '%s' "$git_out" | grep -q "~ git.i-have-adhd $sha_a → $sha_b"; then
  pass "snapshot: unpinned git revision drift is reported"
else
  fail "snapshot: git revision drift not reported"
fi
rc=0
versions_preflight "$AGENT" "$REPO" >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 0 ] && pass "snapshot: unpinned git drift does not block" || fail "snapshot: git drift blocked (rc=$rc)"

# ---- a failing hard pin never advances the snapshot ---------------------
new_case
discover
staged="$(versions_snapshot_stage "$REPO")" && versions_snapshot_commit "$staged" "$REPO"
snapshot_sha="$(sha256sum "$REPO/pi/versions.json" | awk '{print $1}')"
write_stub obscura "obscura 0.2.2"
rc=0
versions_preflight "$AGENT" "$REPO" >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 2 ]; then
  pass "snapshot: hard-pin mismatch blocks backup (rc=2)"
else
  fail "snapshot: hard-pin mismatch did not block (rc=$rc)"
fi
if [ "$snapshot_sha" = "$(sha256sum "$REPO/pi/versions.json" | awk '{print $1}')" ]; then
  pass "snapshot: hard-pin mismatch leaves the snapshot unchanged"
else
  fail "snapshot: blocked preflight advanced the snapshot"
fi
write_stub obscura "obscura 0.2.3"

# ---------------------------------------------------------------- offline
if grep -nE '(curl|wget|git fetch|git pull|npm view)' "$LIB" 2>/dev/null | grep -vE '^[0-9]+: *#' >/dev/null; then
  fail "versions-lib.sh references network tooling"
else
  pass "version discovery is offline (no network tooling references)"
fi

# ---------------------------------------------------------------- summary
echo
if [ "$FAILURES" -ne 0 ]; then
  printf 'test-versions: %d failure(s)\n' "$FAILURES" >&2
  exit 1
fi
printf 'test-versions: all checks passed\n'
