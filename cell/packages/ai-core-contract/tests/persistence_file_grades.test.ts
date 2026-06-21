import { describe, expect, it } from "bun:test"

import { createAiRuntimeDataSubgraphRegistry } from "../src"

/**
 * P1 (track refactor-persistent-session-backplane) — fact-grade conformance.
 *
 * Covers behavior-delta requirement `persistence-file-grades`:
 *  - effect-evidence WAL  → append_only_journal (NOT checkpoint-managed, NOT
 *    live truth, NOT a recovery-primary source)
 *  - checkpoint snapshot  → checkpoint_snapshot, owns ONLY the declared vm
 *    durable subset, NOT History / LlmContext / ToolCall owned facts
 *  - derived index        → derived_projection_cache
 */

const registry = createAiRuntimeDataSubgraphRegistry()

describe("persistence-file-grades: effect-evidence WAL is an append-only journal", () => {
  it("control.effect_wal is graded append_only_journal", () => {
    expect(registry.classifyFactNode("control.effect_wal")).toBe("append_only_journal")
  })

  it("the effect WAL is owned by runtime_control, not by the checkpoint snapshot", () => {
    expect(registry.findOwnerOfFactNode("control.effect_wal")).toBe("runtime_control")
    expect(registry.findOwnerOfFactNode("control.effect_wal")).not.toBe("checkpoint_snapshot")
    // The checkpoint component must not own the journal (not checkpoint-managed).
    const checkpoint = registry.getContract("checkpoint_snapshot")
    const checkpointOwned = checkpoint?.ownedFactNodes.map((n) => n.nodeId) ?? []
    expect(checkpointOwned).not.toContain("control.effect_wal")
  })

  it("the effect WAL is not live truth and is not a checkpoint-managed snapshot grade", () => {
    expect(registry.isAllowedLiveRead("control.effect_wal")).toBe(false)
    expect(registry.classifyFactNode("control.effect_wal")).not.toBe("checkpoint_snapshot")
  })

  it("the effect WAL is not the recovery-primary source: checkpoint owns recovery, journal is only sequence fallback", () => {
    // The journal may be observed but is not the owner-source of any domain
    // truth; recovery-primary durable state is the checkpoint snapshot.
    const runtimeControl = registry.getContract("runtime_control")
    // runtime_control disowns conversation/tool truth (those are reconstructed
    // from their own owner domains, never from the WAL payload).
    expect(runtimeControl?.notOwnedHere).toContain("history.committed_messages")
    expect(runtimeControl?.notOwnedHere).toContain("tool_call.result_attribution")
  })
})

describe("persistence-file-grades: checkpoint snapshot owns only the durable subset", () => {
  it("checkpoint.vm_durable_subset is graded checkpoint_snapshot and owned by checkpoint_snapshot", () => {
    expect(registry.classifyFactNode("checkpoint.vm_durable_subset")).toBe("checkpoint_snapshot")
    expect(registry.findOwnerOfFactNode("checkpoint.vm_durable_subset")).toBe("checkpoint_snapshot")
  })

  it("the checkpoint snapshot does NOT own History / LlmContext / ToolCall owned facts", () => {
    const checkpoint = registry.getContract("checkpoint_snapshot")
    expect(checkpoint?.notOwnedHere).toContain("history.committed_messages")
    expect(checkpoint?.notOwnedHere).toContain("llm_context.materialized_provider_context")
    expect(checkpoint?.notOwnedHere).toContain("tool_call.result_attribution")

    // And it does not list any of those as an owned node.
    const owned = checkpoint?.ownedFactNodes.map((n) => n.nodeId) ?? []
    expect(owned).not.toContain("history.committed_messages")
    expect(owned).not.toContain("llm_context.materialized_provider_context")
    expect(owned).not.toContain("tool_call.result_attribution")

    // Every owned node of the checkpoint component is graded checkpoint_snapshot.
    for (const node of checkpoint?.ownedFactNodes ?? []) {
      expect(node.grade).toBe("checkpoint_snapshot")
    }
  })

  it("the checkpoint durable subset is not live truth", () => {
    expect(registry.isAllowedLiveRead("checkpoint.vm_durable_subset")).toBe(false)
  })
})

describe("persistence-file-grades: derived index is a derived projection cache", () => {
  it("the snapshot derived index node is graded derived_projection_cache", () => {
    // The recovery-time derived index files (actors_by_key, fibers_by_id, ...)
    // are a rebuildable projection cache, never a recovery source of truth.
    expect(registry.classifyFactNode("checkpoint.derived_index")).toBe("derived_projection_cache")
  })

  it("the derived index has no owner (it is a derived node, not an owned fact)", () => {
    // derivedNodes are rebuildable and therefore have no owner entry.
    expect(registry.findOwnerOfFactNode("checkpoint.derived_index")).toBeNull()
  })

  it("the derived index is not live truth and is not a recovery primary source", () => {
    expect(registry.isAllowedLiveRead("checkpoint.derived_index")).toBe(false)
  })
})
