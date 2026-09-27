#!/usr/bin/env python3
"""One-shot bridge between the pi laya-routing extension and a local Laya runtime.

Protocol (one JSON document in, one JSON document out):

  request   {"text": "<bounded raw prompt>", "schema": {<laya object schema>}}
  success   {"ok": true, "purpose": "...", "answer_confidence": 0.9,
             "confidence": 0.5, "probabilities": {...}, "package_version": "0.3.20",
             "model": "...", "revision": "..."}
  failure   {"ok": false, "error": "unavailable" | "version_mismatch" | "malformed"
             | "invalid_enum" | "invalid_confidence" | "exception", "detail": "..."}

The bridge is spawned per decision and pins both the `laya` package version and
the model revision from `laya.lock.json` next to this file. `--probe` reports
availability (no network) and `--selftest` runs deterministic checks. The
test-only `LAYA_BRIDGE_TEST_FAKE_JSON` environment variable emits a canned
response without importing Laya; production code never sets it.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
from pathlib import Path

LOCK_PATH = Path(__file__).with_name("laya.lock.json")


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def read_lock() -> dict:
    with LOCK_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def allowed_purposes(schema: object) -> list[str] | None:
    if not isinstance(schema, dict):
        return None
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return None
    purpose = properties.get("purpose")
    if not isinstance(purpose, dict):
        return None
    enum = purpose.get("enum")
    if not isinstance(enum, list) or not all(isinstance(item, str) for item in enum) or len(enum) == 0:
        return None
    return list(enum)


def success_payload(
    purpose: str,
    answer: dict,
    probabilities: dict | None,
    package_version: str,
    model: str,
    revision: str,
) -> dict:
    return {
        "ok": True,
        "purpose": purpose,
        "answer_confidence": answer.get("answer_confidence"),
        "confidence": answer.get("confidence"),
        "probabilities": probabilities,
        "package_version": package_version,
        "model": model,
        "revision": revision,
    }


def classify(request: object, lock: dict) -> dict:
    if not isinstance(request, dict):
        return {"ok": False, "error": "malformed", "detail": "request is not an object"}
    text = request.get("text")
    if not isinstance(text, str) or not text.strip():
        return {"ok": False, "error": "malformed", "detail": "request.text must be a non-empty string"}
    schema = request.get("schema")
    purposes = allowed_purposes(schema)
    if purposes is None:
        return {"ok": False, "error": "malformed", "detail": "request.schema is not a purpose enum schema"}

    package = lock["python_package"]
    model = lock["model"]

    try:
        from importlib.metadata import PackageNotFoundError, version

        try:
            installed = version(package["name"])
        except PackageNotFoundError as exc:
            return {"ok": False, "error": "unavailable", "detail": f"python package {package['name']} is not installed: {exc}"}
        if installed != package["version"]:
            return {
                "ok": False,
                "error": "version_mismatch",
                "detail": f"installed {package['name']} {installed} != pinned {package['version']}",
            }

        import laya  # noqa: PLC0415 - imported only when a decision is requested

        # The model can log to stdout; the protocol must stay one JSON document.
        noise = io.StringIO()
        with contextlib.redirect_stdout(noise):
            agent = laya.load(model["repo"], revision=model["revision"])
            result = agent.decide(text, schema=schema, return_details=True)
    except ImportError as exc:
        return {"ok": False, "error": "unavailable", "detail": f"laya import failed: {exc}"}
    except Exception as exc:  # noqa: BLE001 - any runtime failure fails open
        return {"ok": False, "error": "exception", "detail": f"{type(exc).__name__}: {exc}"}

    values = getattr(result, "values", None)
    answers = getattr(result, "answers", None)
    probabilities = getattr(result, "probabilities", None)
    if not isinstance(values, dict) or not isinstance(answers, dict):
        return {"ok": False, "error": "malformed", "detail": "decide() did not return values/answers"}

    purpose = values.get("purpose")
    if not isinstance(purpose, str) or purpose not in purposes:
        return {"ok": False, "error": "invalid_enum", "detail": f"purpose={purpose!r} not in {purposes}"}

    answer = answers.get("purpose")
    if not isinstance(answer, dict):
        return {"ok": False, "error": "malformed", "detail": "answers.purpose is missing"}

    answer_confidence = answer.get("answer_confidence")
    confidence = answer.get("confidence")
    if not isinstance(answer_confidence, (int, float)) or isinstance(answer_confidence, bool) or not 0 <= float(answer_confidence) <= 1:
        return {"ok": False, "error": "invalid_confidence", "detail": f"answer_confidence={answer_confidence!r}"}
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool):
        confidence = None

    per_field = probabilities.get("purpose") if isinstance(probabilities, dict) else None
    if not isinstance(per_field, dict):
        per_field = None

    return success_payload(purpose, answer, per_field, installed, model["repo"], model["revision"])


def probe(lock: dict) -> dict:
    package = lock["python_package"]
    model = lock["model"]
    result = {
        "ok": True,
        "available": False,
        "compliant": False,
        "package_version": None,
        "model": model["repo"],
        "revision": model["revision"],
        "cached": None,
    }
    try:
        from importlib.metadata import PackageNotFoundError, version

        try:
            result["package_version"] = version(package["name"])
        except PackageNotFoundError:
            result["reason"] = "unavailable"
            return result
    except Exception as exc:  # noqa: BLE001
        result["reason"] = f"unavailable: {exc}"
        return result

    result["compliant"] = result["package_version"] == package["version"]
    result["available"] = bool(result["compliant"])
    if not result["compliant"]:
        result["reason"] = "version_mismatch"
        return result

    try:
        from huggingface_hub import snapshot_download

        snapshot_download(
            model["repo"],
            revision=model["revision"],
            local_files_only=True,
            allow_patterns=["rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*"],
        )
        result["cached"] = True
    except Exception:  # noqa: BLE001 - not cached or hub unavailable offline
        result["cached"] = False
    return result


def selftest(lock: dict) -> dict:
    checks: list[tuple[str, bool]] = []

    checks.append(("lock schema", lock.get("schema") == 1 and lock["python_package"]["version"] and lock["model"]["revision"]))

    schema = {"type": "object", "properties": {"purpose": {"type": "string", "enum": ["none", "local_context", "external_context", "architecture"]}}}
    checks.append(("purpose enum parsed", allowed_purposes(schema) == ["none", "local_context", "external_context", "architecture"]))
    checks.append(("rejects non-purpose schema", allowed_purposes({"type": "object", "properties": {"purpose": {"type": "string"}}}) is None))

    payload = success_payload(
        "local_context",
        {"answer_confidence": 0.91, "confidence": 0.4},
        {"local_context": 0.91},
        "0.3.20",
        "repo",
        "rev",
    )
    checks.append(
        (
            "success payload shape",
            payload["ok"] is True
            and payload["answer_confidence"] == 0.91
            and payload["probabilities"] == {"local_context": 0.91}
            and payload["package_version"] == "0.3.20",
        )
    )
    checks.append(("classify rejects malformed request", classify({"text": "", "schema": schema}, lock)["error"] == "malformed"))

    failures = [name for name, passed in checks if not passed]
    return {"ok": not failures, "checks": len(checks), "failed": failures}


def main(argv: list[str]) -> int:
    fake = os.environ.get("LAYA_BRIDGE_TEST_FAKE_JSON")
    if fake:
        emit(json.loads(fake))
        return 0

    try:
        lock = read_lock()
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": "exception", "detail": f"lock unreadable: {exc}"})
        return 0

    if "--selftest" in argv:
        result = selftest(lock)
        emit(result)
        return 0 if result["ok"] else 1

    if "--probe" in argv:
        emit(probe(lock))
        return 0

    try:
        request = json.loads(sys.stdin.read())
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": "malformed", "detail": f"stdin is not JSON: {exc}"})
        return 0

    emit(classify(request, lock))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
