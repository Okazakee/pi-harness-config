#!/usr/bin/env python3
"""Manual checkpoint evaluation for the Laya delegation advisor.

This is repository tooling, not CI: it downloads the pinned model bundle and
runs real inference to choose the English and Italian-capable checkpoints
recorded in pi/extensions/laya-routing/laya.lock.json. It never records or
prints prompt content beyond the synthetic fixture.

Usage:
  ~/.local/share/pi-laya/venv/bin/python scripts/laya-routing-eval.py \
      [--fixture scripts/laya-routing-fixture.json] \
      [--json /tmp/laya-eval.json] \
      [--candidates english-base,english-typed-decisions,multilingual]

Requires: a python environment with laya==0.3.20 (see docs/reproducibility.md)
and network access on first run (the model snapshot is cached afterwards).
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = REPO_ROOT / "pi" / "extensions" / "laya-routing" / "laya.lock.json"
DEFAULT_FIXTURE = Path(__file__).resolve().with_name("laya-routing-fixture.json")

# Mirrors routing.ts PURPOSE_SCHEMA: the classifier speaks purposes, never agent names.
SCHEMA = {
    "type": "object",
    "properties": {
        "purpose": {
            "type": "string",
            "enum": ["none", "local_context", "external_context", "architecture"],
            "description": (
                "Which auxiliary context, if any, would materially help before this request is completed? "
                "none: the request is self-contained and can be handled directly. "
                "local_context: reading or searching this repository's own files would materially help. "
                "external_context: current documentation, library or API behavior, or web lookup is needed that cannot be answered from the repository alone. "
                "architecture: the request needs systemic design, cross-layer analysis, or blast-radius reasoning."
            ),
        }
    },
}

CANDIDATES: dict[str, str | None] = {
    "english-base": None,
    "english-typed-decisions": "typed-decisions",
    "multilingual": "multilingual",
}


def load_lock() -> dict:
    with LOCK_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def snapshot_root(repo: str, revision: str) -> str:
    from huggingface_hub import snapshot_download

    return snapshot_download(
        repo,
        revision=revision,
        allow_patterns=[
            "rl_agent_config.json",
            "model.safetensors",
            "tokenizer/*",
            "encoder/*",
            "multilingual/*",
            "typed-decisions/*",
        ],
    )


def evaluate(candidate: str, subfolder: str | None, root: str, fixture: dict) -> dict:
    import laya

    started = time.perf_counter()
    agent = laya.load(root, subfolder=subfolder)
    load_ms = round((time.perf_counter() - started) * 1000)

    results: list[dict] = []
    for item in fixture["items"]:
        detection = laya.detect_language(item["text"])
        started = time.perf_counter()
        decision = agent.decide(item["text"], schema=SCHEMA, return_details=True)
        latency_ms = round((time.perf_counter() - started) * 1000)
        answer = decision.answers.get("purpose", {})
        results.append(
            {
                "id": item["id"],
                "lang": item["lang"],
                "category": item["category"],
                "expect": item["expect"],
                "purpose": decision.values.get("purpose"),
                "answer_confidence": answer.get("answer_confidence"),
                "latency_ms": latency_ms,
                "detected_language": detection.get("language"),
                "is_english": detection.get("is_english"),
                "script": detection.get("script"),
            }
        )

    def accuracy(items: list[dict]) -> dict:
        classified = [r for r in items if r["expect"] != "bypass"]
        correct = [r for r in classified if r["purpose"] == r["expect"]]
        lowinfo = [r for r in items if r["expect"] == "bypass"]
        return {
            "classified": len(classified),
            "correct": len(correct),
            "accuracy": round(len(correct) / len(classified), 4) if classified else None,
            "lowinfo_answered_none": sum(1 for r in lowinfo if r["purpose"] == "none"),
            "lowinfo_total": len(lowinfo),
        }

    by_category = {
        category: accuracy([r for r in results if r["category"] == category]) for category in sorted({r["category"] for r in results})
    }
    return {
        "candidate": candidate,
        "subfolder": subfolder,
        "load_ms": load_ms,
        "overall": accuracy(results),
        "english": accuracy([r for r in results if r["lang"] == "en"]),
        "italian": accuracy([r for r in results if r["lang"] == "it"]),
        "by_category": by_category,
        "latency_ms": {
            "median": round(statistics.median([r["latency_ms"] for r in results])),
            "min": min(r["latency_ms"] for r in results),
            "max": max(r["latency_ms"] for r in results),
        },
        "language_routing": {
            "english_items_routed_en": sum(1 for r in results if r["lang"] == "en" and r["is_english"]),
            "english_items": sum(1 for r in results if r["lang"] == "en"),
            "italian_items_routed_multilingual": sum(1 for r in results if r["lang"] == "it" and not r["is_english"]),
            "italian_items": sum(1 for r in results if r["lang"] == "it"),
        },
        "results": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE)
    parser.add_argument("--json", type=Path, default=None, help="write the full report here")
    parser.add_argument("--candidates", default=",".join(CANDIDATES), help="comma-separated candidate ids")
    args = parser.parse_args()

    lock = load_lock()
    fixture = json.loads(args.fixture.read_text(encoding="utf-8"))

    print(f"lock: {LOCK_PATH}")
    print(f"repo: {lock['model']['repo']}@ {lock['model']['revision'][:12]}")
    print(f"fixture: {len(fixture['items'])} prompts")
    root = snapshot_root(lock["model"]["repo"], lock["model"]["revision"])
    print(f"snapshot: {root}\n")

    report = []
    for candidate in args.candidates.split(","):
        if candidate not in CANDIDATES:
            print(f"unknown candidate: {candidate}", file=sys.stderr)
            return 2
        print(f"=== {candidate} (subfolder={CANDIDATES[candidate] or '-'}) ===")
        result = evaluate(candidate, CANDIDATES[candidate], root, fixture)
        report.append(result)
        print(
            f"load {result['load_ms']} ms | accuracy {result['overall']['accuracy']} "
            f"(en {result['english']['accuracy']}, it {result['italian']['accuracy']}) "
            f"| median decision {result['latency_ms']['median']} ms"
        )
        for category, stats in result["by_category"].items():
            print(f"  {category:16s} accuracy={stats['accuracy']} ({stats['correct']}/{stats['classified']})")
        routing = result["language_routing"]
        print(
            f"  language routing: en->english {routing['english_items_routed_en']}/{routing['english_items']}, "
            f"it->multilingual {routing['italian_items_routed_multilingual']}/{routing['italian_items']}"
        )
        print()

    if args.json:
        args.json.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"full report: {args.json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
