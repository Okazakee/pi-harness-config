#!/usr/bin/env bash
# ============================================================
# test-obscura-restore.sh — verify Obscura lock + checksum logic in isolation.
#
# Exercises the real functions from obscura-lib.sh against tiny fixture
# archives. No network access, no 70 MB download, and the real Obscura
# binary and ~/.local/bin are never touched.
#
# Covers: valid digest, invalid digest, malformed lock (missing asset,
# missing digest, wrong digest length), unsupported platform, and a
# regression guard that no floating "releases/latest" URL exists.
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$REPO_ROOT/pi/skills/pi-config-backup/scripts/obscura-lib.sh"
RESTORE_SH="$REPO_ROOT/pi/skills/pi-config-backup/scripts/restore.sh"

FAILURES=0
pass() { printf 'ok      %s\n' "$1"; }
fail() { printf 'FAIL    %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

[ -f "$LIB" ] || { printf 'FAIL    missing %s\n' "$LIB" >&2; exit 1; }
# shellcheck source=/dev/null
. "$LIB"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ---------------------------------------------------------------- fixtures
make_archive() {
  local dir="$1" archive="$2"
  mkdir -p "$dir"
  printf '#!/bin/sh\necho "obscura fixture"\n' >"$dir/obscura"
  printf '#!/bin/sh\necho "obscura-worker fixture"\n' >"$dir/obscura-worker"
  chmod +x "$dir/obscura" "$dir/obscura-worker"
  tar czf "$archive" -C "$dir" obscura obscura-worker
}

FIXTURE="$WORK/fixture.tar.gz"
make_archive "$WORK/fixture-src" "$FIXTURE"
FIXTURE_SHA="$(obscura_sha256_of "$FIXTURE")"
[ -n "$FIXTURE_SHA" ] || { printf 'FAIL    cannot hash fixture\n' >&2; exit 1; }

# ---------------------------------------------------------------- 1. valid digest
DEST_OK="$WORK/dest-ok"
if obscura_install_from_url "file://$FIXTURE" "$FIXTURE_SHA" "fixture.tar.gz" "$DEST_OK"; then
  if [ -x "$DEST_OK/obscura" ] && [ -x "$DEST_OK/obscura-worker" ]; then
    pass "valid digest: archive verified, extracted and installed"
  else
    fail "valid digest: binaries were not installed into $DEST_OK"
  fi
else
  fail "valid digest: installation rejected (exit $?)"
fi

# ---------------------------------------------------------------- 2. invalid digest
DEST_BAD="$WORK/dest-bad"
WRONG_SHA="$(printf '%064d' 0)"
rc=0
obscura_install_from_url "file://$FIXTURE" "$WRONG_SHA" "fixture.tar.gz" "$DEST_BAD" || rc=$?
if [ "$rc" -eq 6 ]; then
  pass "invalid digest: rejected with integrity exit code 6"
else
  fail "invalid digest: expected exit 6, got $rc"
fi
if [ -e "$DEST_BAD/obscura" ] || [ -e "$DEST_BAD/obscura-worker" ]; then
  fail "invalid digest: something was installed despite the mismatch"
else
  pass "invalid digest: nothing extracted or installed"
fi
if obscura_is_integrity_failure 6; then
  pass "invalid digest: classified as an integrity failure"
else
  fail "invalid digest: not classified as an integrity failure"
fi

# ---------------------------------------------------------------- 3. malformed locks
write_lock() { printf '%s\n' "$2" >"$WORK/$1"; }

VALID_LOCK='{
  "repository": "h4ckf0r0day/obscura",
  "version": "v0.2.3",
  "assets": {
    "linux-x86_64":   {"name": "obscura-x86_64-linux.tar.gz",   "sha256": "'"$FIXTURE_SHA"'"},
    "linux-aarch64":  {"name": "obscura-aarch64-linux.tar.gz",  "sha256": "'"$FIXTURE_SHA"'"},
    "macos-x86_64":   {"name": "obscura-x86_64-macos.tar.gz",   "sha256": "'"$FIXTURE_SHA"'"},
    "macos-aarch64":  {"name": "obscura-aarch64-macos.tar.gz",  "sha256": "'"$FIXTURE_SHA"'"}
  }
}'
write_lock good.json "$VALID_LOCK"
entry="$(obscura_lock_entry "$WORK/good.json" linux-x86_64)"
if [ $? -eq 0 ] && [ "$(printf '%s' "$entry" | awk -F'\t' '{print NF}')" = "4" ]; then
  pass "valid lock: entry parses to repository/version/asset/sha256"
