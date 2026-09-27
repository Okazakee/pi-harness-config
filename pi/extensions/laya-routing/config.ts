/**
 * Configuration for the Laya delegation advisor.
 *
 * One small JSON file lives next to the other pi extension config
 * (`$PI_CODING_AGENT_DIR/laya-routing.json`, default `~/.pi/agent/laya-routing.json`),
 * mirroring the `pi-lsp.json` precedent. Missing or malformed values fall back
 * to the defaults below; `off` and a conservative `shadow` rollout are always
 * available even with no file on disk.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type LayaRoutingMode = "off" | "shadow" | "advise";

export type Env = Record<string, string | undefined>;

export interface LayaRoutingConfig {
	/** off: inert; shadow: classify + telemetry only; advise: also inject the hint. */
	mode: LayaRoutingMode;
	/** Minimum Laya `answer_confidence` (probability of the reported answer) for a hint. */
	confidenceThreshold: number;
	/** Hard budget for one bridge invocation, cold model load included. */
	timeoutMs: number;
	/** Max wait for a decision before the first provider request of a turn. */
	advisoryBudgetMs: number;
	/** Interpreter that runs the pinned bridge; Laya is not a pi dependency. */
	python: string;
}

/**
 * Rollout defaults. `shadow` until real telemetry exists; the 0.8 confidence
 * gate is deliberately conservative for a 4-way choice (uniform prior 0.25)
 * and is meant to be tuned from recorded `answer_confidence` values, not
 * guessed further up front.
 */
export const DEFAULT_CONFIG: LayaRoutingConfig = {
	mode: "shadow",
	confidenceThreshold: 0.8,
	timeoutMs: 20_000,
	advisoryBudgetMs: 800,
	python: "python3",
};

const MODES: readonly LayaRoutingMode[] = ["off", "shadow", "advise"];

export function isMode(value: unknown): value is LayaRoutingMode {
	return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

/** `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, matching secret-loader. */
export function agentDir(env: Env = process.env, home = homedir()): string {
	const override = env.PI_CODING_AGENT_DIR?.trim();
	return override && override.length > 0 ? override : join(home, ".pi", "agent");
}

export function defaultConfigPath(env: Env = process.env, home = homedir()): string {
	return join(agentDir(env, home), "laya-routing.json");
}

/** XDG state dir: telemetry never lives in the agent dir or the backup repo. */
export function defaultTelemetryPath(env: Env = process.env, home = homedir()): string {
	const base = env.XDG_STATE_HOME?.trim() || join(home, ".local", "state");
	return join(base, "pi", "laya-routing", "decisions.jsonl");
}

export interface ConfigParse {
	config: LayaRoutingConfig;
	warnings: string[];
}

/** Accepts unknown JSON; every invalid field stays at its default and warns. */
export function parseConfig(raw: unknown): ConfigParse {
	const config: LayaRoutingConfig = { ...DEFAULT_CONFIG };
	const warnings: string[] = [];
	if (raw === undefined) return { config, warnings };
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		return { config, warnings: ["config must be a JSON object; using defaults"] };
	}
	const record = raw as Record<string, unknown>;

	if (isMode(record.mode)) config.mode = record.mode;
	else if (record.mode !== undefined) warnings.push(`unknown mode ${JSON.stringify(record.mode)}; using ${config.mode}`);

	const threshold = record.confidenceThreshold;
	if (typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 0 && threshold <= 1) {
		config.confidenceThreshold = threshold;
	} else if (threshold !== undefined) {
		warnings.push(`confidenceThreshold must be a number in [0, 1]; using ${config.confidenceThreshold}`);
	}

	const timeout = record.timeoutMs;
	if (typeof timeout === "number" && Number.isInteger(timeout) && timeout > 0) config.timeoutMs = timeout;
	else if (timeout !== undefined) warnings.push(`timeoutMs must be a positive integer; using ${config.timeoutMs}`);

	const budget = record.advisoryBudgetMs;
	if (typeof budget === "number" && Number.isInteger(budget) && budget >= 0) config.advisoryBudgetMs = budget;
	else if (budget !== undefined) warnings.push(`advisoryBudgetMs must be a non-negative integer; using ${config.advisoryBudgetMs}`);

	const python = record.python;
	if (typeof python === "string" && python.trim().length > 0) config.python = python.trim();
	else if (python !== undefined) warnings.push(`python must be a non-empty string; using ${config.python}`);

	return { config, warnings };
}

export interface ConfigLoad extends ConfigParse {
	exists: boolean;
	error?: string;
}

/**
 * Reads the config file and applies the optional `LAYA_ROUTING_MODE` env
 * override (env wins over the file, so a single shell can force `off`).
 */
export function loadConfig(path: string, env: Env = process.env): ConfigLoad {
	let exists = false;
	let error: string | undefined;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
		exists = true;
	} catch (cause) {
		const code = (cause as NodeJS.ErrnoException | undefined)?.code;
		if (code !== "ENOENT") error = cause instanceof Error ? cause.message : String(cause);
	}

	const parsed = parseConfig(exists ? raw : undefined);
	const warnings = [...parsed.warnings];
	const envMode = env.LAYA_ROUTING_MODE?.trim();
	if (isMode(envMode)) parsed.config.mode = envMode;
	else if (envMode) warnings.push(`unknown LAYA_ROUTING_MODE ${JSON.stringify(envMode)}; using ${parsed.config.mode}`);

	return { config: parsed.config, warnings, exists, error };
}

/** Writes the effective config back; used by `/laya-routing mode <x>`. */
export function saveConfig(path: string, config: LayaRoutingConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
