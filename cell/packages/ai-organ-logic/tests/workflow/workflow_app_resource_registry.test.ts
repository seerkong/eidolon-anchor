import { afterEach, describe, expect, it } from "bun:test"
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { readRuntimeControlEffectEvidence } from "@cell/ai-file-store-logic"
import { composeToolRegistry } from "../../src/composer/AIAgent/ToolFuncComposer"
import { appendLiveHistoryMessageToConversationDomainRuntime } from "../../src/conversation/ConversationDomainRuntime"
import {
  EidolonAppResourceRegistryAdapter,
  mergeResourceAgentConfigs,
  type EidolonResourceRegistryPublicationCandidate,
  type ResourcePackageLayerBinding,
} from "../../src/resources/EidolonAppResourceRegistryAdapter"
import {
  bindWorkflowComponentToRuntime,
  createWorkflowComponent,
  createWorkflowComponentForRuntime,
} from "../../src/workflow"
import { WorkflowFactStore } from "../../src/workflow/runtime"
import { WorkflowRuntimeService } from "../../src/workflow/runtime"
import { buildWorkflowNativeToolDefs } from "../../src/workflow/tools"

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function writePackage(root: string, variant: "global" | "workspace"): Promise<void> {
  const packageId = `eidolon.fixture.${variant}.package`
  const description = variant === "workspace" ? "Workspace support app" : "Global support app"
  const files: Record<string, string> = {
    "manifest.xnl": `<ResourcePackage #${packageId} apiVersion="halfcode.resources/v1" version="1.0.0" {
  lifecycle = "Active"
  description = "${description}"
} (
  <Catalogs [
    <Catalog #kind_definitions { kind = "KindDefinition" shape = "directory" root = "vfs://./KindDefinitions/" entry = "manifest.xnl" }>
    <Catalog #apps { kind = "AIWorkflowAppBundle" shape = "single-file" root = "vfs://./Apps/" }>
    <Catalog #ctrl { kind = "AICtrlWorkflow" shape = "single-file" root = "vfs://./CtrlWorkflows/" }>
    <Catalog #data { kind = "AIDataWorkflow" shape = "single-file" root = "vfs://./DataWorkflows/" }>
    <Catalog #agents { kind = "AIAgentDefinition" shape = "single-file" root = "vfs://./Agents/" }>
    <Catalog #prompts { kind = "Prompt" shape = "single-file" root = "vfs://./Prompts/" }>
    <Catalog #tools { kind = "Tool" shape = "single-file" root = "vfs://./Tools/" }>
    <Catalog #schemas { kind = "MessageSchema" shape = "single-file" root = "vfs://./Schemas/" }>
    <Catalog #policies { kind = "EffectPolicy" shape = "single-file" root = "vfs://./Policies/" }>
    <Catalog #ports { kind = "MaterialPort" shape = "single-file" root = "vfs://./Ports/" }>
    <Catalog #bindings { kind = "MaterialBinding" shape = "single-file" root = "vfs://./Bindings/" }>
    <Catalog #request_materials { kind = "RequestMaterial" shape = "single-file" root = "vfs://./RequestMaterials/" }>
  ]>
)>
`,
    "KindDefinitions/AIWorkflowAppBundle/manifest.xnl": kindDefinition("AIWorkflowAppBundle"),
    "KindDefinitions/AICtrlWorkflow/manifest.xnl": kindDefinition("AICtrlWorkflow"),
    "KindDefinitions/AIDataWorkflow/manifest.xnl": kindDefinition("AIDataWorkflow"),
    "KindDefinitions/AIAgentDefinition/manifest.xnl": kindDefinition("AIAgentDefinition"),
    "KindDefinitions/Prompt/manifest.xnl": kindDefinition("Prompt"),
    "KindDefinitions/Tool/manifest.xnl": kindDefinition("Tool"),
    "KindDefinitions/MessageSchema/manifest.xnl": kindDefinition("MessageSchema"),
    "KindDefinitions/EffectPolicy/manifest.xnl": kindDefinition("EffectPolicy"),
    "KindDefinitions/MaterialPort/manifest.xnl": kindDefinition("MaterialPort"),
    "KindDefinitions/MaterialBinding/manifest.xnl": kindDefinition("MaterialBinding"),
    "KindDefinitions/RequestMaterial/manifest.xnl": kindDefinition("RequestMaterial"),
    "Apps/Support.xnl": `<AIWorkflowAppBundle #eidolon.fixture.SupportApp apiVersion="depa.flows/v1" version="1.0.0" {
  lifecycle = "Active"
  description = "${description}"
} (
  <WorkflowBindings [
    <WorkflowBinding #primary { kind = "AICtrlWorkflow" ref = "resource://eidolon.fixture.SupportCtrl" entrypoint = true }>
    <WorkflowBinding #evidence { kind = "AIDataWorkflow" ref = "resource://eidolon.fixture.SupportData" entrypoint = false }>
  ]>
)>
`,
    "CtrlWorkflows/Support.xnl": `<AICtrlWorkflow #eidolon.fixture.SupportCtrl apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #eidolon.fixture.SupportCtrl>
) [
  <Return #done>
]>
`,
    "DataWorkflows/Support.xnl": `<AIDataWorkflow #eidolon.fixture.SupportData apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #eidolon.fixture.SupportData { inputPorts = ["input"] outputPorts = ["result"] }>
) [
  <EntryNode #entry>
  <ReturnNode #return { inputs = { result = "flow-port://#entry/input" } }>
]>
`,
    "Agents/Support.xnl": `<AIAgentDefinition #eidolon.fixture.SupportAgent apiVersion="depa.flows/v1" version="1.0.0" {
  lifecycle = "Active"
  description = "${variant} reusable support agent"
} (
  <Messages [
    <Message #system { role = "system" promptKind = "Prompt" promptRef = "resource://eidolon.fixture.SupportPrompt" }>
  ]>
  <ToolRefs [
    <ToolRef #lookup { kind = "Tool" ref = "resource://eidolon.fixture.LookupTool" }>
  ]>
  <MaterialPortRefs []>
)>
`,
    "Prompts/Support.xnl": `<Prompt #eidolon.fixture.SupportPrompt apiVersion="depa.flows/v1" version="1.0.0" {
  lifecycle = "Active"
  description = "Ordinary multilingual prompt: 请整理输入，不要猜测关系。"
} (
  <Content ?>Use exact resources only. 请整理输入，不要猜测关系。</?>
)>
`,
    "Tools/Lookup.xnl": `<Tool #eidolon.fixture.LookupTool apiVersion="depa.flows/v1" version="1.0.0" {
  lifecycle = "Active"
  description = "Exact fixture tool identity"
}>
`,
    "unregistered/manifest.xnl": `<AICtrlWorkflow #eidolon.fixture.Hidden apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #eidolon.fixture.Hidden>
) [<Return #done>]>
`,
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, "utf8")
  }
  for (const catalogRoot of ["Schemas", "Policies", "Ports", "Bindings", "RequestMaterials"]) {
    await mkdir(path.join(root, catalogRoot), { recursive: true })
  }
}

