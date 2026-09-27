#!/usr/bin/env python3
"""Shared warm Laya service for the pi laya-routing extension.

One daemon per Linux user, started by the first root Pi that needs it. It owns
a user-private Unix socket, loads both checkpoints once, and serves every Pi
instance that connects. The connection itself is the lease: clients count the
open sockets, the last disconnect arms the shutdown grace timer, and a
reconnect cancels it. No heartbeats, no leases, no renewal protocol.

Protocol: newline-delimited JSON over a private Unix socket.

  client -> {"type": "hello", "protocol": 1, "client": {"pid": N, "session": "..."}}
  daemon -> {"type": "welcome", "protocol": 1, "daemon_id": "...", "pid": N,
             "state": "loading"|"ready"|"degraded", "grace_ms": N,
             "checkpoints": [...], "runtime": {"package_version": "...",
             "checkpoints": {"<id>": {"repo": "...", "revision": "..."}}}}
  client -> {"type": "classify", "id": "...", "text": "...", "schema": {...}}
  daemon -> {"type": "result", "id": "...", "ok": true, "language": "en"|"it"|...,
             "checkpoint": "<id>", "purpose": "...", "answer_confidence": 0.9,
             "confidence": 0.5, "probabilities": {...}, "latency_ms": 123}
  daemon -> {"type": "result", "id": "...", "ok": false, "error": "...", "detail": "..."}
  client -> {"type": "status"}
  daemon -> {"type": "status", ...}
  client -> {"type": "bye"}

Everything fails open: startup, loading, inference and integrity problems are
reported in payloads (and the log), never by blocking Pi. Runtime files (socket,
lock, pid, log) live under $XDG_RUNTIME_DIR/pi-laya and are never backed up.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import socket
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path

LOCK_PATH = Path(__file__).with_name("laya.lock.json")
PROTOCOL_VERSION = 1
MAX_LINE_BYTES = 262_144

# Tiny deterministic Italian markers for the fallback router. Production uses
# Laya's own `detect_language`; this exists so the lifecycle tests and a
# Laya-less host still route deterministically, and it always defaults to
# English when the signal is weak.
ITALIAN_MARKERS = {
    "il", "lo", "la", "gli", "le", "un", "uno", "una", "di", "del", "della", "dei", "delle",
    "che", "non", "per", "con", "come", "cosa", "dove", "quale", "quali", "quando", "perche", "perché",
    "questo", "questa", "questi", "queste", "sono", "essere", "fare", "fallo", "vai", "continua",
    "certo", "anche", "molto", "tutto", "tutti", "senza", "dagli", "dallo", "nell", "sulla",
    "dovremmo", "puoi", "puo", "può", "migliore", "nuovo", "nuova", "solo", "gia", "già",
}
ITALIAN_MARKER_FLOOR = 2

# Low-information acknowledgements never reach the classifier: without the
# conversation transcript they cannot be classified meaningfully. The list is
# deliberately small; a real prompt slipping through is fine.
LOW_INFORMATION_PHRASES = {
    "yes", "yeah", "yep", "y", "ok", "okay", "k", "sure", "continue", "go ahead", "go on",
    "do it", "proceed", "please do", "sounds good", "fine", "si", "sì", "va bene", "certo",
    "continua", "vai", "vai avanti", "fallo", "procedi", "d'accordo", "perfetto",
}


def is_low_information(text: str) -> bool:
    """Small deterministic bypass mirroring the extension-side heuristic."""
    words = re.findall(r"[a-zàèéìòù']+", text.lower())
    if not words or len(words) > 3:
        return False
    return " ".join(words) in LOW_INFORMATION_PHRASES or all(word in LOW_INFORMATION_PHRASES for word in words)


def now_ms() -> int:
    return int(time.time() * 1000)


class Log:
    """Append-only runtime log; also mirrored to stderr in the foreground."""

    def __init__(self, path: Path, foreground: bool):
        self.path = path
        self.foreground = foreground
        self.lock = threading.Lock()

    def line(self, message: str) -> None:
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())
        entry = f"{stamp} {message}\n"
        with self.lock:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with self.path.open("a", encoding="utf-8") as handle:
                    handle.write(entry)
            except OSError:
                pass
        if self.foreground:
            sys.stderr.write(entry)
            sys.stderr.flush()


def runtime_dir_path(env: dict[str, str]) -> Path:
    override = env.get("LAYA_ROUTING_RUNTIME_DIR")
    if override:
        return Path(override)
    if env.get("XDG_RUNTIME_DIR"):
        return Path(env["XDG_RUNTIME_DIR"]) / "pi-laya"
    return Path(tempfile.gettempdir()) / f"pi-laya-{os.getuid()}"


def resolve_runtime_dir(env: dict[str, str]) -> Path:
    base = runtime_dir_path(env)
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    stat = base.stat()
    if stat.st_uid != os.getuid():
        raise SystemExit(f"laya daemon: runtime dir not owned by uid {os.getuid()}: {base}")
    if stat.st_mode & 0o077:
        os.chmod(base, 0o700)
    return base


class LayaLanguageRouter:
    """Language routing through Laya's own detector (no extra model)."""

    kind = "laya"

    def detect(self, text: str) -> dict:
        import laya

        detection = laya.detect_language(text)
        language = detection.get("language")
        is_english = bool(detection.get("is_english"))
        return {
            "language": language or ("en" if is_english else None),
            "is_english": is_english,
            "script": detection.get("script"),
        }