else
  fail "valid lock: unexpected parse result: $entry"
fi

MISSING_ASSET='{"repository":"a/b","version":"v0.2.3","assets":{"linux-x86_64":{"name":"x.tar.gz","sha256":"'"$FIXTURE_SHA"'"}}}'
write_lock missing-asset.json "$MISSING_ASSET"
rc=0; obscura_lock_entry "$WORK/missing-asset.json" linux-x86_64 >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] && pass "malformed lock (missing asset keys): exit 3" || fail "malformed lock (missing asset keys): expected 3, got $rc"

MISSING_DIGEST='{"repository":"a/b","version":"v0.2.3","assets":{"linux-x86_64":{"name":"x.tar.gz"},"linux-aarch64":{"name":"y"},"macos-x86_64":{"name":"z"},"macos-aarch64":{"name":"w"}}}'
write_lock missing-digest.json "$MISSING_DIGEST"
rc=0; obscura_lock_entry "$WORK/missing-digest.json" linux-x86_64 >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] && pass "malformed lock (missing digest): exit 3" || fail "malformed lock (missing digest): expected 3, got $rc"

SHORT_DIGEST='{"repository":"a/b","version":"v0.2.3","assets":{"linux-x86_64":{"name":"x.tar.gz","sha256":"deadbeef"},"linux-aarch64":{"name":"y","sha256":"'"$FIXTURE_SHA"'"},"macos-x86_64":{"name":"z","sha256":"'"$FIXTURE_SHA"'"},"macos-aarch64":{"name":"w","sha256":"'"$FIXTURE_SHA"'"}}}'
write_lock short-digest.json "$SHORT_DIGEST"
rc=0; obscura_lock_entry "$WORK/short-digest.json" linux-x86_64 >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] && pass "malformed lock (digest not 64 hex): exit 3" || fail "malformed lock (digest not 64 hex): expected 3, got $rc"

BAD_VERSION='{"repository":"a/b","version":"latest","assets":{"linux-x86_64":{"name":"x","sha256":"'"$FIXTURE_SHA"'"},"linux-aarch64":{"name":"y","sha256":"'"$FIXTURE_SHA"'"},"macos-x86_64":{"name":"z","sha256":"'"$FIXTURE_SHA"'"},"macos-aarch64":{"name":"w","sha256":"'"$FIXTURE_SHA"'"}}}'
write_lock bad-version.json "$BAD_VERSION"
rc=0; obscura_lock_entry "$WORK/bad-version.json" linux-x86_64 >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 3 ] && pass "malformed lock (floating version 'latest'): exit 3" || fail "malformed lock (floating version): expected 3, got $rc"

# unsupported platform
rc=0; obscura_lock_entry "$WORK/good.json" windows-x86_64 >/dev/null 2>&1 || rc=$?
[ "$rc" -eq 4 ] && pass "unsupported platform: exit 4" || fail "unsupported platform: expected 4, got $rc"

# ---------------------------------------------------------------- 4. version parsing
FAKE_BIN="$WORK/fakebin"
mkdir -p "$FAKE_BIN"
printf '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "obscura 9.9.9"; fi\n' >"$FAKE_BIN/obscura"
chmod +x "$FAKE_BIN/obscura"
detected="$(PATH="$FAKE_BIN:$PATH" obscura_installed_version)"
[ "$detected" = "9.9.9" ] && pass "installed-version parsing: 9.9.9 detected" || fail "installed-version parsing: got '$detected'"

# ---------------------------------------------------------------- 5. no floating URL
if grep -q 'releases/latest' "$RESTORE_SH"; then
  fail "restore.sh still contains a floating releases/latest URL"
else
  pass "restore.sh contains no releases/latest URL"
fi
if grep -q 'obscura_download_url' "$RESTORE_SH"; then
  pass "restore.sh builds the download URL from the lock (no 'latest')"
else
  fail "restore.sh does not use obscura_download_url"
fi

# ---------------------------------------------------------------- summary
echo
if [ "$FAILURES" -ne 0 ]; then
  printf 'test-obscura-restore: %d failure(s)\n' "$FAILURES" >&2
  exit 1
fi
printf 'test-obscura-restore: all checks passed\n'