function kindDefinition(resourceKind: string): string {
  return `<KindDefinition #eidolon.fixture.kind.${resourceKind} apiVersion="halfcode.resources/v1" version="1.0.0" {
  lifecycle = "Stable"
  resourceKind = "${resourceKind}"
  sourceShapes = ["single-file"]
  currentApiVersion = "depa.flows/v1"
  supportedApiVersions = ["depa.flows/v1"]
  description = "Fixture ${resourceKind} resource"
}>
`
}

async function fixtureLayers(): Promise<readonly ResourcePackageLayerBinding[]> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-resource-registry-"))
  temporaryRoots.push(parent)
  const globalRoot = path.join(parent, "global")
  const workspaceRoot = path.join(parent, "workspace")
  await writePackage(globalRoot, "global")
  await writePackage(workspaceRoot, "workspace")
  return Object.freeze([
    Object.freeze({ id: "global", rootDir: globalRoot }),
    Object.freeze({ id: "workspace", rootDir: workspaceRoot }),
  ])
}

async function composableAgentFixture(): Promise<{
  readonly layers: readonly ResourcePackageLayerBinding[]
  readonly workspaceRoot: string
}> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-composable-agent-"))
  temporaryRoots.push(parent)
  const resources = path.join(parent, "resources")
  const workspaceRoot = path.join(parent, "workspace")
  await mkdir(workspaceRoot, { recursive: true })
  await writeFile(path.join(workspaceRoot, "AGENTS.md"), "Keep the workspace invariant.\n", "utf8")
  const files: Record<string, string> = {
    "manifest.xnl": `<ResourcePackage #eidolon.fixture.composable.package apiVersion="halfcode.resources/v1" version="1.0.0" { lifecycle = "Active" } (
  <Catalogs [
    <Catalog #kind_definitions { kind = "KindDefinition" shape = "directory" root = "vfs://./KindDefinitions/" entry = "manifest.xnl" }>
    <Catalog #agents { kind = "AIAgentDefinition" shape = "single-file" root = "vfs://./Agents/" }>
    <Catalog #prompts { kind = "Prompt" shape = "single-file" root = "vfs://./Prompts/" }>
    <Catalog #sources { kind = "AgentMessageSource" shape = "single-file" root = "vfs://./MessageSources/" }>
    <Catalog #pipelines { kind = "AgentContextPipeline" shape = "single-file" root = "vfs://./ContextPipelines/" }>
  ]>
)>
`,
    "KindDefinitions/AIAgentDefinition/manifest.xnl": kindDefinition("AIAgentDefinition"),
    "KindDefinitions/Prompt/manifest.xnl": kindDefinition("Prompt"),
    "KindDefinitions/AgentMessageSource/manifest.xnl": kindDefinition("AgentMessageSource"),
    "KindDefinitions/AgentContextPipeline/manifest.xnl": kindDefinition("AgentContextPipeline"),
    "Agents/Code.xnl": `<AIAgentDefinition #eidolon.fixture.ComposableCode apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" description = "Composable coding Agent" } (
  <MessagePrefix [
    <Message #kernel { role = "system" promptKind = "Prompt" promptRef = "resource://eidolon.fixture.KernelPrompt" }>
    <MessageSource #workspace { kind = "AgentMessageSource" ref = "resource://eidolon.fixture.WorkspaceAgents" }>
    <Message #coding { role = "system" promptKind = "Prompt" promptRef = "resource://eidolon.fixture.CodingPrompt" }>
  ]>
  <ContextPipeline { kind = "AgentContextPipeline" ref = "resource://eidolon.fixture.StandardContext" }>
  <ToolRefs []>
  <MaterialPortRefs []>
)>
`,
    "Prompts/Kernel.xnl": `<Prompt #eidolon.fixture.KernelPrompt apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" } (<Content ?>kernel-prefix</?>)>`,
    "Prompts/Coding.xnl": `<Prompt #eidolon.fixture.CodingPrompt apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" } (<Content ?>coding-prefix</?>)>`,
    "MessageSources/Workspace.xnl": `<AgentMessageSource #eidolon.fixture.WorkspaceAgents apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" } (<Content ?>{\"implementation\":\"eidolon.workspace-agents/v1\"}</?>)>`,
    "ContextPipelines/Standard.xnl": `<AgentContextPipeline #eidolon.fixture.StandardContext apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" } (<Content ?>{\"implementation\":\"eidolon.standard-context-pipeline/v1\",\"stages\":[\"prompt-plan\",\"conversation-prelude\",\"provider-context-facts-at-history-anchors\",\"stable-message-prefix\",\"conversation-boundary-overlays\",\"provider-conversion\"]}</?>)>`,
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(resources, relativePath)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, "utf8")
  }
  return Object.freeze({
    workspaceRoot,
    layers: Object.freeze([Object.freeze({ id: "workspace" as const, rootDir: resources })]),
  })
}

