#!/usr/bin/env bash
# ============================================================
# versions-lib.sh — live harness version discovery.
#
# ONE canonical source of version discovery for the backup skill.
# Sourced by backup.sh (preflight gate) and restore.sh (runtime report).
#
# Contract:
#   * OFFLINE. Only local binaries, local files and local git checkouts.
#     Never curl/wget/gh/npm-view/fetch. Backup must not ask upstream
#     what "latest" is, and must never upgrade anything.
#   * Discover first, compare second. Callers run the preflight before
#     copying any file, so the repository snapshot can never claim a
#     version the machine is not actually running.
#   * Drift is reported, not fatal. A coherent upstream update is normal:
#     detect -> report -> refresh snapshot metadata -> continue.
#   * Incoherent live state is fatal: runtime vs managed marker, pinned
#     tool vs lock, a non-exact package declaration (floating DCP pin,
#     unpinned npm/git/URL source), malformed lock, missing required
#     component.
#
# Test hooks: tests prepend a stub directory to PATH so `pi`, `rtk`,
# `trufflehog` and `obscura` resolve to fixtures. No env-var bin overrides
# are needed, which keeps production and test discovery on the same path.
# ============================================================

VERSIONS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$VERSIONS_LIB_DIR/obscura-lib.sh" ]; then
  # shellcheck source=obscura-lib.sh disable=SC1091
  . "$VERSIONS_LIB_DIR/obscura-lib.sh"
fi

# Populated by versions_discover:
#   VERSIONS_ROWS      component|live|expected|status|note
#   VERSIONS_DRIFTS    human drift lines ("Pi 0.87.0 → 0.87.1")
#   VERSIONS_BLOCKERS  human blocking inconsistency lines
VERSIONS_ROWS=()
VERSIONS_DRIFTS=()
VERSIONS_BLOCKERS=()
VERSIONS_PREV_PI=""

versions_row() { # name live expected status [note]
  VERSIONS_ROWS+=("$1|$2|$3|$4|${5:-}")
}
versions_drift() { VERSIONS_DRIFTS+=("$1"); }
versions_block() { VERSIONS_BLOCKERS+=("$1"); }

# ---------------------------------------------------------------- probes

# First semver-looking token of a command's output. The boundary guards stop
# the match from starting mid-number (node's "v22.22.0" must not become
# "2.22.0" under leftmost-longest POSIX matching).
versions_probe() { # <bin> [args...]
  local bin="$1"
  shift
  command -v "$bin" >/dev/null 2>&1 || return 1
  local out
  out="$("$bin" "$@" 2>/dev/null)" || true
  printf '%s\n' "$out" \
    | grep -oE '(^|[^0-9.])[0-9]+\.[0-9]+\.[0-9]+([^0-9.]|$)' \
    | head -n 1 \
    | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' \
    | head -n 1
}

versions_pi_runtime_version() {
  versions_probe pi --version || true
}

versions_pi_marker_version() { # <agent_dir>
  local marker="$1/install/current-version"
  [ -f "$marker" ] || return 1
  tr -d '[:space:]' <"$marker"
}

# ---------------------------------------------------------------- repo metadata

# Repo snapshot Pi version from pi/settings.json (authoritative snapshot field).
versions_pi_repo_snapshot() { # <repo_dir>
  local file="$1/pi/settings.json"
  [ -f "$file" ] || return 3
  python3 - "$file" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(4)
value = data.get("lastChangelogVersion")
print(value if isinstance(value, str) else "")
PY
}

# README backup-time Pi version line (snapshot metadata, refreshed in place).
versions_pi_readme_version() { # <repo_dir>
  local file="$1/README.md"
  [ -f "$file" ] || return 3
  sed -nE 's/^- Pi version at backup time: \*\*([0-9]+\.[0-9]+\.[0-9]+)\*\*.*/\1/p' "$file" | head -n 1
}