class HeuristicLanguageRouter:
    """Deterministic fallback used by tests and Laya-less hosts."""

    kind = "heuristic"

    def detect(self, text: str) -> dict:
        words = re.findall(r"[a-zàèéìòù]+", text.lower())
        score = sum(1 for word in words if word in ITALIAN_MARKERS)
        if score >= ITALIAN_MARKER_FLOOR:
            return {"language": "it", "is_english": False, "script": "latin"}
        return {"language": "en", "is_english": True, "script": "latin"}


def select_language_router(kind: str) -> object:
    if kind == "heuristic":
        return HeuristicLanguageRouter()
    if kind == "laya":
        return LayaLanguageRouter()
    try:
        import laya  # noqa: F401

        return LayaLanguageRouter()
    except Exception:
        return HeuristicLanguageRouter()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class FakeAgent:
    """Deterministic backend for lifecycle tests; never loads a model."""

    def __init__(self, checkpoint: str):
        self.checkpoint = checkpoint

    def decide(self, text: str, schema: dict, return_details: bool = True):
        upper = text.upper()
        if "LOCAL" in upper:
            purpose = "local_context"
        elif "EXTERNAL" in upper:
            purpose = "external_context"
        elif "ARCH" in upper:
            purpose = "architecture"
        else:
            purpose = "none"
        return {
            "values": {"purpose": purpose},
            "answers": {"purpose": {"type": "choice", "choice": purpose, "confidence": 0.5, "answer_confidence": 0.95}},
            "probabilities": {"purpose": {purpose: 0.95}},
            "checkpoint": self.checkpoint,
        }


