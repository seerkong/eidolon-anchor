import { describe, expect, it } from "bun:test"

import {
  AI_WORKFLOW_DATA_COMPONENT_ID,
  AI_WORKFLOW_DATA_SUBGRAPH_CONTRACT,
  createAiWorkflowDataSubgraphRegistry,
  validateAiWorkflowResourceRef,
} from "../src"

describe("AI workflow contract", () => {
  it("declares an additive workflow data-subgraph owner", () => {
    const registry = createAiWorkflowDataSubgraphRegistry()
    expect(registry.getContract(AI_WORKFLOW_DATA_COMPONENT_ID)).toBe(AI_WORKFLOW_DATA_SUBGRAPH_CONTRACT)
    expect(registry.findOwnerOfFactNode("workflow.run_graph")).toBe(AI_WORKFLOW_DATA_COMPONENT_ID)
    expect(registry.findOwnerOfFactNode("workflow.node_runtime_refs")).toBe(AI_WORKFLOW_DATA_COMPONENT_ID)
  })

  it("explicitly disowns existing Eidolon runtime fact authorities", () => {
    expect(AI_WORKFLOW_DATA_SUBGRAPH_CONTRACT.notOwnedHere).toEqual(
      expect.arrayContaining([
        "actor.registry",
        "actor.fiber_registry",
        "history.committed_messages",
        "llm_context.materialized_provider_context",
        "tool_call.result_attribution",
        "provider_call.content",
        "control.effect_wal",
        "checkpoint.vm_durable_subset",
        "member.roster",
        "holon.governance",
        "detached.tasks",
      ]),
    )
    expect(AI_WORKFLOW_DATA_SUBGRAPH_CONTRACT.forbiddenLiveReads).toContain("control.effect_wal")
    expect(AI_WORKFLOW_DATA_SUBGRAPH_CONTRACT.forbiddenLiveReads).toContain("checkpoint.vm_durable_subset")
  })

  it("validates safe workflow resource refs and rejects host/escape refs", () => {
    for (const ref of [
      "vfs://./workflow/manifest.xnl",
      "vfs://@/shared/workflows/catalog.xnl",
      "resource://depa.flows.demo.Workflow",
      "config://workflow/default",
      "secret://ai-provider/api-key",
    ]) {
      expect(validateAiWorkflowResourceRef(ref).ok).toBe(true)
    }

    for (const ref of [
      "/host/app",
      "./workflow/manifest.xnl",
      "../escape.xnl",
      "file:///host/app",
      "https://example.com/workflow",
      "vfs://../escape.xnl",
      "vfs://.%2e/escape.xnl",
      "vfs://./folder\\escape.xnl",
      "resource://../escape",
    ]) {
      expect(validateAiWorkflowResourceRef(ref).ok).toBe(false)
    }
  })
})
