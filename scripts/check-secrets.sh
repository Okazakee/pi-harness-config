#!/usr/bin/env bash
# ============================================================
# check-secrets.sh — pinned TruffleHog secret scanning.
#
#   --staged    scan exactly the blobs that are about to be committed
#   --history   scan the full Git history of this repository
#   --self-test verify the scanner actually detects a runtime canary
#
# Design notes:
#   * The scanner version is pinned by deps/tools.lock.json. A missing or
#     mismatched scanner is a hard failure, never a silent skip.
#   * Findings are rendered from TruffleHog's JSON with a field allowlist.
#     Raw secret values are never printed.
#   * --staged copies the staged blobs into an isolated temporary tree, so
#     untracked files, .secrets/, and working-tree content are never scanned
#     and never leave the machine.
#   * --self-test builds a throwaway repository with a canary generated at
#     runtime. No canary is ever written into this repository.
#
# Exit codes: 0 clean, 1 findings, 3 scanner unavailable/mismatched, 4 usage.
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_LOCK="$REPO_ROOT/deps/tools.lock.json"

# The repository under inspection. Hooks run with the working tree as cwd, so
# this is normally the same repository the script lives in; resolving it from
# Git keeps --staged correct when the script is invoked from another checkout
# (for example an isolated test repository).
TARGET_REPO="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$TARGET_REPO" ] || TARGET_REPO="$REPO_ROOT"

# Result selection. The upstream default is the widest set; a verified-only
# scan would silently ignore a real but unverifiable credential and would
# make the canary self-test impossible. Override with PI_SECRET_SCAN_RESULTS.
SCAN_RESULTS="${PI_SECRET_SCAN_RESULTS:-verified,unverified,unknown}"

# Single scratch directory, cleaned up once on exit. It is a global on
# purpose: a function-local variable is out of scope by the time an EXIT
# trap runs.
SCRATCH=""
cleanup() {
  if [ -n "$SCRATCH" ]; then
    rm -rf "$SCRATCH"
  fi
}
trap cleanup EXIT

die() { printf 'check-secrets: %s\n' "$1" >&2; exit "${2:-4}"; }

# --------------------------------------------------------------- scanner
scanner_bin() {
  if [ -n "${TRUFFLEHOG_BIN:-}" ] && [ -x "${TRUFFLEHOG_BIN}" ]; then
    printf '%s\n' "$TRUFFLEHOG_BIN"
    return 0
  fi
  command -v trufflehog 2>/dev/null
}

expected_scanner_version() {
  python3 - "$TOOLS_LOCK" <<'PY'
import json
import sys

try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:  # noqa: BLE001
    sys.exit(1)
print(data.get("trufflehog", {}).get("version", ""))
PY
}

require_scanner() {
  local expected actual bin
  expected="$(expected_scanner_version)"
  [ -n "$expected" ] || die "deps/tools.lock.json does not pin a trufflehog version" 3

  bin="$(scanner_bin)" || true
  if [ -z "$bin" ]; then
    printf 'check-secrets: trufflehog %s is required but not installed.\n' "$expected" >&2
    printf 'check-secrets: install it with scripts/install-trufflehog.sh\n' >&2
    exit 3
  fi

  actual="$("$bin" --version 2>/dev/null | sed -nE 's/^trufflehog[[:space:]]+v?([0-9]+\.[0-9]+\.[0-9]+).*$/\1/p' | head -n 1)"
  if [ "$actual" != "$expected" ]; then
    printf 'check-secrets: trufflehog %s is required, found %s (%s).\n' \
      "$expected" "${actual:-unknown}" "$bin" >&2
    printf 'check-secrets: install the pinned version with scripts/install-trufflehog.sh\n' >&2
    exit 3
  fi
  printf '%s\n' "$bin"
}