# Targeted, non-global README refresh. Returns 0 when written or already
# current, 3 when no README, 4 when the known metadata line is missing.
versions_refresh_readme_pi_version() { # <repo_dir> <version>
  local file="$1/README.md" version="$2"
  python3 - "$file" "$version" <<'PY'
import pathlib, re, sys
path = pathlib.Path(sys.argv[1])
version = sys.argv[2]
if not path.is_file():
    sys.exit(3)
text = path.read_text(encoding="utf-8")
pattern = re.compile(r"(- Pi version at backup time: \*\*)[0-9]+\.[0-9]+\.[0-9]+(\*\*)")
updated, count = pattern.subn(rf"\g<1>{version}\g<2>", text)
if count == 0:
    sys.exit(4)
if updated != text:
    path.write_text(updated, encoding="utf-8")
PY
}

versions_obscura_locked_version() { # <repo_dir> -> lock version (keeps the v prefix)
  local file="$1/deps/obscura.lock.json"
  [ -f "$file" ] || return 3
  python3 - "$file" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(4)
value = data.get("version")
if not isinstance(value, str) or not value:
    sys.exit(4)
print(value)
PY
}

versions_trufflehog_pinned_version() { # <repo_dir>
  local file="$1/deps/tools.lock.json"
  [ -f "$file" ] || return 3
  python3 - "$file" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(4)
entry = data.get("trufflehog")
if not isinstance(entry, dict):
    sys.exit(4)
value = entry.get("version")
if not isinstance(value, str) or not value:
    sys.exit(4)
print(value)
PY
}

# Print one package source spec per line from settings.json packages[].
versions_settings_packages() { # <settings.json>
  local file="$1"
  [ -f "$file" ] || return 3
  python3 - "$file" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(4)
packages = data.get("packages")
if not isinstance(packages, list):
    sys.exit(0)
for entry in packages:
    if isinstance(entry, str) and entry.strip():
        print(entry.strip())
PY
}

versions_npm_installed_version() { # <agent_dir> <package>
  local file="$1/npm/node_modules/$2/package.json"
  [ -f "$file" ] || return 3
  python3 - "$file" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(4)
value = data.get("version")
print(value if isinstance(value, str) else "")
PY
}

versions_git_head() { # <checkout_dir>
  local dir="$1"
  [ -d "$dir" ] || return 3
  git -C "$dir" rev-parse HEAD 2>/dev/null || return 4
}

# ---------------------------------------------------------------- discovery

# Split an npm spec body (`[@scope/]name[@version]`) into a package name and
# an optional version. Scoped names start with '@', so only a second '@'
# delimits a version.
versions_split_npm_spec() { # <spec-body>; sets VERSIONS_NPM_NAME / VERSIONS_NPM_PIN
  local body="$1" rest=""
  VERSIONS_NPM_NAME="$body"
  VERSIONS_NPM_PIN=""
  case "$body" in
    @*@*)
      rest="${body#@}"
      VERSIONS_NPM_NAME="@${rest%@*}"
      VERSIONS_NPM_PIN="${body##*@}"
      ;;
    @*) ;;
    *@*)
      VERSIONS_NPM_NAME="${body%@*}"
      VERSIONS_NPM_PIN="${body##*@}"
      ;;
  esac
}

# Exact semver only (Pi's npm pin semantics), mirroring the contract regex
# in scripts/check-repo.sh: reject tags, ranges, caret/tilde/x-ranges and
# malformed versions so they block instead of floating.
versions_npm_pin_is_exact() { # <version>
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?([+][0-9A-Za-z.-]+)?$ ]]
}

