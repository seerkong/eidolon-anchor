import { describe, expect, it } from "bun:test"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

import { WORKFLOW_NATIVE_TOOL_NAMES } from "../../src/workflow/tools"

const repositoryRoot = path.resolve(import.meta.dir, "../../../../..")
const workflowRoot = path.join(repositoryRoot, "cell/packages/ai-organ-logic/src/workflow")

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8")
}

async function typescriptFiles(root: string): Promise<string[]> {
  const result: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile() && entry.name.endsWith(".ts")) result.push(target)
    }
  }
  await visit(root)
  return result.sort()
}

describe("Eidolon workflow architecture boundaries", () => {
  it("keeps executable workflow source on canonical XNL, native roots and in-process effects", async () => {
    const violations: string[] = []
    for (const filePath of await typescriptFiles(workflowRoot)) {
      const content = await readFile(filePath, "utf8")
      const imports = [...content.matchAll(/(?:import|export)\s[\s\S]*?from\s+["']([^"']+)["']/g)]
        .map((match) => match[1]!)
      for (const dependency of imports) {
        if (/mcp|xml2|fast-xml|child_process/i.test(dependency)) {
          violations.push(`${path.relative(repositoryRoot, filePath)} imports ${dependency}`)
        }
      }
      if (/\.xml["'`]/.test(content)) violations.push(`${path.relative(repositoryRoot, filePath)} references executable XML`)
      if (/\b(?:execFile|execSync|spawnSync|child_process)\b/.test(content)) {
        violations.push(`${path.relative(repositoryRoot, filePath)} invokes an external process`)
      }
    }
    expect(violations).toEqual([])
  })

  it("delegates both workflow forms to canonical depa-flows loaders and runtimes", async () => {
    const loader = await source("cell/packages/ai-organ-logic/src/workflow/resources/WorkflowResourceLoader.ts")
    expect(loader).toContain('from "ai-ctrl-workflow-logic"')
    expect(loader).toContain('from "ai-data-workflow-logic"')
    expect(loader).not.toContain("parseXnl")

    const ctrl = await source("cell/packages/ai-organ-logic/src/workflow/runtime/WorkflowRuntimeService.ts")
    expect(ctrl).toContain('from "ai-ctrl-workflow-logic"')
    expect(ctrl).toContain('from "work-ctrl-flow-contract"')
    expect(ctrl).toContain('from "instant-ctrl-flow-logic"')

    const data = await source("cell/packages/ai-organ-logic/src/workflow/runtime/AIDataWorkflowRuntimeDriver.ts")
    expect(data).toContain('from "ai-data-workflow-logic"')
    expect(data).toContain('from "eager-data-flow-logic"')
  })

  it("uses Eidolon roots, actor/session effect authority and native no-MCP surfaces", async () => {
    const component = await source("cell/packages/ai-organ-logic/src/workflow/component/WorkflowComponent.ts")
    expect(component).toContain('path.join(workDir, ".eidolon", "workflows")')
    expect(component).toContain("metadata?.aiWorkflow")
    expect(component).toContain("aiWorkflow?.roots")

    const effects = await source("cell/packages/ai-organ-logic/src/workflow/effects/EidolonWorkflowEffectProvider.ts")
    expect(effects).toContain("spawnChildExecutionActor")
    expect(effects).toContain("ToolFuncRegistry.call")
    expect(effects).toContain("recordAiRuntimeEffectLifecycleEvent")

    const terminalSupport = await source("terminal/packages/organ-support/src/workflow.ts")
    expect(terminalSupport).toContain("mcp: false")
    const cli = await source("terminal/packages/cli/src/commands/workflow.ts")
    expect(cli).toContain('command: "run <instance-id>"')
    expect(cli).not.toContain('command: "run <ref>')
    expect(cli).toContain('callRuntimeTool(deps, "WorkflowRun"')

    expect(WORKFLOW_NATIVE_TOOL_NAMES.some((name) => /mcp/i.test(name))).toBe(false)
    expect(WORKFLOW_NATIVE_TOOL_NAMES).toContain("WorkflowCreateInstance")
    expect(WORKFLOW_NATIVE_TOOL_NAMES).toContain("WorkflowResolve")
    expect(WORKFLOW_NATIVE_TOOL_NAMES).toContain("WorkflowMaterialReplay")
  })

  it("ships one eidolon executable for TUI and headless subcommands", async () => {
    const packageJson = await source("package.json")
    const unifiedEntry = await source("terminal/packages/cli/src/index.ts")
    const builder = await source("scripts/build-terminal-tui.ts")
    expect(packageJson).toContain('"build:terminal": "bun run build:terminal:tui"')
    expect(packageJson).not.toContain("build:terminal:cli")
    expect(packageJson).not.toContain("install:dist:tui")
    expect(unifiedEntry).toContain('.scriptName("eidolon")')
    expect(unifiedEntry).toContain(".command(workflow)")
    expect(unifiedEntry).toContain(".command(globalCommand)")
    expect(unifiedEntry).toContain('command: "$0 [project]"')
    expect(builder).toContain('binaryName = isWindows ? "eidolon.exe" : "eidolon"')
    expect(builder).toContain("EIDOLON_UNIFIED_ENTRY")
  })

  it("forbids deterministic natural-language workflow routing", async () => {
    const violations: string[] = []
    for (const filePath of await typescriptFiles(workflowRoot)) {
      const content = await readFile(filePath, "utf8")
      if (/\/(?:[^/\\]|\\.)*(?:批准|审批|负责人|调研|研究|并行|循环|等待|发布|执行)(?:[^/\\]|\\.)*\/[a-z]*/u.test(content)) {
        violations.push(path.relative(repositoryRoot, filePath))
      }
      if (/infer(?:Scenario|Route)|durableSignals|analyzeWorkflowAuthoringIntent/.test(content)) {
        violations.push(path.relative(repositoryRoot, filePath))
      }
    }
    expect(violations).toEqual([])
  })

  it("reuses the generic actor context policy without a workflow compactor or actor-name routing", async () => {
    const workflowViolations: string[] = []
    for (const filePath of await typescriptFiles(workflowRoot)) {
      const content = await readFile(filePath, "utf8")
      if (/ContextCompressor|Workflow(?:History|Context)(?:Compressor|Compactor|Cache)/.test(content)) {
        workflowViolations.push(path.relative(repositoryRoot, filePath))
      }
      if (/projectWorkflowBusinessConversation|priorConversation/.test(content)) {
        workflowViolations.push(path.relative(repositoryRoot, filePath))
      }
    }
    expect(workflowViolations).toEqual([])

    const executor = await source("cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts")
    const eligibility = executor.match(
      /function shouldCompressActorHistory\([^)]*\): boolean \{([\s\S]*?)\n\}/,
    )?.[1] ?? ""
    expect(eligibility).toContain("contextPolicy.historyCompaction")
    expect(eligibility).not.toMatch(/primary|delegate|detached|member|agentType|workflow|tool/i)
  })
})
