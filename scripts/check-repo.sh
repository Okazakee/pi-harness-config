#!/usr/bin/env bash
# ============================================================
# check-repo.sh — canonical, deterministic repository contract.
#
# Fast, offline, and safe to run on every commit (pre-commit) and in CI.
# It validates the structural invariants this repository relies on:
#
#   * documented runtime/secret paths are never tracked
#   * committed MCP config carries no inline secret material
#   * the DCP package stays pinned to an exact commit
#   * deps/obscura.lock.json is complete and the restore path is pinned
#   * shell/JSON syntax and whitespace integrity
#
# It deliberately does NOT do network access, secret scanning of file
# contents, or integration testing — see check-secrets.sh and the
# test-*.sh scripts for those.
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FAILURES=0
ok()   { printf 'ok      %s\n' "$1"; }
fail() { printf 'FAIL    %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

# ---------------------------------------------------------------- 1. tracked paths
# The backup allowlist is the primary defense; this is the tracked-file
# equivalent. Paths are matched against this repository's documented
# boundary, so an unrelated source directory named "git" elsewhere is fine.
forbidden_re='(^|/)\.secrets/|(^|/)auth\.json$|(^|/)models-store\.json$|(^|/)mcp-cache\.json$|\.(pem|key)$|^(pi/)?(install|npm|bin|git|sessions)/'
hits="$(git ls-files | grep -E "$forbidden_re" || true)"
if [ -n "$hits" ]; then
  fail "secret/runtime paths are tracked:"
  printf '%s\n' "$hits" | sed 's/^/          /' >&2
else
  ok "no secret/runtime paths tracked"
fi

# ---------------------------------------------------------------- 2. MCP config
if [ ! -f mcp/mcp.json ]; then
  fail "mcp/mcp.json is missing"
else
  if ! python3 -m json.tool mcp/mcp.json >/dev/null 2>&1; then
    fail "mcp/mcp.json is not valid JSON"
  else
    mcp_report="$(python3 - <<'PY'
import json
import re
import sys

SENSITIVE_EXACT = {"authorization", "token", "apikey", "password", "secret"}
SENSITIVE_SUFFIX = ("token", "secret", "password")


def normalise(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", key.lower())


def is_sensitive(key: str) -> bool:
    n = normalise(key)
    return n in SENSITIVE_EXACT or n.endswith(SENSITIVE_SUFFIX)


def looks_like_reference(value: str) -> bool:
    # Accept environment-variable indirection; reject literals.
    return bool(re.search(r"\$\{?[A-Za-z_][A-Za-z0-9_]*\}?", value))


def walk(node, path, out):
    if isinstance(node, dict):
        for key, value in node.items():
            here = f"{path}.{key}" if path else key
            if is_sensitive(key) and isinstance(value, str) and value.strip():
                if not looks_like_reference(value):
                    out.append(f"{here} carries a literal value")
            walk(value, here, out)
    elif isinstance(node, list):
        for index, item in enumerate(node):
            walk(item, f"{path}[{index}]", out)


problems = []
try:
    data = json.load(open("mcp/mcp.json", encoding="utf-8"))
except Exception as exc:  # noqa: BLE001
    print(f"cannot parse mcp/mcp.json: {exc}")
    sys.exit(0)

walk(data, "", problems)
for problem in problems:
    print(problem)
PY
)"
    if [ -n "$mcp_report" ]; then
      fail "mcp/mcp.json may carry inline secrets:"
      printf '%s\n' "$mcp_report" | sed 's/^/          /' >&2
    else
      ok "mcp/mcp.json has no inline secret material"
    fi
  fi
fi

# ---------------------------------------------------------------- 3. DCP pin
dcp_report="$(python3 - <<'PY'
import json
import re
import sys

PIN = re.compile(r"^git:github\.com/[\w.-]+/[\w.-]+@[0-9a-f]{40}$")
try:
    settings = json.load(open("pi/settings.json", encoding="utf-8"))
except Exception as exc:  # noqa: BLE001
    print(f"cannot parse pi/settings.json: {exc}")
    sys.exit(0)

packages = settings.get("packages")
if not isinstance(packages, list):
    print("pi/settings.json has no packages array")
    sys.exit(0)

dcp = [p for p in packages if isinstance(p, str) and "pi-dcp" in p]
if not dcp:
    print("no pi-dcp entry in pi/settings.json packages")
for entry in dcp:
    if not PIN.match(entry):
        print(f"pi-dcp is not pinned to an exact commit: {entry}")

for entry in packages:
    if isinstance(entry, str) and entry.startswith("git:") and not PIN.match(entry):
        print(f"git package is not pinned to an exact commit: {entry}")
PY
)"
if [ -n "$dcp_report" ]; then
  fail "DCP/pinned-git package invariant:"
  printf '%s\n' "$dcp_report" | sed 's/^/          /' >&2
