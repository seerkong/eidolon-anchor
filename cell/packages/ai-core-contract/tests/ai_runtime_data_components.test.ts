import { describe, expect, it } from "bun:test"

import {
  AI_RUNTIME_DATA_COMPONENT_IDS,
  AI_RUNTIME_DATA_SUBGRAPH_CONTRACTS,
  AI_PROVIDER_CONTEXT_ALLOWED_INPUTS,
  AI_SESSION_HISTORY_HEAD_RESOLUTION_PRIORITY,
  createAiRuntimeDataSubgraphRegistry,
  type AiRuntimeDataComponentId,
} from "../src"

describe("AI runtime data components", () => {
  it("declares the first batch of ten components", () => {
    expect(AI_RUNTIME_DATA_COMPONENT_IDS).toEqual([
      "actor_runtime",
      "ai_turn_state",
      "history_domain",
      "llm_context_domain",
      "session_domain",
      "tool_call_domain",
      "provider_call_domain",
      "runtime_control",
      "checkpoint_snapshot",
      "surface_projection",
      "ingress_stage",
      "lexical_syntactic_stage",
      "semantic_event",
      "member_holon_data_components",
    ])
    expect(AI_RUNTIME_DATA_SUBGRAPH_CONTRACTS.map((contract) => contract.id)).toEqual(
      AI_RUNTIME_DATA_COMPONENT_IDS as unknown as string[],
    )
  })

  it("builds a registry without ownership conflicts", () => {
    const registry = createAiRuntimeDataSubgraphRegistry()
    expect(registry.contracts.length).toBe(14)
  })

  it("every component declares an owner boundary and an explicit Not Owned Here", () => {
    for (const contract of AI_RUNTIME_DATA_SUBGRAPH_CONTRACTS) {
      expect(contract.ownedFactNodes.length).toBeGreaterThan(0)
      expect(contract.notOwnedHere.length).toBeGreaterThan(0)
      expect(contract.readViews.length).toBeGreaterThan(0)
    }
  })

  it("history, llm context, and session domains own the conversation truth split", () => {
    const registry = createAiRuntimeDataSubgraphRegistry()
    expect(registry.findOwnerOfFactNode("history.committed_messages")).toBe("history_domain")
    expect(registry.findOwnerOfFactNode("llm_context.materialized_provider_context")).toBe("llm_context_domain")
    expect(registry.findOwnerOfFactNode("session.active_actor_binding")).toBe("session_domain")
    expect(registry.findOwnerOfFactNode("session.active_history_head")).toBe("session_domain")
  })

  it("llm context aligns with the existing prompt domain concepts", () => {
    const registry = createAiRuntimeDataSubgraphRegistry()
    const llmContext = registry.getContract("llm_context_domain")
    const ownedIds = llmContext?.ownedFactNodes.map((node) => node.nodeId) ?? []
    expect(ownedIds).toContain("llm_context.generation")
    expect(ownedIds).toContain("llm_context.basis")
    expect(ownedIds).toContain("llm_context.transforms")
    expect(ownedIds).toContain("llm_context.materialized_provider_context")
    expect(llmContext?.notOwnedHere).toContain("history.committed_messages")
  })

  it("tool call domain owns protocol pairing but not effect IO lifecycle", () => {
    const registry = createAiRuntimeDataSubgraphRegistry()
    const toolCall = registry.getContract("tool_call_domain")
    expect(registry.findOwnerOfFactNode("tool_call.result_attribution")).toBe("tool_call_domain")
    expect(toolCall?.notOwnedHere).toContain("control.effect_wal")
    expect(registry.findOwnerOfFactNode("control.effect_wal")).toBe("runtime_control")
  })

  it("declares the lifecycle-track fact nodes: tool gate decision, provider reasoning/content split, turn wait boundary", () => {
    const registry = createAiRuntimeDataSubgraphRegistry()
    // P4: gate decision is an owned ToolCall fact (decision-stored-in-domain).
    expect(registry.findOwnerOfFactNode("tool_call.gate_decision")).toBe("tool_call_domain")
    // P5: reasoning and content are two distinct owned ProviderCall facts.
    expect(registry.findOwnerOfFactNode("provider_call.reasoning")).toBe("provider_call_domain")
    expect(registry.findOwnerOfFactNode("provider_call.content")).toBe("provider_call_domain")
    // P1: the human/tool/provider/questionnaire wait boundary is an owned TurnState fact (G-ai-wait-message).
    expect(registry.findOwnerOfFactNode("turn.wait_boundary")).toBe("ai_turn_state")
    const turn = registry.getContract("ai_turn_state")
    expect(turn?.readViews).toContain("turn.wait_view")
    const provider = registry.getContract("provider_call_domain")
    expect(provider?.readViews).toContain("provider_call.reasoning_view")
  })

  it("runtime control does not own conversation or tool result truth", () => {
    const registry = createAiRuntimeDataSubgraphRegistry()
    const runtimeControl = registry.getContract("runtime_control")
    expect(runtimeControl?.notOwnedHere).toContain("history.committed_messages")
    expect(runtimeControl?.notOwnedHere).toContain("llm_context.materialized_provider_context")
    expect(runtimeControl?.notOwnedHere).toContain("tool_call.result_attribution")
  })

  it("checkpoint snapshot owns only the declared durable subset", () => {
    const registry = createAiRuntimeDataSubgraphRegistry()
    const checkpoint = registry.getContract("checkpoint_snapshot")
    expect(registry.findOwnerOfFactNode("checkpoint.vm_durable_subset")).toBe("checkpoint_snapshot")
    expect(registry.classifyFactNode("checkpoint.vm_durable_subset")).toBe("checkpoint_snapshot")
    expect(checkpoint?.notOwnedHere).toContain("history.committed_messages")
    expect(checkpoint?.notOwnedHere).toContain("llm_context.materialized_provider_context")
    expect(checkpoint?.notOwnedHere).toContain("control.signal_payloads")
  })

  it("declares provider context legal inputs as exactly llm context, history active tail, and session binding", () => {
    expect(AI_PROVIDER_CONTEXT_ALLOWED_INPUTS).toEqual([
      { componentId: "llm_context_domain", readView: "llm_context.provider_request_view" },
      { componentId: "history_domain", readView: "history.active_tail" },
      { componentId: "session_domain", readView: "session.active_binding" },
    ])
    const componentIds: AiRuntimeDataComponentId[] = AI_PROVIDER_CONTEXT_ALLOWED_INPUTS.map(
      (input) => input.componentId,
    )
    expect(componentIds).not.toContain("runtime_control")
    expect(componentIds).not.toContain("checkpoint_snapshot")
    expect(componentIds).not.toContain("surface_projection")
  })

  it("declares a single session history head resolution priority", () => {
    expect(AI_SESSION_HISTORY_HEAD_RESOLUTION_PRIORITY).toEqual([
      "llm_context_prompt_target_reference",
      "session_declared_history_head",
    ])
  })

  it("member/holon data components contract is registered with member/holon/detached owned facts and single owners", () => {
    const registry = createAiRuntimeDataSubgraphRegistry()
    const memberHolon = registry.getContract("member_holon_data_components")
    expect(memberHolon).not.toBeNull()
    // P1: roster / holon governance / detached tasks each owned by this single component.
    expect(registry.findOwnerOfFactNode("member.roster")).toBe("member_holon_data_components")
    expect(registry.findOwnerOfFactNode("holon.governance")).toBe("member_holon_data_components")
    expect(registry.findOwnerOfFactNode("detached.tasks")).toBe("member_holon_data_components")
    const ownedIds = memberHolon?.ownedFactNodes.map((node) => node.nodeId) ?? []
    expect(ownedIds).toEqual(["member.roster", "holon.governance", "detached.tasks"])
    // Live runtime facts: graded as authoritative (live-truth capable, single writer).
    for (const node of memberHolon?.ownedFactNodes ?? []) {
      expect(node.grade).toBe("authoritative_fact")
    }
  })

  it("member/holon data components declares its single-writer commands and read views", () => {
    const registry = createAiRuntimeDataSubgraphRegistry()
    const memberHolon = registry.getContract("member_holon_data_components")
    expect(memberHolon?.writeCommands).toEqual([
      "member_holon.upsert_roster_record",
      "member_holon.update_holon_governance",
      "member_holon.upsert_detached_task",
    ])
    expect(memberHolon?.readViews).toEqual([
      "member_holon.roster_view",
      "member_holon.holon_governance_view",
      "member_holon.detached_tasks_view",
    ])
    expect(registry.isWriteCommandOwnedBy("member_holon_data_components", "member_holon.upsert_roster_record")).toBe(true)
  })

  it("member/holon data components explicitly disowns the conversation-truth owned facts (history/llm-context/tool-call/turn)", () => {
    const registry = createAiRuntimeDataSubgraphRegistry()
    const memberHolon = registry.getContract("member_holon_data_components")
    expect(memberHolon?.notOwnedHere).toEqual(
      expect.arrayContaining([
        "history.committed_messages",
        "llm_context.materialized_provider_context",
        "tool_call.result_attribution",
        "turn.state",
      ]),
    )
    // The conversation-truth nodes remain owned by their real domains, not member/holon.
    expect(registry.findOwnerOfFactNode("history.committed_messages")).toBe("history_domain")
    expect(registry.findOwnerOfFactNode("llm_context.materialized_provider_context")).toBe("llm_context_domain")
    expect(registry.findOwnerOfFactNode("tool_call.result_attribution")).toBe("tool_call_domain")
    expect(registry.findOwnerOfFactNode("turn.state")).toBe("ai_turn_state")
  })
})
