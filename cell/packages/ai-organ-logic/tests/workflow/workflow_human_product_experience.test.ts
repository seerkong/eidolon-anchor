import { describe, expect, it } from "bun:test"

import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { composeToolRegistry } from "../../src/composer/AIAgent"
import corpus from "./fixtures/workflow-human-product-corpus.json"
import {
  WORKFLOW_BUSINESS_SCENARIOS,
  assembleWorkflowFulfillmentPrompt,
  planWorkflowExperience,
  projectWorkflowBusinessState,
} from "../../src/workflow"
import { WORKFLOW_NATIVE_TOOL_NAMES, buildWorkflowNativeToolDefs } from "../../src/workflow/tools"

describe("workflow human product experience", () => {
  it("routes a business-language corpus without requiring internal workflow vocabulary", () => {
    expect(WORKFLOW_BUSINESS_SCENARIOS.length).toBeGreaterThanOrEqual(9)
    for (const entry of corpus) {
      const plan = planWorkflowExperience({ request: entry.request })
      expect(plan.route).toBe(entry.route)
      expect(plan.scenario.id).toBe(entry.scenario)
      expect(plan.request).toBe(entry.request)
      expect(plan.userRequiredFields).toEqual(["request"])
    }
    expect(JSON.stringify(corpus)).not.toMatch(/AICtrlWorkflow|AIDataWorkflow|node_id|reuse_policy|manifest\.xnl|resource:\/\//)
  })

  it("keeps direct work direct and records independent publication/execution authorization", () => {
    const direct = planWorkflowExperience({ request: "修复这个函数里的拼写错误。" })
    expect(direct.route).toBe("direct")
    expect(direct.journey).toEqual(["handle-directly"])

    const workflow = planWorkflowExperience({
      request: "并行调研三个方向，合并结果后等待负责人批准。",
      publish: true,
      execute: false,
    })
    expect(workflow.route).toBe("composite")
    expect(workflow.authorization).toEqual({ publication: "explicit", execution: "missing" })
    expect(workflow.journey).toEqual([
      "select-context",
      "author-and-prove",
      "publish",
      "infer-inputs-and-materials",
      "prepare-instance",
      "preview-execution",
      "await-execution-confirmation",
    ])
  })

  it("routes a report over explicit public URLs to the data workflow product", () => {
    const plan = planWorkflowExperience({
      request: [
        "请创建一个工作流：从以下三个真实公共来源获取最新内容，分析 AI 应用的发展趋势并生成中文报告：",
        "https://hn.algolia.com/api/v1/search_by_date?query=AI",
        "https://api.github.com/search/repositories?q=artificial-intelligence",
        "https://dev.to/api/articles?tag=ai",
      ].join("\n"),
    })
    expect(plan.scenario.id).toBe("research")
    expect(plan.route).toBe("ai-data")
    expect(assembleWorkflowFulfillmentPrompt(plan)).toContain("minimal-ai-data template")
  })

  it("assembles an executable native-tool journey rather than a user-facing DSL lesson", () => {
    const plan = planWorkflowExperience({
      request: "读取访谈材料，分别提炼观点，合并为报告并执行。",
      publish: true,
      execute: true,
    })
    const prompt = assembleWorkflowFulfillmentPrompt(plan)
    for (const tool of [
      "WorkflowGetAuthoringContext",
      "WorkflowOpenAuthoringSession",
      "WorkflowValidateAuthoringSession",
      "WorkflowDryRunAuthoringSession",
      "WorkflowPublishAuthoringSession",
      "WorkflowMaterialImport",
      "WorkflowCreateInstance",
      "WorkflowRun",
      "WorkflowResult",
    ]) expect(prompt).toContain(tool)
    expect(prompt).toContain("business result")
    expect(prompt).toContain("Do not call WorkflowFulfill recursively")
    expect(prompt).toContain("minimal-ai-data template")
    expect(prompt).toContain("open exactly one AIDataWorkflow authoring session")
    expect(prompt).toContain("Do not open scratch, probe, or alternative-form sessions")
    expect(prompt).not.toContain("ask the person to choose")
  })

  it("registers WorkflowFulfill as the ordinary-language native entry", () => {
    expect(WORKFLOW_NATIVE_TOOL_NAMES[0]).toBe("WorkflowFulfill")
    const tool = buildWorkflowNativeToolDefs().find((item) => item.schema.function.name === "WorkflowFulfill")
    expect(tool?.schema.function.parameters.required).toEqual(["request"])
    expect(tool?.schema.function.description).toContain("business goal")
  })

  it("returns simple work to the current actor through the real native registry", async () => {
    const registry = composeToolRegistry({ includeInternalOnly: false })
    const output = JSON.parse(String(await ToolFuncRegistry.call(
      registry,
      "WorkflowFulfill",
      { outerCtx: { workDir: "/tmp/eidolon-workflow-experience" }, registries: {} } as any,
      {} as any,
      { request: "把这句话改得更简洁。" },
    )))
    expect(output).toEqual({
      status: "direct",
      purpose: "把这句话改得更简洁。",
      summary: "这个请求不需要持久工作流，请在当前 Eidolon 对话中直接完成。",
      nextAction: "直接完成用户要求的业务任务。",
    })
  })

  it("projects business state without leaking internal facts by default", () => {
    const projection = projectWorkflowBusinessState({
      status: "waiting",
      purpose: "形成发布风险报告并等待负责人决定",
      summary: "风险报告已经生成，正在等待负责人确认。",
      nextAction: "请负责人确认是否发布。",
      internal: {
        form: "AICtrlWorkflow",
        workflowRef: "resource://demo.Release",
        instanceId: "instance-1",
        runId: "run-1",
        nodeId: "approval",
      },
    })
    expect(projection).toEqual({
      status: "waiting",
      purpose: "形成发布风险报告并等待负责人决定",
      summary: "风险报告已经生成，正在等待负责人确认。",
      nextAction: "请负责人确认是否发布。",
    })
    expect(JSON.stringify(projection)).not.toMatch(/AICtrlWorkflow|resource:\/\/|instance-1|run-1|approval/)
  })
})
