#!/usr/bin/env bash
# ============================================================
# install-trufflehog.sh — install the exact pinned TruffleHog release.
#
# deps/tools.lock.json is the single source of truth: exact version, exact
# asset name and exact SHA-256 per platform. Nothing here uses "latest",
# "main", or an unversioned curl|sh pipeline.
#
# Usage: scripts/install-trufflehog.sh [--dest DIR] [--force]
# ============================================================
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_LOCK="$REPO_ROOT/deps/tools.lock.json"
DEST="${HOME}/.local/bin"
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="${2:?--dest needs a value}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) printf 'usage: %s [--dest DIR] [--force]\n' "$0"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 4 ;;
  esac
done

die() { printf 'install-trufflehog: %s\n' "$1" >&2; exit "${2:-1}"; }

platform() {
  local os arch
  case "$(uname -s)" in
    Linux)  os=linux ;;
    Darwin) os=macos ;;
    *) die "unsupported OS: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch=x86_64 ;;
    aarch64|arm64) arch=aarch64 ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
  printf '%s-%s\n' "$os" "$arch"
}

PLATFORM="$(platform)"

read_lock() {
  python3 - "$TOOLS_LOCK" "$PLATFORM" <<'PY'
import json
import re
import sys

lock_path, platform = sys.argv[1], sys.argv[2]
REQUIRED = ("linux-x86_64", "linux-aarch64", "macos-x86_64", "macos-aarch64")


def die(message, code=1):
    print(f"install-trufflehog: {message}", file=sys.stderr)
    sys.exit(code)


try:
    data = json.load(open(lock_path, encoding="utf-8"))
except Exception as exc:  # noqa: BLE001
    die(f"cannot read {lock_path}: {exc}")

tool = data.get("trufflehog")
if not isinstance(tool, dict):
    die("deps/tools.lock.json has no trufflehog entry")

repository = tool.get("repository")
version = tool.get("version")
tag = tool.get("tag") or f"v{version}"
assets = tool.get("assets")
if not isinstance(repository, str) or "/" not in repository:
    die("trufflehog.repository must look like owner/name")
if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
    die(f"trufflehog.version must look like X.Y.Z, got {version!r}")
if not isinstance(assets, dict):
    die("trufflehog.assets must be an object")

entry = assets.get(platform)
if not isinstance(entry, dict):
    die(f"no trufflehog asset for {platform} (supported: {', '.join(REQUIRED)})")

name = entry.get("name")
sha = entry.get("sha256")
if not isinstance(name, str) or not name:
    die(f"asset name missing for {platform}")
if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
    die(f"sha256 for {platform} must be 64 lowercase hex characters")

print(repository, tag, name, sha, sep="\t")
PY
}

LOCK_ENTRY="$(read_lock)" || exit 1
IFS=$'\t' read -r REPOSITORY TAG ASSET SHA256 <<<"$LOCK_ENTRY"
VERSION="${TAG#v}"

if [ "$FORCE" -eq 0 ]; then
  # The destination is authoritative: --dest must be honoured, so an
  # unrelated trufflehog elsewhere on PATH never satisfies the request.
  if [ -x "$DEST/trufflehog" ]; then
    current="$("$DEST/trufflehog" --version 2>/dev/null | sed -nE 's/^trufflehog[[:space:]]+v?([0-9]+\.[0-9]+\.[0-9]+).*$/\1/p' | head -n1)"
    if [ "$current" = "$VERSION" ]; then
      printf 'install-trufflehog: trufflehog %s already installed (%s)\n' "$VERSION" "$DEST/trufflehog"
      exit 0
    fi
  fi
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
URL="https://github.com/${REPOSITORY}/releases/download/${TAG}/${ASSET}"

printf 'install-trufflehog: downloading %s\n' "$URL"
curl -fsSL "$URL" -o "$TMP/$ASSET" || die "download failed: $URL"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$TMP/$ASSET" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')"
fi
if [ "$actual" != "$SHA256" ]; then
  printf 'install-trufflehog: ERROR: SHA-256 mismatch for %s\n' "$ASSET" >&2
  printf 'install-trufflehog: ERROR:   expected %s\n' "$SHA256" >&2
  printf 'install-trufflehog: ERROR:   actual   %s\n' "$actual" >&2
  printf 'install-trufflehog: ERROR: refusing to install an unverified binary\n' >&2
  exit 1
fi

tar xzf "$TMP/$ASSET" -C "$TMP" || die "cannot extract $ASSET"
[ -f "$TMP/trufflehog" ] || die "archive did not contain a trufflehog binary"

mkdir -p "$DEST" || die "cannot create $DEST"
install -m 755 "$TMP/trufflehog" "$DEST/trufflehog" || die "cannot install into $DEST"

installed="$("$DEST/trufflehog" --version 2>/dev/null | sed -nE 's/^trufflehog[[:space:]]+v?([0-9]+\.[0-9]+\.[0-9]+).*$/\1/p' | head -n1)"
if [ "$installed" != "$VERSION" ]; then
  die "installed binary reports $installed, expected $VERSION"
fi

printf 'install-trufflehog: installed trufflehog %s to %s (SHA-256 verified)\n' "$VERSION" "$DEST/trufflehog"