class ModelPool:
    """Loads and owns the resident checkpoints; loads once, in the background."""

    def __init__(self, lock: dict, backend: str, log: Log, router: object):
        self.lock = lock
        self.backend = backend
        self.log = log
        self.router = router
        self.state = "loading"
        self.error: dict | None = None
        self.agents: dict[str, object] = {}
        self.english_id = "english"
        self.multilingual_id = "multilingual"
        self.loaded_ms: dict[str, int] = {}
        self.package_version: str | None = None
        self.ready = threading.Event()

    def checkpoints(self) -> list[dict]:
        entries = []
        for checkpoint_id, meta in self.lock["checkpoints"].items():
            entries.append(
                {
                    "id": checkpoint_id,
                    "role": meta.get("role"),
                    "repo": self.lock["model"]["repo"],
                    "subfolder": meta.get("subfolder"),
                    "revision": self.lock["model"]["revision"],
                }
            )
        return entries

    def start(self) -> None:
        threading.Thread(target=self._load, name="laya-model-load", daemon=True).start()

    def _load(self) -> None:
        try:
            if self.backend == "fake":
                self.agents[self.english_id] = FakeAgent(self.english_id)
                self.agents[self.multilingual_id] = FakeAgent(self.multilingual_id)
                self.state = "ready"
                self.ready.set()
                self.log.line("backend=fake ready")
                return

            from importlib.metadata import version

            self.package_version = version("laya")
            pinned = self.lock["python_package"]["version"]
            if self.package_version != pinned:
                self._degrade("version_mismatch", f"installed laya {self.package_version} != pinned {pinned}")
                return

            import laya

            started = time.perf_counter()
            root = self._snapshot_root()
            self.log.line(f"snapshot ready in {round((time.perf_counter() - started) * 1000)} ms: {root}")

            for checkpoint_id, meta in self.lock["checkpoints"].items():
                started = time.perf_counter()
                self._verify_checkpoint(root, meta, checkpoint_id)
                subfolder = meta.get("subfolder")
                self.agents[checkpoint_id] = laya.load(root, subfolder=subfolder)
                self.loaded_ms[checkpoint_id] = round((time.perf_counter() - started) * 1000)
                self.log.line(f"checkpoint {checkpoint_id} loaded in {self.loaded_ms[checkpoint_id]} ms")

            self.state = "ready"
            self.ready.set()
            self.log.line("state=ready")
        except Exception as exc:  # noqa: BLE001 - startup must never kill the daemon
            self._degrade("unavailable", f"{type(exc).__name__}: {exc}")
            self.log.line(f"load failed: {traceback.format_exc()}")

    def _degrade(self, reason: str, detail: str) -> None:
        self.state = "degraded"
        self.error = {"error": reason, "detail": detail}
        self.ready.set()
        self.log.line(f"state=degraded {reason}: {detail}")

    def _snapshot_root(self) -> str:
        from huggingface_hub import snapshot_download

        model = self.lock["model"]
        return snapshot_download(
            model["repo"],
            revision=model["revision"],
            allow_patterns=model.get("allow_patterns"),
        )

    def _verify_checkpoint(self, root: str, meta: dict, checkpoint_id: str) -> None:
        expected = meta.get("sha256")
        if not expected:
            return
        path = Path(root) / meta["file"]
        if not path.is_file():
            raise FileNotFoundError(f"{checkpoint_id}: {path} missing from the pinned snapshot")
        actual = file_sha256(path)
        if actual != expected:
            raise ValueError(f"{checkpoint_id}: sha256 {actual} != pinned {expected}")
        self.log.line(f"checkpoint {checkpoint_id} integrity ok ({path.name})")

    def failure(self) -> dict | None:
        return self.error

    def decide(self, text: str, schema: dict) -> dict:
        if self.state != "ready":
            return {"ok": False, "error": self.state, "detail": (self.error or {}).get("detail", "models are not ready")}
        detection = self.router.detect(text)
        checkpoint_id = self.english_id if detection["is_english"] else self.multilingual_id
        agent = self.agents.get(checkpoint_id)
        if agent is None:
            return {"ok": False, "error": "unavailable", "detail": f"checkpoint {checkpoint_id} is not loaded"}
        started = time.perf_counter()
        result = agent.decide(text, schema=schema, return_details=True)
        latency_ms = round((time.perf_counter() - started) * 1000)
        if isinstance(result, dict):
            values = result.get("values") or {}
            answers = result.get("answers") or {}
            probabilities = result.get("probabilities") or {}
        else:
            values = getattr(result, "values", None) or {}
            answers = getattr(result, "answers", None) or {}
            probabilities = getattr(result, "probabilities", None) or {}
        purpose = values.get("purpose")
        allowed = schema.get("properties", {}).get("purpose", {}).get("enum", [])
        if purpose not in allowed:
            return {"ok": False, "error": "invalid_enum", "detail": f"purpose={purpose!r}"}
        answer = answers.get("purpose") or {}
        answer_confidence = answer.get("answer_confidence")
        if not isinstance(answer_confidence, (int, float)) or isinstance(answer_confidence, bool) or not 0 <= float(answer_confidence) <= 1:
            return {"ok": False, "error": "invalid_confidence", "detail": f"answer_confidence={answer_confidence!r}"}
        confidence = answer.get("confidence")
        per_field = (probabilities or {}).get("purpose")
        return {
            "ok": True,
            "language": detection.get("language"),
            "is_english": detection.get("is_english"),
            "checkpoint": checkpoint_id,
            "purpose": purpose,
            "answer_confidence": float(answer_confidence),
            "confidence": float(confidence) if isinstance(confidence, (int, float)) and not isinstance(confidence, bool) else None,
            "probabilities": per_field if isinstance(per_field, dict) else None,
            "latency_ms": latency_ms,
        }


