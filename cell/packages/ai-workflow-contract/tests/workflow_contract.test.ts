import { describe, expect, it } from "bun:test"

import {
  AI_CTRL_WORKFLOW_DESCRIPTOR,
  AI_DATA_WORKFLOW_DESCRIPTOR,
  AI_WORKFLOW_FORMS,
  AI_WORKFLOW_MACHINE_NODE_DEFAULT_REUSE_POLICY,
  AI_WORKFLOW_MANUAL_NODE_DEFAULT_REUSE_POLICY,
  AI_WORKFLOW_DATA_COMPONENT_ID,
  AI_WORKFLOW_DATA_SUBGRAPH_CONTRACT,
  createAiWorkflowDataSubgraphRegistry,
  validateAiWorkflowResourceRef,
} from "../src"

describe("AI workflow contract", () => {
  it("projects canonical depa-flows workflow descriptors and reuse defaults", () => {
    expect(AI_WORKFLOW_FORMS).toEqual(["AICtrlWorkflow", "AIDataWorkflow"])
    expect(AI_CTRL_WORKFLOW_DESCRIPTOR).toMatchObject({
      kind: "AICtrlWorkflow",
      substrate: "WorkCtrlFlow",
    })
    expect(AI_DATA_WORKFLOW_DESCRIPTOR).toMatchObject({
      kind: "AIDataWorkflow",
      substrate: "EagerDataFlow",
    })
    expect(AI_WORKFLOW_MACHINE_NODE_DEFAULT_REUSE_POLICY).toBe("semantic-hash")
    expect(AI_WORKFLOW_MANUAL_NODE_DEFAULT_REUSE_POLICY).toBe("never")
  })

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
      "vfs:///host/app",
      "vfs://folder/manifest.xnl",
      "vfs://./folder\\escape.xnl",
      "resource://../escape",
      "secret://safe/%2e%2e/escape",
    ]) {
      expect(validateAiWorkflowResourceRef(ref).ok).toBe(false)
    }
  })
})
