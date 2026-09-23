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
  ok "mcp/mcp.json absent (no MCP servers configured)"
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

# ------------------------------------------------- 3. Package pin invariant
dcp_report="$(python3 - <<'PY'
import json
import re
import sys

GIT_PIN = re.compile(r"^git:github\.com/[\w.-]+/[\w.-]+@[0-9a-f]{40}$")
# NPM_PIN mirrors versions_npm_pin_is_exact() in
# pi/skills/pi-config-backup/scripts/versions-lib.sh — keep them in sync.
NPM_PIN = re.compile(r"^npm:(?:@[\w.-]+/)?[\w.-]+@(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$")
URL_PIN = re.compile(r"^https://github\.com/[\w.-]+/[\w.-]+(?:\.git)?@[0-9a-f]{40}$")
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
    if not GIT_PIN.match(entry):
        print(f"pi-dcp is not pinned to an exact commit: {entry}")

for entry in packages:
    if not isinstance(entry, str):
        continue
    if entry.startswith("git:") and not GIT_PIN.match(entry):
        print(f"git package is not pinned to an exact commit: {entry}")
    if entry.startswith("npm:") and not NPM_PIN.match(entry):
        print(f"npm package is not pinned to an exact version: {entry}")
    if entry.startswith(("http://", "https://")) and not URL_PIN.match(entry):
        print(f"URL package is not pinned to an exact commit: {entry}")
PY
)"
if [ -n "$dcp_report" ]; then
  fail "package pin invariant (DCP/npm/git/URL):"
  printf '%s\n' "$dcp_report" | sed 's/^/          /' >&2
else
  ok "all declared packages are exactly pinned (DCP, npm, git, URL)"
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
  pi/skills/pi-config-backup/scripts/versions-lib.sh \
  scripts/check-repo.sh \
  scripts/check-secrets.sh \
  scripts/check-secret-scanner.sh \
  scripts/install-hooks.sh \
  scripts/install-trufflehog.sh \
  scripts/test-backup-restore.sh \
  scripts/test-obscura-restore.sh \
  scripts/test-renderer-patch.sh \
  scripts/test-statusline.sh \
  scripts/test-cwd-switch.sh \
  scripts/test-todo.sh \
  scripts/test-versions.sh \
  scripts/install-renderer-guard.sh \
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

# The renderer update guard: a systemd --user path unit that re-applies the
# TUI patch whenever the managed Pi version changes. Static checks only; CI
# has no user systemd manager.
GUARD_SERVICE="systemd/pi-renderer-patch.service"
GUARD_PATH="systemd/pi-renderer-patch.path"
if [ ! -f "$GUARD_SERVICE" ] || [ ! -f "$GUARD_PATH" ]; then
  fail "renderer update guard units are missing under systemd/"
elif ! grep -q '^ExecStart=/usr/bin/env python3 %h/\.pi/agent/patch-pi-renderer\.py$' "$GUARD_SERVICE"; then
  fail "$GUARD_SERVICE does not run patch-pi-renderer.py via python3"
elif ! grep -q '^PathChanged=%h/\.pi/agent/install/current-version$' "$GUARD_PATH"; then
  fail "$GUARD_PATH does not watch the managed Pi version file"
elif ! grep -q '^Unit=pi-renderer-patch\.service$' "$GUARD_PATH"; then
  fail "$GUARD_PATH does not reference pi-renderer-patch.service"
else
  ok "renderer update guard units are consistent"
fi

# The backup entrypoint must discover live versions before copying anything.
# This is a static wiring check; live comparisons belong to backup time
# (scripts/test-versions.sh covers the discovery logic offline).
BACKUP_ENTRY="pi/skills/pi-config-backup/scripts/backup.sh"
if [ ! -f "$BACKUP_ENTRY" ]; then
  fail "backup entrypoint is missing: $BACKUP_ENTRY"
elif ! grep -q 'versions-lib.sh' "$BACKUP_ENTRY"; then
  fail "$BACKUP_ENTRY does not source the version discovery helper"