class Daemon:
    def __init__(self, args: argparse.Namespace):
        self.env = dict(os.environ)
        self.runtime_dir = resolve_runtime_dir(self.env)
        self.socket_path = self.runtime_dir / "laya.sock"
        self.lock_path = self.runtime_dir / "laya.lock"
        self.pid_path = self.runtime_dir / "laya.pid"
        self.log = Log(self.runtime_dir / "laya.log", foreground=args.foreground)
        self.grace_ms = args.grace_ms
        self.daemon_id = f"{os.getpid()}-{now_ms()}"
        self.started_at = now_ms()
        self.server: socket.socket | None = None
        self.clients: dict[socket.socket, dict] = {}
        self.state_lock = threading.Lock()
        self.inference_lock = threading.Lock()
        self.grace_timer: threading.Timer | None = None
        self.grace_deadline_ms: int | None = None
        self.stopping = False
        self.last: dict | None = None
        self.lock_handle = None
        self.router = select_language_router(args.language_router)
        with LOCK_PATH.open(encoding="utf-8") as handle:
            self.lock = json.load(handle)
        self.pool = ModelPool(self.lock, args.backend, self.log, self.router)

    # ── startup ─────────────────────────────────────────────────────────────

    def acquire_singleton(self) -> bool:
        self.lock_handle = self.lock_path.open("w", encoding="utf-8")
        try:
            fcntl.flock(self.lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return False
        self.lock_handle.write(str(os.getpid()))
        self.lock_handle.flush()
        return True

    def bind(self) -> None:
        # Safe: we hold the singleton lock, so any existing socket is stale.
        if self.socket_path.exists() or self.socket_path.is_socket():
            self.socket_path.unlink()
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(self.socket_path))
        os.chmod(self.socket_path, 0o600)
        server.listen(16)
        # A bounded accept timeout lets a timer-thread stop() unblock the loop;
        # closing a socket does not reliably wake a blocked accept() on Linux.
        server.settimeout(0.2)
        self.server = server

    # ── lifecycle ───────────────────────────────────────────────────────────

    def run(self) -> int:
        if not self.acquire_singleton():
            self.log.line("singleton lock held by another daemon; exiting")
            return 0
        self.bind()
        self.pid_path.write_text(str(os.getpid()), encoding="utf-8")
        self.log.line(
            f"daemon {self.daemon_id} listening pid={os.getpid()} socket={self.socket_path} "
            f"grace={self.grace_ms}ms router={getattr(self.router, 'kind', '?')} backend={self.pool.backend}"
        )
        self.pool.start()
        # A freshly spawned daemon whose client died before connecting must not
        # linger: arm the grace timer until the first client registers.
        with self.state_lock:
            self.arm_grace_locked()
        try:
            while not self.stopping:
                try:
                    connection, _ = self.server.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break
                threading.Thread(target=self.handle_client, args=(connection,), name="laya-client", daemon=True).start()
        finally:
            self.cleanup()
        return 0

    def handle_client(self, connection: socket.socket) -> None:
        with self.state_lock:
            self.clients[connection] = {"pid": None, "session": None, "connected_at": now_ms()}
            self.cancel_grace_locked()
        self.log.line(f"client connected (clients={len(self.clients)})")
        buffer = b""
        try:
            while not self.stopping:
                chunk = connection.recv(65536)
                if not chunk:
                    break
                buffer += chunk
                if len(buffer) > MAX_LINE_BYTES:
                    break
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if line.strip():
                        self.handle_message(connection, line)
        except OSError:
            pass
        finally:
            try:
                connection.close()
            except OSError:
                pass
            with self.state_lock:
                self.clients.pop(connection, None)
                remaining = len(self.clients)
                if remaining == 0:
                    self.arm_grace_locked()
            self.log.line(f"client disconnected (clients={remaining})")

    def handle_message(self, connection: socket.socket, line: bytes) -> None:
        try:
            message = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send(connection, {"type": "error", "error": "malformed", "detail": "invalid JSON line"})
            return
        if not isinstance(message, dict):
            self.send(connection, {"type": "error", "error": "malformed", "detail": "message is not an object"})
            return

        kind = message.get("type")
        if kind == "hello":
            client = message.get("client") if isinstance(message.get("client"), dict) else {}
            with self.state_lock:
                if connection in self.clients:
                    self.clients[connection]["pid"] = client.get("pid")
                    self.clients[connection]["session"] = client.get("session")
            self.send(
                connection,
                {
                    "type": "welcome",
                    "protocol": PROTOCOL_VERSION,
                    "daemon_id": self.daemon_id,
                    "pid": os.getpid(),
                    "state": self.pool.state,
                    "grace_ms": self.grace_ms,
                    "checkpoints": self.pool.checkpoints(),
                    "runtime": {
                        "package_version": self.pool.package_version or self.lock["python_package"]["version"],
                        "repo": self.lock["model"]["repo"],
                        "revision": self.lock["model"]["revision"],
                        "checkpoints": {
                            checkpoint_id: {"role": meta.get("role"), "subfolder": meta.get("subfolder")}
                            for checkpoint_id, meta in self.lock["checkpoints"].items()
                        },
                    },
                },
            )
        elif kind == "classify":
            request_id = message.get("id")
            text = message.get("text")
            schema = message.get("schema")
            if not isinstance(request_id, str) or not isinstance(text, str) or not isinstance(schema, dict):
                self.send(connection, {"type": "result", "id": request_id, "ok": False, "error": "malformed"})
                return
            try:
                with self.inference_lock:
                    result = self.pool.decide(text, schema)
            except Exception as exc:  # noqa: BLE001 - one bad request must not kill the daemon
                result = {"ok": False, "error": "exception", "detail": f"{type(exc).__name__}: {exc}"}
            if result.get("ok"):
                self.last = {
                    "at": now_ms(),
                    "language": result.get("language"),
                    "checkpoint": result.get("checkpoint"),
                    "purpose": result.get("purpose"),
                    "answer_confidence": result.get("answer_confidence"),
                    "latency_ms": result.get("latency_ms"),
                }
            else:
                self.last = {"at": now_ms(), "error": result.get("error"), "detail": result.get("detail")}
            self.send(connection, {"type": "result", "id": request_id, **result})
        elif kind == "status":
            self.send(connection, {**self.status_payload(), "id": message.get("id")})
        elif kind == "bye":
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        else:
            self.send(connection, {"type": "error", "error": "malformed", "detail": f"unknown type {kind!r}"})

    def send(self, connection: socket.socket, payload: dict) -> None:
        try:
            connection.sendall((json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8"))
        except OSError:
            pass

    def status_payload(self) -> dict:
        with self.state_lock:
            clients = [
                {"pid": meta.get("pid"), "session": meta.get("session"), "connected_at": meta.get("connected_at")}
                for meta in self.clients.values()
            ]
            grace_deadline = self.grace_deadline_ms
            grace_pending = self.grace_timer is not None and grace_deadline is not None
        return {
            "type": "status",
            "daemon_id": self.daemon_id,
            "pid": os.getpid(),
            "uptime_ms": now_ms() - self.started_at,
            "state": self.pool.state,
            "clients": clients,
            "client_count": len(clients),
            "grace": {
                "pending": grace_pending,
                "grace_ms": self.grace_ms,
                "remaining_ms": max(0, (grace_deadline - now_ms())) if grace_pending and grace_deadline else None,
            },
            "router": getattr(self.router, "kind", "?"),
            "backend": self.pool.backend,
            "checkpoints": self.pool.checkpoints(),
            "loaded_ms": self.pool.loaded_ms,
            "package_version": self.pool.package_version,
            "error": self.pool.failure(),
            "last": self.last,
            "socket": str(self.socket_path),
        }

    def arm_grace_locked(self) -> None:
        self.cancel_grace_locked()
        self.grace_deadline_ms = now_ms() + self.grace_ms
        self.grace_timer = threading.Timer(self.grace_ms / 1000.0, self.stop_from_grace)
        self.grace_timer.daemon = True
        self.grace_timer.start()
        self.log.line(f"grace armed: {self.grace_ms} ms")

    def cancel_grace_locked(self) -> None:
        if self.grace_timer is not None:
            self.grace_timer.cancel()
            self.log.line("grace cancelled")
        self.grace_timer = None
        self.grace_deadline_ms = None

    def stop_from_grace(self) -> None:
        self.log.line("grace expired with no clients; exiting")
        self.stop()

    def stop(self) -> None:
        self.stopping = True
        with self.state_lock:
            self.cancel_grace_locked()
        for connection in list(self.clients.keys()):
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        if self.server is not None:
            try:
                self.server.close()
            except OSError:
                pass

    def cleanup(self) -> None:
        for path in (self.socket_path, self.pid_path):
            try:
                path.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                pass
        self.log.line("daemon stopped")


def selftest() -> dict:
    """Deterministic, offline checks for CI: no server, no model, no network."""
    checks: list[tuple[str, bool]] = []
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    checks.append(("lock schema", lock.get("schema") == 2 and {"english", "multilingual"} <= set(lock.get("checkpoints", {}))))
    checks.append(("revision pinned", bool(re.fullmatch(r"[0-9a-f]{40}", lock["model"]["revision"]))))
    checks.append(("digests pinned", all(re.fullmatch(r"[0-9a-f]{64}", meta["sha256"]) for meta in lock["checkpoints"].values())))

    router = HeuristicLanguageRouter()
    checks.append(("heuristic english", router.detect("Where is the auth middleware validated?")["is_english"] is True))
    checks.append(("heuristic italian", router.detect("Dove viene validato il token in questo repository?")["is_english"] is False))
    checks.append(("heuristic short defaults english", router.detect("ok")["is_english"] is True))

    schema = {"type": "object", "properties": {"purpose": {"type": "string", "enum": ["none", "local_context", "external_context", "architecture"]}}}
    pool = ModelPool(lock, "fake", Log(Path("/dev/null"), False), router)
    pool.agents = {"english": FakeAgent("english"), "multilingual": FakeAgent("multilingual")}
    pool.state = "ready"
    english = pool.decide("please scan LOCAL repository files", schema)
    checks.append(("fake decision maps purpose", english.get("ok") is True and english.get("purpose") == "local_context"))
    checks.append(("english prompt routes to english", english.get("checkpoint") == "english"))
    italian = pool.decide("Dove sono i file LOCAL di questo repository?", schema)
    checks.append(("italian prompt routes to multilingual", italian.get("checkpoint") == "multilingual"))
    checks.append((
        "unknown purpose rejected",
        pool.decide("EXTERNAL docs", {"properties": {"purpose": {"enum": ["none"]}}}).get("error") == "invalid_enum",
    ))
    checks.append(("runtime dir override honoured", runtime_dir_path({"LAYA_ROUTING_RUNTIME_DIR": "/run/user/1000/pi-laya-test"}) == Path("/run/user/1000/pi-laya-test")))
    checks.append(("low information bypass", is_low_information("ok") and is_low_information("go ahead") and is_low_information("sì")))
    checks.append(("low information leaves real prompts", not is_low_information("fix the failing test") and not is_low_information("qual è il problema?")))

    failures = [name for name, passed in checks if not passed]
    return {"ok": not failures, "checks": len(checks), "failed": failures}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--grace-ms", type=int, default=int(os.environ.get("LAYA_ROUTING_GRACE_MS", "300000")))
    parser.add_argument("--backend", choices=["auto", "fake"], default=os.environ.get("LAYA_ROUTING_TEST_BACKEND", "auto"))
    parser.add_argument("--language-router", choices=["auto", "laya", "heuristic"], default=os.environ.get("LAYA_ROUTING_LANGUAGE_ROUTER", "auto"))
    parser.add_argument("--foreground", action="store_true", help="also mirror the runtime log to stderr")
    parser.add_argument("--selftest", action="store_true", help="run deterministic offline checks and exit")
    args = parser.parse_args(argv)

    if args.selftest:
        result = selftest()
        print(json.dumps(result, separators=(",", ":")))
        return 0 if result["ok"] else 1

    daemon = Daemon(args)
    return daemon.run()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
