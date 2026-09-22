#!/usr/bin/env python3
"""Re-apply Pi TUI renderer patches after a Pi update.

Pi's bundled Markdown renderer hardcodes:
  * a literal "```" fence line above and below every code block
  * 1 line per mouse-wheel event (kitty's default multiplier is 5)

This script removes the fence lines and raises the wheel scroll amount.
It is idempotent: re-running on an already-patched install reports "already patched".

Usage:  python3 ~/.pi/agent/patch-pi-renderer.py
"""
from __future__ import annotations

import pathlib
import sys

AGENT_DIR = pathlib.Path.home() / ".pi" / "agent"

BUNDLE_PATCHES = [
    (
        'case"code":{let indent=this.theme.codeBlockIndent??"  ";'
        'if(lines.push(this.theme.codeBlockBorder(`\\`\\`\\`${token.lang||""}`)),this.theme.highlightCode){',
        'case"code":{let indent=this.theme.codeBlockIndent??"  ";if(this.theme.highlightCode){',
    ),
    (
        'lines.push(this.theme.codeBlockBorder("```")),nextTokenType&&nextTokenType!=="space"&&lines.push("");break}case"list":{',
        'nextTokenType&&nextTokenType!=="space"&&lines.push("");break}case"list":{',
    ),
    (
        "this.wheelScrollLines=Math.max(1,Math.floor(options.wheelScrollLines??1))",
        "this.wheelScrollLines=Math.max(1,Math.floor(options.wheelScrollLines??5))",
    ),
]

TUI_PATCHES = [
    (
        '                lines.push(this.theme.codeBlockBorder(`\\`\\`\\`${token.lang || ""}`));\n',
        "",
    ),
    (
        '                lines.push(this.theme.codeBlockBorder("```"));\n',
        "",
    ),
]


def patch(path: pathlib.Path, pairs: list[tuple[str, str]]) -> None:
    if not path.exists():
        print(f"skip (missing): {path}")
        return
    text = path.read_text(encoding="utf-8")
    changed = 0
    already = 0
    for old, new in pairs:
        if old in text:
            text = text.replace(old, new, 1)
            changed += 1
        elif new in text:
            already += 1
        else:
            print(f"WARN: pattern not found in {path.name}: {old[:70]!r}")
    if changed:
        path.write_text(text, encoding="utf-8")
        print(f"patched {changed} pattern(s): {path}")
    else:
        print(f"already patched ({already}/{len(pairs)}): {path}")


def main() -> int:
    version_file = AGENT_DIR / "install" / "current-version"
    if not version_file.exists():
        print(f"error: cannot find {version_file}", file=sys.stderr)
        return 1
    version = version_file.read_text(encoding="utf-8").strip()
    release = AGENT_DIR / "install" / "releases" / version
    print(f"patching Pi {version} under {release}")
    patch(
        release / "node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-4DKZACXI.js",
        BUNDLE_PATCHES,
    )
    patch(release / "node_modules/@earendil-works/pi-tui/dist/components/markdown.js", TUI_PATCHES)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