# Verify a commit-pinned git source (git: prefix or github URL with @ref).
# Fills the row from the installed checkout and blocks on any mismatch.
versions_discover_git_pin() { # <agent_dir> <owner_repo> <pin> <spec>
  local agent_dir="$1" owner_repo="$2" pin="$3" spec="$4"
  case "$pin" in
    ""|"$spec"|*[!0-9a-f]*)
      versions_block "git package is not pinned to an exact commit: $spec"
      versions_row "git:$owner_repo" "floating" "-" BLOCK "no 40-hex commit pin"
      return 0
      ;;
  esac
  if [ "${#pin}" -ne 40 ]; then
    versions_block "git package pin is not a 40-hex commit: $spec"
    versions_row "git:$owner_repo" "$pin" "$pin" BLOCK "invalid pin"
    return 0
  fi
  local checkout="$agent_dir/git/$owner_repo" commit="" rc=0
  commit="$(versions_git_head "$checkout" 2>/dev/null)" || rc=$?
  if [ "$rc" -eq 3 ]; then
    versions_row "git:$owner_repo" "missing" "$pin" MISSING "checkout not found"
  elif [ -z "$commit" ]; then
    versions_block "could not read installed commit for git package $owner_repo"
    versions_row "git:$owner_repo" "unknown" "$pin" BLOCK "unreadable checkout"
  elif [ "$commit" != "$pin" ]; then
    versions_block "git package $owner_repo installed at $commit but pinned to $pin"
    versions_row "git:$owner_repo" "$commit" "$pin" BLOCK "installed != pinned"
  else
    versions_row "git:$owner_repo" "$commit" "$pin" OK "pinned commit"
  fi
}

# Classify one git/npm package spec. Fills the row. Every declared package
# must be exactly pinned; non-exact npm versions, floating git refs and bare
# URLs block, as does any live install that disagrees with its pin.
versions_discover_package() { # <agent_dir> <repo_dir> <spec>
  local agent_dir="$1" repo_dir="$2" spec="$3"
  case "$spec" in
    npm:*)
      local body="${spec#npm:}" pkg="" pin="" installed="" rc=0
      versions_split_npm_spec "$body"
      pkg="$VERSIONS_NPM_NAME"
      pin="$VERSIONS_NPM_PIN"
      if [ -z "$pin" ] || ! versions_npm_pin_is_exact "$pin"; then
        versions_block "npm package is not pinned to an exact version: $spec"
        versions_row "npm:$pkg" "floating" "-" BLOCK "no exact version pin"
        return 0
      fi
      installed="$(versions_npm_installed_version "$agent_dir" "$pkg" 2>/dev/null)" || rc=$?
      if [ "$rc" -eq 3 ]; then
        versions_row "npm:$pkg" "missing" "$pin" MISSING "declared in settings.json"
      elif [ -z "$installed" ]; then
        versions_row "npm:$pkg" "unknown" "$pin" MISSING "unreadable package.json"
      elif [ "$installed" != "$pin" ]; then
        versions_block "npm package $pkg installed at $installed but pinned to $pin"
        versions_row "npm:$pkg" "$installed" "$pin" BLOCK "installed != pinned"
      else
        versions_row "npm:$pkg" "$installed" "$pin" OK "pinned version"
      fi
      ;;
    git:*)
      # Split into separate assignments: a single `local a=... b=$a` line can
      # expand later RHS words before the earlier assignments exist.
      local pin repo_path owner_repo
      pin="${spec##*@}"
      repo_path="${spec#git:}"
      owner_repo="${repo_path%@*}"
      versions_discover_git_pin "$agent_dir" "$owner_repo" "$pin" "$spec"
      ;;
    http://*|https://*)
      # A GitHub URL is a contract pin only with an explicit @<40-hex commit>;
      # a bare URL blocks, exactly like a floating git: source.
      local owner_repo="${spec#*github.com/}" pin=""
      case "$owner_repo" in
        *@*)
          pin="${owner_repo##*@}"
          owner_repo="${owner_repo%@*}"
          ;;
      esac
      owner_repo="github.com/${owner_repo%.git}"
      versions_discover_git_pin "$agent_dir" "$owner_repo" "$pin" "$spec"
      ;;
    *)
      versions_row "package" "$spec" "-" MISSING "unrecognized package source"
      ;;
  esac
}

