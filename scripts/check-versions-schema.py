#!/usr/bin/env python3
"""Validate pi/versions.json (schema 1) against the repository contract.

Prints one problem per line and exits 0; check-repo.sh treats any output as a
failure. The section schemas are intentionally separate: package versions are
exact npm versions (prerelease and build metadata allowed), while the Pi,
tool and runtime versions the discovery probes record are plain x.y.z.
"""

import json
import re
import sys

PLAIN_VERSION = re.compile(r"\d+\.\d+\.\d+")
EXACT_VERSION = re.compile(
    r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)"
    r"(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
)
SHA = re.compile(r"[0-9a-f]{40}")
SECRET = re.compile(r"(sk-[A-Za-z0-9]{16,}|gho_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY)")


def validate(path):
    problems = []
    try:
        data = json.load(open(path, encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        return [f"invalid JSON: {exc}"]
    if not isinstance(data, dict):
        return ["top level must be an object"]
    if data.get("schemaVersion") != 1:
        problems.append("schemaVersion must be 1")
    pi = data.get("pi")
    if not isinstance(pi, str) or not PLAIN_VERSION.fullmatch(pi):
        problems.append(f"pi must be a plain x.y.z version, got {pi!r}")
    for section in ("tools", "packages", "git", "runtime"):
        value = data.get(section)
        if not isinstance(value, dict):
            problems.append(f"{section} must be an object")
            continue
        for name, entry in value.items():
            if section == "git":
                if not isinstance(entry, str) or not SHA.fullmatch(entry):
                    problems.append(f"git.{name} must be a full 40-hex SHA")
            elif section == "packages":
                if not isinstance(entry, str) or not EXACT_VERSION.fullmatch(entry):
                    problems.append(f"packages.{name} must be an exact npm version")
            elif not isinstance(entry, str) or not PLAIN_VERSION.fullmatch(entry):
                problems.append(f"{section}.{name} must be a plain x.y.z version")
    text = open(path, encoding="utf-8").read()
    if SECRET.search(text):
        problems.append("looks like secret material")
    return problems


def main():
    if len(sys.argv) != 2:
        print("usage: check-versions-schema.py <versions.json>")
        return 2
    for problem in validate(sys.argv[1]):
        print(problem)
    return 0


if __name__ == "__main__":
    sys.exit(main())
