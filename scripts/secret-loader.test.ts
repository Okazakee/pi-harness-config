// Tests for pi/extensions/secret-loader.ts.
//
// Run with:  bun test scripts/secret-loader.test.ts
// or via:    scripts/test-secret-loader.sh
//
// The extension uses type-only imports from @earendil-works/pi-coding-agent, so
// it loads here without that package being installed — no node_modules needed.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import {
  SECRET_NAMES,
  agentDir,
  applySecrets,
  loadSecret,
  default as secretsEnv,
} from "../pi/extensions/secret-loader"

const ENV_NAMES = [...SECRET_NAMES, "PI_CODING_AGENT_DIR"]

const savedEnv = new Map<string, string | undefined>()
for (const name of ENV_NAMES) savedEnv.set(name, process.env[name])

const tempDirs: string[] = []

function makeDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "secret-loader-"))
  tempDirs.push(dir)
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), value)
  }
  return dir
}

afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true })
  }
})

describe("agentDir", () => {
  test("honors $PI_CODING_AGENT_DIR", () => {
    expect(agentDir({ PI_CODING_AGENT_DIR: "/custom/agent" })).toBe("/custom/agent")
  })

  test("falls back to ~/.pi/agent for blank or absent overrides", () => {
    expect(agentDir({ PI_CODING_AGENT_DIR: "   " })).toBe(join(homedir(), ".pi", "agent"))
    expect(agentDir({})).toBe(join(homedir(), ".pi", "agent"))
  })
})

describe("loadSecret", () => {
  test("returns trimmed content", () => {
    const dir = makeDir({ EXA_API_KEY: "  key-value\n" })
    expect(loadSecret("EXA_API_KEY", dir)).toBe("key-value")
  })

  test("returns undefined for blank or missing files", () => {
    const dir = makeDir({ BLANK: " \n\t" })
    expect(loadSecret("BLANK", dir)).toBeUndefined()
    expect(loadSecret("MISSING", dir)).toBeUndefined()
    expect(loadSecret("EXA_API_KEY", join(dir, "nope"))).toBeUndefined()
  })
})

describe("applySecrets", () => {
  test("applies allowlisted secrets and leaves other files alone", () => {
    const dir = makeDir({
      EXA_API_KEY: "exa-value",
      TAVILY_API_KEY: "tavily-value",
      OTHER_TOKEN: "must-not-load",
    })
    const env: NodeJS.ProcessEnv = {}

    expect(applySecrets(env, dir)).toEqual(["TAVILY_API_KEY", "EXA_API_KEY"])
    expect(env.EXA_API_KEY).toBe("exa-value")
    expect(env.TAVILY_API_KEY).toBe("tavily-value")
    expect(env.OTHER_TOKEN).toBeUndefined()
  })

  test("already-set variables always win", () => {
    const dir = makeDir({ EXA_API_KEY: "store-value" })
    const env: NodeJS.ProcessEnv = { EXA_API_KEY: "shell-value", JINA_API_KEY: "  " }

    expect(applySecrets(env, dir)).toEqual([])
    expect(env.EXA_API_KEY).toBe("shell-value")
    expect(env.JINA_API_KEY).toBe("  ")
  })
})

describe("default export", () => {
  test("bridges the agent-dir store into process.env", () => {
    const agent = makeDir()
    mkdirSync(join(agent, ".secrets"))
    writeFileSync(join(agent, ".secrets", "EXA_API_KEY"), "bridged\n")
    delete process.env.EXA_API_KEY
    process.env.PI_CODING_AGENT_DIR = agent

    secretsEnv({} as Parameters<typeof secretsEnv>[0])

    expect(process.env.EXA_API_KEY).toBe("bridged")
  })
})