versions_discover() { # <agent_dir> <repo_dir>
  VERSIONS_ROWS=()
  VERSIONS_DRIFTS=()
  VERSIONS_BLOCKERS=()
  VERSIONS_PREV_PI=""

  # ---- Pi: live application version ---------------------------
  local runtime marker live pi_source repo_snapshot readme_v
  runtime="$(versions_pi_runtime_version)"
  marker="$(versions_pi_marker_version "$1" 2>/dev/null || true)"
  if [ -z "$runtime" ] && [ -z "$marker" ]; then
    versions_block "Pi version could not be discovered (no 'pi --version' and no install/current-version marker)"
    versions_row "Pi" "unknown" "-" BLOCK "required component"
  elif [ -n "$runtime" ] && [ -n "$marker" ] && [ "$runtime" != "$marker" ]; then
    versions_block "Pi runtime version ($runtime) disagrees with managed install marker ($marker)"
    versions_row "Pi" "$runtime" "$marker" BLOCK "runtime != install/current-version"
  else
    if [ -n "$runtime" ]; then
      live="$runtime"
      pi_source="pi --version"
    else
      live="$marker"
      pi_source="install/current-version"
    fi
    repo_snapshot="$(versions_pi_repo_snapshot "$2" 2>/dev/null || true)"
    readme_v="$(versions_pi_readme_version "$2" 2>/dev/null || true)"
    VERSIONS_PREV_PI="$repo_snapshot"
    if [ -n "$repo_snapshot" ] && [ "$repo_snapshot" != "$live" ]; then
      versions_drift "Pi $repo_snapshot → $live"
      versions_row "Pi" "$live" "$repo_snapshot" DRIFT "$pi_source"
    else
      versions_row "Pi" "$live" "${repo_snapshot:-$live}" OK "$pi_source"
    fi
    if [ -n "$readme_v" ] && [ "$readme_v" != "$live" ]; then
      versions_drift "README backup-time Pi $readme_v → $live"
    fi
  fi

  # ---- RTK: installed tool release (no repo pin) --------------
  local rtk
  rtk="$(versions_probe rtk --version)"
  if [ -n "$rtk" ]; then
    versions_row "RTK" "$rtk" "-" OK "installed tool"
  else
    versions_row "RTK" "missing" "-" MISSING "optional tool not in PATH"
  fi

  # ---- TruffleHog: installed vs pinned lock -------------------
  local th installed pinned rc=0
  installed="$(versions_probe trufflehog --version)"
  pinned="$(versions_trufflehog_pinned_version "$2" 2>/dev/null)" || rc=$?
  if [ "$rc" -eq 4 ]; then
    versions_block "deps/tools.lock.json is malformed (no usable trufflehog.version)"
    versions_row "TruffleHog" "${installed:-missing}" "-" BLOCK "malformed lock"
  elif [ "$rc" -eq 3 ]; then
    versions_row "TruffleHog" "${installed:-missing}" "-" OK "no repo lock"
  elif [ -z "$installed" ]; then
    versions_block "TruffleHog is required by deps/tools.lock.json but is not installed"
    versions_row "TruffleHog" "missing" "$pinned" BLOCK "required by lock"
  elif [ "$installed" != "$pinned" ]; then
    versions_block "TruffleHog installed $installed != pinned $pinned (install the pinned version)"
    versions_row "TruffleHog" "$installed" "$pinned" BLOCK "installed != pinned"
  else
    versions_row "TruffleHog" "$installed" "$pinned" OK "installed == pinned"
  fi

  # ---- Obscura: installed vs locked release -------------------
  local obsc installed_o locked locked_num rc_o=0
  if command -v obscura_installed_version >/dev/null 2>&1; then
    installed_o="$(obscura_installed_version 2>/dev/null || true)"
  else
    installed_o="$(versions_probe obscura --version)"
  fi
  locked="$(versions_obscura_locked_version "$2" 2>/dev/null)" || rc_o=$?
  if [ "$rc_o" -eq 4 ]; then
    versions_block "deps/obscura.lock.json is malformed (no usable version)"
    versions_row "Obscura" "${installed_o:-missing}" "-" BLOCK "malformed lock"
  elif [ "$rc_o" -eq 3 ]; then
    versions_row "Obscura" "${installed_o:-missing}" "-" OK "no repo lock"
  elif [ -z "$installed_o" ]; then
    versions_row "Obscura" "missing" "$locked" MISSING "not installed (run restore.sh)"
  else
    locked_num="${locked#v}"
    if [ "$installed_o" != "$locked_num" ]; then
      versions_block "Obscura installed $installed_o != locked $locked (run restore.sh or update the lock deliberately)"
      versions_row "Obscura" "$installed_o" "$locked" BLOCK "installed != locked"
    else
      versions_row "Obscura" "$installed_o" "$locked" OK "installed == locked"
    fi
  fi

  # ---- Pi packages/extensions and git pins --------------------
  local settings_live="$1/settings.json" settings_repo="$2/pi/settings.json"
  local spec
  local packages_file="$settings_live"
  [ -f "$packages_file" ] || packages_file="$settings_repo"
  if [ -f "$packages_file" ]; then
    while IFS= read -r spec; do
      [ -n "$spec" ] || continue
      versions_discover_package "$1" "$2" "$spec"
    done < <(versions_settings_packages "$packages_file" 2>/dev/null || true)
  fi

  # ---- Toolchain/runtime --------------------------------------
  local bun node_v
  bun="$(versions_probe bun --version)"
  versions_row "Bun" "${bun:-missing}" "-" OK "runtime"
  node_v="$(versions_probe node --version)"
  versions_row "Node" "${node_v:-not installed}" "-" OK "optional runtime"
}

