/**
 * Persistent transport to the shared warm Laya daemon.
 *
 * One connection per root Pi process is the client lease: the daemon counts
 * open sockets, arms its shutdown grace timer when the last one closes, and
 * cancels it when a client reconnects. The transport starts the daemon when
 * the socket is missing, reconnects on demand after a crash (bounded by a
 * spawn cooldown so a broken runtime cannot cause an infinite restart loop),
 * and never throws: every failure is a typed `{ ok: false }` result.
 *
 * Protocol: newline-delimited JSON over a user-private Unix socket; requests
 * carry ids so concurrent clients cannot confuse responses.
 */

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { Env } from "./config";

export interface RuntimePaths {
	dir: string;
	socket: string;
	lock: string;
	pid: string;
	log: string;
}

/** `$LAYA_ROUTING_RUNTIME_DIR` > `$XDG_RUNTIME_DIR/pi-laya` > `/tmp/pi-laya-<uid>`. */
export function resolveRuntimePaths(
	env: Env = process.env,
	home = homedir(),
	uid: number | string = typeof process.getuid === "function" ? process.getuid() : "user",
): RuntimePaths {
	const override = env.LAYA_ROUTING_RUNTIME_DIR?.trim();
	const xdg = env.XDG_RUNTIME_DIR?.trim();
	const dir =
		override && override.length > 0
			? override
			: xdg && xdg.length > 0
				? join(xdg, "pi-laya")
				: join(tmpdir(), `pi-laya-${uid}`);
	return {
		dir,
		socket: join(dir, "laya.sock"),
		lock: join(dir, "laya.lock"),
		pid: join(dir, "laya.pid"),
		log: join(dir, "laya.log"),
	};
}

export interface DaemonCheckpoint {
	id: string;
	role?: string;
	repo?: string;
	subfolder?: string | null;
	revision?: string;
}

export interface DaemonWelcome {
	protocol: number;
	daemonId: string;
	pid: number;
	state: string;
	graceMs: number;
	checkpoints: DaemonCheckpoint[];
	packageVersion?: string;
	repo?: string;
	revision?: string;
}

export interface DaemonStatus {
	daemonId: string;
	pid: number;
	uptimeMs: number;
	state: string;
	clientCount: number;
	clients: Array<{ pid?: number; session?: string; connectedAt?: number }>;
	grace: { pending: boolean; graceMs: number; remainingMs: number | null };
	router?: string;
	backend?: string;
	checkpoints: DaemonCheckpoint[];
	loadedMs?: Record<string, number>;
	packageVersion?: string | null;
	error?: { error: string; detail?: string } | null;
	last?: Record<string, unknown> | null;
	socket?: string;
}

export type ClassifyResult =
	| {
			ok: true;
			language?: string;
			isEnglish?: boolean;
			checkpoint?: string;
			purpose: string;
			answerConfidence: number;
			confidence?: number;
			probabilities?: Record<string, number>;
			latencyMs: number;
	  }
	| { ok: false; error: string; detail?: string };

export interface SpawnedChild {
	pid?: number;
	unref?: () => void;
	on?: (event: "error", handler: (error: Error) => void) => void;
}

