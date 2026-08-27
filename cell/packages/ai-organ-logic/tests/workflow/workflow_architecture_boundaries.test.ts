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
  it("binds the published DEPA persistence closure with exact package identities", async () => {
    const organ = JSON.parse(await source("cell/packages/ai-organ-logic/package.json")) as {
      dependencies: Record<string, string>
    }
    const contract = JSON.parse(await source("cell/packages/ai-workflow-contract/package.json")) as {
      dependencies: Record<string, string>
    }
    const support = JSON.parse(await source("cell/packages/ai-support/package.json")) as {
      dependencies: Record<string, string>
    }
    const organClosure = {
      "ai-ctrl-workflow-logic": "0.1.8",
      "ai-data-workflow-contract": "0.1.5",
      "ai-data-workflow-logic": "0.1.11",
      "ai-workflow-contract": "0.1.8",
      "ai-workflow-logic": "0.1.9",
      "depa-actor": "0.2.2",
      "depa-processor": "0.1.1",
      "eager-data-flow-logic": "0.1.5",
      "flow-step-space-contract": "0.1.1",
      "flow-step-space-logic": "0.1.1",
      "holarchy-core-contract": "0.1.1",
      "holarchy-core-logic": "0.1.2",
      "holarchy-eidolon-adapter": "0.1.1",
      "holarchy-file-xnl-capsule": "0.2.0",
      "instant-ctrl-flow-logic": "0.1.5",
      "task-manager-contract": "0.1.3",
      "task-manager-logic": "0.1.6",
      "work-ctrl-flow-contract": "0.1.3",
      "work-ctrl-flow-logic": "0.1.4",
    }
    const contractClosure = {
      "ai-ctrl-workflow-contract": "0.1.5",
      "ai-data-workflow-contract": "0.1.5",
      "ai-workflow-contract": "0.1.8",
      "ai-workflow-logic": "0.1.9",
      "flow-step-space-contract": "0.1.1",
    }
    expect(organ.dependencies).toMatchObject(organClosure)
    expect(contract.dependencies).toMatchObject(contractClosure)
    expect(support.dependencies["ai-workflow-flow-dsl-reference"]).toBe("0.1.6")
    expect(organ.dependencies["halfcode-compiler.xnl"]).toBe("0.2.2")
    expect(support.dependencies["halfcode-compiler.xnl"]).toBe("0.2.3")
    for (const version of [
      ...Object.values(organClosure),
      ...Object.values(contractClosure),
      support.dependencies["ai-workflow-flow-dsl-reference"],
    ]) {
      expect(version).not.toMatch(/^(?:workspace:|file:|link:|[~^*><=])/)
    }

    for (const manifestPath of [
      "backend/packages/core/package.json",
      "cell/packages/ai-core-logic/package.json",
      "cell/packages/ai-runtime-control-contract/package.json",
      "cell/packages/ai-runtime-control-logic/package.json",
      "cell/packages/symbiont-contract/package.json",
    ]) {
      const manifest = JSON.parse(await source(manifestPath)) as { dependencies: Record<string, string> }
      expect(manifest.dependencies["depa-actor"]).toBe("0.2.2")
    }

    expect(Object.keys(organ.dependencies).filter((name) => /(?:depa-orm|sqlite)/i.test(name))).toEqual([])
    expect(Object.keys(organ.dependencies).filter((name) => name.startsWith("holarchy-depa-"))).toEqual([])
  })

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

  it("checks the generated system Skill plan before every canonical unified build", async () => {
    const builder = await source("scripts/build-terminal-tui.ts")
    const release = await source("scripts/build_tui_release.sh")
    const checkCommand = '["bun", "run", "--cwd", "cell/packages/ai-support", "generate:system-skills:check"]'
    const bundleCommand = '["bun", "--config=./scripts/bunfig.build.toml", "./scripts/build.ts", outFile]'

    expect(builder).toContain(checkCommand)
    expect(builder.indexOf(checkCommand)).toBeLessThan(builder.indexOf(bundleCommand))
    expect(builder).toContain("if (exitCode !== 0) process.exit(exitCode)")
    expect(builder).not.toContain('"generate:system-skills"')
    expect(release).toContain("bun run build:terminal:tui")
    expect(release).not.toContain("generate:system-skills")
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

  it("requires explicit typed authority instead of node-label keyword inference", async () => {
    const loader = await source("cell/packages/ai-organ-logic/src/workflow/resources/WorkflowResourceLoader.ts")
    const sessions = await source("cell/packages/ai-organ-logic/src/workflow/authoring/WorkflowAuthoringSessionStore.ts")
    expect(loader).not.toContain("effectNodeIds")
    expect(loader).not.toMatch(/Effect\|Task\|Transform\|Source\|Sink/)
    expect(sessions).not.toContain("effectNodeIds")
    expect(sessions).toContain('source: "canonical-profile:explicit-acceptance-policy-default"')
  })

  it("keeps published resource discovery on Halfcode and typed depa projections", async () => {
    const repository = await source("cell/packages/ai-organ-logic/src/workflow/runtime/WorkflowDefinitionRepository.ts")
    expect(repository).not.toContain("workspace.tree()")
    expect(repository).not.toContain('endsWith("/manifest.xnl")')
    expect(repository).toContain("executableDependencies(loaded.binding)")
    expect(repository).toContain('scope: "resource" | "package"')
    expect(repository).toContain("node?.attrs?.src")
    expect(repository).toContain("node?.attrs?.when")
    expect(repository).toContain('"src" in node ? node.src')
    expect(repository).toContain('"impl" in node ? node.impl')
    expect(repository).not.toContain("Object.values(definition)")
    expect(repository).not.toContain("JSON.stringify(definition)")

    const query = await source("cell/packages/ai-organ-logic/src/workflow/component/WorkflowQueryService.ts")
    expect(query).not.toContain("new WorkflowDefinitionRepository")
    expect(query).not.toContain("JSON.stringify(definition)")
    expect(query).not.toContain(".match(/material:")

    const registry = await source("cell/packages/ai-organ-logic/src/resources/EidolonAppResourceRegistryAdapter.ts")
    expect(registry).toContain('from "halfcode-compiler.xnl/resource-core"')
    expect(registry).toContain('from "halfcode-compiler.xnl/resource-mapping"')
    expect(registry).toContain('from "ai-workflow-logic"')
    expect(registry).toContain("safePathLexicalIssue(value, \"relative-path\")")
    expect(registry).toContain("new WeakMap<")
    expect(registry).toContain("captureFrozenLayer")
    expect(registry).toContain("withFileTypes: true")
    expect(registry).not.toContain('endsWith("/manifest.xnl")')
    expect(registry).toContain('target[`${prefix}/manifest.xnl`]')
  })

  it("separates whole-package registry publication from honest legacy VFS drafts", async () => {
    const publisher = await source("cell/packages/ai-organ-logic/src/workflow/component/WorkflowResourcePackagePublisher.ts")
    expect(publisher).toContain("withPublicationFence")
    expect(publisher).toContain("recordResourcePackagePublication")
    expect(publisher).toContain("publicationEffectDispatched: true")
    expect(publisher).toContain("runtimeEffectDispatched: false")
    expect(publisher).not.toMatch(/批准|审批|负责人|等待.*确认/u)
    expect(publisher).not.toMatch(/infer|guess|fuzzy/i)

    const drafts = await source("cell/packages/ai-organ-logic/src/workflow/component/WorkflowCommandService.ts")
    expect(drafts).toContain('const workflowRef = `vfs://./${slug}/manifest.xnl`')
    expect(drafts).toContain('workflowDefinitionRef = "vfs://./manifest.xnl"')
    expect(drafts).toContain("runtime.ai.effects.runAgent<Input, Output>(input, config)")
    expect(drafts).toContain("runtime.ai.effects.runTargetedAgent<Input, Output>(selector, invocation, config)")
    expect(drafts).toContain("runtime.ai.effects.writeMaterial(input, config)")
    expect(drafts).not.toContain("runtime.ai.effects.invoke")
    expect(drafts).not.toContain('operation: "ai.agent"')
    expect(drafts).not.toContain('`resource://${command.fqn}`')
    expect(drafts).not.toContain("workflowResourceRef")
  })

  it("does not retain a code-owned reusable Agent inventory", async () => {
    const installed = await source("cell/packages/ai-organ-logic/src/workflow/resources/authoring/WorkflowAuthoringResourceRegistry.ts")
    expect(installed).not.toContain("reusableAgents")

    const tools = await source("cell/packages/ai-organ-logic/src/workflow/tools/WorkflowAuthoringTools.ts")
    expect(tools).not.toContain("catalog.listReusableAgents")
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

  it("keeps resource Agent selection exact while reusing the generic delegate runtime", async () => {
    const resources = await source("cell/packages/ai-organ-logic/src/resources/EidolonAppResourceRegistryAdapter.ts")
    const effects = await source("cell/packages/ai-organ-logic/src/workflow/effects/EidolonWorkflowEffectProvider.ts")
    const delegate = await source("cell/packages/ai-organ-logic/src/agent/DelegateActor.ts")
    const ctrlRuntime = await source("cell/packages/ai-organ-logic/src/workflow/runtime/WorkflowRuntimeService.ts")
    const dataRuntime = await source("cell/packages/ai-organ-logic/src/workflow/runtime/AIDataWorkflowRuntimeDriver.ts")

    expect(resources).toContain('from "ai-workflow-logic/run-freeze"')
    expect(resources).toContain("freezeAIWorkflowRunResources")
    expect(resources).not.toMatch(/RegExp|localeCompare|inferAgent|guessAgent|resolveAgentAlias/)
    expect(effects).toContain("selectExactAgentDefinitionRef")
    expect(effects).toContain("spawnChildExecutionActor")
    expect(effects).not.toContain('workflow.ref.startsWith("resource://")')
    expect(effects).not.toMatch(/inferAgent|guessAgent|resolveAgentAlias/)
    expect(ctrlRuntime).toContain('scheme: definition.resourceReceipt ? "resource" : "vfs"')
    expect(dataRuntime).toContain('scheme: definition.resourceReceipt ? "resource" as const : "vfs" as const')
    expect(ctrlRuntime).not.toContain('descriptor.workflowRef.startsWith("resource://")')
    expect(dataRuntime).not.toContain('descriptor.workflowRef.startsWith("resource://")')
    expect(delegate).toContain("params.resolvedConfig ?? AgentRegistry.get")
    expect(delegate).not.toMatch(/WorkflowAgentActor|WorkflowAgentSession|WorkflowAgentHistory|WorkflowAgentCompactor/)
  })

  it("keeps Ctrl/Data node lifecycle admission outside generic core and Executor", async () => {
    const effects = await source("cell/packages/ai-organ-logic/src/workflow/effects/EidolonWorkflowEffectProvider.ts")
    const recovery = await source("cell/packages/ai-organ-logic/src/persistence/RuntimeSnapshots.ts")
    const admission = await source("cell/packages/ai-organ-logic/src/workflow/runtime/WorkflowNodeActorAdmission.ts")
    const executor = await source("cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts")
    const coreActor = await source("cell/packages/ai-core-logic/src/runtime/actor.ts")

    expect(effects).toContain("prepareResourceAgentDispatch")
    expect(effects).toContain("assertWorkflowNodeAgentConfigIsolation")
    expect(effects.indexOf("prepareResourceAgentDispatch(request)")).toBeLessThan(
      effects.indexOf("workflow.effect.requested"),
    )
    expect(recovery).toContain("assertWorkflowNodeActorIsolation(actor)")
    expect(admission).toContain("WORKFLOW_LIFECYCLE_DEFINITION_TOOL_NAMES")
    expect(admission).not.toContain("WORKFLOW_PUBLIC_GATEWAY_TOOL_NAMES")
    expect(executor).not.toContain("WorkflowNodeActorAdmission")
    expect(coreActor).not.toContain("WorkflowNodeActorAdmission")
  })
})
