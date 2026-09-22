#!/usr/bin/env python3
"""Re-apply Pi TUI renderer patches after a Pi update.

Pi's bundled Markdown renderer hardcodes:
  * a literal "```" fence line above and below every code block
  * 1 line per mouse-wheel event (kitty's default multiplier is 5)

This script removes the fence lines and raises the wheel scroll amount.

Contract (this is the point of the script):
  * every required target must exist, otherwise the run FAILS
  * for every required transformation, either the original form is present
    (patch it) or the patched form is already present (nothing to do)
  * anything else FAILS — a pattern that cannot be found is never reported
    as success

It is idempotent: re-running on an already-patched install reports
"already" for every patch and changes nothing.

The bundle chunk filename carries a content hash that changes between Pi
releases, so it is discovered by signature instead of hardcoded: exactly
one chunk may carry a renderer-patch signature. Zero or several is an error.

Usage:  python3 ~/.pi/agent/patch-pi-renderer.py
        PI_CODING_AGENT_DIR=/tmp/fake python3 patch-pi-renderer.py
"""
from __future__ import annotations

import os
import pathlib
import sys
from dataclasses import dataclass

CODING_AGENT_PKG = "@earendil-works/pi-coding-agent"
TUI_PKG = "@earendil-works/pi-tui"


@dataclass(frozen=True)
class Patch:
    """One required transformation.

    old     exact pre-patch text
    new     exact post-patch text ("" means the text must simply disappear)
    anchor  context that must exist in BOTH states; it proves the file is
            still the file we think we are patching, which is what makes an
            already-applied removal distinguishable from an upstream change
    """

    name: str
    old: str
    new: str
    anchor: str


BUNDLE_PATCHES = [
    Patch(
        name="bundle-code-fence-lang",
        old=(
            'case"code":{let indent=this.theme.codeBlockIndent??"  ";'
            'if(lines.push(this.theme.codeBlockBorder(`\\`\\`\\`${token.lang||""}`)),this.theme.highlightCode){'
        ),
        new='case"code":{let indent=this.theme.codeBlockIndent??"  ";if(this.theme.highlightCode){',
        anchor='case"code":{let indent=this.theme.codeBlockIndent??"  ";',
    ),
    Patch(
        name="bundle-code-fence-close",
        old=(
            'lines.push(this.theme.codeBlockBorder("```")),nextTokenType&&nextTokenType!=="space"&&lines.push("");'
            'break}case"list":{'
        ),
        new='nextTokenType&&nextTokenType!=="space"&&lines.push("");break}case"list":{',
        anchor='nextTokenType&&nextTokenType!=="space"&&lines.push("");break}case"list":{',
    ),
    Patch(
        name="bundle-wheel-scroll",
        old="this.wheelScrollLines=Math.max(1,Math.floor(options.wheelScrollLines??1))",
        new="this.wheelScrollLines=Math.max(1,Math.floor(options.wheelScrollLines??5))",
        anchor="this.wheelScrollLines=Math.max(1,Math.floor(options.wheelScrollLines",
    ),
]

TUI_PATCHES = [
    Patch(
        name="tui-code-fence-lang",
        old='                lines.push(this.theme.codeBlockBorder(`\\`\\`\\`${token.lang || ""}`));\n',
        new="",
        anchor='const indent = this.theme.codeBlockIndent ?? "  ";',
    ),
    Patch(
        name="tui-code-fence-plain",
        old='                lines.push(this.theme.codeBlockBorder("```"));\n',
        new="",
        anchor='const indent = this.theme.codeBlockIndent ?? "  ";',
    ),
]

# Any of these strings identifies the bundle chunk that carries the renderer
# patches, in either its original or its patched form.
BUNDLE_SIGNATURES = tuple(
    dict.fromkeys(
        [patch.old for patch in BUNDLE_PATCHES]
        + [patch.new for patch in BUNDLE_PATCHES if patch.new]
    )
)

PATCHED = "patched"
ALREADY = "already"
FAILED = "failed"