# ---------------------------------------------------------------- snapshot
# pi/versions.json records the live inventory of the last SUCCESSFUL backup.
# It is a historical snapshot, never a lock: hard pins live in the existing
# lock files and settings, and this file must never drive installation.
# Deterministic content only (sorted keys, no timestamps).

export VERSIONS_SNAPSHOT_REL="pi/versions.json"

# Emit the discovered inventory as deterministic JSON on stdout.
versions_snapshot_json() {
  local row name live expected status note tsv=""
  for row in "${VERSIONS_ROWS[@]}"; do
    IFS='|' read -r name live expected status note <<<"$row"
    case "$name" in
      Pi) [ "$live" != "unknown" ] && tsv+="pi\t$live\n" ;;
      RTK) [ "$live" != "missing" ] && tsv+="tools.rtk\t$live\n" ;;
      TruffleHog) [ "$live" != "missing" ] && tsv+="tools.trufflehog\t$live\n" ;;
      Obscura) [ "$live" != "missing" ] && tsv+="tools.obscura\t${live#v}\n" ;;
      npm:*)
        [ "$live" != "missing" ] && [ "$live" != "unknown" ] && tsv+="packages.${name#npm:}\t$live\n"
        ;;
      git:*)
        [ "$live" != "missing" ] && [ "$live" != "unknown" ] && tsv+="git.${name##*/}\t$live\n"
        ;;
      Bun) [ "$live" != "missing" ] && tsv+="runtime.bun\t$live\n" ;;
      Node) [ "$live" != "missing" ] && [ "$live" != "not installed" ] && tsv+="runtime.node\t$live\n" ;;
    esac
  done
  printf '%b' "$tsv" | python3 -c '
import json, sys

out = {"schemaVersion": 1, "pi": "", "tools": {}, "packages": {}, "git": {}, "runtime": {}}
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    key, value = line.split("\t", 1)
    parts = key.split(".")
    if parts[0] == "pi":
        out["pi"] = value
    else:
        node = out
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = value
print(json.dumps(out, sort_keys=True, indent=2))
'
}

# flatten a snapshot JSON stream into component<TAB>value lines.
versions_json_to_flat() {
  python3 -c '
import json, sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(4)
if not isinstance(data, dict) or data.get("schemaVersion") != 1:
    sys.exit(5)
lines = []


def walk(prefix, node):
    if isinstance(node, dict):
        for key in sorted(node):
            walk(prefix + "." + key if prefix else key, node[key])
    elif isinstance(node, str):
        lines.append(prefix + "\t" + node)


if isinstance(data.get("pi"), str):
    lines.append("pi\t" + data["pi"])
for section in ("tools", "packages", "git", "runtime"):
    walk(section, data.get(section, {}))
print("\n".join(sorted(set(lines))))
'
}

versions_snapshot_flat() { # <snapshot-file>
  local file="$1"
  [ -f "$file" ] || return 3
  versions_json_to_flat <"$file"
}

