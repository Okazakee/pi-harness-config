#!/usr/bin/env bash
# ============================================================
# test-laya-routing.sh — deterministic tests for the Laya delegation advisor.
#
# Runs the routing extension's pure modules (intent, mapping, confidence gate,
# config, response validation, telemetry privacy), the wiring tests with a fake
# ExtensionAPI and fake DecisionClient, and the Python bridge protocol tests
# (`--selftest`, fake-response mode, `--probe`).
#
# Bun and python3 (the bridge runtime) are required. A missing runtime is a
# hard failure, never a silent skip — a test that quietly does nothing is
# worse than no test. Nothing here touches the network or the real Laya model.
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_FILE="$REPO_ROOT/scripts/laya-routing.test.ts"

if [ ! -f "$TEST_FILE" ]; then
  printf 'test-laya-routing: missing %s\n' "$TEST_FILE" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  printf 'test-laya-routing: bun is required but not installed.\n' >&2
  printf 'test-laya-routing: install it from https://bun.sh — this test must not be skipped silently.\n' >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  printf 'test-laya-routing: python3 is required to exercise the pinned bridge protocol.\n' >&2
  printf 'test-laya-routing: install Python 3.10+ — this test must not be skipped silently.\n' >&2
  exit 1
fi

exec bun test "$TEST_FILE"
