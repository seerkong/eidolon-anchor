import { describe, expect, it } from "bun:test"
import { access, readFile } from "node:fs/promises"
import path from "node:path"

import matrix from "./fixtures/workflow-product-acceptance-matrix.json"
import { WORKFLOW_NATIVE_TOOL_NAMES, assembleWorkflowFulfillmentPrompt } from "../../src/workflow"

const repositoryRoot = path.resolve(import.meta.dir, "../../../../..")

describe("Eidolon final workflow acceptance", () => {
  it("closes every requirement-to-evidence matrix row with executable local evidence", async () => {
    expect(matrix.length).toBeGreaterThanOrEqual(20)
    expect(new Set(matrix.map((row) => row.id)).size).toBe(matrix.length)
    expect(new Set(matrix.map((row) => row.area))).toEqual(new Set([
      "human", "authoring", "lifecycle", "material", "recovery", "runtime", "architecture", "distribution",
    ]))
    for (const row of matrix) {
      expect(row.status).toBe("closed")
      expect(row.requiredBehavior.trim().length).toBeGreaterThan(10)
      expect(["xnl", "eidolon-root", "depa-flows", "eidolon-effects", "native-component"]).toContain(row.boundary)
      await access(path.join(repositoryRoot, row.implementationEvidence))
      await access(path.join(repositoryRoot, row.test))
    }
  })

  it("keeps the installed product contract centered on one ordinary-language native journey", async () => {
    expect(WORKFLOW_NATIVE_TOOL_NAMES[0]).toBe("WorkflowFulfill")
    const cli = await readFile(path.join(repositoryRoot, "terminal/packages/cli/src/commands/workflow.ts"), "utf8")
    const kernel = await readFile(path.join(repositoryRoot, "cell/packages/mod-ai-kernel/src/prompt/KernelRules.md"), "utf8")
    expect(cli).toContain('command: "agent [requirement]"')
    expect(cli).toContain("'/dev/stdin' to read a heredoc")
    expect(cli).toContain('option("session"')
    expect(cli).toContain("Call WorkflowFulfill exactly once")
    expect(kernel).toContain("global `sys-eidolon-anchor-devops`")
    expect(kernel).toContain("WorkflowFulfill")
    const stageLoader = await readFile(path.join(
      repositoryRoot,
      "cell/packages/ai-organ-logic/src/workflow/tools/WorkflowLoadStageContext/Logic.ts",
    ), "utf8")
    const stagePolicy = await readFile(path.join(
      repositoryRoot,
      "cell/packages/ai-organ-logic/src/workflow/tools/WorkflowLoadStageContext/StageToolPolicy.ts",
    ), "utf8")
    expect(stageLoader).not.toContain("STAGE_NEXT_ACTION")
    expect(stageLoader).not.toContain("nextAction:")
    expect(stageLoader).toContain("readWorkflowLifecycleFrozenResourcePackage")
    expect(stagePolicy).toContain('authority: "actor-durable-material:workflow-resource-package"')
  })

  it("delegates ordinary request semantics to the system actor", () => {
    const prompt = assembleWorkflowFulfillmentPrompt({ request: "并行读取多份访谈，汇总成报告后等待负责人批准。" })
    expect(prompt).toContain("WorkflowLoadStageContext")
    expect(prompt).toContain('"publication": false')
    expect(prompt).toContain('"execution": false')
    expect(prompt).not.toMatch(/approval-process|composite/)
  })

  it("binds workflow prompt producers to the split DevOps authority", async () => {
    const productionFiles = [
      "cell/packages/ai-organ-logic/src/workflow/tools/WorkflowFulfill/Logic.ts",
      "cell/packages/ai-organ-logic/src/workflow/tools/WorkflowFulfill/Tool.detail.xnl",
      "cell/packages/ai-organ-logic/src/workflow/tools/WorkflowAuthor/Logic.ts",
      "cell/packages/ai-organ-logic/src/workflow/prompts/index.ts",
      "cell/packages/ai-organ-logic/src/workflow/tools/WorkflowLoadStageContext/Logic.ts",
      "cell/packages/ai-organ-logic/src/workflow/tools/WorkflowLoadStageContext/StageToolPolicy.ts",
      "cell/packages/mod-ai-kernel/src/prompt/KernelRules.md",
      "cell/packages/mod-ai-coding/src/agent/workflow/AGENT.md",
      "cell/packages/mod-ai-coding/src/agent/workflow/ROUTING.md",
    ]
    const sources = await Promise.all(productionFiles.map((file) => readFile(path.join(repositoryRoot, file), "utf8")))
    expect(sources.join("\n")).toContain("sys-eidolon-anchor-devops")
    for (const source of sources) expect(source).not.toContain("sys-ai-workflow")
  })
})