# Stage a candidate snapshot outside the tracked path. Nothing is committed
# until the caller decides the whole backup succeeded. Prints the temp path.
versions_snapshot_stage() { # <repo_dir>
  local repo="$1" tmp
  tmp="$(mktemp "$repo/.versions.json.staged.XXXXXX" 2>/dev/null)" || return 1
  if ! versions_snapshot_json >"$tmp" 2>/dev/null; then
    rm -f "$tmp"
    return 1
  fi
  if ! versions_json_to_flat <"$tmp" >/dev/null 2>&1; then
    rm -f "$tmp"
    return 1
  fi
  printf '%s' "$tmp"
}

# Replace the tracked snapshot with the staged candidate. Call this ONLY
# after copy and verification succeeded.
versions_snapshot_commit() { # <staged-file> <repo_dir>
  local staged="$1" repo="$2"
  [ -s "$staged" ] || return 1
  mkdir -p "$repo/pi"
  mv -f "$staged" "$repo/$VERSIONS_SNAPSHOT_REL"
}

# Historical comparison against the previous successful snapshot. Reports
# changed/added/removed unpinned components; never blocks. Pi has its own
# explicit drift reporting and is excluded here.
versions_compare_snapshot() { # <repo_dir>
  local repo="$1" snapshot="$1/$VERSIONS_SNAPSHOT_REL"
  printf '\nVersion snapshot\n'
  if [ ! -f "$snapshot" ]; then
    printf 'baseline: no previous inventory — a successful backup will create %s\n' "$VERSIONS_SNAPSHOT_REL"
    return 0
  fi

  local live_flat prev_flat key old new changes=0
  live_flat="$(versions_snapshot_json 2>/dev/null | versions_json_to_flat)" || true
  prev_flat="$(versions_snapshot_flat "$snapshot" 2>/dev/null)" || true
  if [ -z "$prev_flat" ]; then
    printf 'WARNING: previous %s is unreadable; treating this run as a baseline\n' "$VERSIONS_SNAPSHOT_REL" >&2
    return 0
  fi

  while IFS=$'\t' read -r key new; do
    [ -n "$key" ] || continue
    [ "$key" = "pi" ] && continue
    old="$(printf '%s\n' "$prev_flat" | awk -F$'\t' -v k="$key" '$1 == k { print $2; exit }')"
    if [ -z "$old" ]; then
      printf '  + %s %s\n' "$key" "$new"
      changes=1
    elif [ "$old" != "$new" ]; then
      printf '  ~ %s %s → %s\n' "$key" "$old" "$new"
      changes=1
    fi
  done <<<"$live_flat"

  while IFS=$'\t' read -r key old; do
    [ -n "$key" ] || continue
    [ "$key" = "pi" ] && continue
    if ! printf '%s\n' "$live_flat" | grep -qF "$key"$'\t'; then
      printf '  - %s %s\n' "$key" "$old"
      changes=1
    fi
  done <<<"$prev_flat"

  if [ "$changes" -eq 0 ]; then
    printf 'no changes since the last successful backup\n'
  fi
  printf '(component changes are informational; all declared pins are enforced by the live preflight above)\n'
  return 0
}

# ---------------------------------------------------------------- reporting

versions_report() {
  printf 'Live version preflight\n\n'
  local width=9 row name live expected status note
  for row in "${VERSIONS_ROWS[@]}"; do
    IFS='|' read -r name _ _ _ _ <<<"$row"
    [ "${#name}" -gt "$width" ] && width="${#name}"
  done
  printf "%-${width}s %-16s %-26s %s\n" "Component" "Live" "Repo expectation" "Status"
  for row in "${VERSIONS_ROWS[@]}"; do
    IFS='|' read -r name live expected status note <<<"$row"
    printf "%-${width}s %-16s %-26s %s%s\n" "$name" "${live:--}" "${expected:--}" "$status" "${note:+  ($note)}"
  done
  printf '\n'
  if [ "${#VERSIONS_DRIFTS[@]}" -gt 0 ]; then
    local drift
    for drift in "${VERSIONS_DRIFTS[@]}"; do
      printf 'Version drift detected: %s\n' "$drift"
    done
  else
    printf 'Version drift: none\n'
  fi
  if [ "${#VERSIONS_BLOCKERS[@]}" -gt 0 ]; then
    printf '\nBlocking inconsistencies:\n'
    local blocker
    for blocker in "${VERSIONS_BLOCKERS[@]}"; do
      printf '  BLOCK: %s\n' "$blocker"
    done
  fi
}