export interface TransportOptions {
	daemonPath: string;
	python: () => string;
	graceMs: () => number;
	paths: RuntimePaths;
	env?: Env;
	now?: () => number;
	/** Test seams. */
	connectImpl?: (path: string) => Socket;
	spawnImpl?: (command: string, args: string[], options: { detached: boolean; stdio: "ignore"; env: Env }) => SpawnedChild;
	connectTimeoutMs?: number;
	spawnCooldownMs?: number;
	helloTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 3_000;
const DEFAULT_SPAWN_COOLDOWN_MS = 5_000;
const DEFAULT_HELLO_TIMEOUT_MS = 2_000;
const CONNECT_RETRY_MS = 50;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export class LayaDaemonTransport {
	private readonly options: TransportOptions;
	private readonly now: () => number;
	private socket: Socket | undefined;
	private buffer = "";
	private welcomeInfo: DaemonWelcome | undefined;
	private connecting: Promise<DaemonWelcome | undefined> | undefined;
	private lastSpawnAt = 0;
	private closing = false;
	private readonly pending = new Map<
		string,
		{ resolve: (payload: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout>; kind: "result" | "status" }
	>();
	private readonly waiters: Array<{ resolve: (welcome: DaemonWelcome | undefined) => void; timer: ReturnType<typeof setTimeout> }> = [];

	constructor(options: TransportOptions) {
		this.options = options;
		this.now = options.now ?? (() => Date.now());
	}

	get connected(): boolean {
		return this.socket !== undefined && !this.socket.destroyed && this.welcomeInfo !== undefined;
	}

	get welcome(): DaemonWelcome | undefined {
		return this.welcomeInfo;
	}

	/** Connect (or start) the daemon; resolves undefined when unavailable. */
	async ensureConnected(): Promise<DaemonWelcome | undefined> {
		if (this.connected) return this.welcomeInfo;
		if (this.connecting) return this.connecting;
		this.connecting = this.connectWithStart()
			.catch(() => undefined)
			.finally(() => {
				this.connecting = undefined;
			});
		return this.connecting;
	}

	private async connectWithStart(): Promise<DaemonWelcome | undefined> {
		if (await this.tryConnect()) return this.welcomeInfo;

		const now = this.now();
		if (now - this.lastSpawnAt >= (this.options.spawnCooldownMs ?? DEFAULT_SPAWN_COOLDOWN_MS)) {
			this.lastSpawnAt = now;
			this.spawnDaemon();
		}

		const deadline = this.now() + (this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
		while (this.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_MS));
			if (await this.tryConnect()) return this.welcomeInfo;
		}
		return undefined;
	}

	private spawnDaemon(): void {
		try {
			mkdirSync(this.options.paths.dir, { recursive: true, mode: 0o700 });
			const spawnImpl =
				this.options.spawnImpl ??
				((command: string, args: string[], options: { detached: boolean; stdio: "ignore"; env: Env }): SpawnedChild =>
					spawn(command, args, options));
			const child = spawnImpl(this.options.python(), [this.options.daemonPath, "--grace-ms", String(this.options.graceMs())], {
				detached: true,
				stdio: "ignore",
				env: { ...process.env, ...(this.options.env ?? {}) },
			});
			// An async spawn failure (missing interpreter) surfaces as an 'error'
			// event; the connect retries below report it, so swallow it here.
			child.on?.("error", () => {});
			child.unref?.();
		} catch {
			// The next ensureConnected() retries after the cooldown.
		}
	}

	private async tryConnect(): Promise<boolean> {
		const connectImpl = this.options.connectImpl ?? ((path: string) => netConnect(path));
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (value: boolean) => {
				if (settled) return;
				settled = true;
				resolve(value);
			};
			let socket: Socket;
			try {
				socket = connectImpl(this.options.paths.socket);
			} catch {
				finish(false);
				return;
			}
			const timer = setTimeout(() => {
				socket.destroy();
				finish(false);
			}, this.options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS);
			socket.once("error", () => {
				clearTimeout(timer);
				socket.destroy();
				finish(false);
			});
			socket.once("connect", () => {
				this.attach(socket);
				this.send({ type: "hello", protocol: 1, client: { pid: process.pid } });
				this.awaitWelcome((welcome) => {
					clearTimeout(timer);
					if (!welcome) {
						this.detach(socket);
						finish(false);
						return;
					}
					this.welcomeInfo = welcome;
					finish(true);
				});
			});
		});
	}

	private attach(socket: Socket): void {
		this.detach(this.socket);
		this.socket = socket;
		this.buffer = "";
		this.closing = false;
		socket.setNoDelay?.(true);
		socket.on("data", (chunk) => this.onData(String(chunk)));
		socket.on("error", () => this.failSocket());
		socket.on("close", () => this.failSocket());
	}

	private detach(socket: Socket | undefined): void {
		if (!socket) return;
		socket.removeAllListeners();
		socket.destroy();
		if (this.socket === socket) this.socket = undefined;
	}

	private failSocket(): void {
		this.welcomeInfo = undefined;
		this.flushPending({ ok: false, error: "daemon_disconnected" });
		if (this.closing) return;
		this.socket = undefined;
	}

	/** The daemon is gone: pending requests fail and the next call reconnects. */
	private flushPending(payload: Record<string, unknown>): void {
		for (const [, waiter] of this.pending) {
			clearTimeout(waiter.timer);
			waiter.resolve(payload);
		}
		this.pending.clear();
	}

	private awaitWelcome(callback: (welcome: DaemonWelcome | undefined) => void): void {
		const timer = setTimeout(() => {
			const index = this.waiters.findIndex((waiter) => waiter.timer === timer);
			if (index >= 0) this.waiters.splice(index, 1);
			callback(undefined);
		}, this.options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS);
		this.waiters.push({ resolve: callback, timer });
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			const line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (line.trim().length > 0) this.onMessage(line);
			index = this.buffer.indexOf("\n");
		}
	}

	private onMessage(line: string): void {
		let payload: Record<string, unknown>;
		try {
			const parsed = JSON.parse(line);
			const record = asRecord(parsed);
			if (!record) return;
			payload = record;
		} catch {
			return;
		}

		if (payload.type === "welcome") {
			const waiter = this.waiters.shift();
			if (!waiter) return;
			clearTimeout(waiter.timer);
			waiter.resolve(this.parseWelcome(payload));
			return;
		}

		const id = typeof payload.id === "string" ? payload.id : undefined;
		if (id !== undefined) {
			const waiter = this.pending.get(id);
			if (waiter) {
				clearTimeout(waiter.timer);
				this.pending.delete(id);
				waiter.resolve(payload);
			}
		}
	}

	private parseWelcome(payload: Record<string, unknown>): DaemonWelcome {
		const runtime = asRecord(payload.runtime);
		const checkpoints = Array.isArray(payload.checkpoints)
			? payload.checkpoints.flatMap((entry): DaemonCheckpoint[] => {
					const record = asRecord(entry);
					return record && typeof record.id === "string"
						? [
								{
									id: record.id,
									role: typeof record.role === "string" ? record.role : undefined,
									repo: typeof record.repo === "string" ? record.repo : undefined,
									subfolder: typeof record.subfolder === "string" ? record.subfolder : null,
									revision: typeof record.revision === "string" ? record.revision : undefined,
								},
							]
						: [];
				})
			: [];
		return {
			protocol: typeof payload.protocol === "number" ? payload.protocol : 0,
			daemonId: typeof payload.daemon_id === "string" ? payload.daemon_id : "unknown",
			pid: typeof payload.pid === "number" ? payload.pid : 0,
			state: typeof payload.state === "string" ? payload.state : "unknown",
			graceMs: typeof payload.grace_ms === "number" ? payload.grace_ms : 0,
			checkpoints,
			packageVersion: typeof runtime?.package_version === "string" ? runtime.package_version : undefined,
			repo: typeof runtime?.repo === "string" ? runtime.repo : undefined,
			revision: typeof runtime?.revision === "string" ? runtime.revision : undefined,
		};
	}

	private send(payload: Record<string, unknown>): boolean {
		if (!this.socket || this.socket.destroyed) return false;
		try {
			this.socket.write(`${JSON.stringify(payload)}\n`);
			return true;
		} catch {
			return false;
		}
	}

	/** Request/response with an id and a hard timeout. */
	private request(payload: Record<string, unknown>, kind: "result" | "status", timeoutMs: number): Promise<Record<string, unknown>> {
		return new Promise((resolve) => {
			const id = `${process.pid}-${this.now()}-${Math.random().toString(36).slice(2, 10)}`;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ ok: false, error: "timeout" });
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, timer, kind });
			if (!this.send({ ...payload, id })) {
				clearTimeout(timer);
				this.pending.delete(id);
				resolve({ ok: false, error: "unavailable" });
			}
		});
	}

	async classify(text: string, schema: unknown, timeoutMs: number): Promise<ClassifyResult> {
		const welcome = await this.ensureConnected();
		if (!welcome) return { ok: false, error: "unavailable" };
		const payload = await this.request({ type: "classify", text, schema }, "result", timeoutMs);
		if (payload.ok === true) {
			const purpose = typeof payload.purpose === "string" ? payload.purpose : undefined;
			const answerConfidence = typeof payload.answer_confidence === "number" ? payload.answer_confidence : undefined;
			if (purpose === undefined || answerConfidence === undefined) return { ok: false, error: "malformed" };
			return {
				ok: true,
				language: typeof payload.language === "string" ? payload.language : undefined,
				isEnglish: typeof payload.is_english === "boolean" ? payload.is_english : undefined,
				checkpoint: typeof payload.checkpoint === "string" ? payload.checkpoint : undefined,
				purpose,
				answerConfidence,
				confidence: typeof payload.confidence === "number" ? payload.confidence : undefined,
				probabilities: asRecord(payload.probabilities) as Record<string, number> | undefined,
				latencyMs: typeof payload.latency_ms === "number" ? payload.latency_ms : 0,
			};
		}
		return {
			ok: false,
			error: typeof payload.error === "string" ? payload.error : "malformed",
			detail: typeof payload.detail === "string" ? payload.detail : undefined,
		};
	}

	async status(timeoutMs: number): Promise<DaemonStatus | undefined> {
		const welcome = await this.ensureConnected();
		if (!welcome) return undefined;
		const payload = await this.request({ type: "status" }, "status", timeoutMs);
		if (payload.type !== "status") return undefined;
		const grace = asRecord(payload.grace) ?? {};
		const clients = Array.isArray(payload.clients)
			? payload.clients.flatMap((entry) => {
					const record = asRecord(entry);
					return record
						? [
								{
									pid: typeof record.pid === "number" ? record.pid : undefined,
									session: typeof record.session === "string" ? record.session : undefined,
									connectedAt: typeof record.connected_at === "number" ? record.connected_at : undefined,
								},
							]
						: [];
				})
			: [];
		const checkpoints = Array.isArray(payload.checkpoints)
			? payload.checkpoints.flatMap((entry): DaemonCheckpoint[] => {
					const record = asRecord(entry);
					return record && typeof record.id === "string"
						? [
								{
									id: record.id,
									role: typeof record.role === "string" ? record.role : undefined,
									repo: typeof record.repo === "string" ? record.repo : undefined,
									subfolder: typeof record.subfolder === "string" ? record.subfolder : null,
									revision: typeof record.revision === "string" ? record.revision : undefined,
								},
							]
						: [];
				})
			: [];
		const error = asRecord(payload.error);
		return {
			daemonId: typeof payload.daemon_id === "string" ? payload.daemon_id : "unknown",
			pid: typeof payload.pid === "number" ? payload.pid : 0,
			uptimeMs: typeof payload.uptime_ms === "number" ? payload.uptime_ms : 0,
			state: typeof payload.state === "string" ? payload.state : "unknown",
			clientCount: typeof payload.client_count === "number" ? payload.client_count : clients.length,
			clients,
			grace: {
				pending: grace.pending === true,
				graceMs: typeof grace.grace_ms === "number" ? grace.grace_ms : 0,
				remainingMs: typeof grace.remaining_ms === "number" ? grace.remaining_ms : null,
			},
			router: typeof payload.router === "string" ? payload.router : undefined,
			backend: typeof payload.backend === "string" ? payload.backend : undefined,
			checkpoints,
			loadedMs: asRecord(payload.loaded_ms) as Record<string, number> | undefined,
			packageVersion: typeof payload.package_version === "string" ? payload.package_version : null,
			error: error ? { error: typeof error.error === "string" ? error.error : "unknown", detail: typeof error.detail === "string" ? error.detail : undefined } : null,
			last: asRecord(payload.last) ?? null,
			socket: typeof payload.socket === "string" ? payload.socket : undefined,
		};
	}

	/** Close the lease; the daemon's grace timer takes over if this was the last one. */
	close(): void {
		this.closing = true;
		this.send({ type: "bye" });
		const socket = this.socket;
		this.socket = undefined;
		this.welcomeInfo = undefined;
		if (socket) {
			try {
				socket.end();
			} catch {
				// Already gone.
			}
			socket.removeAllListeners();
			socket.destroy();
		}
		this.flushPending({ ok: false, error: "closed" });
	}
}
