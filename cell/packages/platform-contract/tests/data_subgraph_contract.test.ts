import { describe, expect, it } from "bun:test"

import {
  DATA_FACT_GRADES,
  LIVE_TRUTH_CAPABLE_FACT_GRADES,
  isLiveTruthCapableFactGrade,
  createDataSubgraphContractRegistry,
  type DataFactGrade,
  type DataNodeDeclaration,
  type DataSubgraphContract,
} from "../src"

function makeContract(overrides: Partial<DataSubgraphContract> & { id: string }): DataSubgraphContract {
  return {
    layer: "domain",
    ownedFactNodes: [],
    derivedNodes: [],
    writeCommands: [],
    readViews: [],
    factStreams: [],
    projectionSinks: [],
    notOwnedHere: [],
    allowedRecoveryReads: [],
    forbiddenLiveReads: [],
    ...overrides,
  }
}

describe("data fact grades", () => {
  it("exports the full fact grade ladder in stable order", () => {
    expect(DATA_FACT_GRADES).toEqual([
      "authoritative_fact",
      "domain_canonical_event",
      "runtime_control_fact",
      "append_only_journal",
      "checkpoint_snapshot",
      "derived_projection_cache",
      "surface_view",
      "legacy_mixed",
    ])
  })

  it("only authoritative, domain canonical, and runtime control grades are live-truth capable", () => {
    expect(LIVE_TRUTH_CAPABLE_FACT_GRADES).toEqual([
      "authoritative_fact",
      "domain_canonical_event",
      "runtime_control_fact",
    ])
    const liveTruthVerdicts = Object.fromEntries(
      DATA_FACT_GRADES.map((grade) => [grade, isLiveTruthCapableFactGrade(grade)]),
    )
    expect(liveTruthVerdicts).toEqual({
      authoritative_fact: true,
      domain_canonical_event: true,
      runtime_control_fact: true,
      append_only_journal: false,
      checkpoint_snapshot: false,
      derived_projection_cache: false,
      surface_view: false,
      legacy_mixed: false,
    })
  })
})

describe("DataSubgraphContract shape", () => {
  it("declares owner boundaries: owned facts, derived nodes, write commands, read views, not-owned-here", () => {
    const ownedNode: DataNodeDeclaration = {
      nodeId: "history.committed_messages",
      grade: "authoritative_fact",
    }
    const derivedNode: DataNodeDeclaration = {
      nodeId: "history.visible_view",
      grade: "derived_projection_cache",
    }
    const contract = makeContract({
      id: "history_domain",
      layer: "domain",
      ownedFactNodes: [ownedNode],
      derivedNodes: [derivedNode],
      writeCommands: ["history.append_committed_message"],
      readViews: ["history.active_tail"],
      factStreams: ["history.domain_events"],
      projectionSinks: ["surface.visible_history"],
      notOwnedHere: ["llm_context.materialized_provider_context"],
      allowedRecoveryReads: ["checkpoint.vm_durable_subset"],
      forbiddenLiveReads: ["checkpoint.vm_durable_subset", "journal.effect_wal"],
    })

    const registry = createDataSubgraphContractRegistry([contract])

    expect(registry.getContract("history_domain")?.id).toBe("history_domain")
    expect(registry.findOwnerOfFactNode("history.committed_messages")).toBe("history_domain")
    expect(registry.classifyFactNode("history.committed_messages")).toBe("authoritative_fact")
    expect(registry.classifyFactNode("history.visible_view")).toBe("derived_projection_cache")
    expect(registry.getContract("history_domain")?.writeCommands).toContain("history.append_committed_message")
    expect(registry.getContract("history_domain")?.readViews).toContain("history.active_tail")
    expect(registry.getContract("history_domain")?.notOwnedHere).toContain(
      "llm_context.materialized_provider_context",
    )
  })

  it("answers live-read, recovery-read, and write-command ownership questions", () => {
    const contract = makeContract({
      id: "history_domain",
      ownedFactNodes: [{ nodeId: "history.committed_messages", grade: "authoritative_fact" }],
      writeCommands: ["history.append_committed_message"],
      allowedRecoveryReads: ["checkpoint.vm_durable_subset"],
      forbiddenLiveReads: ["checkpoint.vm_durable_subset", "journal.effect_wal"],
    })
    const journal = makeContract({
      id: "journal_sink",
      ownedFactNodes: [{ nodeId: "journal.effect_wal", grade: "append_only_journal" }],
    })
    const registry = createDataSubgraphContractRegistry([contract, journal])

    expect(registry.isAllowedLiveRead("history.committed_messages")).toBe(true)
    expect(registry.isAllowedLiveRead("journal.effect_wal")).toBe(false)
    expect(registry.isAllowedRecoveryRead("history_domain", "checkpoint.vm_durable_subset")).toBe(true)
    expect(registry.isAllowedRecoveryRead("history_domain", "journal.effect_wal")).toBe(false)
    expect(registry.isForbiddenLiveRead("history_domain", "journal.effect_wal")).toBe(true)
    expect(registry.isWriteCommandOwnedBy("history_domain", "history.append_committed_message")).toBe(true)
    expect(registry.isWriteCommandOwnedBy("journal_sink", "history.append_committed_message")).toBe(false)
  })
})

describe("DataSubgraphContract registry validation", () => {
  it("rejects duplicate component ids", () => {
    expect(() =>
      createDataSubgraphContractRegistry([makeContract({ id: "dup" }), makeContract({ id: "dup" })]),
    ).toThrow(/dup/)
  })

  it("rejects two components owning the same fact node", () => {
    const a = makeContract({
      id: "component_a",
      ownedFactNodes: [{ nodeId: "shared.node", grade: "authoritative_fact" }],
    })
    const b = makeContract({
      id: "component_b",
      ownedFactNodes: [{ nodeId: "shared.node", grade: "authoritative_fact" }],
    })
    expect(() => createDataSubgraphContractRegistry([a, b])).toThrow(/shared\.node/)
  })

  it("rejects a component owning a node it declares as not-owned-here", () => {
    const contradictory = makeContract({
      id: "contradictory",
      ownedFactNodes: [{ nodeId: "history.committed_messages", grade: "authoritative_fact" }],
      notOwnedHere: ["history.committed_messages"],
    })
    expect(() => createDataSubgraphContractRegistry([contradictory])).toThrow(/not-owned-here|notOwnedHere/)
  })

  it("rejects a fact node graded as projection, journal, checkpoint, or surface being declared an owned authoritative fact under a different grade by a second component", () => {
    const journalOwner = makeContract({
      id: "journal_owner",
      ownedFactNodes: [{ nodeId: "journal.effect_wal", grade: "append_only_journal" }],
    })
    const truthThief = makeContract({
      id: "truth_thief",
      ownedFactNodes: [{ nodeId: "journal.effect_wal", grade: "authoritative_fact" }],
    })
    expect(() => createDataSubgraphContractRegistry([journalOwner, truthThief])).toThrow(/journal\.effect_wal/)
  })
})
