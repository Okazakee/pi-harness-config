#!/usr/bin/env bash
# ============================================================
# test-statusline.sh — deterministic tests for the statusline provider-usage module.
#
# Runs the OpenCode Go / OpenAI Codex / Command Code usage parsers, the JWT
# account-id derivation, the pinned-origin request shapes and the compact footer
# rendering under bun. The module is pure or takes an injectable fetch, so no Pi runtime,
# network or node_modules tree is needed.
#
# Bun is required. A missing runtime is a hard failure, never a silent skip —
# a test that quietly does nothing is worse than no test.
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_FILE="$REPO_ROOT/scripts/statusline.test.ts"

if [ ! -f "$TEST_FILE" ]; then
  printf 'test-statusline: missing %s\n' "$TEST_FILE" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  printf 'test-statusline: bun is required but not installed.\n' >&2
  printf 'test-statusline: install it from https://bun.sh — this test must not be skipped silently.\n' >&2
  exit 1
fi

exec bun test "$TEST_FILE"