elif ! grep -q 'versions_preflight' "$BACKUP_ENTRY"; then
  fail "$BACKUP_ENTRY does not run the live version preflight"
else
  ok "backup entrypoint runs the live version preflight"
fi

# Snapshot Pi metadata must be internally consistent in the repository.
# Live discovery happens at backup time; CI can only verify the snapshot.
if [ -f pi/settings.json ] && [ -f README.md ]; then
  settings_v="$(python3 -c 'import json;print(json.load(open("pi/settings.json")).get("lastChangelogVersion",""))' 2>/dev/null || true)"
  readme_v="$(sed -nE 's/^- Pi version at backup time: \*\*([0-9]+\.[0-9]+\.[0-9]+)\*\*.*/\1/p' README.md | head -n1)"
  if [ -z "$settings_v" ]; then
    fail "pi/settings.json has no lastChangelogVersion"
  elif [ -z "$readme_v" ]; then
    fail "README.md has no Pi version backup-time line"
  elif [ "$settings_v" != "$readme_v" ]; then
    fail "snapshot Pi metadata disagrees: settings=$settings_v README=$readme_v"
  else
    ok "Pi snapshot metadata consistent ($settings_v)"
  fi
fi

# The version snapshot is the machine-readable inventory from the last
# successful backup. Validate its shape only; live comparison happens at
# backup time, never in CI.
SNAPSHOT_FILE="pi/versions.json"
if [ ! -f "$SNAPSHOT_FILE" ]; then
  fail "$SNAPSHOT_FILE is missing — run a successful backup to bootstrap the version inventory"
else
  snapshot_report="$(python3 - "$SNAPSHOT_FILE" <<'PY'
import json
import re
import sys

path = sys.argv[1]
problems = []
try:
    data = json.load(open(path, encoding="utf-8"))
except Exception as exc:  # noqa: BLE001
    print(f"invalid JSON: {exc}")
    sys.exit(0)

if not isinstance(data, dict):
    print("top level must be an object")
    sys.exit(0)
if data.get("schemaVersion") != 1:
    problems.append("schemaVersion must be 1")
pi = data.get("pi")
if not isinstance(pi, str) or not re.fullmatch(r"\d+\.\d+\.\d+", pi):
    problems.append(f"pi must be a semver string, got {pi!r}")
for section in ("tools", "packages", "git", "runtime"):
    value = data.get(section)
    if not isinstance(value, dict):
        problems.append(f"{section} must be an object")
        continue
    for name, entry in value.items():
        if section == "git":
            if not isinstance(entry, str) or not re.fullmatch(r"[0-9a-f]{40}", entry):
                problems.append(f"git.{name} must be a full 40-hex SHA")
        elif not isinstance(entry, str) or not re.fullmatch(r"\d+\.\d+\.\d+", entry):
            problems.append(f"{section}.{name} must be a semver string")

text = open(path, encoding="utf-8").read()
if re.search(r"(sk-[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY)", text):
    problems.append("looks like secret material")

for problem in problems:
    print(problem)
PY
)"
  if [ -n "$snapshot_report" ]; then
    fail "$SNAPSHOT_FILE is invalid:"
    printf '%s\n' "$snapshot_report" | sed 's/^/          /' >&2
  else
    ok "version snapshot is valid (schema 1)"
  fi
fi

for json in pi/settings.json pi/pi-lsp.json mcp/mcp.json deps/obscura.lock.json deps/tools.lock.json; do
  if [ ! -f "$json" ]; then
    case "$json" in
      pi/pi-lsp.json|mcp/mcp.json) continue ;; # optional config: absence is a valid state
      *) fail "expected JSON file is missing: $json" ;;
    esac
  fi
  if ! python3 -m json.tool "$json" >/dev/null 2>&1; then
    fail "invalid JSON: $json"
  fi
done
ok "JSON files parse (optional config validated when present)"

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
