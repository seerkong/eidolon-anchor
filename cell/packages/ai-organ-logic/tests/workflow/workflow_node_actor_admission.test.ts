import { describe, expect, it } from "bun:test"

import { createActor, hydrateActor, serializeActor } from "@cell/ai-core-logic"
import {
  assertWorkflowNodeActorIsolation,
  assertWorkflowNodeAgentConfigIsolation,
  createWorkflowNodeActorOrigin,
} from "../../src/workflow/runtime/WorkflowNodeActorAdmission"
import { buildBuiltinToolDefs } from "../../src/composer/AIAgent/ToolFuncBuiltin"
import {
  WORKFLOW_LIFECYCLE_DEFINITION_TOOL_NAMES,
  WORKFLOW_PUBLIC_GATEWAY_TOOL_NAMES,
} from "../../src/workflow/tools/WorkflowToolCatalog"

function nodeActor(toolNames: readonly string[]) {
  return createActor({
    key: "node",
    agentName: "resource://demo.agent.Node",
    origin: createWorkflowNodeActorOrigin({ runId: "run-1", generation: 1, nodeId: "node", effectId: "effect-1" }),
    llmClient: null,
    modelConfig: { model: "mock" },
    systemPrompts: ["frozen AgentDefinition instruction"],
    toolPolicy: {
      allowedToolsMode: "exact",
      allowedTools: [...toolNames],
      enabledToolKeys: [],
      disabledToolKeys: [],
    },
    callbacks: { buildToolset: () => [], processStream: async () => null },
  })
}

describe("Workflow node Actor admission", () => {
  it("keeps ordinary and node schemas structurally disjoint from lifecycle-internal presentation", () => {
    const ordinary = createActor({ key: "ordinary" })
    const node = nodeActor(["WorkflowAuthor"])
    const publicSchemas = buildBuiltinToolDefs({ includeInternalOnly: false })
      .map((definition) => definition.schema.function.name)
    expect(publicSchemas.filter((name) => WORKFLOW_LIFECYCLE_DEFINITION_TOOL_NAMES.includes(name as any))).toEqual([])
    expect(publicSchemas.filter((name) => WORKFLOW_PUBLIC_GATEWAY_TOOL_NAMES.includes(name as any))).toEqual([
      "WorkflowFulfill",
      "WorkflowAuthor",
    ])
    for (const actor of [ordinary, node]) {
      expect(actor.runtimeFacets).toEqual({})
      expect(actor.origin?.proofDigest ?? null).not.toBe("workflow_lifecycle")
      expect(actor.systemPrompts.join("\n")).not.toContain("sys-eidolon-anchor-devops")
      expect(actor.toolPolicy.providerToolSurface?.toolNames ?? []).not.toEqual(
        expect.arrayContaining([...WORKFLOW_LIFECYCLE_DEFINITION_TOOL_NAMES]),
      )
    }
  })

  it("keeps an explicitly declared public gateway without minting lifecycle authority", () => {
    const actor = nodeActor(["WorkflowFulfill"])
    expect(() => assertWorkflowNodeActorIsolation(actor)).not.toThrow()
    expect(actor.runtimeFacets).toEqual({})
    expect(actor.toolPolicy.allowedTools).toEqual(["WorkflowFulfill"])
    expect(actor.systemPrompts).toEqual(["frozen AgentDefinition instruction"])
  })

  it("accepts only the frozen exact AgentDefinition tool list and no managed lifecycle Skill", () => {
    expect(() => assertWorkflowNodeAgentConfigIsolation({
      name: "resource://demo.agent.Node",
      tools: ["WorkflowAuthor", "Read"],
      requireExactTools: true,
      prompt: [],
      seedMessages: [{ role: "system", content: "frozen node instruction" }],
    })).not.toThrow()
    expect(() => assertWorkflowNodeAgentConfigIsolation({
      name: "resource://demo.agent.Node",
      tools: "*",
      requireExactTools: true,
      prompt: [],
    })).toThrow("requires an exact declared tool list")
    expect(() => assertWorkflowNodeAgentConfigIsolation({
      name: "resource://demo.agent.Node",
      tools: [],
      requireExactTools: true,
      prompt: ["name: sys-eidolon-anchor-devops"],
    })).toThrow("cannot admit the managed lifecycle Skill")
  })

  it("rejects a recovered node snapshot carrying a lifecycle-internal tool", () => {
    const recovered = hydrateActor(serializeActor(nodeActor(["WorkflowRun"])))
    expect(() => assertWorkflowNodeActorIsolation(recovered)).toThrow(
      "frozen Agent task cannot admit lifecycle-internal tool 'WorkflowRun'",
    )
  })
})