# Scan the repo for the previous backed-up Pi version. Known snapshot
# metadata is reported as refreshed by the preflight; everything else is a
# historical/pinned reference that a backup must never rewrite blindly.
versions_scan_stale_references() { # <repo_dir> <old_version>
  local repo="$1" old="$2"
  [ -n "$old" ] || return 0
  local line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      */pi/settings.json:*)
        printf 'stale-reference: %s  [snapshot metadata; refreshed by the copy phase]\n' "$line"
        ;;
      */README.md:*)
        printf 'stale-reference: %s  [snapshot metadata; refreshed in place]\n' "$line"
        ;;
      *)
        printf 'stale-reference: %s  [review: historical/pinned reference, not rewritten]\n' "$line"
        ;;
    esac
  done < <(grep -rIn --exclude-dir=.git --exclude-dir=node_modules -F "$old" "$repo" 2>/dev/null || true)
}

# Full preflight. Returns 0 when coherent (drift is fine), 2 on blockers,
# 1 on unexpected discovery failure. `--refresh` updates snapshot metadata
# (README Pi line) after the drift report.
versions_preflight() { # <agent_dir> <repo_dir> [--refresh]
  local agent_dir="$1" repo_dir="$2"
  local refresh=0
  [ "${3:-}" = "--refresh" ] && refresh=1

  versions_discover "$agent_dir" "$repo_dir" || return 1
  versions_report
  versions_compare_snapshot "$repo_dir"

  # Blocking inconsistencies abort before the repository is touched: no
  # refresh, no scan, no copy. Drift alone still reconciles below.
  if [ "${#VERSIONS_BLOCKERS[@]}" -gt 0 ]; then
    return 2
  fi

  local live_pi="" row
  for row in "${VERSIONS_ROWS[@]}"; do
    case "$row" in
      "Pi|"*)
        IFS='|' read -r _ live_pi _ _ _ <<<"$row"
        ;;
    esac
  done

  if [ "$refresh" -eq 1 ] && [ -n "$live_pi" ] && [ "$live_pi" != "unknown" ]; then
    local rc=0
    versions_refresh_readme_pi_version "$repo_dir" "$live_pi" || rc=$?
    case "$rc" in
      0) printf 'Snapshot metadata: README Pi version is %s\n' "$live_pi" ;;
      3) : ;; # no README in this repository shape
      4) printf 'WARNING: README has no "- Pi version at backup time:" line to refresh\n' >&2 ;;
    esac
  fi

  if [ -n "$VERSIONS_PREV_PI" ] && [ "$VERSIONS_PREV_PI" != "$live_pi" ]; then
    versions_scan_stale_references "$repo_dir" "$VERSIONS_PREV_PI"
  fi

  return 0
}

# True when discovery reported a real Pi version transition (DRIFT).
versions_pi_drifted() {
  local row name live expected status note
  for row in "${VERSIONS_ROWS[@]}"; do
    case "$row" in
      "Pi|"*)
        IFS='|' read -r name live expected status note <<<"$row"
        [ "$status" = "DRIFT" ] && return 0
        return 1
        ;;
    esac
  done
  return 1
}