function deferred<T = void>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe("Eidolon Halfcode App resource registry", () => {
  it("splices heterogeneous MessagePrefix sources and binds the standard ContextPipeline", async () => {
    const fixture = await composableAgentFixture()
    const adapter = new EidolonAppResourceRegistryAdapter({
      layers: fixture.layers,
      workspaceRoot: fixture.workspaceRoot,
    })

    const plan = await adapter.materializeAgentExecutionPlan(
      "resource://eidolon.fixture.ComposableCode",
      { scope: "standalone" },
    )

    expect(plan.messages.map(({ id, content }) => [id, content])).toEqual([
      ["kernel", "kernel-prefix"],
      ["workspace", "AGENTS.md (workspace):\nKeep the workspace invariant."],
      ["coding", "coding-prefix"],
    ])
    expect(plan.messages.map((message) => message.contentDigest)).toHaveLength(3)
    expect(plan.contextPipeline).toMatchObject({
      resourceId: "eidolon.fixture.StandardContext",
      implementation: "eidolon.standard-context-pipeline/v1",
    })
    expect(plan.agentConfig.contextPipeline).toEqual(plan.contextPipeline)
  })

  it("fails closed before Actor creation for an unknown ContextPipeline implementation", async () => {
    const fixture = await composableAgentFixture()
    const pipeline = path.join(fixture.layers[0]!.rootDir, "ContextPipelines", "Standard.xnl")
    await writeFile(pipeline, `<AgentContextPipeline #eidolon.fixture.StandardContext apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" } (<Content ?>{\"implementation\":\"unknown/v9\",\"stages\":[]}</?>)>`, "utf8")
    const adapter = new EidolonAppResourceRegistryAdapter({
      layers: fixture.layers,
      workspaceRoot: fixture.workspaceRoot,
    })

    await expect(adapter.materializeAgentExecutionPlan(
      "resource://eidolon.fixture.ComposableCode",
      { scope: "standalone" },
    )).rejects.toThrow("EIDOLON_AGENT_CONTEXT_PIPELINE_IMPLEMENTATION_UNSUPPORTED")
  })

  it("freezes the exact union of declared and discovered Agent tasks", async () => {
    const frozenTasks: string[] = []
    const registry = {
      async listWorkflowAgentTasks() {
        return [{
          workflowKind: "AICtrlWorkflow",
          workflowRef: "resource://eidolon.fixture.MixedCtrl",
          nodeId: "declared-agent",
          agentDefinitionRef: "resource://eidolon.fixture.SupportAgent",
        }]
      },
      async freezeWorkflowAgentTaskBinding(task: { nodeId: string }) {
        frozenTasks.push(task.nodeId)
        return Object.freeze({ task })
      },
    }
    const descriptor = {
      form: "AICtrlWorkflow",
      workflowRef: "resource://eidolon.fixture.MixedCtrl",
    }
    const definition = {
      resourceReceipt: { resourceId: "eidolon.fixture.MixedCtrl" },
      binding: {
        definition: {
          nodes: [{
            id: "discovered-agent",
            config: { agentDefinitionRef: "resource://eidolon.fixture.SupportAgent" },
          }],
        },
      },
    }

    const proofs = await (WorkflowRuntimeService.prototype as any).frozenAgentTaskProofs(
      descriptor,
      definition,
      registry,
    )

    expect(Object.keys(proofs)).toEqual(["declared-agent", "discovered-agent"])
    expect(frozenTasks).toEqual(["declared-agent", "discovered-agent"])

    await expect((WorkflowRuntimeService.prototype as any).frozenAgentTaskProofs(
      descriptor,
      {
        ...definition,
        binding: {
          definition: {
            nodes: [{
              id: "declared-agent",
              config: { agentDefinitionRef: "resource://eidolon.fixture.OtherAgent" },
            }],
          },
        },
      },
      registry,
    )).rejects.toThrow("conflicting declared and discovered identities")
  })

  it("loads explicit layers and projects Apps, workflows and reusable Agents from one snapshot", async () => {
    const adapter = new EidolonAppResourceRegistryAdapter({ layers: await fixtureLayers() })
    const snapshot = await adapter.snapshot()

    expect(snapshot.registry.layers.map((layer) => layer.id)).toEqual(["global", "workspace"])
    expect(snapshot.registry.byId.get("eidolon.fixture.SupportCtrl")?.effectiveLayerId).toBe("workspace")
    expect(snapshot.registry.byId.has("eidolon.fixture.Hidden")).toBe(false)
    expect(snapshot.appBundles).toHaveLength(1)
    expect(snapshot.appBundles[0]?.resource.description).toBe("Workspace support app")
    expect(snapshot.appBundles[0]?.workflowBindings.map((binding) => binding.ref)).toEqual([
      "resource://eidolon.fixture.SupportCtrl",
      "resource://eidolon.fixture.SupportData",
    ])
    expect(snapshot.agentResources.agentDefinitions.map((agent) => agent.fqn)).toEqual([
      "eidolon.fixture.SupportAgent",
    ])
    expect(snapshot.contentIdentities.get("eidolon.fixture.SupportCtrl")?.authorityDigest).toMatch(/^sha256:/)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.appBundles)).toBe(true)
    await expect(adapter.getApp(" eidolon.fixture.SupportApp ")).rejects.toThrow("EIDOLON_RESOURCE_ID_INVALID")
  })

  it("materializes a standalone Agent plan from exact normalized message and tool resources", async () => {
    const adapter = new EidolonAppResourceRegistryAdapter({ layers: await fixtureLayers() })
    const plan = await adapter.materializeAgentExecutionPlan(
      "resource://eidolon.fixture.SupportAgent",
      { scope: "standalone" },
    )

    expect(plan).toMatchObject({
      schemaVersion: "eidolon.resource-agent-execution-plan/v1",
      agentDefinitionRef: "resource://eidolon.fixture.SupportAgent",
      requiresWorkflowTask: false,
      agentConfig: {
        name: "resource://eidolon.fixture.SupportAgent",
        description: "workspace reusable support agent",
        tools: ["eidolon.fixture.LookupTool"],
        prompt: [],
        seedMessages: [{
          role: "system",
          content: "Use exact resources only. 请整理输入，不要猜测关系。",
        }],
      },
      messages: [{
        id: "system",
        role: "system",
        promptResourceId: "eidolon.fixture.SupportPrompt",
        contentDigest: expect.stringMatching(/^sha256:/),
      }],
      toolResourceIds: ["eidolon.fixture.LookupTool"],
    })
    expect(plan.registryRevision).toBe((await adapter.snapshot()).registryRevision)
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.agentConfig)).toBe(true)
    expect(Object.isFrozen(plan.agentConfig.seedMessages)).toBe(true)
    expect(await adapter.listStandaloneAgentExecutionPlans()).toEqual([plan])
  })

  it("freezes the exact workflow task and resource closure before Agent dispatch", async () => {
    const adapter = new EidolonAppResourceRegistryAdapter({ layers: await fixtureLayers() })
    const prepared = await adapter.prepareWorkflowAgentExecution({
      workflowKind: "AICtrlWorkflow",
      workflowRef: "resource://eidolon.fixture.SupportCtrl",
      nodeId: "support-agent",
      agentDefinitionRef: "resource://eidolon.fixture.SupportAgent",
    })

    expect(prepared.plan).toMatchObject({
      agentDefinitionRef: "resource://eidolon.fixture.SupportAgent",
      requiresWorkflowTask: true,
    })
    expect(prepared.receipt).toMatchObject({
      schemaVersion: "ai-workflow.run-resource-freeze/v1",
      task: {
        workflowKind: "AICtrlWorkflow",
        workflowRef: "resource://eidolon.fixture.SupportCtrl",
        nodeId: "support-agent",
        agentDefinitionRef: "resource://eidolon.fixture.SupportAgent",
      },
      bindingResourceIds: [],
      semanticFingerprint: expect.stringMatching(/^sha256:/),
    })
    expect(prepared.receipt.dependencySnapshot.closure.map((entry) => entry.resourceId))
      .toEqual(expect.arrayContaining([
        "eidolon.fixture.SupportCtrl",
        "eidolon.fixture.SupportAgent",
        "eidolon.fixture.SupportPrompt",
        "eidolon.fixture.LookupTool",
      ]))
    expect(Object.isFrozen(prepared)).toBe(true)

    const dataPrepared = await adapter.prepareWorkflowAgentExecution({
      workflowKind: "AIDataWorkflow",
      workflowRef: "resource://eidolon.fixture.SupportData",
      nodeId: "support-agent-data",
      agentDefinitionRef: "resource://eidolon.fixture.SupportAgent",
    })
    expect(dataPrepared.receipt.task).toEqual({
      workflowKind: "AIDataWorkflow",
      workflowRef: "resource://eidolon.fixture.SupportData",
      nodeId: "support-agent-data",
      agentDefinitionRef: "resource://eidolon.fixture.SupportAgent",
    })
  })

  it("rejects unsupported prompt shapes instead of selecting another text field", async () => {
    const layers = await fixtureLayers()
    const workspaceRoot = layers.find((layer) => layer.id === "workspace")!.rootDir
    const promptPath = path.join(workspaceRoot, "Prompts", "Support.xnl")
    await writeFile(
      promptPath,
      (await Bun.file(promptPath).text()).replace("<Content ?>", "<Body ?>"),
      "utf8",
    )
    const adapter = new EidolonAppResourceRegistryAdapter({ layers })

    await expect(adapter.materializeAgentExecutionPlan(
      "resource://eidolon.fixture.SupportAgent",
      { scope: "standalone" },
    )).rejects.toThrow("EIDOLON_RESOURCE_AGENT_PROMPT_CONTENT_UNSUPPORTED")
  })

  it("enforces the closed none tool policy without textual or alias routing", async () => {
    const layers = await fixtureLayers()
    const workspaceRoot = layers.find((layer) => layer.id === "workspace")!.rootDir
    await writeFile(
      path.join(workspaceRoot, "Policies", "None.xnl"),
      `<EffectPolicy #eidolon.fixture.NonePolicy apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Stable" toolMode = "none" }>`,
    )
    const agentPath = path.join(workspaceRoot, "Agents", "Support.xnl")
    const original = await Bun.file(agentPath).text()
    await writeFile(agentPath, original.replace(
      "  <MaterialPortRefs []>",
      `  <EffectPolicyRef { kind = "EffectPolicy" ref = "resource://eidolon.fixture.NonePolicy" }>\n  <MaterialPortRefs []>`,
    ))
    await expect(new EidolonAppResourceRegistryAdapter({ layers }).materializeAgentExecutionPlan(
      "resource://eidolon.fixture.SupportAgent",
      { scope: "standalone" },
    )).rejects.toThrow("EIDOLON_RESOURCE_AGENT_EFFECT_POLICY_CONFLICT")

    await writeFile(agentPath, (await Bun.file(agentPath).text()).replace(
      /  <ToolRefs \[[\s\S]*?  <MaterialPortRefs/,
      "  <ToolRefs []>\n  <EffectPolicyRef { kind = \"EffectPolicy\" ref = \"resource://eidolon.fixture.NonePolicy\" }>\n  <MaterialPortRefs",
    ))
    const plan = await new EidolonAppResourceRegistryAdapter({ layers }).materializeAgentExecutionPlan(
      "resource://eidolon.fixture.SupportAgent",
      { scope: "standalone" },
    )
    expect(plan.executionContract.effectPolicy).toEqual({ toolMode: "none" })
    expect(plan.agentConfig.tools).toEqual([])
  })

  it("merges standalone resource Agents by exact ref and reuses the prebound component", async () => {
    const layers = await fixtureLayers()
    const parent = path.dirname(layers[0]!.rootDir)
    const component = createWorkflowComponent({
      workspaceRoot: path.join(parent, "authoring"),
      resourceLayers: layers,
    })
    const plans = await component.resourceRegistry.listStandaloneAgentExecutionPlans()
    const merged = mergeResourceAgentConfigs({
      code: { name: "code", description: "local Agent", tools: "*", prompt: [] },
    }, plans)
    expect(Object.keys(merged)).toEqual(["code", "resource://eidolon.fixture.SupportAgent"])
    expect(merged["resource://eidolon.fixture.SupportAgent"]).toBe(plans[0]?.agentConfig)
    expect(() => mergeResourceAgentConfigs({
      "resource://eidolon.fixture.SupportAgent": {
        name: "resource://eidolon.fixture.SupportAgent",
        description: "local collision",
        tools: "*",
        prompt: [],
      },
    }, plans)).toThrow("EIDOLON_RESOURCE_AGENT_REGISTRY_COLLISION")

    const runtime = { vm: { outerCtx: { workDir: parent, metadata: {} } } } as any
    bindWorkflowComponentToRuntime(runtime, component)
    expect(createWorkflowComponentForRuntime(runtime)).toBe(component)
  })

  it("treats missing optional roots as absent layers and rejects relative roots", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-resource-registry-"))
    temporaryRoots.push(parent)
    const missingRoot = path.join(parent, "missing")
    const empty = await new EidolonAppResourceRegistryAdapter({
      layers: [{ id: "global", rootDir: missingRoot }],
    }).snapshot()
    expect(empty.registry.layers).toEqual([])
    expect(empty.appBundles).toEqual([])

    expect(() => new EidolonAppResourceRegistryAdapter({
      layers: [{ id: "workspace", rootDir: ".eidolon/resources" }],
    })).toThrow("absolute")
  })

  it("fails closed for an existing invalid package and does not fall back to manifest discovery", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-resource-registry-"))
    temporaryRoots.push(parent)
    const invalidRoot = path.join(parent, "invalid")
    await mkdir(invalidRoot, { recursive: true })
    await writeFile(path.join(invalidRoot, "ordinary.txt"), "resource://eidolon.fixture.SupportApp", "utf8")

    try {
      await new EidolonAppResourceRegistryAdapter({
        layers: [{ id: "workspace", rootDir: invalidRoot }],
      }).snapshot()
      throw new Error("invalid package unexpectedly loaded")
    } catch (error) {
      expect((error as any).diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "RESOURCE_FILE_MISSING" }),
      ]))
    }
  })

  it("shares a cached snapshot, detects source drift and switches the whole projection on refresh", async () => {
    const layers = await fixtureLayers()
    const adapter = new EidolonAppResourceRegistryAdapter({ layers })
    const [first, same] = await Promise.all([adapter.snapshot(), adapter.snapshot()])
    expect(same).toBe(first)

    const ctrl = await adapter.readEffectiveSource("eidolon.fixture.SupportCtrl", first)
    expect(ctrl.layerId).toBe("workspace")
    expect(ctrl.source).toContain("<AICtrlWorkflow #eidolon.fixture.SupportCtrl")

    const workspaceRoot = layers.find((layer) => layer.id === "workspace")!.rootDir
    const appPath = path.join(workspaceRoot, "Apps", "Support.xnl")
    const changed = (await Bun.file(appPath).text()).replace("Workspace support app", "Refreshed support app")
    await writeFile(appPath, changed, "utf8")

    expect((await adapter.snapshot()).registry.compositionRevision).toBe(first.registry.compositionRevision)
    await expect(adapter.readEffectiveSource("eidolon.fixture.SupportApp", first))
      .rejects.toThrow("EIDOLON_RESOURCE_SOURCE_DIGEST_MISMATCH")

    const refreshed = await adapter.refresh()
    expect(refreshed).not.toBe(first)
    expect(refreshed.registryRevision).not.toBe(first.registryRevision)
    expect(refreshed.appBundles[0]?.resource.description).toBe("Refreshed support app")
    expect((await adapter.readEffectiveSource("eidolon.fixture.SupportApp", refreshed)).source).toBe(changed)
  })

  it("admits one independently loaded publication candidate only after exact caller verification", async () => {
    const layers = await fixtureLayers()
    const adapter = new EidolonAppResourceRegistryAdapter({ layers })
    const previous = await adapter.snapshot()
    const workspaceRoot = layers.find((layer) => layer.id === "workspace")!.rootDir
    const appPath = path.join(workspaceRoot, "Apps", "Support.xnl")
    await writeFile(
      appPath,
      (await Bun.file(appPath).text()).replace("Workspace support app", "Verified publication app"),
      "utf8",
    )

    const candidateLoaded = deferred()
    const verificationComplete = deferred()
    const publication = adapter.withPublicationFence(async (fence) => {
      expect(fence.currentSnapshot).toBe(previous)
      const candidate = await fence.loadCandidateSnapshot()
      expect(candidate.snapshot.appBundles[0]?.resource.description).toBe("Verified publication app")
      candidateLoaded.resolve()
      await verificationComplete.promise
      return Object.freeze({ candidate, value: "exact-readback" as const })
    })

    await candidateLoaded.promise
    expect(await adapter.snapshot()).toBe(previous)
    await expect(adapter.readEffectiveSource("eidolon.fixture.SupportApp")).rejects.toMatchObject({
      code: "EIDOLON_RESOURCE_REGISTRY_PUBLICATION_RETRYABLE",
      retryable: true,
    })
    verificationComplete.resolve()

    const admitted = await publication
    expect(admitted.value).toBe("exact-readback")
    expect(admitted.previousSnapshot).toBe(previous)
    expect(admitted.snapshot.appBundles[0]?.resource.description).toBe("Verified publication app")
    expect(await adapter.snapshot()).toBe(admitted.snapshot)
    expect(Object.isFrozen(admitted)).toBe(true)
  })

  it("loads an explicit isolated candidate without changing the admitted snapshot", async () => {
    const layers = await fixtureLayers()
    const adapter = new EidolonAppResourceRegistryAdapter({ layers })
    const previous = await adapter.snapshot()
    const workspaceRoot = layers.find((layer) => layer.id === "workspace")!.rootDir
    const appPath = path.join(workspaceRoot, "Apps", "Support.xnl")
    await writeFile(
      appPath,
      (await Bun.file(appPath).text()).replace("Workspace support app", "Isolated candidate app"),
      "utf8",
    )

    const candidate = await adapter.loadIsolatedSnapshot({ layers })
    expect(candidate.appBundles[0]?.resource.description).toBe("Isolated candidate app")
    expect(candidate).not.toBe(previous)
    expect(await adapter.snapshot()).toBe(previous)
  })

  it("keeps the old authority on a failed publication callback and makes a queued refresh load afresh", async () => {
    const layers = await fixtureLayers()
    const adapter = new EidolonAppResourceRegistryAdapter({ layers })
    const previous = await adapter.snapshot()
    const workspaceRoot = layers.find((layer) => layer.id === "workspace")!.rootDir
    const appPath = path.join(workspaceRoot, "Apps", "Support.xnl")
    await writeFile(
      appPath,
      (await Bun.file(appPath).text()).replace("Workspace support app", "Unadmitted candidate app"),
      "utf8",
    )

    const candidateLoaded = deferred()
    const failPublication = deferred()
    const publication = adapter.withPublicationFence(async (fence) => {
      const candidate = await fence.loadCandidateSnapshot()
      expect(candidate.snapshot.appBundles[0]?.resource.description).toBe("Unadmitted candidate app")
      candidateLoaded.resolve()
      await failPublication.promise
      throw new Error("exact readback rejected")
    })
    await candidateLoaded.promise

    const refresh = adapter.refresh()
    let refreshSettled = false
    void refresh.finally(() => {
      refreshSettled = true
    })
    await Promise.resolve()
    expect(refreshSettled).toBe(false)

    await writeFile(
      appPath,
      (await Bun.file(appPath).text()).replace("Unadmitted candidate app", "Fresh refresh app"),
      "utf8",
    )
    failPublication.resolve()
    await expect(publication).rejects.toThrow("exact readback rejected")
    expect(await adapter.snapshot()).toBe(previous)

    const refreshed = await refresh
    expect(refreshed.appBundles[0]?.resource.description).toBe("Fresh refresh app")
    expect(refreshed).not.toBe(previous)
    expect(await adapter.snapshot()).toBe(refreshed)
  })

  it("rejects a candidate token from an earlier publication fence", async () => {
    const layers = await fixtureLayers()
    const adapter = new EidolonAppResourceRegistryAdapter({ layers })
    const previous = await adapter.snapshot()
    let staleCandidate: EidolonResourceRegistryPublicationCandidate | undefined

    await expect(adapter.withPublicationFence(async (fence) => {
      staleCandidate = await fence.loadCandidateSnapshot()
      throw new Error("verification did not complete")
    })).rejects.toThrow("verification did not complete")
    expect(staleCandidate).toBeDefined()

    await expect(adapter.withPublicationFence(async () => ({
      candidate: staleCandidate!,
      value: null,
    }))).rejects.toMatchObject({ code: "EIDOLON_RESOURCE_PUBLICATION_CANDIDATE_INVALID" })
    expect(await adapter.snapshot()).toBe(previous)
  })

  it("keeps the admitted snapshot authoritative when an ordinary refresh fails", async () => {
    const layers = await fixtureLayers()
    const adapter = new EidolonAppResourceRegistryAdapter({ layers })
    const previous = await adapter.snapshot()
    const workspaceRoot = layers.find((layer) => layer.id === "workspace")!.rootDir
    await writeFile(path.join(workspaceRoot, "manifest.xnl"), "not a resource package\n", "utf8")

    await expect(adapter.refresh()).rejects.toBeDefined()
    expect(await adapter.snapshot()).toBe(previous)
  })

  it("validates dependency owner, lexical path and symlink containment before reading", async () => {
    const layers = await fixtureLayers()
    const adapter = new EidolonAppResourceRegistryAdapter({ layers })
    const owner = await adapter.readEffectiveSource("eidolon.fixture.SupportCtrl")

    await expect(adapter.readEffectiveDependencySource(
      { ...owner },
      "flow-code/agent.ts",
    )).rejects.toThrow("EIDOLON_RESOURCE_DEPENDENCY_OWNER_INVALID")
    await expect(adapter.readEffectiveDependencySource(
      owner,
      "bad\uD800target.ts",
    )).rejects.toThrow("EIDOLON_RESOURCE_DEPENDENCY_PATH_INVALID")

    const workspaceRoot = layers.find((layer) => layer.id === "workspace")!.rootDir
    const outside = path.join(workspaceRoot, "outside.ts")
    const codeRoot = path.join(workspaceRoot, "CtrlWorkflows", "flow-code")
    await mkdir(codeRoot, { recursive: true })
    await writeFile(outside, "export const value = 1\n", "utf8")
    await symlink(outside, path.join(codeRoot, "outside.ts"))
    await expect(adapter.readEffectiveDependencySource(
      owner,
      "flow-code/outside.ts",
    )).rejects.toThrow("EIDOLON_RESOURCE_DEPENDENCY_OUTSIDE_OWNER")
  })

  it("exposes bounded App and reusable Agent queries from the shared WorkflowComponent", async () => {
    const layers = await fixtureLayers()
    const parent = path.dirname(layers[0]!.rootDir)
    const component = createWorkflowComponent({
      workspaceRoot: path.join(parent, "authoring"),
      resourceLayers: layers,
    })

    const apps = await component.queries.listApps()
    const app = await component.queries.getApp("eidolon.fixture.SupportApp")
    const agents = await component.queries.listReusableAgents()
    expect(apps).toEqual([{
      id: "eidolon.fixture.SupportApp",
      description: "Workspace support app",
      workflowCount: 2,
      entrypoints: ["resource://eidolon.fixture.SupportCtrl"],
      registryRevision: apps[0]?.registryRevision,
    }])
    expect(app).toMatchObject({
      id: "eidolon.fixture.SupportApp",
      kind: "AIWorkflowAppBundle",
      workflowCount: 2,
    })
    expect(app.bindings).toHaveLength(2)
    expect(agents).toEqual([{
      id: "eidolon.fixture.SupportAgent",
      description: "workspace reusable support agent",
      messageCount: 1,
      toolCount: 1,
      materialPortCount: 0,
      promptLoaded: false,
      registryRevision: apps[0]?.registryRevision,
    }])
  })

  it("resolves and freezes workflow definitions by exact effective ResourceRecord origin", async () => {
    const layers = await fixtureLayers()
    const parent = path.dirname(layers[0]!.rootDir)
    const component = createWorkflowComponent({
      workspaceRoot: path.join(parent, "authoring"),
      resourceLayers: layers,
    })
    expect(component.repository).toBeDefined()
    expect(await component.repository!.listResourceRefs()).toEqual([
      "resource://eidolon.fixture.SupportCtrl",
      "resource://eidolon.fixture.SupportData",
    ])

    const captured = await component.repository!.capture("resource://eidolon.fixture.SupportCtrl")
    expect(captured).toMatchObject({
      workflowRef: "resource://eidolon.fixture.SupportCtrl",
      fqn: "eidolon.fixture.SupportCtrl",
      form: "AICtrlWorkflow",
      sourceBundlePath: "CtrlWorkflows",
      resourceReceipt: {
        schemaVersion: "eidolon.workflow-definition-resource-receipt/v1",
        resourceId: "eidolon.fixture.SupportCtrl",
        kind: "AICtrlWorkflow",
        packageId: "eidolon.fixture.workspace.package",
        layerId: "workspace",
        logicalPath: "CtrlWorkflows/Support.xnl",
        authorityDigest: expect.stringMatching(/^sha256:/),
        contentDigest: expect.stringMatching(/^sha256:/),
      },
    })
    expect(captured.resourceReceipt?.registryRevision).toBe(
      (await component.resourceRegistry.snapshot()).registryRevision,
    )
    expect(captured.files["manifest.xnl"]).toContain("<AICtrlWorkflow #eidolon.fixture.SupportCtrl")

    await expect(component.repository!.resolve("resource://eidolon.fixture.SupportApp"))
      .rejects.toThrow("expected AICtrlWorkflow or AIDataWorkflow")
    await expect(component.repository!.resolve("resource://eidolon.fixture.Unknown"))
      .rejects.toThrow("EIDOLON_RESOURCE_NOT_FOUND")
    await expect(component.repository!.resolve(" resource://eidolon.fixture.SupportCtrl"))
      .rejects.toThrow("registry is not bound")

    await component.authoring!.store.writeAtomic("legacy/manifest.xnl", `<AICtrlWorkflow #eidolon.fixture.Legacy apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #eidolon.fixture.Legacy>
) [<Return #done>]>
`)
    const legacy = await component.repository!.capture("vfs://./legacy/manifest.xnl")
    expect(legacy.fqn).toBe("eidolon.fixture.Legacy")
    expect(legacy.resourceReceipt).toBeUndefined()
    expect(await component.repository!.listResourceRefs()).not.toContain("resource://eidolon.fixture.Legacy")
  })

  it("persists the exact resource receipt and restores frozen source after the live package changes", async () => {
    const layers = await fixtureLayers()
    const parent = path.dirname(layers[0]!.rootDir)
    const component = createWorkflowComponent({
      workspaceRoot: path.join(parent, "authoring"),
      resourceLayers: layers,
    })
    const frozen = await component.repository!.capture("resource://eidolon.fixture.SupportCtrl")
    const facts = new WorkflowFactStore(path.join(parent, "facts"))
    await facts.saveDefinitionRevision(frozen)

    const workspaceRoot = layers.find((layer) => layer.id === "workspace")!.rootDir
    const sourcePath = path.join(workspaceRoot, "CtrlWorkflows", "Support.xnl")
    await writeFile(sourcePath, `\n${await Bun.file(sourcePath).text()}`, "utf8")
    await component.resourceRegistry.refresh()
    const live = await component.repository!.capture("resource://eidolon.fixture.SupportCtrl")
    expect(live.revision).not.toBe(frozen.revision)
    expect(live.resourceReceipt?.registryRevision).not.toBe(frozen.resourceReceipt?.registryRevision)

    const restored = await facts.loadDefinitionRevision(frozen.revision)
    expect(restored).toEqual(frozen)
    const resolved = component.repository!.resolveFrozen(restored!, path.join(parent, "frozen"))
    expect(resolved.binding.definition.fqn).toBe("eidolon.fixture.SupportCtrl")
    expect(resolved.sources["manifest.xnl"]).toBe(frozen.files["manifest.xnl"])
  })

  it("returns bounded App list and detail through the native tool surface", async () => {
    const layers = await fixtureLayers()
    const parent = path.dirname(layers[0]!.rootDir)
    const runtime = {
      vm: {
        outerCtx: {
          workDir: parent,
          metadata: {
            aiWorkflow: { roots: { workspaceRoot: path.join(parent, "authoring") } },
            resourcePackages: { layers },
          },
        },
      },
      actor: {},
    } as any
    const definitions = buildWorkflowNativeToolDefs()
    const list = definitions.find((definition) => definition.schema.function.name === "WorkflowListApps")!
    const get = definitions.find((definition) => definition.schema.function.name === "WorkflowGetApp")!

    const listed = JSON.parse(String(await list.run(runtime, {})))
    const detailed = JSON.parse(String(await get.run(runtime, { app_resource_id: "eidolon.fixture.SupportApp" })))
    expect(listed).toMatchObject({
      ok: true,
      kind: "workflow.apps",
      effectDispatched: false,
      apps: [{ id: "eidolon.fixture.SupportApp", workflowCount: 2 }],
    })
    expect(detailed).toMatchObject({
      ok: true,
      kind: "workflow.app",
      effectDispatched: false,
      app: { id: "eidolon.fixture.SupportApp", kind: "AIWorkflowAppBundle" },
    })
    expect(JSON.stringify(listed)).not.toContain("byKind")
    expect(detailed.app.resource).toBeUndefined()
    expect(detailed.app.node).toBeUndefined()
    expect(detailed.app.source).toBeUndefined()
  })

  it("creates and runs an Instance from a resource receipt after the live package is unavailable", async () => {
    const layers = await fixtureLayers()
    const parent = path.dirname(layers[0]!.rootDir)
    const sessionDir = path.join(parent, "session")
    const workspaceRoot = path.join(parent, "authoring")
    const runtime = (resourceLayers: readonly ResourcePackageLayerBinding[]) => ({
      vm: {
        outerCtx: {
          workDir: parent,
          metadata: {
            sessionDir,
            aiWorkflow: { roots: { workspaceRoot } },
            resourcePackages: { layers: resourceLayers },
          },
        },
        registries: {},
      },
      actor: {},
    }) as any

    const first = new WorkflowRuntimeService(runtime(layers))
    const instance = await first.createInstance({
      workflowRef: "resource://eidolon.fixture.SupportCtrl",
      instanceId: "resource-instance",
      initialInput: { message: "hello" },
    })
    const frozen = await first.facts.loadDefinitionRevision(instance.definitionRevision)
    expect(frozen?.resourceReceipt).toMatchObject({
      resourceId: "eidolon.fixture.SupportCtrl",
      layerId: "workspace",
    })

    await rm(layers[0]!.rootDir, { recursive: true, force: true })
    await rm(layers[1]!.rootDir, { recursive: true, force: true })
    const recovered = new WorkflowRuntimeService(runtime([]))
    const result = await recovered.start({
      instanceId: instance.instanceId,
      runId: "resource-run",
      confirmed: true,
    })
    expect(result).toMatchObject({
      ok: true,
      status: "Completed",
      instance_id: "resource-instance",
      definition_revision: instance.definitionRevision,
    })
  })

  it("freezes exact external code for resource-backed Ctrl and Data Agent workflows", async () => {
    const layers = await fixtureLayers()
    const parent = path.dirname(layers[0]!.rootDir)
    const workspacePackage = layers.find((layer) => layer.id === "workspace")!.rootDir
    const flowCode = [
      `export async function invokeAgent(runtime: any, input: unknown, config: Record<string, unknown> = {}) {`,
      `  const result = await runtime.ai.effects.runAgent(input, {`,
      `    agentDefinitionRef: String(config.agentDefinitionRef),`,
      `  })`,
      `  return result.output`,
      `}`,
      `export async function invokeDataAgent(runtime: any, input: unknown, config: Record<string, unknown> = {}) {`,
      `  return { value: await invokeAgent(runtime, input, config) }`,
      `}`,
      `export function identity(_runtime: any, input: unknown) { return input }`,
      ``,
    ].join("\n")
    await mkdir(path.join(workspacePackage, "flow-code"), { recursive: true })
    await mkdir(path.join(workspacePackage, "CtrlWorkflows", "flow-code"), { recursive: true })
    await mkdir(path.join(workspacePackage, "DataWorkflows", "flow-code"), { recursive: true })
    await writeFile(path.join(workspacePackage, "flow-code", "agent.ts"), flowCode)
    await writeFile(
      path.join(workspacePackage, "CtrlWorkflows", "flow-code", "nested.ts"),
      "export function always() { return true }\nexport function identity(_runtime: any, input: unknown) { return input }\n",
    )
    await writeFile(
      path.join(workspacePackage, "Agents", "Support.xnl"),
      `<AIAgentDefinition #eidolon.fixture.SupportAgent apiVersion="depa.flows/v1" version="1.0.0" {
  lifecycle = "Active"
  description = "workspace reusable support agent"
} (
  <Messages [
    <Message #system { role = "system" promptKind = "Prompt" promptRef = "resource://eidolon.fixture.SupportPrompt" } (
      <SchemaRef { kind = "MessageSchema" ref = "resource://eidolon.fixture.ResponseSchema" }>
    )>
  ]>
  <InputSchemaRef { kind = "MessageSchema" ref = "resource://eidolon.fixture.InputSchema" }>
  <OutputSchemaRef { kind = "MessageSchema" ref = "resource://eidolon.fixture.ResponseSchema" }>
  <ToolRefs []>
  <EffectPolicyRef { kind = "EffectPolicy" ref = "resource://eidolon.fixture.SafePolicy" }>
  <MaterialPortRefs [
    <MaterialPortRef #request { kind = "MaterialPort" ref = "resource://eidolon.fixture.RequestPort" }>
  ]>
)>
`,
    )
    await mkdir(path.join(workspacePackage, "Schemas"), { recursive: true })
    await mkdir(path.join(workspacePackage, "Policies"), { recursive: true })
    await mkdir(path.join(workspacePackage, "Ports"), { recursive: true })
    await mkdir(path.join(workspacePackage, "Bindings"), { recursive: true })
    await mkdir(path.join(workspacePackage, "RequestMaterials"), { recursive: true })
    await writeFile(path.join(workspacePackage, "Schemas", "Input.xnl"), `<MessageSchema #eidolon.fixture.InputSchema apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Stable" schema = { type = "object" } }>`)
    await writeFile(path.join(workspacePackage, "Schemas", "Response.xnl"), `<MessageSchema #eidolon.fixture.ResponseSchema apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Stable" schema = { type = "string" } }>`)
    await writeFile(path.join(workspacePackage, "Policies", "Safe.xnl"), `<EffectPolicy #eidolon.fixture.SafePolicy apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Stable" toolMode = "declared-only" }>`)
    await writeFile(path.join(workspacePackage, "Ports", "Request.xnl"), `<MaterialPort #eidolon.fixture.RequestPort apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Stable" materialKind = "RequestMaterial" required = true cardinality = "one" } (
  <SchemaRef { kind = "MessageSchema" ref = "resource://eidolon.fixture.InputSchema" }>
)>`)
    await writeFile(path.join(workspacePackage, "RequestMaterials", "Request.xnl"), `<RequestMaterial #eidolon.fixture.RequestMaterial apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" value = { request = "material request" } }>`)
    await writeFile(path.join(workspacePackage, "Bindings", "Ctrl.xnl"), `<MaterialBinding #eidolon.fixture.CtrlBinding apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" } (
  <AgentTaskRef { workflowKind = "AICtrlWorkflow" workflowRef = "resource://eidolon.fixture.SupportCtrl" nodeId = "agent-node" agentDefinitionRef = "resource://eidolon.fixture.SupportAgent" }>
  <PortRef { kind = "MaterialPort" ref = "resource://eidolon.fixture.RequestPort" }>
  <MaterialRef { kind = "RequestMaterial" ref = "resource://eidolon.fixture.RequestMaterial" }>
)>`)
    await writeFile(path.join(workspacePackage, "Bindings", "Data.xnl"), `<MaterialBinding #eidolon.fixture.DataBinding apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" } (
  <AgentTaskRef { workflowKind = "AIDataWorkflow" workflowRef = "resource://eidolon.fixture.SupportData" nodeId = "agent-node" agentDefinitionRef = "resource://eidolon.fixture.SupportAgent" }>
  <PortRef { kind = "MaterialPort" ref = "resource://eidolon.fixture.RequestPort" }>
  <MaterialRef { kind = "RequestMaterial" ref = "resource://eidolon.fixture.RequestMaterial" }>
)>`)
    await writeFile(
      path.join(workspacePackage, "CtrlWorkflows", "Support.xnl"),
      `<AICtrlWorkflow #eidolon.fixture.SupportCtrl apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #eidolon.fixture.SupportCtrl>
) [
  <Run #agent-node { src = "vfs://@/flow-code/agent.ts#invokeAgent" config = { effectId = "ctrl-agent-effect" nodeId = "agent-node" agentDefinitionRef = "resource://eidolon.fixture.SupportAgent" } }>
  <If #route (
    <Branches [
      <Branch #complete { when = "vfs://./flow-code/nested.ts#always" } [
        <Return #done { src = "vfs://./flow-code/nested.ts#identity" }>
      ]>
      <Otherwise [
        <Return #fallback { src = "vfs://@/flow-code/agent.ts#identity" }>
      ]>
    ]>
  )>
]>
`,
    )
    await writeFile(
      path.join(workspacePackage, "DataWorkflows", "Support.xnl"),
      `<AIDataWorkflow #eidolon.fixture.SupportData apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #eidolon.fixture.SupportData { inputPorts = ["value"] outputPorts = ["value"] }>
) [
  <EntryNode #entry>
  <TransformNode #agent-node { inputs = { value = "flow-port://#entry/value" } outputs = ["value"] impl = "vfs://@/flow-code/agent.ts#invokeDataAgent" config = { effectId = "data-agent-effect" nodeId = "agent-node" agentDefinitionRef = "resource://eidolon.fixture.SupportAgent" reuse_policy = "never" } }>
  <ReturnNode #return { inputs = { value = "flow-port://#agent-node/value" } }>
]>
`,
    )

    const actor = createActor({
      key: "main",
      id: "resource-agent-runtime",
      llmClient: {
        type: "openai",
        async createStream() {
          async function* stream() { yield { ok: true } }
          return { stream: stream() }
        },
      },
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (vm, child) => {
          const message = { role: "assistant" as const, content: "resource Agent completed" }
          appendLiveHistoryMessageToConversationDomainRuntime({
            vm,
            actorKey: child.key,
            actorId: child.id,
            message,
          })
          return message
        },
      },
    })
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: {
        toolRegistry: composeToolRegistry(),
        agentRegistry: new AgentRegistry({}),
      },
      outerCtx: {
        workDir: parent,
        metadata: {
          sessionDir: path.join(parent, "resource-agent-session"),
          aiWorkflow: { roots: { workspaceRoot: path.join(parent, "authoring") } },
          resourcePackages: { layers },
        },
      },
    })
    const service = new WorkflowRuntimeService({ vm, actor } as any)
    const ctrlInstance = await service.createInstance({
      workflowRef: "resource://eidolon.fixture.SupportCtrl",
      instanceId: "resource-agent-ctrl",
      initialInput: { prompt: "ctrl request" },
    })
    const dataInstance = await service.createInstance({
      workflowRef: "resource://eidolon.fixture.SupportData",
      instanceId: "resource-agent-data",
      initialInput: { value: "data request" },
    })
    const ctrlFrozen = await service.facts.loadDefinitionRevision(ctrlInstance.definitionRevision)
    const dataFrozen = await service.facts.loadDefinitionRevision(dataInstance.definitionRevision)
    const ordered = (values: string[]) => values.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    const ctrlPaths = Object.keys(ctrlFrozen?.files ?? {})
    const dataPaths = Object.keys(dataFrozen?.files ?? {})
    const ctrlClosurePaths = ordered(ctrlPaths.filter((filePath) => filePath.startsWith(".agent-resources/")))
    const dataClosurePaths = ordered(dataPaths.filter((filePath) => filePath.startsWith(".agent-resources/")))
    expect(ctrlClosurePaths.length).toBeGreaterThan(0)
    expect(ctrlClosurePaths).toEqual(dataClosurePaths)
    expect(ordered(ctrlPaths.filter((filePath) => !filePath.startsWith(".agent-resources/")))).toEqual(ordered([
      "flow-code/agent.ts",
      "flow-code/nested.ts",
      "manifest.xnl",
    ]))
    expect(ordered(dataPaths.filter((filePath) => !filePath.startsWith(".agent-resources/")))).toEqual(ordered([
      "flow-code/agent.ts",
      "manifest.xnl",
    ]))

    const ctrlResult = await service.start({ instanceId: ctrlInstance.instanceId, runId: "resource-agent-ctrl-run", confirmed: true })
    const dataResult = await service.start({ instanceId: dataInstance.instanceId, runId: "resource-agent-data-run", confirmed: true })
    expect(ctrlResult).toMatchObject({ status: "Completed" })
    expect(dataResult).toMatchObject({ status: "Succeeded", output: { value: "resource Agent completed" } })
    const lifecycle = await readRuntimeControlEffectEvidence(path.join(parent, "resource-agent-session"))
    expect(lifecycle).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "result", effectId: expect.stringMatching(/^agent:resource-agent-ctrl:resource-agent-ctrl-run:agent-node#\d+$/), handlerKey: "workflow:ai.agent" }),
      expect.objectContaining({ kind: "result", effectId: expect.stringMatching(/^agent:resource-agent-data:resource-agent-data-run:agent-node#\d+$/), handlerKey: "workflow:ai.agent" }),
    ]))
    for (const runId of ["resource-agent-ctrl-run", "resource-agent-data-run"]) {
      await expect(access(path.join(
        parent, "resource-agent-session", "workflow-runtime", "agent-executions", runId,
      ))).rejects.toMatchObject({ code: "ENOENT" })
    }
  })
})
