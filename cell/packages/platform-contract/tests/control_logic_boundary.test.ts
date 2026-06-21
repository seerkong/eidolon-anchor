import { describe, expect, it } from "bun:test"

import {
  CONTROL_ENTRY_KINDS,
  createControlLogicBoundaryRegistry,
  type ControlEntryKind,
  type ControlLogicBoundaryDeclaration,
} from "../src"

function makeDeclaration(
  overrides: Partial<ControlLogicBoundaryDeclaration> & { id: string },
): ControlLogicBoundaryDeclaration {
  return {
    layer: "platform",
    coreLogicEntries: [],
    injectedEffectContracts: [],
    outerAdapterSurface: [],
    entries: [],
    forbiddenDirectIo: [],
    ...overrides,
  }
}

describe("control entry kinds", () => {
  it("classifies entries as exactly sync_command or async_message", () => {
    expect(CONTROL_ENTRY_KINDS).toEqual(["sync_command", "async_message"])
  })
})

describe("ControlLogicBoundaryDeclaration shape", () => {
  it("declares core logic entries, injected effects, outer surface, classified entries, and forbidden direct IO", () => {
    const declaration = makeDeclaration({
      id: "runtime_control_engine",
      layer: "platform_domain_bridge",
      coreLogicEntries: ["selectNextAiRuntimeControlCommand", "classifyAiRuntimeControlRecovery"],
      injectedEffectContracts: ["effect_handler_registry", "durable_head_store"],
      outerAdapterSurface: ["runOneAiRuntimeControlStep", "runAiRuntimeControlUntilIdle"],
      entries: [
        { entryId: "enqueueAiRuntimeControlCommand", kind: "sync_command" },
        { entryId: "effect_result_delivery", kind: "async_message" },
      ],
      forbiddenDirectIo: ["node:fs", "fetch("],
    })

    const registry = createControlLogicBoundaryRegistry([declaration])
    const resolved = registry.getDeclaration("runtime_control_engine")

    expect(resolved?.layer).toBe("platform_domain_bridge")
    expect(registry.listCoreLogicEntries("runtime_control_engine")).toEqual([
      "selectNextAiRuntimeControlCommand",
      "classifyAiRuntimeControlRecovery",
    ])
    expect(resolved?.injectedEffectContracts).toContain("durable_head_store")
    expect(resolved?.outerAdapterSurface).toContain("runOneAiRuntimeControlStep")
    expect(resolved?.forbiddenDirectIo).toContain("node:fs")
  })

  it("answers entry classification questions", () => {
    const declaration = makeDeclaration({
      id: "orchestrator_driver",
      entries: [
        { entryId: "resumeFiber", kind: "async_message" },
        { entryId: "registerFiber", kind: "sync_command" },
      ],
    })
    const registry = createControlLogicBoundaryRegistry([declaration])

    const resume: ControlEntryKind | null = registry.classifyEntry("orchestrator_driver", "resumeFiber")
    expect(resume).toBe("async_message")
    expect(registry.classifyEntry("orchestrator_driver", "registerFiber")).toBe("sync_command")
    expect(registry.classifyEntry("orchestrator_driver", "no_such_entry")).toBe(null)
    expect(registry.classifyEntry("no_such_component", "resumeFiber")).toBe(null)
  })
})

describe("ControlLogicBoundaryRegistry validation", () => {
  it("rejects duplicate component ids", () => {
    expect(() =>
      createControlLogicBoundaryRegistry([makeDeclaration({ id: "dup" }), makeDeclaration({ id: "dup" })]),
    ).toThrow(/dup/)
  })

  it("rejects duplicate entry ids within one component", () => {
    const declaration = makeDeclaration({
      id: "component",
      entries: [
        { entryId: "same_entry", kind: "sync_command" },
        { entryId: "same_entry", kind: "async_message" },
      ],
    })
    expect(() => createControlLogicBoundaryRegistry([declaration])).toThrow(/same_entry/)
  })

  it("rejects entries with an unknown kind at runtime", () => {
    const declaration = makeDeclaration({
      id: "component",
      entries: [{ entryId: "weird", kind: "fire_and_forget" as ControlEntryKind }],
    })
    expect(() => createControlLogicBoundaryRegistry([declaration])).toThrow(/fire_and_forget/)
  })
})
