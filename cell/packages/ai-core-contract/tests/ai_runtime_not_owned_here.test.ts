import { describe, expect, it } from "bun:test"

import { createDataSubgraphContractRegistry, type DataSubgraphContract } from "@cell/platform-contract"
import {
  AI_RUNTIME_DATA_SUBGRAPH_CONTRACTS,
  assertAiRuntimeLiveReadAllowed,
  createAiRuntimeDataSubgraphRegistry,
} from "../src"

const registry = createAiRuntimeDataSubgraphRegistry()

describe("not-owned-here: journal misuse", () => {
  it("rejects the effect WAL as live truth", () => {
    expect(registry.isAllowedLiveRead("control.effect_wal")).toBe(false)
    expect(() => assertAiRuntimeLiveReadAllowed(registry, "control.effect_wal")).toThrow(
      /append_only_journal/,
    )
  })

  it("tool call domain explicitly disowns the effect WAL and forbids reading it live", () => {
    const toolCall = registry.getContract("tool_call_domain")
    expect(toolCall?.notOwnedHere).toContain("control.effect_wal")
    expect(registry.isForbiddenLiveRead("tool_call_domain", "control.effect_wal")).toBe(true)
  })
})

describe("not-owned-here: checkpoint snapshot misuse", () => {
  it("rejects the snapshot durable subset as live truth", () => {
    expect(registry.isAllowedLiveRead("checkpoint.vm_durable_subset")).toBe(false)
    expect(() => assertAiRuntimeLiveReadAllowed(registry, "checkpoint.vm_durable_subset")).toThrow(
      /checkpoint_snapshot/,
    )
  })

  it("history and llm context may read the snapshot only during explicit recovery", () => {
    for (const componentId of ["history_domain", "llm_context_domain"] as const) {
      expect(registry.isAllowedRecoveryRead(componentId, "checkpoint.vm_durable_subset")).toBe(true)
      expect(registry.isForbiddenLiveRead(componentId, "checkpoint.vm_durable_subset")).toBe(true)
    }
  })

  it("rejects a snapshot component that tries to own formal history", () => {
    const snapshotThief: DataSubgraphContract = {
      id: "checkpoint_snapshot_thief",
      layer: "platform",
      ownedFactNodes: [{ nodeId: "history.committed_messages", grade: "checkpoint_snapshot" }],
      derivedNodes: [],
      writeCommands: [],
      readViews: ["checkpoint.recovery_view"],
      factStreams: [],
      projectionSinks: [],
      notOwnedHere: [],
      allowedRecoveryReads: [],
      forbiddenLiveReads: [],
    }
    expect(() =>
      createDataSubgraphContractRegistry([...AI_RUNTIME_DATA_SUBGRAPH_CONTRACTS, snapshotThief]),
    ).toThrow(/history\.committed_messages/)
  })
})

describe("not-owned-here: surface misuse", () => {
  it("rejects surface views as live truth", () => {
    expect(registry.isAllowedLiveRead("surface.tui_view")).toBe(false)
    expect(() => assertAiRuntimeLiveReadAllowed(registry, "surface.tui_view")).toThrow(/surface_view/)
  })

  it("surface projection exposes no domain write commands", () => {
    const surface = registry.getContract("surface_projection")
    expect(surface?.writeCommands).toEqual([])
    expect(registry.isWriteCommandOwnedBy("surface_projection", "history.append_committed_message")).toBe(false)
    expect(registry.isWriteCommandOwnedBy("history_domain", "history.append_committed_message")).toBe(true)
  })

  it("surface projection explicitly disowns domain truth nodes", () => {
    const surface = registry.getContract("surface_projection")
    expect(surface?.notOwnedHere).toEqual(
      expect.arrayContaining([
        "history.committed_messages",
        "llm_context.materialized_provider_context",
        "tool_call.result_attribution",
        "turn.state",
      ]),
    )
  })

  it("rejects a surface component that tries to own turn state", () => {
    const surfaceThief: DataSubgraphContract = {
      id: "surface_thief",
      layer: "surface",
      ownedFactNodes: [{ nodeId: "turn.state", grade: "surface_view" }],
      derivedNodes: [],
      writeCommands: [],
      readViews: ["surface.rendered_view"],
      factStreams: [],
      projectionSinks: [],
      notOwnedHere: [],
      allowedRecoveryReads: [],
      forbiddenLiveReads: [],
    }
    expect(() =>
      createDataSubgraphContractRegistry([...AI_RUNTIME_DATA_SUBGRAPH_CONTRACTS, surfaceThief]),
    ).toThrow(/turn\.state/)
  })
})

describe("not-owned-here: member/holon data components", () => {
  it("member/holon owns its roster/holon/detached facts but disowns the conversation truth split", () => {
    const memberHolon = registry.getContract("member_holon_data_components")
    expect(registry.findOwnerOfFactNode("member.roster")).toBe("member_holon_data_components")
    expect(registry.findOwnerOfFactNode("holon.governance")).toBe("member_holon_data_components")
    expect(registry.findOwnerOfFactNode("detached.tasks")).toBe("member_holon_data_components")
    expect(memberHolon?.notOwnedHere).toEqual(
      expect.arrayContaining([
        "history.committed_messages",
        "llm_context.materialized_provider_context",
        "tool_call.result_attribution",
        "turn.state",
      ]),
    )
  })

  it("rejects member/holon trying to own conversation history truth", () => {
    const conversationThief: DataSubgraphContract = {
      id: "member_holon_thief",
      layer: "domain",
      ownedFactNodes: [{ nodeId: "history.committed_messages", grade: "authoritative_fact" }],
      derivedNodes: [],
      writeCommands: [],
      readViews: ["member_holon.roster_view"],
      factStreams: [],
      projectionSinks: [],
      notOwnedHere: [],
      allowedRecoveryReads: [],
      forbiddenLiveReads: [],
    }
    expect(() =>
      createDataSubgraphContractRegistry([...AI_RUNTIME_DATA_SUBGRAPH_CONTRACTS, conversationThief]),
    ).toThrow(/history\.committed_messages/)
  })
})

describe("not-owned-here: declared contradictions are impossible to register", () => {
  it("every first-batch component is free of own/not-owned-here contradictions", () => {
    for (const contract of AI_RUNTIME_DATA_SUBGRAPH_CONTRACTS) {
      const ownedIds = new Set(contract.ownedFactNodes.map((node) => node.nodeId))
      for (const disowned of contract.notOwnedHere) {
        expect(ownedIds.has(disowned)).toBe(false)
      }
    }
  })
})
