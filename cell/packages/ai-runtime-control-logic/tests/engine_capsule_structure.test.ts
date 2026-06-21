import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { assertEngineCommandDerivation, type AiRuntimeControlPorts } from "@cell/ai-runtime-control-contract"
import {
  engineCommandDerivation,
  runEngineCapsule,
} from "../src/engineCapsule/coreLogic"
import {
  registerEnginePortAdapter,
  resolveEnginePortAdapter,
} from "../src/engineCapsule/adapterRegistry"

/**
 * Capsule structure conformance for the runtime_control_engine cluster
 * (spec cases stable-core-logic-entry, adapters-wired-by-enum,
 * internals-not-imported, types-stay-in-contract).
 */

const packageRoot = path.resolve(import.meta.dir, "..")
const capsuleDir = path.join(packageRoot, "src/engineCapsule")

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

describe("engine capsule structure", () => {
  it("has the capsule layout: coreLogic, adapterRegistry", () => {
    expect(fs.existsSync(path.join(capsuleDir, "coreLogic.ts"))).toBe(true)
    expect(fs.existsSync(path.join(capsuleDir, "adapterRegistry.ts"))).toBe(true)
  })

  it("coreLogic exposes the stable (runtime, input, config) entry", () => {
    const source = fs.readFileSync(path.join(capsuleDir, "coreLogic.ts"), "utf8")
    expect(source).toMatch(/export async function runEngineCapsule\s*\(\s*runtime\b/)
    expect(source).toMatch(/runEngineCapsule\s*\(\s*runtime[^)]*\binput\b[^)]*\bconfig\b/s)
  })

  it("the engine derivation satisfies the contract and reduces like the public reducers", () => {
    const derivation = assertEngineCommandDerivation(engineCommandDerivation)
    const initial = derivation.initializeControlState()
    const advanced = derivation.enqueueCommand(initial, {
      kind: "effect_request",
      commandId: "cmd-1",
      effectId: "effect-1",
      handlerKey: "handler",
    })
    expect(advanced).not.toBe(initial)
    expect(derivation.selectNextCommand(advanced)?.commandId).toBe("cmd-1")
    expect(derivation.classifyRecovery(advanced).runtime.recovery.classification).toBeDefined()
  })

  it("port adapters are wired by enum id through the registry", () => {
    const ports: AiRuntimeControlPorts = {
      effects: {
        hasHandler: () => true,
        dispatchEffect: async (request) => ({ effectId: request.effectId, resultId: "r" }),
      },
      durableHeads: {
        bufferHead: async () => {},
        commitCohort: async () => "marker",
      },
    }
    registerEnginePortAdapter("in_memory", () => ports)
    expect(resolveEnginePortAdapter("in_memory")({})).toBe(ports)
    expect(() => resolveEnginePortAdapter("no_such_adapter" as never)).toThrow(/no_such_adapter/)
  })

  it("runEngineCapsule drives commands through derivation and adapter-resolved ports", async () => {
    const dispatched: string[] = []
    registerEnginePortAdapter("in_memory", () => ({
      effects: {
        hasHandler: () => true,
        dispatchEffect: async (request) => {
          dispatched.push(request.effectId)
          return { effectId: request.effectId, resultId: `r:${request.effectId}` }
        },
      },
      durableHeads: {
        bufferHead: async () => {},
        commitCohort: async () => "marker",
      },
    }))

    const initial = engineCommandDerivation.enqueueCommand(
      engineCommandDerivation.initializeControlState(),
      { kind: "effect_request", commandId: "cmd-1", effectId: "effect-1", handlerKey: "handler" },
    )
    const result = await runEngineCapsule(
      {},
      { state: initial },
      { portAdapter: "in_memory" },
    )
    expect(dispatched).toEqual(["effect-1"])
    expect(result.state.runtime.persistence.effects["effect-1"]?.status).toBe("completed")
  })

  it("internals are not imported from outside the capsule", () => {
    const outside = listTsFiles(path.join(packageRoot, "src")).filter(
      (file) => !file.includes("engineCapsule"),
    )
    for (const file of outside) {
      const content = fs.readFileSync(file, "utf8")
      expect(content.includes("engineCapsule/internals"), `${file} must not import capsule internals`).toBe(
        false,
      )
    }
  })

  it("derivation implementations stay IO-free (spec case derivation-is-pure)", () => {
    const source = fs.readFileSync(path.join(capsuleDir, "coreLogic.ts"), "utf8")
    const ioImports = (source.match(/^import .*$/gm) ?? []).filter((line) =>
      /node:fs|node:child_process|node:net|node:http/.test(line),
    )
    expect(ioImports).toEqual([])
    for (const pattern of ["fetch(", "process.env"]) {
      expect(source.includes(pattern), `coreLogic.ts must not contain ${pattern}`).toBe(false)
    }
  })

  it("types stay in the contract package: the capsule defines no contract-named types", () => {
    for (const file of listTsFiles(capsuleDir)) {
      const content = fs.readFileSync(file, "utf8")
      const localTypes = content.match(/export (?:type|interface) (AiRuntime\w+|EngineCapsuleConfig)\b/g)
      expect(localTypes, `${file} must not redefine contract types`).toBeNull()
    }
  })
})
