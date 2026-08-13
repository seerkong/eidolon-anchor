import { describe, expect, it } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { composeToolRegistry } from "../../src/composer/AIAgent"
import {
  assembleWorkflowAuthorPrompt,
  createWorkflowComponentForRuntime,
} from "../../src/workflow"
import { publishWorkflowFixture } from "./support"

describe("natural-language workflow authoring", () => {
  it("assembles the native authoring lifecycle instead of a form-first DSL prompt", () => {
    const prompt = assembleWorkflowAuthorPrompt({
      operation: "create",
      request: "收集三个数据源，并行总结后交给人工审核。",
      form: "auto",
      publish: true,
    })
    expect(prompt).toContain("WorkflowLoadStageContext")
    expect(prompt).toContain("sys-ai-workflow")
    expect(prompt).toContain('"publication": true')
    expect(prompt).toContain('"execution": false')
    expect(prompt).not.toContain("<AIDataWorkflow #pkg.Flow")
    expect(prompt).toContain("收集三个数据源，并行总结后交给人工审核。")
    expect(prompt).not.toContain("approval-process")
  })

  it("assembles an edit prompt around the existing logical resource ref", () => {
    const prompt = assembleWorkflowAuthorPrompt({
      operation: "edit",
      request: "在汇总后增加事实核验节点，其他节点保持不变。",
      workflowRef: "resource://demo.workflow.Report",
    })
    expect(prompt).toContain('"workflowRef": "resource://demo.workflow.Report"')
    expect(prompt).toContain('"operation": "edit"')
    expect(prompt).toContain("WorkflowLoadStageContext")
  })

  it("exposes component-backed workspace primitives to the model tool registry", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workspace-tool-"))
    const runtime = {
      vm: {
        outerCtx: { workDir: path.dirname(workspaceRoot), metadata: { aiWorkflow: { roots: { workspaceRoot } } } },
        registries: {},
      },
      actor: {},
    } as any
    await publishWorkflowFixture(createWorkflowComponentForRuntime(runtime), {
      form: "ai-data",
      name: "Workspace Tool",
      fqn: "demo.workflow.WorkspaceTool",
    })
    const registry = composeToolRegistry({ includeInternalOnly: false })
    expect(ToolFuncRegistry.get(registry, "WorkflowGetAuthoringContext")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowListAuthoringTemplates")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowOpenAuthoringSession")).toBeDefined()
    expect(ToolFuncRegistry.get(registry, "WorkflowPublishAuthoringSession")).toBeDefined()

    const tree = JSON.parse(await ToolFuncRegistry.call(
      registry,
      "WorkflowWorkspace",
      runtime.vm,
      runtime.actor,
      { operation: "tree" },
    ) as string)
    expect(tree.ok).toBe(true)
    expect(tree.files).toContain("workspace-tool/manifest.xnl")

    const read = JSON.parse(await ToolFuncRegistry.call(
      registry,
      "WorkflowWorkspace",
      runtime.vm,
      runtime.actor,
      { operation: "read", path: "workspace-tool/manifest.xnl" },
    ) as string)
    expect(read.content).toContain("<AIDataWorkflow #demo.workflow.WorkspaceTool")

    const validation = JSON.parse(await ToolFuncRegistry.call(
      registry,
      "WorkflowWorkspace",
      runtime.vm,
      runtime.actor,
      { operation: "validate", form: "AIDataWorkflow", content: read.content },
    ) as string)
    expect(validation.binding).toMatchObject({ kind: "AIDataWorkflow" })
    expect(validation.diagnostics).toEqual([])
  })
})
