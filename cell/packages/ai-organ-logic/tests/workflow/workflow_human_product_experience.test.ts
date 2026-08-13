import { describe, expect, it } from "bun:test"

import corpus from "./fixtures/workflow-human-product-corpus.json"
import { assembleWorkflowFulfillmentPrompt } from "../../src/workflow"
import { WORKFLOW_NATIVE_TOOL_NAMES, buildWorkflowNativeToolDefs } from "../../src/workflow/tools"
import {
  applyAiWorkflowStageSystemContext,
  applyAiWorkflowStageToolPolicy,
} from "../../src/workflow/tools/WorkflowLoadStageContext"
import { BUILTIN_CODING_AGENT_CONFIGS } from "@cell/mod-ai-coding/agent"

describe("workflow human product experience", () => {
  it("preserves a business-language corpus for model-owned semantic routing", () => {
    for (const entry of corpus) {
      const prompt = assembleWorkflowFulfillmentPrompt({ request: entry.request })
      expect(prompt).toContain(entry.request)
      expect(prompt).not.toContain(`"route": "${entry.route}"`)
      expect(prompt).not.toContain(`"scenario": "${entry.scenario}"`)
    }
    expect(JSON.stringify(corpus)).not.toMatch(/AICtrlWorkflow|AIDataWorkflow|node_id|reuse_policy|manifest\.xnl|resource:\/\//)
  })

  it("records independent publication/execution authorization without interpreting the request", () => {
    const prompt = assembleWorkflowFulfillmentPrompt({
      request: "并行调研三个方向，合并结果后等待负责人批准。",
      publish: true,
      execute: false,
    })
    expect(prompt).toContain('"publication": true')
    expect(prompt).toContain('"execution": false')
    expect(prompt).not.toMatch(/approval-process|composite/)
  })

  it("passes only the current structured invocation instead of building workflow-specific history", () => {
    const prompt = assembleWorkflowFulfillmentPrompt({
      request: "Proceed with the confirmed recommendation and publish it.",
      publish: false,
      execute: false,
    })
    expect(prompt).not.toContain("eidolon.aiWorkflowPriorConversation")
    expect(prompt).toContain('"publication": false')
    expect(prompt).toContain('"execution": false')
  })

  it("assembles an executable native-tool journey rather than a user-facing DSL lesson", () => {
    const prompt = assembleWorkflowFulfillmentPrompt({
      request: "读取访谈材料，分别提炼观点，合并为报告并执行。",
      publish: true,
      execute: true,
    })
    expect(prompt).toContain("WorkflowLoadStageContext")
    expect(prompt).toContain("sys-ai-workflow")
    expect(prompt).not.toContain("WorkflowOpenAuthoringSession")
    expect(prompt).not.toContain("minimal-ai-data")
  })

  it("registers WorkflowFulfill as the ordinary-language native entry", () => {
    expect(WORKFLOW_NATIVE_TOOL_NAMES[0]).toBe("WorkflowFulfill")
    expect(WORKFLOW_NATIVE_TOOL_NAMES).toContain("WorkflowLoadStageContext")
    const tool = buildWorkflowNativeToolDefs().find((item) => item.schema.function.name === "WorkflowFulfill")
    expect(tool?.schema.function.parameters.required).toEqual(["request"])
    expect(tool?.schema.function.description).toContain("business goal")
  })

  it("gives the dedicated actor a workflow-only tool surface", () => {
    const tools = BUILTIN_CODING_AGENT_CONFIGS.workflow?.tools
    expect(tools).not.toBe("*")
    expect(tools).toContain("WorkflowLoadStageContext")
    expect(tools).not.toContain("WorkflowFulfill")
    expect(tools).not.toContain("Bash")
    expect(tools).not.toContain("Write")
  })

  it("narrows the actor tool policy after an explicit stage selection", () => {
    const actor = { toolPolicy: { allowedTools: ["WorkflowWorkspace", "WorkflowRun"] } }
    const coding = applyAiWorkflowStageToolPolicy(actor, "coding")
    expect(coding).toContain("WorkflowWorkspace")
    expect(coding).not.toContain("WorkflowRun")
    const monitoring = applyAiWorkflowStageToolPolicy(actor, "monitoring")
    expect(monitoring).toContain("WorkflowResult")
    expect(monitoring).not.toContain("WorkflowWorkspace")
    expect(actor.toolPolicy.allowedTools).toEqual(monitoring)
  })

  it("replaces the selected stage as system context instead of a user prompt", () => {
    const actor = { systemPrompts: ["root authority"] }
    applyAiWorkflowStageSystemContext(actor, "coding", "coding context")
    applyAiWorkflowStageSystemContext(actor, "testing", "testing context")
    expect(actor.systemPrompts).toEqual([
      "root authority",
      "<!-- eidolon:sys-ai-workflow-stage=testing -->\ntesting context",
    ])
  })
})
