#!/usr/bin/env bash
# ============================================================
# test-renderer-patch.sh — fixture tests for pi/patch-pi-renderer.py.
#
# Builds throwaway fake Pi installation trees under a temporary directory.
# The real Pi installation is never read or written by this test.
#
# Fixtures are generated from the patch script's own pattern constants, so
# the test exercises the transformation semantics rather than duplicating
# (and drifting from) the patterns.
#
# Cases: unpatched, already patched, upstream changed, missing target,
# ambiguous chunk.
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PATCHER="$REPO_ROOT/pi/patch-pi-renderer.py"

FAILURES=0
pass() { printf 'ok      %s\n' "$1"; }
fail() { printf 'FAIL    %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

[ -f "$PATCHER" ] || { printf 'FAIL    missing %s\n' "$PATCHER" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CHUNK_REL="install/releases/0.0.0-test/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks"
TUI_REL="install/releases/0.0.0-test/node_modules/@earendil-works/pi-tui/dist/components"

# ---------------------------------------------------------------- fixtures
python3 - "$PATCHER" "$WORK" <<'PY'
import importlib.util
import pathlib
import sys

patcher_path, work = sys.argv[1], pathlib.Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("patchmod", patcher_path)
mod = importlib.util.module_from_spec(spec)
sys.modules["patchmod"] = mod  # dataclasses needs the module registered
spec.loader.exec_module(mod)

chunk_rel = "install/releases/0.0.0-test/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks"
tui_rel = "install/releases/0.0.0-test/node_modules/@earendil-works/pi-tui/dist/components"

unpatched_chunk = "\n".join(p.old for p in mod.BUNDLE_PATCHES) + "\n"
patched_chunk = "\n".join(p.new for p in mod.BUNDLE_PATCHES if p.new) + "\n"
changed_chunk = "// upstream refactor: none of the known renderer patterns exist any more\n"

tui_anchor = mod.TUI_PATCHES[0].anchor
unpatched_tui = "function render() {\n" + tui_anchor + "\n" + "\n".join(p.old for p in mod.TUI_PATCHES) + "}\n"
patched_tui = "function render() {\n" + tui_anchor + "\n}\n"
changed_tui = "function render() { /* upstream refactor */ }\n"


def write_tree(name, chunk_text, tui_text, *, chunk_name="chunk-TEST0001.js",
               extra_chunk=None, include_tui=True):
    root = work / name
    (root / chunk_rel).mkdir(parents=True, exist_ok=True)
    (root / tui_rel).mkdir(parents=True, exist_ok=True)
    (root / "install" / "current-version").write_text("0.0.0-test\n", encoding="utf-8")
    (root / chunk_rel / chunk_name).write_text(chunk_text, encoding="utf-8")
    if extra_chunk:
        (root / chunk_rel / extra_chunk[0]).write_text(extra_chunk[1], encoding="utf-8")
    if include_tui:
        (root / tui_rel / "markdown.js").write_text(tui_text, encoding="utf-8")
    return root


write_tree("unpatched", unpatched_chunk, unpatched_tui)
write_tree("changed", changed_chunk, changed_tui)
write_tree("missing", unpatched_chunk, "", include_tui=False)
write_tree(
    "ambiguous",
    unpatched_chunk,
    unpatched_tui,
    extra_chunk=("chunk-TEST0002.js", unpatched_chunk),
)
print("fixtures written")
PY

run_patcher() {
  PI_CODING_AGENT_DIR="$1" python3 "$PATCHER" >"$WORK/out.txt" 2>"$WORK/err.txt"
}

CHUNK_FILE="$WORK/unpatched/$CHUNK_REL/chunk-TEST0001.js"
TUI_FILE="$WORK/unpatched/$TUI_REL/markdown.js"

# ---------------------------------------------------------------- 1. unpatched
rc=0; run_patcher "$WORK/unpatched" || rc=$?
if [ "$rc" -eq 0 ]; then
  pass "unpatched fixture: exits 0"
else
  fail "unpatched fixture: expected exit 0, got $rc"
  sed 's/^/        /' "$WORK/err.txt" >&2
fi

python3 - "$PATCHER" "$CHUNK_FILE" "$TUI_FILE" <<'PY' && pass "unpatched fixture: all patched forms present" || fail "unpatched fixture: patched forms missing"
import importlib.util
import sys

patcher_path, chunk_path, tui_path = sys.argv[1], sys.argv[2], sys.argv[3]
spec = importlib.util.spec_from_file_location("patchmod", patcher_path)
mod = importlib.util.module_from_spec(spec)
sys.modules["patchmod"] = mod  # dataclasses needs the module registered
spec.loader.exec_module(mod)

chunk = open(chunk_path, encoding="utf-8").read()
tui = open(tui_path, encoding="utf-8").read()

problems = []
for patch in mod.BUNDLE_PATCHES:
    if patch.old in chunk:
        problems.append(f"{patch.name}: original form still present")
    if patch.new and patch.new not in chunk:
        problems.append(f"{patch.name}: patched form missing")
for patch in mod.TUI_PATCHES:
    if patch.old in tui:
        problems.append(f"{patch.name}: original form still present")

for problem in problems:
    print(f"        {problem}", file=sys.stderr)
sys.exit(1 if problems else 0)
PY

# ---------------------------------------------------------------- 2. already patched
before="$(sha256sum "$CHUNK_FILE" "$TUI_FILE")"
rc=0; run_patcher "$WORK/unpatched" || rc=$?
after="$(sha256sum "$CHUNK_FILE" "$TUI_FILE")"
if [ "$rc" -eq 0 ]; then
  pass "already-patched fixture: exits 0"
else
  fail "already-patched fixture: expected exit 0, got $rc"
fi
if [ "$before" = "$after" ]; then
  pass "already-patched fixture: files unchanged (idempotent)"
else
  fail "already-patched fixture: files were modified on a second run"
fi
if grep -q 'already' "$WORK/out.txt"; then
  pass "already-patched fixture: reports 'already' rather than re-patching"
else
  fail "already-patched fixture: did not report 'already'"
fi

# ---------------------------------------------------------------- 3. upstream changed
rc=0; run_patcher "$WORK/changed" || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "upstream-changed fixture: exits non-zero ($rc)"
else
  fail "upstream-changed fixture: expected non-zero, got 0 (false success)"
fi
if grep -qi 'ERROR' "$WORK/err.txt"; then
  pass "upstream-changed fixture: reports an explicit error"
else
  fail "upstream-changed fixture: no explicit error reported"
fi

# ---------------------------------------------------------------- 4. missing target
rc=0; run_patcher "$WORK/missing" || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "missing-target fixture: exits non-zero ($rc)"
else
  fail "missing-target fixture: expected non-zero, got 0"
fi

# ---------------------------------------------------------------- 5. ambiguous chunk
rc=0; run_patcher "$WORK/ambiguous" || rc=$?
if [ "$rc" -ne 0 ]; then
  pass "ambiguous-chunk fixture: exits non-zero ($rc)"
else
  fail "ambiguous-chunk fixture: expected non-zero, got 0"
fi
if grep -qi 'ambiguous' "$WORK/err.txt"; then
  pass "ambiguous-chunk fixture: reports ambiguity"
else
  fail "ambiguous-chunk fixture: did not report ambiguity"
fi

# ---------------------------------------------------------------- 6. no version file
rc=0
PI_CODING_AGENT_DIR="$WORK/does-not-exist" python3 "$PATCHER" >/dev/null 2>&1 || rc=$?
[ "$rc" -ne 0 ] && pass "missing installation: exits non-zero ($rc)" || fail "missing installation: expected non-zero, got 0"

echo
if [ "$FAILURES" -ne 0 ]; then
  printf 'test-renderer-patch: %d failure(s)\n' "$FAILURES" >&2
  exit 1
fi
printf 'test-renderer-patch: all checks passed\n'
