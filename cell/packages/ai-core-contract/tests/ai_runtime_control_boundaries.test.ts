import { describe, expect, it } from "bun:test"

import {
  AI_RUNTIME_CONTROL_BOUNDARY_IDS,
  AI_RUNTIME_CONTROL_BOUNDARY_DECLARATIONS,
  createAiRuntimeControlBoundaryRegistry,
} from "../src"

const registry = createAiRuntimeControlBoundaryRegistry()

describe("AI runtime control boundary declarations", () => {
  it("declares the three control clusters", () => {
    expect(AI_RUNTIME_CONTROL_BOUNDARY_IDS).toEqual([
      "orchestrator_driver",
      "runtime_control_engine",
      "snapshot_coordinator",
    ])
    expect(AI_RUNTIME_CONTROL_BOUNDARY_DECLARATIONS.map((declaration) => declaration.id)).toEqual(
      AI_RUNTIME_CONTROL_BOUNDARY_IDS as unknown as string[],
    )
  })

  it("every cluster has a complete boundary declaration", () => {
    for (const declaration of AI_RUNTIME_CONTROL_BOUNDARY_DECLARATIONS) {
      expect(declaration.coreLogicEntries.length).toBeGreaterThan(0)
      expect(declaration.injectedEffectContracts.length).toBeGreaterThan(0)
      expect(declaration.outerAdapterSurface.length).toBeGreaterThan(0)
      expect(declaration.entries.length).toBeGreaterThan(0)
      expect(declaration.forbiddenDirectIo.length).toBeGreaterThan(0)
    }
  })

  it("layers follow the platform / bridge split", () => {
    expect(registry.getDeclaration("orchestrator_driver")?.layer).toBe("platform")
    expect(registry.getDeclaration("runtime_control_engine")?.layer).toBe("platform_domain_bridge")
    expect(registry.getDeclaration("snapshot_coordinator")?.layer).toBe("platform_domain_bridge")
  })

  it("cross-actor unblock entries are classified as async messages", () => {
    expect(registry.classifyEntry("orchestrator_driver", "resumeFiber")).toBe("async_message")
    expect(registry.classifyEntry("orchestrator_driver", "emitFiberSignal")).toBe("async_message")
    expect(registry.classifyEntry("orchestrator_driver", "settleInterruptedFiber")).toBe("async_message")
    expect(registry.classifyEntry("runtime_control_engine", "effect_result_delivery")).toBe("async_message")
    expect(registry.classifyEntry("snapshot_coordinator", "interrupted_inflight_evidence_replay")).toBe(
      "async_message",
    )
  })

  it("same-call-stack state advances are classified as sync commands", () => {
    expect(registry.classifyEntry("orchestrator_driver", "spawnFiber")).toBe("sync_command")
    expect(registry.classifyEntry("orchestrator_driver", "tick")).toBe("sync_command")
    expect(registry.classifyEntry("runtime_control_engine", "enqueueAiRuntimeControlCommand")).toBe("sync_command")
    expect(registry.classifyEntry("snapshot_coordinator", "snapshot_save_request")).toBe("sync_command")
    expect(registry.classifyEntry("snapshot_coordinator", "recovery_bootstrap")).toBe("sync_command")
  })

  it("core logic entries reference real source symbols of the engine cluster", () => {
    const engine = registry.getDeclaration("runtime_control_engine")
    expect(engine?.coreLogicEntries).toEqual(
      expect.arrayContaining([
        "selectNextAiRuntimeControlCommand",
        "evaluateAiAgentRuntimeSnapshotSafepoint",
        "classifyRealSessionRecovery",
      ]),
    )
  })

  it("snapshot coordinator core logic is the boundary decision, not the writer", () => {
    const coordinator = registry.getDeclaration("snapshot_coordinator")
    expect(coordinator?.coreLogicEntries).toEqual(
      expect.arrayContaining([
        "decideAiRuntimePendingEffectsRecovery",
        "buildAiRuntimeInterruptedInflightFailedEvidence",
      ]),
    )
    expect(coordinator?.outerAdapterSurface).toEqual(
      expect.arrayContaining(["saveAiAgentRuntimeSnapshot", "recoverAiAgentRuntime"]),
    )
  })
})
