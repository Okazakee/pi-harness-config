#!/usr/bin/env python3
"""Update deps/obscura.lock.json from published GitHub release metadata.

This is an EXPLICIT dependency-update operation. It never runs during
restore, backup, commit, push or CI, and it never writes anything unless
`--write` is passed. An update is a normal reviewed repository change.

Usage:
  scripts/update-obscura-lock.py --check
  scripts/update-obscura-lock.py --write
  scripts/update-obscura-lock.py --check  --release v0.3.0
  scripts/update-obscura-lock.py --write  --include-prerelease

Exit codes: 0 success, 1 failure (network, metadata, or validation problem).

Structured GitHub release metadata is used; no HTML scraping.
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.request

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
LOCK_PATH = REPO_ROOT / "deps" / "obscura.lock.json"
API = "https://api.github.com"
DEFAULT_REPOSITORY = "h4ckf0r0day/obscura"

# platform key -> release asset name. These are the four supported default
# (non-stealth, non-no-render) builds.
DEFAULT_ASSETS = {
    "linux-x86_64": "obscura-x86_64-linux.tar.gz",
    "linux-aarch64": "obscura-aarch64-linux.tar.gz",
    "macos-x86_64": "obscura-x86_64-macos.tar.gz",
    "macos-aarch64": "obscura-aarch64-macos.tar.gz",
}
SHA256_RE = re.compile(r"sha256:([0-9a-f]{64})$")
VERSION_RE = re.compile(r"v\d+\.\d+\.\d+")


def die(message: str) -> "NoReturn":  # type: ignore[name-defined]
    print(f"update-obscura-lock: error: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_lock() -> dict:
    if not LOCK_PATH.is_file():
        return {}
    try:
        return json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        die(f"cannot read {LOCK_PATH}: {exc}")


def expected_assets(lock: dict) -> dict[str, str]:
    """Prefer the asset names already declared in the lock; else defaults."""
    declared = lock.get("assets")
    if isinstance(declared, dict) and set(declared) == set(DEFAULT_ASSETS):
        names = {}
        for key, entry in declared.items():
            name = entry.get("name") if isinstance(entry, dict) else None
            if not isinstance(name, str) or not name:
                die(f"existing lock entry {key} has no asset name")
            names[key] = name
        return names
    return dict(DEFAULT_ASSETS)


def api_get(path: str) -> dict:
    request = urllib.request.Request(
        f"{API}{path}",
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "pi-harness-config-update-obscura-lock",
            **(
                {"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}"}
                if os.environ.get("GITHUB_TOKEN")
                else {}
            ),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        die(f"GitHub API {path} returned HTTP {exc.code}")
    except urllib.error.URLError as exc:
        die(f"GitHub API {path} is unreachable: {exc.reason}")
    except json.JSONDecodeError as exc:
        die(f"GitHub API {path} returned invalid JSON: {exc}")
    raise AssertionError("unreachable")


def resolve_release(repository: str, tag: str | None) -> dict:
    if tag:
        release = api_get(f"/repos/{repository}/releases/tags/{tag}")
    else:
        release = api_get(f"/repos/{repository}/releases/latest")
    if not isinstance(release, dict):
        die("release metadata is not an object")
    return release


def build_assets(release: dict, names: dict[str, str]) -> dict[str, dict[str, str]]:
    if release.get("draft"):
        die("refusing to use a draft release")
    if release.get("prerelease"):
        die("refusing to use a prerelease without --include-prerelease")

    assets = release.get("assets")
    if not isinstance(assets, list):
        die("release metadata has no assets array")

    by_name: dict[str, list[dict]] = {}
    for asset in assets:
        name = asset.get("name")
        if isinstance(name, str):
            by_name.setdefault(name, []).append(asset)

    result: dict[str, dict[str, str]] = {}
    for key, asset_name in sorted(names.items()):
        matches = by_name.get(asset_name, [])
        if not matches:
            die(f"expected asset is missing from the release: {asset_name}")
        if len(matches) > 1:
            die(f"duplicate ambiguous assets named {asset_name} ({len(matches)} copies)")

        digest = matches[0].get("digest")
        if not isinstance(digest, str) or not digest:
            die(f"asset {asset_name} exposes no digest metadata")
        match = SHA256_RE.fullmatch(digest)
        if not match:
            die(f"asset {asset_name} digest is not SHA-256 shaped: {digest!r}")
        result[key] = {"name": asset_name, "sha256": match.group(1)}
    return result


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Update deps/obscura.lock.json from GitHub release metadata."
    )
    parser.add_argument("--write", action="store_true", help="write the updated lock file")
    parser.add_argument("--check", action="store_true", help="report only (default)")
    parser.add_argument("--release", metavar="TAG", help="use a specific release tag")
    parser.add_argument(
        "--include-prerelease",
        action="store_true",
        help="allow a prerelease to be selected",
    )
    parser.add_argument("--repository", default=None, help="override owner/name")
    args = parser.parse_args()

    if args.write and args.check:
        die("--write and --check are mutually exclusive")

    lock = load_lock()
    repository = args.repository or lock.get("repository") or DEFAULT_REPOSITORY
    if not isinstance(repository, str) or "/" not in repository:
        die(f"repository must look like owner/name, got {repository!r}")

    names = expected_assets(lock)
    release = resolve_release(repository, args.release)
    if args.include_prerelease and release.get("prerelease") and args.release is None:
        # only reachable with an explicit tag; keep the guard honest
        pass

    tag = release.get("tag_name")
    if not isinstance(tag, str) or not VERSION_RE.fullmatch(tag):
        die(f"release tag is not vX.Y.Z shaped: {tag!r}")

    if release.get("prerelease") and not args.include_prerelease:
        die(f"{tag} is a prerelease; pass --include-prerelease to allow it")
    if release.get("draft"):
        die(f"{tag} is a draft release")

    assets = build_assets(release, names)

    current_version = lock.get("version")
    current_assets = lock.get("assets") if isinstance(lock.get("assets"), dict) else {}

    print(f"update-obscura-lock: repository {repository}")
    print(f"update-obscura-lock: lock file  {LOCK_PATH}")
    print(f"update-obscura-lock: current    {current_version or '(no lock yet)'}")
    print(f"update-obscura-lock: upstream   {tag} (published {release.get('published_at')})")
    print()

    changes: list[str] = []
    if current_version != tag:
        changes.append(f"version: {current_version or '(none)'} -> {tag}")

    for key in sorted(assets):
        new = assets[key]
        old = current_assets.get(key) if isinstance(current_assets.get(key), dict) else {}
        old_sha = old.get("sha256")
        old_name = old.get("name")
        if old_name != new["name"]:
            changes.append(f"{key}: asset {old_name or '(none)'} -> {new['name']}")
        if old_sha != new["sha256"]:
            changes.append(f"{key}: sha256 {old_sha or '(none)'} -> {new['sha256']}")
        marker = "unchanged" if old_sha == new["sha256"] else "CHANGED"
        print(f"  {key:<14} {new['name']}")
        print(f"      {new['sha256']}  [{marker}]")

    print()
    if not changes:
        print("up to date: no change proposed")
        return 0

    print("proposed changes:")
    for change in changes:
        print(f"  - {change}")

    if not args.write:
        print()
        print("nothing written. Re-run with --write, then review the diff and commit it.")
        return 0

    lock_document = {
        "repository": repository,
        "version": tag,
        "assets": {key: assets[key] for key in sorted(assets)},
    }
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOCK_PATH.write_text(json.dumps(lock_document, indent=2) + "\n", encoding="utf-8")
    print()
    print(f"wrote {LOCK_PATH}")
    print("review the diff and commit it as a normal repository change")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
