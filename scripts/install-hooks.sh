#!/usr/bin/env bash
# ============================================================
# install-hooks.sh — activate this repository's tracked Git hooks.
#
# Git does not use .githooks/ just because it exists. This sets the LOCAL
# configuration only (core.hooksPath), never global Git config.
#
# Hooks are developer feedback, not authority: they can be bypassed with
# --no-verify. GitHub CI is the independent verification layer.
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf 'install-hooks: %s is not a Git working tree\n' "$REPO_ROOT" >&2
  exit 1
fi

if [ ! -d "$REPO_ROOT/.githooks" ]; then
  printf 'install-hooks: %s/.githooks is missing\n' "$REPO_ROOT" >&2
  exit 1
fi

if ! git config --local core.hooksPath .githooks; then
  printf 'install-hooks: could not set core.hooksPath locally\n' >&2
  exit 1
fi

for hook in pre-commit pre-push; do
  path="$REPO_ROOT/.githooks/$hook"
  if [ ! -f "$path" ]; then
    printf 'install-hooks: warning: %s is missing\n' "$path" >&2
  elif [ ! -x "$path" ]; then
    chmod +x "$path" && printf 'install-hooks: made %s executable\n' "$hook"
  fi
done

printf 'install-hooks: core.hooksPath=%s (local config, repo %s)\n' \
  "$(git config --local --get core.hooksPath)" "$REPO_ROOT"
printf 'install-hooks: pre-commit = fast staged checks; pre-push = history + integration checks\n'
