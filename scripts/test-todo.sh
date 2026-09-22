#!/usr/bin/env bash
# ============================================================
# test-todo.sh — deterministic tests for pi/extensions/todo.ts.
#
# Runs the todo state machine, persistence/reconstruction, request-local
# context injection, subagent gating, /todo command parsing and UI formatting
# under bun. No Pi runtime, no network, no node_modules: the extension only
# imports types from @earendil-works/pi-coding-agent, which are erased at load.
#
# Bun is required. A missing runtime is a hard failure, never a silent skip —
# a test that quietly does nothing is worse than no test.
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_FILE="$REPO_ROOT/scripts/todo.test.ts"

if [ ! -f "$TEST_FILE" ]; then
  printf 'test-todo: missing %s\n' "$TEST_FILE" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  printf 'test-todo: bun is required but not installed.\n' >&2
  printf 'test-todo: install it from https://bun.sh — this test must not be skipped silently.\n' >&2
  exit 1
fi

exec bun test "$TEST_FILE"
