import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { assertSchedulerDerivation } from "@cell/ai-core-contract"
import { schedulerDerivation, createOrchestratorCapsule } from "../../../src/orchestratorCapsule/coreLogic"
import {
  createAiAgentOrchestratorDriver,
  createAiAgentOrchestratorDriverWithCooperative,
  AI_AGENT_ORCHESTRATOR_TICK_SCOPES,
} from "../../../src/OrchestratorDriver"

/**
 * Capsule structure conformance for the orchestrator_driver cluster
 * (spec cases stable-core-logic-entry, internals-not-imported,
 * types-stay-in-contract) plus the scheduler derivation's behavior and the
 * compatibility facade.
 */

const packageRoot = path.resolve(import.meta.dir, "../../..")
const capsuleDir = path.join(packageRoot, "src/orchestratorCapsule")

function listTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const collected: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collected.push(...listTsFiles(full))
    else if (entry.name.endsWith(".ts")) collected.push(full)
  }
  return collected
}

describe("orchestrator capsule structure", () => {
  it("has the capsule layout: coreLogic plus internals", () => {
    expect(fs.existsSync(path.join(capsuleDir, "coreLogic.ts"))).toBe(true)
    expect(fs.existsSync(path.join(capsuleDir, "internals"))).toBe(true)
  })

  it("coreLogic exposes the stable (runtime, input, config) entry", () => {
    const source = fs.readFileSync(path.join(capsuleDir, "coreLogic.ts"), "utf8")
    expect(source).toMatch(/export function createOrchestratorCapsule\s*\(\s*runtime\b/)
    expect(source).toMatch(/createOrchestratorCapsule\s*\(\s*runtime[^)]*\binput\b[^)]*\bconfig\b/s)
  })

  it("internals are not imported from outside the capsule", () => {
    const outside = listTsFiles(path.join(packageRoot, "src")).filter(
      (file) => !file.includes("orchestratorCapsule"),
    )
    for (const file of outside) {
      const content = fs.readFileSync(file, "utf8")
      expect(
        content.includes("orchestratorCapsule/internals"),
        `${file} must not import capsule internals`,
      ).toBe(false)
    }
  })

  it("derivation implementations stay IO-free (spec case derivation-is-pure)", () => {
    const derivationFiles = ["coreLogic.ts", path.join("internals", "decisions.ts")]
    for (const file of derivationFiles) {
      const source = fs.readFileSync(path.join(capsuleDir, file), "utf8")
      const ioImports = (source.match(/^import .*$/gm) ?? []).filter((line) =>
        /node:fs|node:child_process|node:net|node:http/.test(line),
      )
      expect(ioImports, `${file} must not import IO modules`).toEqual([])
      for (const pattern of ["fetch(", "process.env"]) {
        expect(source.includes(pattern), `${file} must not contain ${pattern}`).toBe(false)
      }
    }
  })

  it("capsule files do not export contract-named or facade-owned type declarations", () => {
    for (const file of listTsFiles(capsuleDir)) {
      const content = fs.readFileSync(file, "utf8")
      const localTypes = content.match(
        /export (?:type|interface) (AiAgent\w+|Scheduler\w+|Orchestrator\w+|FiberStep\w*|EmitFiberSignal\w*)\b/g,
      )
      expect(localTypes, `${file} must not export driver type declarations`).toBeNull()
    }
  })
})

describe("scheduler derivation", () => {
  const derivation = assertSchedulerDerivation(schedulerDerivation)

  it("initializes an empty scheduler state", () => {
    const state = derivation.initializeSchedulerState() as { fibers: Record<string, unknown> }
    expect(state.fibers).toEqual({})
  })

  it("reduces fiber events through the vendor orchestrator reducer", () => {
    const state = derivation.initializeSchedulerState()
    const result = derivation.reduceFiberEvent(state, { type: "tick", now: 1 })
    expect(result.state).toBeDefined()
    expect(Array.isArray(result.effects)).toBe(true)
  })

  it("projects the scheduler signal shape from explicit state", () => {
    const state = derivation.initializeSchedulerState()
    const signal = derivation.projectSchedulerSignal(state) as Record<string, unknown>
    expect(Object.keys(signal).sort()).toEqual(
      [
        "blockedFiberIds",
        "interruptedFiberIds",
        "pendingResumeFiberIds",
        "readyFiberIds",
        "runningFiberIds",
        "suspendedFiberIds",
        "updatedAt",
      ].sort(),
    )
  })
})

describe("compatibility facade", () => {
  it("keeps the public driver factories importable from the original path", () => {
    expect(typeof createAiAgentOrchestratorDriver).toBe("function")
    expect(typeof createAiAgentOrchestratorDriverWithCooperative).toBe("function")
    expect(AI_AGENT_ORCHESTRATOR_TICK_SCOPES).toBeDefined()
  })

  it("the capsule entry composes a driver from (runtime, input, config)", () => {
    const capsule = createOrchestratorCapsule(
      {},
      { fibers: [] },
      { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    )
    expect(typeof capsule.driver.tick).toBe("function")
    expect(typeof capsule.driver.resumeFiber).toBe("function")
  })
})