# --------------------------------------------------------------- rendering
# Print findings using an allowlist of non-secret fields only.
render_findings() {
  python3 - "$1" <<'PY'
import json
import sys

path = sys.argv[1]
findings = []
try:
    with open(path, encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                findings.append(json.loads(line))
            except json.JSONDecodeError:
                continue
except FileNotFoundError:
    findings = []


def location(entry):
    data = entry.get("SourceMetadata", {}).get("Data", {}) or {}
    for key in ("Git", "Filesystem", "Github", "Gitlab"):
        meta = data.get(key)
        if isinstance(meta, dict):
            file_name = meta.get("file") or meta.get("link") or "?"
            line_no = meta.get("line")
            commit = meta.get("commit")
            parts = [str(file_name)]
            if line_no:
                parts.append(f"line {line_no}")
            if commit:
                parts.append(f"commit {str(commit)[:12]}")
            return ", ".join(parts)
    return "?"


if not findings:
    sys.exit(0)

print(f"  {len(findings)} finding(s):")
for entry in findings:
    detector = entry.get("DetectorName") or entry.get("DetectorType") or "unknown"
    verified = "verified" if entry.get("Verified") else "unverified"
    decoder = entry.get("DecoderName") or "?"
    print(f"    - {detector} [{verified}/{decoder}] {location(entry)}")
print("  raw secret values are intentionally not printed")
PY
}

# --------------------------------------------------------------- scanning
# run_scanner <scanner> <source-kind> <target> <json-out-file|-> <online|offline>
# Sets SCAN_RC to the scanner exit status.
#
# "offline" passes --no-verification: no credential is checked against a
# remote API, so the run has no network dependency at all. That is what the
# pre-commit staged scan uses. The history scan stays online because a
# verified finding is stronger evidence and pre-push/CI can afford it.
run_scanner() {
  local bin="$1" kind="$2" target="$3" out="$4" mode="$5"
  local own_out=0
  if [ "$out" = "-" ]; then
    out="$(mktemp)"
    own_out=1
  fi

  local -a extra=()
  [ "$mode" = "offline" ] && extra=(--no-verification)

  SCAN_RC=0
  "$bin" "$kind" "$target" --results="$SCAN_RESULTS" --fail --no-update \
    "${extra[@]+${extra[@]}}" --json >"$out" 2>/dev/null || SCAN_RC=$?

  render_findings "$out"

  if [ "$own_out" -eq 1 ]; then
    rm -f "$out"
  fi
}

scan_staged() {
  local bin
  bin="$(require_scanner)"

  SCRATCH="$(mktemp -d)"

  local staged_count=0 path rc=0
  while IFS= read -r -d '' path; do
    staged_count=$((staged_count + 1))
    mkdir -p "$SCRATCH/$(dirname -- "$path")"
    if ! git -C "$TARGET_REPO" show ":$path" >"$SCRATCH/$path" 2>/dev/null; then
      printf 'check-secrets: cannot read staged blob: %s\n' "$path" >&2
      rc=1
    fi
  done < <(git -C "$TARGET_REPO" diff --cached --name-only --diff-filter=ACMR -z)

  if [ "$staged_count" -eq 0 ]; then
    printf 'check-secrets: nothing staged — nothing to scan\n'
    return 0
  fi

  printf 'check-secrets: scanning %d staged path(s) in %s (offline, no credential verification)\n' \
    "$staged_count" "$TARGET_REPO"
  run_scanner "$bin" filesystem "$SCRATCH" - offline

  if [ "$SCAN_RC" -eq 183 ] || [ "$SCAN_RC" -eq 1 ]; then
    printf 'check-secrets: FAIL — secret findings in staged content\n' >&2
    return 1
  fi
  if [ "$SCAN_RC" -ne 0 ]; then
    printf 'check-secrets: scanner exited %s\n' "$SCAN_RC" >&2
    return 1
  fi
  [ "$rc" -eq 0 ] || return 1

  printf 'check-secrets: staged content clean\n'
  return 0
}

scan_history() {
  local bin
  bin="$(require_scanner)"
  printf 'check-secrets: scanning full history of %s\n' "$TARGET_REPO"
  run_scanner "$bin" git "file://$TARGET_REPO" - online

  if [ "$SCAN_RC" -eq 183 ] || [ "$SCAN_RC" -eq 1 ]; then
    printf 'check-secrets: FAIL — secret findings in Git history\n' >&2
    return 1
  fi
  if [ "$SCAN_RC" -ne 0 ]; then
    printf 'check-secrets: scanner exited %s\n' "$SCAN_RC" >&2
    return 1
  fi

  printf 'check-secrets: history clean\n'
  return 0
}

# --------------------------------------------------------------- self-test
self_test() {
  local bin
  bin="$(require_scanner)"

  SCRATCH="$(mktemp -d)"

  # Generated at runtime; never committed anywhere.
  local canary
  canary="$(python3 - <<'PY'
import secrets
import string

alphabet = string.ascii_letters + string.digits
print("ghp_" + "".join(secrets.choice(alphabet) for _ in range(36)))
PY
)"

  git -C "$SCRATCH" init -q -b main .
  git -C "$SCRATCH" config user.email "scanner-self-test@example.invalid"
  git -C "$SCRATCH" config user.name "scanner self-test"
  printf 'token = %s\n' "$canary" >"$SCRATCH/canary.txt"
  git -C "$SCRATCH" add -A
  git -C "$SCRATCH" commit -qm "scanner self-test canary"

  local out
  out="$(mktemp)"
  run_scanner "$bin" git "file://$SCRATCH" "$out" offline

  local hits
  hits="$(grep -c . "$out" 2>/dev/null || true)"
  [ -n "$hits" ] || hits=0
  rm -f "$out"

  if [ "$hits" -eq 0 ]; then
    printf 'check-secrets: SELF-TEST FAILED — the scanner did not report the canary\n' >&2
    printf 'check-secrets: a scanner that silently stops detecting is not trustworthy\n' >&2
    return 1
  fi

  printf 'check-secrets: self-test passed (%s canary finding(s), scanner %s)\n' \
    "$hits" "$("$bin" --version 2>/dev/null | awk '{print $2}')"
  return 0
}

# --------------------------------------------------------------- entrypoint
case "${1:-}" in
  --staged)    scan_staged ;;
  --history)   scan_history ;;
  --self-test) self_test ;;
  *)
    printf 'usage: check-secrets.sh --staged | --history | --self-test\n' >&2
    exit 4
    ;;
esac
