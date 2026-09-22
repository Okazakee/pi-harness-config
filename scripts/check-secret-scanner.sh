#!/usr/bin/env bash
# ============================================================
# check-secret-scanner.sh — prove the secret scanner still detects.
#
# A secret scanner that silently stops detecting is worse than one that
# visibly fails. This wraps `check-secrets.sh --self-test`, which builds a
# throwaway repository containing a credential canary generated at runtime
# and fails if TruffleHog does not report it.
#
# It also proves the installed scanner version matches deps/tools.lock.json.
# ============================================================
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/check-secrets.sh" --self-test
