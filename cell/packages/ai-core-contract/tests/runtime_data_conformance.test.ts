import { describe, expect, it } from "bun:test"

import {
  AI_PROVIDER_CONTEXT_ALLOWED_INPUTS,
  AI_SESSION_HISTORY_HEAD_RESOLUTION_PRIORITY,
  assertAiRuntimeLiveReadAllowed,
  createAiRuntimeDataSubgraphRegistry,
  listAiProviderContextViolations,
} from "../src"

const registry = createAiRuntimeDataSubgraphRegistry()

/**
 * Conformance: Provider Context and Tool Result Truth (T3.1).
 * Cases mirror the spec suite `not-live-truth` / `core-components` and the
 * historical incidents behind them (pending bash effect, repeated tool reads).
 */
describe("conformance: pending effect is not provider-visible tool result", () => {
  it("given pending tool effect evidence in the effect WAL, assembling provider context from it is a violation", () => {
    const violations = listAiProviderContextViolations([
      { componentId: "runtime_control", readView: "control.effect_wal" },
    ])
    expect(violations.length).toBe(1)
    expect(violations[0]).toMatch(/control\.effect_wal/)
  })

  it("tool result truth is owned by the tool call domain, not by effect evidence", () => {
    expect(registry.findOwnerOfFactNode("tool_call.result_attribution")).toBe("tool_call_domain")
    expect(registry.classifyFactNode("tool_call.result_attribution")).toBe("authoritative_fact")
    expect(registry.classifyFactNode("control.effect_wal")).toBe("append_only_journal")
    expect(registry.isAllowedLiveRead("control.effect_wal")).toBe(false)
  })
})

describe("conformance: provider context has exactly one set of legal inputs", () => {
  it("accepts the three declared inputs: llm context view, history active tail, session binding", () => {
    expect(listAiProviderContextViolations([...AI_PROVIDER_CONTEXT_ALLOWED_INPUTS])).toEqual([])
  })

  it("rejects journal, checkpoint, and surface sources", () => {
    const violations = listAiProviderContextViolations([
      { componentId: "runtime_control", readView: "control.effect_wal" },
      { componentId: "checkpoint_snapshot", readView: "checkpoint.recovery_view" },
      { componentId: "surface_projection", readView: "surface.tui_view" },
      { componentId: "history_domain", readView: "history.active_tail" },
    ])
    expect(violations.length).toBe(3)
    expect(violations.join("\n")).toMatch(/control\.effect_wal/)
    expect(violations.join("\n")).toMatch(/checkpoint\.recovery_view/)
    expect(violations.join("\n")).toMatch(/surface\.tui_view/)
  })

  it("rejects an undeclared read view even from an allowed component", () => {
    const violations = listAiProviderContextViolations([
      { componentId: "history_domain", readView: "history.visible_history" },
    ])
    expect(violations.length).toBe(1)
  })
})

describe("conformance: session history head resolution is a single declared rule", () => {
  it("declares prompt-target reference before declared history head, and nothing else", () => {
    expect(AI_SESSION_HISTORY_HEAD_RESOLUTION_PRIORITY).toEqual([
      "llm_context_prompt_target_reference",
      "session_declared_history_head",
    ])
  })

  it("both heads are owned by the session domain alone", () => {
    expect(registry.findOwnerOfFactNode("session.active_history_head")).toBe("session_domain")
    expect(registry.findOwnerOfFactNode("session.active_llm_context_head")).toBe("session_domain")
  })
})

/**
 * Conformance: Formal History and Surface Projection (T3.2).
 */
describe("conformance: checkpoint snapshot does not own formal history", () => {
  it("given actor/fiber state inside a snapshot, reading it as Formal History is forbidden", () => {
    expect(() => assertAiRuntimeLiveReadAllowed(registry, "checkpoint.vm_durable_subset")).toThrow()
    expect(registry.isForbiddenLiveRead("history_domain", "checkpoint.vm_durable_subset")).toBe(true)
    expect(registry.getContract("checkpoint_snapshot")?.notOwnedHere).toContain("history.committed_messages")
  })

  it("snapshot content has a single declared owner and excludes control signal payloads", () => {
    expect(registry.findOwnerOfFactNode("checkpoint.vm_durable_subset")).toBe("checkpoint_snapshot")
    expect(registry.getContract("checkpoint_snapshot")?.notOwnedHere).toContain("control.signal_payloads")
  })

  it("history persistence lag does not affect live provider context: live inputs never include persisted history files", () => {
    const liveInputNodes = AI_PROVIDER_CONTEXT_ALLOWED_INPUTS.map((input) => input.readView)
    expect(liveInputNodes).not.toContain("checkpoint.recovery_view")
    expect(liveInputNodes).not.toContain("control.effect_wal")
    for (const input of AI_PROVIDER_CONTEXT_ALLOWED_INPUTS) {
      const contract = registry.getContract(input.componentId)
      expect(contract?.readViews).toContain(input.readView)
    }
  })
})

describe("conformance: surface hydration never writes domain truth", () => {
  it("given TUI hydration read persistence, surface updates must not write History, ToolCall, or TurnState owned facts", () => {
    const surface = registry.getContract("surface_projection")
    expect(surface?.writeCommands).toEqual([])
    for (const truthNode of ["history.committed_messages", "tool_call.result_attribution", "turn.state"]) {
      expect(registry.findOwnerOfFactNode(truthNode)).not.toBe("surface_projection")
      expect(surface?.notOwnedHere).toContain(truthNode)
    }
  })
})
