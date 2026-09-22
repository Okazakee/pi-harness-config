#!/usr/bin/env bash
# ============================================================
# obscura-lib.sh — lock-pinned, checksum-verified Obscura install.
#
# Sourced by restore.sh and by scripts/test-obscura-restore.sh.
# Nothing here runs on source; every function is side-effect free
# except obscura_install_from_url, which writes only into the
# destination directory it is given.
#
# Exit codes returned by the functions below:
#   0  success
#   2  sha256 tooling unavailable
#   3  lock file missing, unreadable, malformed, or digest invalid
#   4  platform not covered by the lock
#   5  download failed (network / HTTP)
#   6  checksum mismatch                      <- integrity failure
#   7  archive extraction failed
#   8  archive contained no expected binaries
#
# Codes 3, 4 and 6 are integrity failures: restore.sh reports them
# loudly and exits non-zero. 5 and 7 remain best-effort, matching the
# established restore contract.
# ============================================================

# Map `uname` output onto a deps/obscura.lock.json asset key.
# Prints e.g. "linux-x86_64"; returns 1 for unsupported platforms.
obscura_platform_key() {
  local os arch
  case "$(uname -s)" in
    Linux)  os=linux ;;
    Darwin) os=macos ;;
    *)      return 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)   arch=x86_64 ;;
    aarch64|arm64)  arch=aarch64 ;;
    *)              return 1 ;;
  esac
  printf '%s-%s\n' "$os" "$arch"
}

# Print the SHA-256 of a file as lowercase hex.
obscura_sha256_of() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    return 2
  fi
}

# Read and validate one asset entry out of the lock file.
#   obscura_lock_entry <lockfile> <platform-key>
# Prints "repository<TAB>version<TAB>asset-name<TAB>sha256" on success.
obscura_lock_entry() {
  python3 - "$1" "$2" <<'PY'
import json
import re
import sys

lock_path, platform = sys.argv[1], sys.argv[2]
REQUIRED = ("linux-x86_64", "linux-aarch64", "macos-x86_64", "macos-aarch64")


def die(message, code=3):
    print(f"obscura lock: {message}", file=sys.stderr)
    sys.exit(code)


try:
    raw = open(lock_path, encoding="utf-8").read()
except OSError as exc:
    die(f"cannot read {lock_path}: {exc}")

try:
    data = json.loads(raw)
except json.JSONDecodeError as exc:
    die(f"{lock_path} is not valid JSON: {exc}")

if not isinstance(data, dict):
    die("top level must be a JSON object")

repository = data.get("repository")
if not isinstance(repository, str) or not re.fullmatch(r"[\w.-]+/[\w.-]+", repository):
    die(f"repository must look like owner/name, got {repository!r}")

version = data.get("version")
if not isinstance(version, str) or not re.fullmatch(r"v\d+\.\d+\.\d+", version):
    die(f"version must look like vX.Y.Z, got {version!r}")

assets = data.get("assets")
if not isinstance(assets, dict):
    die("assets must be a JSON object")

missing = [key for key in REQUIRED if key not in assets]
if missing:
    die("missing required asset key(s): " + ", ".join(missing))

entry = assets.get(platform)
if not isinstance(entry, dict):
    die(
        f"no asset for platform {platform!r} (supported: {', '.join(REQUIRED)})",
        code=4,
    )

name = entry.get("name")
sha = entry.get("sha256")
if not isinstance(name, str) or not name:
    die(f"asset name missing for {platform}")
if not isinstance(sha, str) or not re.fullmatch(r"[0-9a-f]{64}", sha):
    die(f"sha256 for {platform} must be 64 lowercase hex characters")

print(f"{repository}\t{version}\t{name}\t{sha}")
PY
}

# Constant-work equality check of a file's digest against an expected value.
obscura_verify_sha256() {
  local file="$1" expected="$2" actual
  actual="$(obscura_sha256_of "$file")" || return 2
  [ "$actual" = "$expected" ]
}

# Print the release URL for a version + asset name. Never uses "latest".
obscura_download_url() {
  local repo="$1" version="$2" asset="$3"
  printf 'https://github.com/%s/releases/download/%s/%s\n' "$repo" "$version" "$asset"
}

# Print the version reported by an installed obscura binary ("0.2.2"), or nothing.
obscura_installed_version() {
  command -v obscura >/dev/null 2>&1 || return 1
  obscura --version 2>/dev/null \
    | sed -nE 's/^obscura[[:space:]]+v?([0-9]+\.[0-9]+\.[0-9]+).*$/\1/p' \
    | head -n 1
}

# Download -> verify -> extract -> install. The archive is never extracted
# before its digest matches.
#   obscura_install_from_url <url> <sha256> <asset-name> <dest-dir> [binary...]
obscura_install_from_url() {
  local url="$1" expected_sha="$2" asset="$3" dest="$4"
  shift 4
  local bins=("$@")
  [ "${#bins[@]}" -gt 0 ] || bins=(obscura obscura-worker)

  local tmp
  tmp="$(mktemp -d)" || return 5
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN

  if ! curl -fsSL "$url" -o "$tmp/$asset"; then
    printf 'obscura: ERROR: download failed: %s\n' "$url" >&2
    return 5
  fi

  if ! obscura_verify_sha256 "$tmp/$asset" "$expected_sha"; then
    printf 'obscura: ERROR: SHA-256 mismatch for %s\n' "$asset" >&2
    printf 'obscura: ERROR:   expected %s\n' "$expected_sha" >&2
    printf 'obscura: ERROR:   actual   %s\n' "$(obscura_sha256_of "$tmp/$asset")" >&2
    printf 'obscura: ERROR: refusing to extract or install an unverified archive\n' >&2
    return 6
  fi

  if ! tar xzf "$tmp/$asset" -C "$tmp"; then
    printf 'obscura: ERROR: cannot extract %s\n' "$asset" >&2
    return 7
  fi

  local installed=0 bin
  mkdir -p "$dest" || return 8
  for bin in "${bins[@]}"; do
    if [ -f "$tmp/$bin" ]; then
      install -m 755 "$tmp/$bin" "$dest/$bin" || return 8
      installed=$((installed + 1))
    fi
  done
  if [ "$installed" -eq 0 ]; then
    printf 'obscura: ERROR: archive contained none of: %s\n' "${bins[*]}" >&2
    return 8
  fi
  return 0
}

# Human-readable label for the codes above.
obscura_failure_label() {
  case "$1" in
    3) printf 'malformed or incomplete lock file' ;;
    4) printf 'unsupported platform' ;;
    5) printf 'download failed' ;;
    6) printf 'CHECKSUM MISMATCH' ;;
    7) printf 'extraction failed' ;;
    8) printf 'archive did not contain the expected binaries' ;;
    *) printf 'unknown failure' ;;
  esac
}

# 1 when a failure code must abort the restore as an integrity failure.
obscura_is_integrity_failure() {
  case "$1" in 3|4|6) return 0 ;; *) return 1 ;; esac
}
