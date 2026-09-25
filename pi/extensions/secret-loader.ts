/**
 * secret-loader — bridge the agent-dir secret store to standard environment
 * variables consumed by other extensions.
 *
 * Store: <agent-dir>/.secrets/<NAME> — filename = secret name, content = value,
 * where <agent-dir> is $PI_CODING_AGENT_DIR or ~/.pi/agent. Only the names in
 * SECRET_NAMES are read, an already-set environment variable always wins, and
 * values are never logged. The store itself is never part of the backup.
 *
 * The four key names below are exactly the ones @counterposition/pi-web-search
 * reads; without this bridge a store file would never reach the extension.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

/** Secrets the harness is allowed to expose to the process environment. */
export const SECRET_NAMES = [
  "BRAVE_API_KEY",
  "TAVILY_API_KEY",
  "EXA_API_KEY",
  "JINA_API_KEY",
] as const

/** The Pi agent directory, honoring $PI_CODING_AGENT_DIR. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_CODING_AGENT_DIR?.trim()
  return override ? override : join(homedir(), ".pi", "agent")
}

/** Read one secret from the store; blank or missing files yield undefined. */
export function loadSecret(name: string, dir = join(agentDir(), ".secrets")): string | undefined {
  try {
    const value = readFileSync(join(dir, name), "utf8").trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Copy every allowlisted secret that exists in `dir` into `env`. Already-set
 * variables are left alone so shell/CI overrides keep working. Returns the
 * names that were applied.
 */
export function applySecrets(env: NodeJS.ProcessEnv, dir: string): string[] {
  const applied: string[] = []
  for (const name of SECRET_NAMES) {
    if (env[name]?.trim()) continue
    const value = loadSecret(name, dir)
    if (value === undefined) continue
    env[name] = value
    applied.push(name)
  }
  return applied
}

export default function secretsEnv(_pi: ExtensionAPI): void {
  applySecrets(process.env, join(agentDir(), ".secrets"))
}