def apply_patch(path: pathlib.Path, patch: Patch) -> tuple[str, str]:
    """Apply one required transformation. Returns (status, detail)."""
    text = path.read_text(encoding="utf-8")

    if patch.old in text:
        occurrences = text.count(patch.old)
        updated = text.replace(patch.old, patch.new)
        if patch.old in updated:
            return FAILED, "replacement did not remove the original form"
        path.write_text(updated, encoding="utf-8")
        return PATCHED, f"{occurrences} occurrence(s)"

    if patch.new and patch.new in text:
        return ALREADY, "patched form already present"

    if not patch.new and patch.anchor and patch.anchor in text:
        return ALREADY, "removal already applied"

    return FAILED, "neither the original nor the patched form is present"


def discover_bundle_chunk(chunks_dir: pathlib.Path) -> tuple[pathlib.Path | None, str]:
    """Find the single bundle chunk carrying a renderer-patch signature."""
    if not chunks_dir.is_dir():
        return None, f"chunk directory not found: {chunks_dir}"

    candidates: list[pathlib.Path] = []
    for candidate in sorted(chunks_dir.glob("*.js")):
        try:
            text = candidate.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if any(signature in text for signature in BUNDLE_SIGNATURES):
            candidates.append(candidate)

    if len(candidates) == 1:
        return candidates[0], ""
    if not candidates:
        return None, f"no chunk under {chunks_dir} carries a renderer-patch signature"
    names = ", ".join(sorted(c.name for c in candidates))
    return None, f"ambiguous: {len(candidates)} chunks carry a renderer-patch signature: {names}"


def run_group(
    path: pathlib.Path,
    patches: list[Patch],
    results: list[tuple[str, str, str, str]],
) -> None:
    for patch in patches:
        try:
            status, detail = apply_patch(path, patch)
        except OSError as exc:
            status, detail = FAILED, f"cannot read/write {path}: {exc}"
        results.append((status, patch.name, str(path), detail))


def main() -> int:
    agent_dir = pathlib.Path(
        os.environ.get("PI_CODING_AGENT_DIR") or (pathlib.Path.home() / ".pi" / "agent")
    )

    version_file = agent_dir / "install" / "current-version"
    if not version_file.is_file():
        print(f"error: cannot find {version_file}", file=sys.stderr)
        return 1
    version = version_file.read_text(encoding="utf-8").strip()
    if not version:
        print(f"error: {version_file} is empty", file=sys.stderr)
        return 1

    release = agent_dir / "install" / "releases" / version
    if not release.is_dir():
        print(f"error: release directory not found: {release}", file=sys.stderr)
        return 1

    print(f"patching Pi {version} under {release}")

    results: list[tuple[str, str, str, str]] = []
    failures: list[str] = []

    # --- bundle chunk (discovered by signature, never hardcoded) -----------
    chunks_dir = release / "node_modules" / CODING_AGENT_PKG / "dist" / "bundle" / "chunks"
    chunk, why = discover_bundle_chunk(chunks_dir)
    if chunk is None:
        failures.append(f"bundle chunk: {why}")
    else:
        run_group(chunk, BUNDLE_PATCHES, results)

    # --- TUI markdown renderer (fixed package path, must exist) -----------
    tui_markdown = release / "node_modules" / TUI_PKG / "dist" / "components" / "markdown.js"
    if not tui_markdown.is_file():
        failures.append(f"required target missing: {tui_markdown}")
    else:
        run_group(tui_markdown, TUI_PATCHES, results)

    # --- report -----------------------------------------------------------
    width = max((len(name) for _, name, _, _ in results), default=0)
    for status, name, path, detail in results:
        location = pathlib.Path(path).name
        print(f"{status:<8} {name:<{width}}  {location}  ({detail})")

    for failure in failures:
        print(f"ERROR: {failure}", file=sys.stderr)

    failed = [r for r in results if r[0] == FAILED]
    for _, name, path, detail in failed:
        print(f"ERROR: {name}: {detail} [{path}]", file=sys.stderr)

    if failures or failed:
        print(
            f"error: {len(failures) + len(failed)} required renderer patch(es) could not be proven",
            file=sys.stderr,
        )
        return 1

    patched = sum(1 for r in results if r[0] == PATCHED)
    already = sum(1 for r in results if r[0] == ALREADY)
    print(f"ok: {patched} patched, {already} already patched, 0 unprovable")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