# Lightweight local compatibility checks for a Pi version transition. Runs
# against the CURRENT install, makes no provider requests, and never
# upgrades anything. Returns 0 when the install still satisfies the harness
# contracts a Pi update can break.
versions_pi_transition_checks() { # <agent_dir> <repo_dir>
  local agent_dir="$1" repo_dir="$2"
  local ok=0

  printf '\nPi version transition: running local compatibility checks\n'

  # 1. Renderer patch signatures on the current install (verify only).
  local patcher="$agent_dir/patch-pi-renderer.py"
  if [ -f "$patcher" ]; then
    if ! python3 "$patcher" --check; then
      printf 'version-preflight: ERROR: renderer patch signatures are not provable on the current install\n' >&2
      ok=1
    fi
  else
    printf 'version-preflight: WARN: no patch-pi-renderer.py in %s\n' "$agent_dir" >&2
  fi

  # 2. Extensions load under the current Pi in headless RPC mode (no prompt,
  #    no provider request). The repo's todo extension is loaded explicitly
  #    when it is not yet restored into the live config.
  if command -v pi >/dev/null 2>&1; then
    local load_log="$repo_dir/.pi-transition-load.log"
    local extra=()
    local timeout_cmd=()
    if [ -f "$repo_dir/pi/extensions/todo.ts" ] && [ ! -f "$agent_dir/extensions/todo.ts" ]; then
      extra=(-e "$repo_dir/pi/extensions/todo.ts")
    fi
    command -v timeout >/dev/null 2>&1 && timeout_cmd=(timeout "${PI_COMPAT_TIMEOUT:-45}")
    if ! "${timeout_cmd[@]}" pi --mode rpc --no-session "${extra[@]}" </dev/null >"$load_log" 2>&1; then
      printf 'version-preflight: ERROR: pi --mode rpc failed while loading extensions\n' >&2
      ok=1
    fi
    if grep -qi 'Failed to load extension' "$load_log"; then
      printf 'version-preflight: ERROR: extension failed to load after the Pi update:\n' >&2
      grep -i 'Failed to load extension' "$load_log" >&2
      ok=1
    fi
    rm -f "$load_log"
  else
    printf 'version-preflight: WARN: pi not in PATH; skipping extension load check\n' >&2
  fi

  # 3. Existing extension test scripts when their runtime is available.
  if command -v bun >/dev/null 2>&1; then
    local test_script
    for test_script in test-cwd-switch.sh test-todo.sh; do
      if [ -x "$repo_dir/scripts/$test_script" ]; then
        if ! "$repo_dir/scripts/$test_script" >/dev/null 2>&1; then
          printf 'version-preflight: ERROR: %s failed after the Pi update\n' "$test_script" >&2
          ok=1
        fi
      fi
    done
  else
    printf 'version-preflight: WARN: bun not installed; skipping extension test scripts\n' >&2
  fi

  if [ "$ok" -eq 0 ]; then
    printf 'Pi transition checks: OK\n'
  fi
  return "$ok"
}

# Post-copy invariant: the snapshot must describe the live Pi version.
# Returns 0 when coherent (or when a file is absent in a minimal repo),
# 1 when snapshot metadata still disagrees.
versions_verify_snapshot() { # <agent_dir> <repo_dir>
  local agent_dir="$1" repo_dir="$2"
  local runtime marker live
  runtime="$(versions_pi_runtime_version)"
  marker="$(versions_pi_marker_version "$agent_dir" 2>/dev/null || true)"
  if [ -n "$runtime" ] && [ -n "$marker" ] && [ "$runtime" != "$marker" ]; then
    printf 'version-preflight: ERROR: Pi runtime (%s) != managed marker (%s)\n' "$runtime" "$marker" >&2
    return 1
  fi
  live="${runtime:-$marker}"
  [ -n "$live" ] || return 0

  local ok=0 settings_v readme_v rc=0
  settings_v="$(versions_pi_repo_snapshot "$repo_dir" 2>/dev/null)" || rc=$?
  if [ "$rc" -eq 0 ] && [ -n "$settings_v" ] && [ "$settings_v" != "$live" ]; then
    printf 'version-preflight: ERROR: repo settings lastChangelogVersion=%s but live Pi is %s\n' "$settings_v" "$live" >&2
    ok=1
  fi
  rc=0
  readme_v="$(versions_pi_readme_version "$repo_dir" 2>/dev/null)" || rc=$?
  if [ "$rc" -eq 0 ] && [ -n "$readme_v" ] && [ "$readme_v" != "$live" ]; then
    printf 'version-preflight: ERROR: repo README backup-time Pi=%s but live Pi is %s\n' "$readme_v" "$live" >&2
    ok=1
  fi
  return "$ok"
}