else
  ok "DCP package pinned to an exact commit"
fi

# ---------------------------------------------------------------- 4. Obscura lock
if [ ! -f deps/obscura.lock.json ]; then
  fail "deps/obscura.lock.json is missing"
else
  lock_report="$(python3 - <<'PY'
import json
import re
import sys

REQUIRED = ("linux-x86_64", "linux-aarch64", "macos-x86_64", "macos-aarch64")
problems = []
try:
    data = json.load(open("deps/obscura.lock.json", encoding="utf-8"))
except Exception as exc:  # noqa: BLE001
    print(f"cannot parse deps/obscura.lock.json: {exc}")
    sys.exit(0)

version = data.get("version")
if not isinstance(version, str) or not re.fullmatch(r"v\d+\.\d+\.\d+", version):
    problems.append(f"version must look like vX.Y.Z, got {version!r}")

assets = data.get("assets")
if not isinstance(assets, dict):
    problems.append("assets must be an object")
else:
    for key in REQUIRED:
        entry = assets.get(key)
        if not isinstance(entry, dict):
            problems.append(f"missing asset entry: {key}")
            continue
        name = entry.get("name")
        sha = entry.get("sha256")
        if not isinstance(name, str) or not name:
            problems.append(f"{key}: asset name missing")
        if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
            problems.append(f"{key}: sha256 must be 64 lowercase hex characters")

for problem in problems:
    print(problem)
PY
)"
  if [ -n "$lock_report" ]; then
    fail "deps/obscura.lock.json is incomplete:"
    printf '%s\n' "$lock_report" | sed 's/^/          /' >&2
  else
    ok "deps/obscura.lock.json declares all four assets with SHA-256"
  fi
fi

RESTORE_SH="pi/skills/pi-config-backup/scripts/restore.sh"
if [ ! -f "$RESTORE_SH" ]; then
  fail "$RESTORE_SH is missing"
else
  if grep -q 'releases/latest' "$RESTORE_SH"; then
    fail "$RESTORE_SH still contains a floating releases/latest download"
  else
    ok "restore.sh has no floating releases/latest download"
  fi
  if grep -q 'obscura.lock.json' "$RESTORE_SH" && grep -q 'obscura_lock_entry' "$RESTORE_SH"; then
    ok "restore.sh resolves Obscura through the lock file"
  else
    fail "restore.sh does not resolve Obscura through deps/obscura.lock.json"
  fi
fi

# ---------------------------------------------------------------- 5. syntax / integrity
for script in \
  pi/skills/pi-config-backup/scripts/backup.sh \
  pi/skills/pi-config-backup/scripts/restore.sh \
  pi/skills/pi-config-backup/scripts/obscura-lib.sh \
  scripts/check-repo.sh \
  scripts/check-secrets.sh \
  scripts/check-secret-scanner.sh \
  scripts/install-hooks.sh \
  scripts/install-trufflehog.sh \
  scripts/test-backup-restore.sh \
  scripts/test-obscura-restore.sh \
  scripts/test-renderer-patch.sh \
  scripts/test-cwd-switch.sh \
  .githooks/pre-commit \
  .githooks/pre-push ; do
  if [ ! -f "$script" ]; then
    fail "expected script is missing: $script"
  elif ! bash -n "$script" 2>/dev/null; then
    fail "shell syntax error: $script"
  elif [ ! -x "$script" ]; then
    fail "expected script is not executable: $script"
  fi
done
[ "$FAILURES" -eq 0 ] && ok "shell syntax clean and scripts executable"

for json in pi/settings.json mcp/mcp.json deps/obscura.lock.json deps/tools.lock.json; do
  if [ ! -f "$json" ]; then
    fail "expected JSON file is missing: $json"
  elif ! python3 -m json.tool "$json" >/dev/null 2>&1; then
    fail "invalid JSON: $json"
  fi
done
ok "JSON files parse"

if ! git diff --check >/dev/null 2>&1; then
  fail "git diff --check reported whitespace errors (working tree)"
  git diff --check >&2 || true
else
  ok "git diff --check clean (working tree)"
fi

if ! git diff --cached --check >/dev/null 2>&1; then
  fail "git diff --cached --check reported whitespace errors (index)"
  git diff --cached --check >&2 || true
else
  ok "git diff --check clean (index)"
fi

# ---------------------------------------------------------------- summary
echo
if [ "$FAILURES" -ne 0 ]; then
  printf 'check-repo: %d problem(s)\n' "$FAILURES" >&2
  exit 1
fi
printf 'check-repo: all repository invariants hold\n'
