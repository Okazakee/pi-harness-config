#!/usr/bin/env bash
# ============================================================
# test-todo.sh — deterministic tests for pi/extensions/todo.ts.
#
# Runs the todo state machine, persistence/reconstruction, request-local
# context injection, subagent gating, /todo command parsing and UI formatting
# under bun. The suite lives in scripts/todo/: harness.ts holds the fixtures
# and fake Pi harness, and one focused *.test.ts per responsibility exercises
# the pi/extensions/todo.ts entrypoint.
#
# No Pi runtime is needed, no network, no node_modules: the extension only
# imports types from @earendil-works/pi-coding-agent, which are erased at load,
# plus its own local helper modules. One test uses the real Pi loader when a
# `pi` binary happens to be on PATH and is reported as skipped otherwise.
#
# Bun is required. A missing runtime is a hard failure, never a silent skip —
# a test that quietly does nothing is worse than no test.
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$REPO_ROOT/scripts/todo"

if [ ! -d "$TEST_DIR" ]; then
  printf 'test-todo: missing %s\n' "$TEST_DIR" >&2
  exit 1
fi

# A runner that silently finds zero test files would look green while proving
# nothing; require at least one test module up front.
shopt -s nullglob
TEST_FILES=("$TEST_DIR"/*.test.ts)
shopt -u nullglob
if [ "${#TEST_FILES[@]}" -eq 0 ]; then
  printf 'test-todo: no *.test.ts files in %s\n' "$TEST_DIR" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  printf 'test-todo: bun is required but not installed.\n' >&2
  printf 'test-todo: install it from https://bun.sh — this test must not be skipped silently.\n' >&2
  exit 1
fi

exec bun test "$TEST_DIR"
