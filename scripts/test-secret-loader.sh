#!/usr/bin/env bash
# ============================================================
# test-secret-loader.sh — unit tests for pi/extensions/secret-loader.ts.
#
# Runs the extension helpers under bun. No Pi runtime, no network, no
# node_modules: the extension only imports types from
# @earendil-works/pi-coding-agent, which are erased at load.
#
# Bun is required. A missing runtime is a hard failure, never a silent skip —
# a test that quietly does nothing is worse than no test.
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_FILE="$REPO_ROOT/scripts/secret-loader.test.ts"

if [ ! -f "$TEST_FILE" ]; then
  printf 'test-secret-loader: missing %s\n' "$TEST_FILE" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  printf 'test-secret-loader: bun is required but not installed.\n' >&2
  printf 'test-secret-loader: install it from https://bun.sh — this test must not be skipped silently.\n' >&2
  exit 1
fi

exec bun test "$TEST_FILE"
