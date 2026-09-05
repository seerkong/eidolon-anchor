import { afterEach, describe, expect, it } from "bun:test"
import { access, cp, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { readRuntimeControlEffectEvidence } from "@cell/ai-file-store-logic"
import { applyFileStoreAiRuntimeSessionUpgrade } from "@cell/ai-runtime-control-composer"
import {
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFileRuntimeDerivedIndexesStore,
  LocalFileRuntimeSnapshotRepositoryFactory,
} from "@cell/ai-support"
import { composeToolRegistry } from "../../src/composer/AIAgent/ToolFuncComposer"
import { appendLiveHistoryMessageToConversationDomainRuntime } from "../../src/conversation/ConversationDomainRuntime"
import { createAiAgentOrchestratorDriver } from "../../src/OrchestratorDriver"
import {
  configureRuntimePersistenceSupport,
  recoverAiAgentRuntime,
  saveAiAgentRuntimeSnapshot,
} from "../../src/persistence/RuntimeSnapshots"
import {
  bindWorkflowComponentToRuntime,
  createWorkflowComponent,
  runWorkflowNativeHostCommand,
} from "../../src/workflow"
import { WorkflowRuntimeService } from "../../src/workflow/runtime"
import {
  depaAIResourceKindContract,
  type DepaAIResourceKind,
} from "ai-workflow-contract"

const fixtureRoot = path.join(import.meta.dir, "fixtures", "resource-native-authoring-package")
const temporaryRoots: string[] = []
const extensionCodecs = Object.freeze({
  resolve: (kind: string) => kind === "eidolon.fixture.review-policy"
    ? Object.freeze({
        schemaRef: "schema://eidolon.fixture.review-policy/v1",
        codec: Object.freeze({
          normalize: (value: unknown) => value,
        }),
      })
    : undefined,
})

configureRuntimePersistenceSupport({
  snapshotRepositoryFactory: LocalFileRuntimeSnapshotRepositoryFactory,
  derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore,
  conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
})

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const kindDefinition = (kind: DepaAIResourceKind) => depaAIResourceKindContract(kind).kindDefinitionSource

const completeManifest = `<ResourcePackage #eidolon.fixture.resource_native_authoring envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {
  lifecycle = "Active"
  description = "Complete ResourcePackage fixture for whole-package authoring"
  packageVersion = "1.0.0"
} (
  <Catalogs [
    <Catalog #kind_definitions { kind = "KindDefinition" shape = "directory" root = "vfs://./KindDefinitions/" entry = "manifest.xnl" }>
    <Catalog #apps { kind = "AIWorkflowAppBundle" shape = "single-file" root = "vfs://./Apps/" }>
    <Catalog #ctrl_workflows { kind = "AICtrlWorkflow" shape = "single-file" root = "vfs://./Workflows/" }>
    <Catalog #data_workflows { kind = "AIDataWorkflow" shape = "single-file" root = "vfs://./DataWorkflows/" }>
    <Catalog #agents { kind = "AIAgentDefinition" shape = "single-file" root = "vfs://./Agents/" }>
    <Catalog #context_pipelines { kind = "AgentContextPipeline" shape = "single-file" root = "vfs://./ContextPipelines/" }>
    <Catalog #prompts { kind = "Prompt" shape = "single-file" root = "vfs://./Prompts/" }>
    <Catalog #schemas { kind = "MessageSchema" shape = "single-file" root = "vfs://./Schemas/" }>
    <Catalog #policies { kind = "EffectPolicy" shape = "single-file" root = "vfs://./Policies/" }>
    <Catalog #ports { kind = "MaterialPort" shape = "single-file" root = "vfs://./Ports/" }>
    <Catalog #materials { kind = "ContextMaterial" shape = "single-file" root = "vfs://./Materials/" }>
    <Catalog #bindings { kind = "MaterialBinding" shape = "single-file" root = "vfs://./Bindings/" }>
  ]>
)>
`

const app = `<AIWorkflowAppBundle #eidolon.fixture.SummaryApp envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {
  lifecycle = "Active" description = "Complete Agent Ctrl/Data app"
} (
  <WorkflowBindings [
    <WorkflowBinding #summary { kind = "AICtrlWorkflow" ref = "resource://eidolon.fixture.SummaryWorkflow" entrypoint = true }>
    <WorkflowBinding #transform { kind = "AIDataWorkflow" ref = "resource://eidolon.fixture.SummaryDataWorkflow" entrypoint = false }>
  ]>
)>
`

const agent = `<AIAgentDefinition #eidolon.fixture.SummaryAgent envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {
  lifecycle = "Active" description = "Exact reusable summary Agent"
} (
  <MessagePrefix [
    <Message #system { role = "system" promptKind = "Prompt" promptRef = "resource://eidolon.fixture.SummaryPrompt" }>
  ]>
  <ContextPipeline { kind = "AgentContextPipeline" ref = "resource://eidolon.fixture.StandardContext" }>
  <InputSchemaRef { kind = "MessageSchema" ref = "resource://eidolon.fixture.InputSchema" }>
  <OutputSchemaRef { kind = "MessageSchema" ref = "resource://eidolon.fixture.OutputSchema" }>
  <ToolRefs []>
  <EffectPolicyRef { kind = "EffectPolicy" ref = "resource://eidolon.fixture.DeclaredOnlyPolicy" }>
  <MaterialPortRefs [
    <MaterialPortRef #article { kind = "MaterialPort" ref = "resource://eidolon.fixture.ArticlePort" }>
  ]>
)>
`

const ctrlWorkflow = `<AICtrlWorkflow #eidolon.fixture.SummaryWorkflow envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 (
  <FlowContract #eidolon.fixture.SummaryWorkflow>
  <StepSpaceRef { src = "step-space/step-space.xnl" }>
)>
`

const ctrlStepSpace = `<StepSpace #eidolon.fixture.SummaryCtrlSteps apiVersion="depa.flows/v1" version="1" [
  <StepRef #summarize { src = "step-space/steps/summarize/step.xnl" }>
  <StepRef #mutate-policy { src = "step-space/steps/mutate-policy/step.xnl" }>
  <StepRef #continue-by-name { src = "step-space/steps/continue-by-name/step.xnl" }>
  <StepRef #refine-by-name { src = "step-space/steps/refine-by-name/step.xnl" }>
  <StepRef #continue-by-id { src = "step-space/steps/continue-by-id/step.xnl" }>
  <StepRef #refine-by-id { src = "step-space/steps/refine-by-id/step.xnl" }>
  <StepRef #done { src = "step-space/steps/done/step.xnl" }>
]>
`

const ctrlSteps = {
  summarize: `<Step #summarize (
    <Core [<Run #summarize { src = "vfs://./flow-code/agent.ts#createAgent" config = { nodeId = "summarize" agentDefinitionRef = "resource://eidolon.fixture.SummaryAgent" } }>]>
    <Extensions [<ExtensionRef { kind = "eidolon.fixture.review-policy" src = "step-space/steps/summarize/review-policy.xnl" schema = "schema://eidolon.fixture.review-policy/v1" }>]>
  )>`,
  "mutate-policy": `<Step #mutate-policy (<Core [<Run #mutate-policy { src = "vfs://./flow-code/agent.ts#mutateCtrlPolicy" config = { stepId = "summarize" extensionKind = "eidolon.fixture.review-policy" expectedRevision = 0 } }>]>)>`,
  "continue-by-name": `<Step #continue-by-name (<Core [<ExternalJob #continue-by-name { signalKind = "agent.continue" signalKey = "by-name" }>]>)>`,
  "refine-by-name": `<Step #refine-by-name (<Core [<Run #refine-by-name { src = "vfs://./flow-code/agent.ts#targetAgentByName" config = { nodeId = "refine-by-name" agentDefinitionRef = "resource://eidolon.fixture.SummaryAgent" } }>]>)>`,
  "continue-by-id": `<Step #continue-by-id (<Core [<ExternalJob #continue-by-id { signalKind = "agent.continue" signalKey = "by-id" }>]>)>`,
  "refine-by-id": `<Step #refine-by-id (<Core [<Run #refine-by-id { src = "vfs://./flow-code/agent.ts#targetAgentById" config = { nodeId = "refine-by-id" agentDefinitionRef = "resource://eidolon.fixture.SummaryAgent" } }>]>)>`,
  done: `<Step #done (<Core [<Return #done>]>)>`,
} as const

const dataWorkflow = `<AIDataWorkflow #eidolon.fixture.SummaryDataWorkflow envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 (
  <FlowContract #eidolon.fixture.SummaryDataWorkflow { inputPorts = ["topic"] outputPorts = ["summary"] }>
  <StepSpaceRef { src = "step-space/step-space.xnl" }>
)>
`

const dataStepSpace = `<StepSpace #eidolon.fixture.SummaryDataSteps apiVersion="depa.flows/v1" version="1" [
  <StepRef #entry { src = "step-space/steps/entry/step.xnl" }>
  <StepGroup #agent-processing [
    <StepRef #transform { src = "step-space/steps/transform/step.xnl" }>
    <StepRef #wait-data-by-name { src = "step-space/steps/wait-data-by-name/step.xnl" }>
    <StepRef #refine-data-by-name { src = "step-space/steps/refine-data-by-name/step.xnl" }>
    <StepRef #wait-data-by-id { src = "step-space/steps/wait-data-by-id/step.xnl" }>
    <StepRef #refine-data-by-id { src = "step-space/steps/refine-data-by-id/step.xnl" }>
  ]>
  <StepRef #return { src = "step-space/steps/return/step.xnl" }>
]>
`

const dataSteps = {
  entry: `<Step #entry (<Core [<EntryNode #entry>]>)>`,
  transform: `<Step #transform (
    <Core [<TransformNode #transform { inputs = { topic = "flow-port://#entry/topic" } outputs = ["summary" "instanceId"] impl = "vfs://./flow-code/agent.ts#createDataAgent" config = { effectId = "data-agent-effect" nodeId = "transform" agentDefinitionRef = "resource://eidolon.fixture.SummaryAgent" reuse_policy = "never" } }>]>
    <Extensions [<ExtensionRef { kind = "eidolon.fixture.review-policy" src = "step-space/steps/transform/review-policy.xnl" schema = "schema://eidolon.fixture.review-policy/v1" }>]>
  )>`,
  "wait-data-by-name": `<Step #wait-data-by-name (<Core [<TransformNode #wait-data-by-name { inputs = { summary = "flow-port://#transform/summary" instanceId = "flow-port://#transform/instanceId" } outputs = ["summary" "instanceId"] impl = "vfs://./flow-code/agent.ts#passData" config = { node_type = "manual" } }>]>)>`,
  "refine-data-by-name": `<Step #refine-data-by-name (<Core [<TransformNode #refine-data-by-name { inputs = { summary = "flow-port://#wait-data-by-name/summary" instanceId = "flow-port://#wait-data-by-name/instanceId" } outputs = ["summary" "instanceId"] impl = "vfs://./flow-code/agent.ts#targetDataAgentByName" config = { nodeId = "refine-data-by-name" agentDefinitionRef = "resource://eidolon.fixture.SummaryAgent" reuse_policy = "never" } }>]>)>`,
  "wait-data-by-id": `<Step #wait-data-by-id (<Core [<TransformNode #wait-data-by-id { inputs = { summary = "flow-port://#refine-data-by-name/summary" instanceId = "flow-port://#refine-data-by-name/instanceId" } outputs = ["summary" "instanceId"] impl = "vfs://./flow-code/agent.ts#passData" config = { node_type = "manual" } }>]>)>`,
  "refine-data-by-id": `<Step #refine-data-by-id (<Core [<TransformNode #refine-data-by-id { inputs = { summary = "flow-port://#wait-data-by-id/summary" instanceId = "flow-port://#wait-data-by-id/instanceId" } outputs = ["summary" "instanceId"] impl = "vfs://./flow-code/agent.ts#targetDataAgentById" config = { nodeId = "refine-data-by-id" agentDefinitionRef = "resource://eidolon.fixture.SummaryAgent" reuse_policy = "never" } }>]>)>`,
  return: `<Step #return (<Core [<ReturnNode #return { inputs = { summary = "flow-port://#refine-data-by-id/summary" } }>]>)>`,
} as const

const flowCode = `export async function createDataAgent(runtime: any, input: unknown, config: Record<string, unknown> = {}) {
  const result = config.repairIntent
    ? await runtime.ai.effects.runTargetedAgent(
      { byName: "data-summary-agent" },
      { kind: "ai.agent", payload: input },
      { agentDefinitionRef: String(config.agentDefinitionRef) },
    )
    : await runtime.ai.effects.runAgent(input, {
      agentDefinitionRef: String(config.agentDefinitionRef),
      instanceName: "data-summary-agent",
    })
  return { summary: result.output.summary, instanceId: result.instance.instanceId }
}

export function passData(_runtime: any, input: unknown) {
  return input
}

export async function targetDataAgentByName(runtime: any, input: any, config: Record<string, unknown> = {}) {
  const result = await runtime.ai.effects.runTargetedAgent(
    { byName: "data-summary-agent" },
    { kind: "ai.agent", payload: input },
    { agentDefinitionRef: String(config.agentDefinitionRef) },
  )
  return { summary: result.output.summary, instanceId: result.instance.instanceId }
}

export async function targetDataAgentById(runtime: any, input: any, config: Record<string, unknown> = {}) {
  const result = await runtime.ai.effects.runTargetedAgent(
    { byId: String(input.instanceId) },
    { kind: "ai.agent", payload: input },
    { agentDefinitionRef: String(config.agentDefinitionRef) },
  )
  return { summary: result.output.summary, instanceId: result.instance.instanceId }
}

export function createAgent(runtime: any, input: unknown, config: Record<string, unknown> = {}) {
  return runtime.ai.effects.runAgent(input, {
    agentDefinitionRef: String(config.agentDefinitionRef),
    instanceName: "summary-agent",
  })
}

export async function mutateCtrlPolicy(runtime: any, input: unknown, config: Record<string, unknown> = {}) {
  const run = runtime.ai.metadata.run
  await runtime.ai.effects.mutateRunStepExtension(
    {
      instanceId: String(runtime.ai.metadata.flowInstanceId),
      runId: String(run.runId),
      stepId: String(config.stepId),
      kind: String(config.extensionKind),
    },
    {
      expectedRevision: Number(config.expectedRevision),
      value: { reviewDepth: 2, audience: "product" },
    },
    {},
  )
  return input
}

export function targetAgentByName(runtime: any, input: unknown, config: Record<string, unknown> = {}) {
  return runtime.ai.effects.runTargetedAgent(
    { byName: "summary-agent" },
    { kind: "ai.agent", payload: input },
    { agentDefinitionRef: String(config.agentDefinitionRef) },
  )
}

export async function targetAgentById(runtime: any, input: any, config: Record<string, unknown> = {}) {
  const result = await runtime.ai.effects.runTargetedAgent(
    { byId: String(input.instanceId) },
    { kind: "ai.agent", payload: input },
    { agentDefinitionRef: String(config.agentDefinitionRef) },
  )
  return result.output
}
`

const ctrlBinding = `<MaterialBinding #eidolon.fixture.ArticleBinding envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle = "Active" } (
  <AgentTaskRef { workflowKind = "AICtrlWorkflow" workflowRef = "resource://eidolon.fixture.SummaryWorkflow" nodeId = "summarize" agentDefinitionRef = "resource://eidolon.fixture.SummaryAgent" }>
  <PortRef { kind = "MaterialPort" ref = "resource://eidolon.fixture.ArticlePort" }>
  <MaterialRef { kind = "ContextMaterial" ref = "resource://eidolon.fixture.Article" }>
)>
`

const dataBinding = `<MaterialBinding #eidolon.fixture.DataArticleBinding envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle = "Active" } (
  <AgentTaskRef { workflowKind = "AIDataWorkflow" workflowRef = "resource://eidolon.fixture.SummaryDataWorkflow" nodeId = "transform" agentDefinitionRef = "resource://eidolon.fixture.SummaryAgent" }>
  <PortRef { kind = "MaterialPort" ref = "resource://eidolon.fixture.ArticlePort" }>
  <MaterialRef { kind = "ContextMaterial" ref = "resource://eidolon.fixture.Article" }>
)>
`

const dataTargetByNameBinding = `<MaterialBinding #eidolon.fixture.DataArticleByNameBinding envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle = "Active" } (
  <AgentTaskRef { workflowKind = "AIDataWorkflow" workflowRef = "resource://eidolon.fixture.SummaryDataWorkflow" nodeId = "refine-data-by-name" agentDefinitionRef = "resource://eidolon.fixture.SummaryAgent" }>
  <PortRef { kind = "MaterialPort" ref = "resource://eidolon.fixture.ArticlePort" }>
  <MaterialRef { kind = "ContextMaterial" ref = "resource://eidolon.fixture.Article" }>
)>
`

const dataTargetByIdBinding = `<MaterialBinding #eidolon.fixture.DataArticleByIdBinding envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle = "Active" } (
  <AgentTaskRef { workflowKind = "AIDataWorkflow" workflowRef = "resource://eidolon.fixture.SummaryDataWorkflow" nodeId = "refine-data-by-id" agentDefinitionRef = "resource://eidolon.fixture.SummaryAgent" }>
  <PortRef { kind = "MaterialPort" ref = "resource://eidolon.fixture.ArticlePort" }>
  <MaterialRef { kind = "ContextMaterial" ref = "resource://eidolon.fixture.Article" }>
)>
`

const ctrlTargetByNameBinding = `<MaterialBinding #eidolon.fixture.ArticleByNameBinding envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle = "Active" } (
  <AgentTaskRef { workflowKind = "AICtrlWorkflow" workflowRef = "resource://eidolon.fixture.SummaryWorkflow" nodeId = "refine-by-name" agentDefinitionRef = "resource://eidolon.fixture.SummaryAgent" }>
  <PortRef { kind = "MaterialPort" ref = "resource://eidolon.fixture.ArticlePort" }>
  <MaterialRef { kind = "ContextMaterial" ref = "resource://eidolon.fixture.Article" }>
)>
`

const ctrlTargetByIdBinding = `<MaterialBinding #eidolon.fixture.ArticleByIdBinding envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle = "Active" } (
  <AgentTaskRef { workflowKind = "AICtrlWorkflow" workflowRef = "resource://eidolon.fixture.SummaryWorkflow" nodeId = "refine-by-id" agentDefinitionRef = "resource://eidolon.fixture.SummaryAgent" }>
  <PortRef { kind = "MaterialPort" ref = "resource://eidolon.fixture.ArticlePort" }>
  <MaterialRef { kind = "ContextMaterial" ref = "resource://eidolon.fixture.Article" }>
)>
`

describe("complete AIAgentDefinition Ctrl/Data product integration", () => {
  it("authors, proves, publishes and runs both workflow profiles through the typed Agent facade", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-complete-agent-e2e-"))
    temporaryRoots.push(parent)
    const resourceRoot = path.join(parent, "resources")
    await cp(fixtureRoot, resourceRoot, { recursive: true })
    const component = createWorkflowComponent({
      workspaceRoot: path.join(parent, "workflows"),
      resourceLayers: [{ id: "workspace", rootDir: resourceRoot }],
      extensionCodecs,
    })
    const opened = await component.sessions.openResourcePackage({
      sessionId: "complete-agent-authoring",
      source: { kind: "workspace-layer" },
    })
    const patched = await component.sessions.applyPatch({
      sessionId: opened.sessionId,
      expectedWorkingRevision: opened.workingRevision,
      operations: [
        { kind: "update", path: "/work/manifest.xnl", content: completeManifest },
        { kind: "update", path: "/work/Apps/Summary.xnl", content: app },
        { kind: "update", path: "/work/Agents/Summary.xnl", content: agent },
        { kind: "add", path: "/work/KindDefinitions/AgentContextPipeline/manifest.xnl", content: kindDefinition("AgentContextPipeline") },
        { kind: "add", path: "/work/ContextPipelines/StandardContext.xnl", content: `<AgentContextPipeline #eidolon.fixture.StandardContext envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle = "Stable" description = "Canonical Eidolon context pipeline" } (\n  <Content ?>{"implementation":"eidolon.standard-context-pipeline/v1","stages":["prompt-plan","conversation-prelude","provider-context-facts-at-history-anchors","stable-message-prefix","conversation-boundary-overlays","provider-conversion"]}</?>\n)>` },
        { kind: "update", path: "/work/Workflows/Summary.xnl", content: ctrlWorkflow },
        { kind: "add", path: "/work/Workflows/step-space/step-space.xnl", content: ctrlStepSpace },
        ...Object.entries(ctrlSteps).map(([stepId, content]) => ({
          kind: "add" as const,
          path: `/work/Workflows/step-space/steps/${stepId}/step.xnl`,
          content,
        })),
        { kind: "add", path: "/work/Workflows/step-space/steps/summarize/review-policy.xnl", content: `<StepExtension #summarize-review-policy { kind = "eidolon.fixture.review-policy" schema = "schema://eidolon.fixture.review-policy/v1" value = { reviewDepth = 1 audience = "product" } }>` },
        { kind: "update", path: "/work/Workflows/flow-code/agent.ts", content: flowCode },
        { kind: "update", path: "/work/Bindings/Article.xnl", content: ctrlBinding },
        { kind: "add", path: "/work/Bindings/ArticleByName.xnl", content: ctrlTargetByNameBinding },
        { kind: "add", path: "/work/Bindings/ArticleById.xnl", content: ctrlTargetByIdBinding },
        { kind: "add", path: "/work/KindDefinitions/AIDataWorkflow/manifest.xnl", content: kindDefinition("AIDataWorkflow") },
        { kind: "add", path: "/work/KindDefinitions/MessageSchema/manifest.xnl", content: kindDefinition("MessageSchema") },
        { kind: "add", path: "/work/KindDefinitions/EffectPolicy/manifest.xnl", content: kindDefinition("EffectPolicy") },
        { kind: "add", path: "/work/DataWorkflows/Summary.xnl", content: dataWorkflow },
        { kind: "add", path: "/work/DataWorkflows/step-space/step-space.xnl", content: dataStepSpace },
        ...Object.entries(dataSteps).map(([stepId, content]) => ({
          kind: "add" as const,
          path: `/work/DataWorkflows/step-space/steps/${stepId}/step.xnl`,
          content,
        })),
        { kind: "add", path: "/work/DataWorkflows/step-space/steps/transform/review-policy.xnl", content: `<StepExtension #transform-review-policy { kind = "eidolon.fixture.review-policy" schema = "schema://eidolon.fixture.review-policy/v1" value = { reviewDepth = 1 audience = "product" } }>` },
        { kind: "add", path: "/work/DataWorkflows/step-space/unreferenced-malformed.xnl", content: `<not-valid` },
        { kind: "add", path: "/work/DataWorkflows/step-space/unreferenced-sibling.xnl", content: `<AIDataWorkflow #eidolon.fixture.Unreferenced apiVersion="depa.flows/v1" version="1.0.0" (<FlowContract #eidolon.fixture.Unreferenced { inputPorts = ["input"] outputPorts = ["output"] }>) [<EntryNode #entry> <ReturnNode #return { inputs = { output = "flow-port://#entry/input" } }>]>` },
        { kind: "add", path: "/work/DataWorkflows/flow-code/agent.ts", content: flowCode },
        { kind: "add", path: "/work/Schemas/Input.xnl", content: `<MessageSchema #eidolon.fixture.InputSchema envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle = "Stable" schema = { type = "object" } }>` },
        { kind: "add", path: "/work/Schemas/Output.xnl", content: `<MessageSchema #eidolon.fixture.OutputSchema envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle = "Stable" schema = { type = "object" properties = { summary = { type = "string" } } required = ["summary"] additionalProperties = false } }>` },
        { kind: "add", path: "/work/Policies/DeclaredOnly.xnl", content: `<EffectPolicy #eidolon.fixture.DeclaredOnlyPolicy envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle = "Stable" toolMode = "declared-only" }>` },
        { kind: "add", path: "/work/Bindings/DataArticle.xnl", content: dataBinding },
        { kind: "add", path: "/work/Bindings/DataArticleByName.xnl", content: dataTargetByNameBinding },
        { kind: "add", path: "/work/Bindings/DataArticleById.xnl", content: dataTargetByIdBinding },
      ],
    })

    expect(await readFile(path.join(resourceRoot, "Apps", "Summary.xnl"), "utf8"))
      .not.toContain("SummaryDataWorkflow")
    const prepared = await component.sessions.prepareResourcePackagePublication({ sessionId: opened.sessionId })
    expect(prepared.revision).toBe(patched.revision)
    expect(prepared.proofSet.workflowProfileReceipts.map((receipt) => receipt.workflowKind)).toEqual([
      "AIDataWorkflow",
      "AICtrlWorkflow",
    ])
    expect(prepared.proofSet.runResourceReceipts.map((receipt) => receipt.task)).toEqual([
      {
        workflowKind: "AICtrlWorkflow",
        workflowRef: "resource://eidolon.fixture.SummaryWorkflow",
        nodeId: "refine-by-id",
        agentDefinitionRef: "resource://eidolon.fixture.SummaryAgent",
      },
      {
        workflowKind: "AICtrlWorkflow",
        workflowRef: "resource://eidolon.fixture.SummaryWorkflow",
        nodeId: "refine-by-name",
        agentDefinitionRef: "resource://eidolon.fixture.SummaryAgent",
      },
      {
        workflowKind: "AICtrlWorkflow",
        workflowRef: "resource://eidolon.fixture.SummaryWorkflow",
        nodeId: "summarize",
        agentDefinitionRef: "resource://eidolon.fixture.SummaryAgent",
      },
      {
        workflowKind: "AIDataWorkflow",
        workflowRef: "resource://eidolon.fixture.SummaryDataWorkflow",
        nodeId: "refine-data-by-id",
        agentDefinitionRef: "resource://eidolon.fixture.SummaryAgent",
      },
      {
        workflowKind: "AIDataWorkflow",
        workflowRef: "resource://eidolon.fixture.SummaryDataWorkflow",
        nodeId: "refine-data-by-name",
        agentDefinitionRef: "resource://eidolon.fixture.SummaryAgent",
      },
      {
        workflowKind: "AIDataWorkflow",
        workflowRef: "resource://eidolon.fixture.SummaryDataWorkflow",
        nodeId: "transform",
        agentDefinitionRef: "resource://eidolon.fixture.SummaryAgent",
      },
    ])
    const preview = await component.resourcePackagePublisher!.publish({
      sessionId: opened.sessionId,
      expectedRevision: prepared.revision,
      confirmed: false,
    })
    expect(preview).toMatchObject({ status: "confirmation_required", runtimeEffectDispatched: false })
    const published = await component.resourcePackagePublisher!.publish({
      sessionId: opened.sessionId,
      expectedRevision: prepared.revision,
      confirmed: true,
    })
    expect(published).toMatchObject({
      status: "published",
      receipt: {
        workflowRefs: [
          "resource://eidolon.fixture.SummaryDataWorkflow",
          "resource://eidolon.fixture.SummaryWorkflow",
        ],
        agentRefs: ["resource://eidolon.fixture.SummaryAgent"],
        publicationEffectDispatched: true,
        runtimeEffectDispatched: false,
      },
    })

    const acceptedSummary = "schema-valid Agent result"
    const verifySummary = (value: unknown) => value === acceptedSummary
    let providerCalls = 0
    const actor = createActor({
      key: "main",
      id: "complete-agent-runtime",
      llmClient: {
        type: "openai",
        async createStream() {
          async function* stream() {}
          return { stream: stream() }
        },
      },
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (vm, child) => {
          providerCalls += 1
          const summary = providerCalls === 2 ? "schema-incomplete Agent result" : acceptedSummary
          const message = { role: "assistant" as const, content: JSON.stringify({ summary }) }
          appendLiveHistoryMessageToConversationDomainRuntime({ vm, actorKey: child.key, actorId: child.id, message })
          return message
        },
      },
    })
    const runtime = {
      vm: createVM({
        controlActorKey: actor.key,
        actors: { [actor.key]: actor },
        registries: { toolRegistry: composeToolRegistry(), agentRegistry: new AgentRegistry({}) },
        outerCtx: {
          workDir: parent,
          metadata: {
            sessionDir: path.join(parent, "runtime-session"),
            sessionId: "complete-agent-runtime-session",
            aiWorkflow: {
              roots: { workspaceRoot: path.join(parent, "workflows") },
              extensionCodecs,
            },
            resourcePackages: { layers: [{ id: "workspace", rootDir: resourceRoot }] },
          },
        },
      }),
      actor,
    } as any
    bindWorkflowComponentToRuntime(runtime, component)
    const recoverRuntimeOwner = async (sourceRuntime: any) => {
      const actors = Object.values(sourceRuntime.vm.actors) as any[]
      const snapshotDriver = createAiAgentOrchestratorDriver({
        fibers: actors.map((currentActor) => ({
          fiberId: `${currentActor.key}:${currentActor.id}`,
          vm: sourceRuntime.vm,
          actor: currentActor,
          messages: currentActor.messages,
          basePriority: 1,
        })),
        runStep: async () => ({ kind: "yield" as const }),
        options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
      })
      expect((await saveAiAgentRuntimeSnapshot({
        sessionDir: path.join(parent, "runtime-session"),
        sessionId: "complete-agent-runtime-session",
        vm: sourceRuntime.vm,
        driver: snapshotDriver,
      })).status).toBe("saved")
      const upgraded = await applyFileStoreAiRuntimeSessionUpgrade({
        sessionDir: path.join(parent, "runtime-session"),
      })
      expect(["applied", "already_upgraded"]).toContain(upgraded.status)
      const recovered = await recoverAiAgentRuntime({
        sessionDir: path.join(parent, "runtime-session"),
        sessionId: "complete-agent-runtime-session",
        llmClient: sourceRuntime.actor.llmClient,
        actorCallbacks: sourceRuntime.actor.callbacks,
        registries: sourceRuntime.vm.registries,
        callbacks: sourceRuntime.vm.callbacks,
        effects: sourceRuntime.vm.effects,
        outerCtx: sourceRuntime.vm.outerCtx,
        mcpManager: sourceRuntime.vm.mcpManager,
      })
      expect(recovered).not.toBeNull()
      const nextRuntime = { vm: recovered!.vm, actor: recovered!.controlActor } as any
      bindWorkflowComponentToRuntime(nextRuntime, component)
      return nextRuntime
    }
    const service = new WorkflowRuntimeService(runtime)
    const ctrlInstance = await service.createInstance({
      workflowRef: "resource://eidolon.fixture.SummaryWorkflow",
      instanceId: "complete-agent-ctrl",
      initialInput: { topic: "ctrl" },
    })
    const dataInstance = await service.createInstance({
      workflowRef: "resource://eidolon.fixture.SummaryDataWorkflow",
      instanceId: "complete-agent-data",
      initialInput: { topic: "data" },
    })
    expect(await readFile(path.join(
      parent,
      "runtime-session",
      "workflow-runtime",
      "instances",
      ctrlInstance.instanceId,
      "definition",
      ".agent-resources",
      "workspace",
      "Agents",
      "Summary.xnl",
    ), "utf8")).toContain("AIAgentDefinition #eidolon.fixture.SummaryAgent")
    expect(await readFile(path.join(
      parent,
      "runtime-session",
      "workflow-runtime",
      "instances",
      dataInstance.instanceId,
      "definition",
      ".agent-resources",
      "workspace",
      "DataWorkflows",
      "step-space",
      "steps",
      "transform",
      "review-policy.xnl",
    ), "utf8")).toContain('kind = "eidolon.fixture.review-policy"')
    await rm(resourceRoot, { recursive: true })
    const freshService = new WorkflowRuntimeService(runtime)
    const ctrlResult = await freshService.start({ instanceId: ctrlInstance.instanceId, runId: "complete-agent-ctrl-run", confirmed: true })
    const dataResult = await freshService.start({ instanceId: dataInstance.instanceId, runId: "complete-agent-data-run", confirmed: true })
    expect(ctrlResult).toMatchObject({ status: "Waiting" })
    expect(dataResult).toMatchObject({ status: "Waiting" })
    expect(providerCalls).toBe(2)
    const initialDataSummary = dataResult.nodes.find((node: any) => node.id === "transform")?.result?.output?.summary
    expect(initialDataSummary).toBe("schema-incomplete Agent result")
    expect(verifySummary(initialDataSummary)).toBe(false)
    expect(Object.values(runtime.vm.actors).filter((candidate: any) => candidate.key !== "main"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          contextPipeline: expect.objectContaining({
            implementation: "eidolon.standard-context-pipeline/v1",
            resourceId: "eidolon.fixture.StandardContext",
          }),
        }),
      ]))
    const mutationCheckpoint = await freshService.mutateRunStepExtension({
      instanceId: dataInstance.instanceId,
      runId: "complete-agent-data-run",
      stepId: "transform",
      kind: "eidolon.fixture.review-policy",
      expectedRevision: 0,
      value: { reviewDepth: 2, audience: "product" },
    })
    const mutationFact = mutationCheckpoint.stepExtensions?.byStepId.transform?.["eidolon.fixture.review-policy"]
    const mutation = {
      ok: true,
      kind: "workflow.stepExtensionMutation",
      instance_id: mutationCheckpoint.instanceId,
      run_id: mutationCheckpoint.runId,
      step_id: "transform",
      extension_kind: "eidolon.fixture.review-policy",
      checkpoint_version: mutationCheckpoint.version,
      schema_ref: mutationFact?.schemaRef,
      revision: mutationFact?.revision,
      value: mutationFact?.value,
    }
    expect(mutation).toEqual({
      ok: true,
      kind: "workflow.stepExtensionMutation",
      instance_id: dataInstance.instanceId,
      run_id: "complete-agent-data-run",
      step_id: "transform",
      extension_kind: "eidolon.fixture.review-policy",
      checkpoint_version: expect.any(Number),
      revision: 1,
      schema_ref: "schema://eidolon.fixture.review-policy/v1",
      value: { audience: "product", reviewDepth: 2 },
    })
    const mutationReceipt = JSON.parse(await readFile(path.join(
      parent,
      "runtime-session",
      "workflow-runtime",
      "instances",
      dataInstance.instanceId,
      "runs",
      "complete-agent-data-run",
      "step-space",
      "receipts",
      `${mutation.checkpoint_version}.json`,
    ), "utf8"))
    expect(mutationReceipt.addedMaterialRecordDigests).toHaveLength(1)
    expect(mutationReceipt.addedRecordDigests).toHaveLength(1)
    expect(mutationReceipt.addedTreeNodeDigests.length).toBeGreaterThan(0)
    expect(mutationReceipt.addedTreeNodeDigests.length).toBeLessThan(8)
    const revisedExtension = await freshService.depa.checkpointStore.load({
      instanceId: dataInstance.instanceId,
      runId: "complete-agent-data-run",
    }) as any
    expect(revisedExtension.stepExtensions?.byStepId.transform["eidolon.fixture.review-policy"]).toEqual({
      schemaRef: "schema://eidolon.fixture.review-policy/v1",
      revision: 1,
      value: { audience: "product", reviewDepth: 2 },
    })
    await expect(freshService.mutateRunStepExtension({
      instanceId: dataInstance.instanceId,
      runId: "complete-agent-data-run",
      stepId: "transform",
      kind: "eidolon.fixture.review-policy",
      expectedRevision: 0,
      value: { reviewDepth: 3, audience: "product" },
    })).rejects.toThrow(/revision conflict/i)
    const patchOutput = await runWorkflowNativeHostCommand(
      { vm: runtime.vm, actor: runtime.actor },
      "WorkflowApplyGraphPatch",
      {
        run_id: "complete-agent-data-run",
        patch: {
          patchId: "repair-summary-after-verifier-gap",
          generation: 1,
          reason: "unchanged summary verifier rejected generation zero",
          atMs: 101,
          operations: [{
            op: "update-node",
            nodeId: "transform",
            changes: {
              config: {
                effectId: "data-agent-effect",
                nodeId: "transform",
                agentDefinitionRef: "resource://eidolon.fixture.SummaryAgent",
                reuse_policy: "never",
                repairIntent: "satisfy-unchanged-summary-verifier",
              },
            },
          }],
        },
      },
    ) as string
    const replannedData = JSON.parse(patchOutput)
    expect(replannedData).toMatchObject({
      kind: "workflow.graphPatch",
      status: "Waiting",
      generation: 1,
      run_id: "complete-agent-data-run",
      instance_id: dataInstance.instanceId,
      workflow_ref: "resource://eidolon.fixture.SummaryDataWorkflow",
    })
    const repairedDataSummary = replannedData.nodes.find((node: any) => node.id === "transform")?.result?.output?.summary
    expect(verifySummary(repairedDataSummary)).toBe(true)
    expect(replannedData.graph.patchHistory).toEqual([
      expect.objectContaining({
        patchId: "repair-summary-after-verifier-gap",
        generation: 1,
        reason: "unchanged summary verifier rejected generation zero",
      }),
    ])
    expect(replannedData.graph.invalidations).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: "refine-data-by-name", generation: 1 }),
    ]))
    expect(replannedData.nodes.find((node: any) => node.id === "transform")).toMatchObject({
      generation: 1,
      status: "Succeeded",
      config: { repairIntent: "satisfy-unchanged-summary-verifier" },
    })
    expect(replannedData.nodes.find((node: any) => node.id === "wait-data-by-name")).toMatchObject({
      generation: 1,
      status: "Running",
      result: { generation: 1, status: "Waiting" },
    })
    expect(providerCalls).toBe(3)
    const checkpointAfterCreate = await freshService.depa.checkpointStore.load({
      instanceId: ctrlInstance.instanceId,
      runId: "complete-agent-ctrl-run",
    }) as any
    const firstInstance = Object.values(checkpointAfterCreate.profile.ai.instancesById)[0] as any
    expect(firstInstance).toMatchObject({ instanceName: "summary-agent" })
    let activeRuntime = await recoverRuntimeOwner(runtime)
    const retainedActorCount = Object.keys(activeRuntime.vm.actors).length
    const firstHandle = ctrlResult.open_wait_handles[0]
    const nameService = new WorkflowRuntimeService(activeRuntime)
    const afterName = await nameService.resume("complete-agent-ctrl-run", {
      signalKind: firstHandle.signalKind,
      signalKey: firstHandle.signalKey,
      resumeToken: firstHandle.resumeToken,
      payload: { phase: "by-name" },
    })
    expect(afterName).toMatchObject({ status: "Waiting" })
    expect((afterName as any).step_extensions.byStepId.summarize["eidolon.fixture.review-policy"].revision).toBe(1)
    expect(providerCalls).toBe(4)
    expect(Object.keys(activeRuntime.vm.actors)).toHaveLength(retainedActorCount)
    activeRuntime = await recoverRuntimeOwner(activeRuntime)
    const secondHandle = afterName!.open_wait_handles[0]
    const idService = new WorkflowRuntimeService(activeRuntime)
    const afterId = await idService.resume("complete-agent-ctrl-run", {
      signalKind: secondHandle.signalKind,
      signalKey: secondHandle.signalKey,
      resumeToken: secondHandle.resumeToken,
      payload: { instanceId: firstInstance.instanceId, phase: "by-id" },
    })
    expect(afterId).toMatchObject({ status: "Completed" })
    expect((afterId as any).step_extensions.byStepId.summarize["eidolon.fixture.review-policy"]).toEqual({
      schemaRef: "schema://eidolon.fixture.review-policy/v1",
      revision: 1,
      value: { audience: "product", reviewDepth: 2 },
    })
    expect(providerCalls).toBe(5)
    expect(Object.keys(activeRuntime.vm.actors)).toHaveLength(retainedActorCount)
    const checkpointAfterTargets = await idService.depa.checkpointStore.load({
      instanceId: ctrlInstance.instanceId,
      runId: "complete-agent-ctrl-run",
    }) as any
    expect(Object.values(checkpointAfterTargets.profile.ai.instancesById)).toHaveLength(1)
    expect(Object.values(checkpointAfterTargets.profile.ai.invocationsByKey).map((receipt: any) => receipt.instanceId))
      .toEqual([firstInstance.instanceId, firstInstance.instanceId, firstInstance.instanceId])
    expect((Object.values(checkpointAfterTargets.profile.ai.instancesById)[0] as any).sessionId)
      .toBe(firstInstance.sessionId)
    expect(checkpointAfterTargets.stepExtensions.byStepId.summarize["eidolon.fixture.review-policy"].revision).toBe(1)
    const ctrlStatus = await idService.status("complete-agent-ctrl-run")
    const ctrlResultProjection = await idService.result("complete-agent-ctrl-run")
    const ctrlSummary = await idService.flowSummary("complete-agent-ctrl-run")
    const ctrlEvents = await idService.events("complete-agent-ctrl-run")
    const ctrlReplayPreview = await idService.replay({ runId: "complete-agent-ctrl-run", confirmed: false })
    expect(ctrlStatus.step_extensions.byStepId.summarize["eidolon.fixture.review-policy"].revision).toBe(1)
    expect(ctrlResultProjection.step_extensions.byStepId.summarize["eidolon.fixture.review-policy"].revision).toBe(1)
    expect((ctrlSummary?.checkpoint as any).stepExtensions.byStepId.summarize["eidolon.fixture.review-policy"].revision).toBe(1)
    expect((ctrlEvents?.checkpoint as any).stepExtensions.byStepId.summarize["eidolon.fixture.review-policy"].revision).toBe(1)
    expect(ctrlReplayPreview.preview.source_checkpoint.step_extensions.byStepId.summarize["eidolon.fixture.review-policy"].revision).toBe(1)
    expect(JSON.stringify({ ctrlStatus, ctrlResultProjection, ctrlSummary, ctrlEvents, ctrlReplayPreview })).not.toContain(parent)
    activeRuntime = await recoverRuntimeOwner(activeRuntime)
    const dataService = new WorkflowRuntimeService(activeRuntime)
    const checkpointAfterDataCreate = await dataService.depa.checkpointStore.load({
      instanceId: dataInstance.instanceId,
      runId: "complete-agent-data-run",
    }) as any
    const dataFirstInstance = Object.values(checkpointAfterDataCreate.profile.ai.instancesById)[0] as any
    expect(dataFirstInstance).toMatchObject({ instanceName: "data-summary-agent" })
    const dataRetainedActorCount = Object.keys(activeRuntime.vm.actors).length
    const dataAfterName = await dataService.resumeDataNode("complete-agent-data-run", "wait-data-by-name", {
      summary: acceptedSummary,
      instanceId: dataFirstInstance.instanceId,
    })
    expect(dataAfterName).toMatchObject({ status: "Waiting" })
    expect(providerCalls).toBe(6)
    expect(Object.keys(activeRuntime.vm.actors)).toHaveLength(dataRetainedActorCount)
    activeRuntime = await recoverRuntimeOwner(activeRuntime)
    const dataIdService = new WorkflowRuntimeService(activeRuntime)
    const dataAfterId = await dataIdService.resumeDataNode("complete-agent-data-run", "wait-data-by-id", {
      summary: acceptedSummary,
      instanceId: dataFirstInstance.instanceId,
    })
    expect(dataAfterId).toMatchObject({ status: "Succeeded", output: { summary: acceptedSummary } })
    expect(providerCalls).toBe(7)
    expect(Object.keys(activeRuntime.vm.actors)).toHaveLength(dataRetainedActorCount)
    const checkpointAfterDataTargets = await dataIdService.depa.checkpointStore.load({
      instanceId: dataInstance.instanceId,
      runId: "complete-agent-data-run",
    }) as any
    expect(checkpointAfterDataTargets.stepExtensions?.byStepId.transform["eidolon.fixture.review-policy"])
      .toEqual({
        schemaRef: "schema://eidolon.fixture.review-policy/v1",
        revision: 1,
        value: { audience: "product", reviewDepth: 2 },
      })
    expect(Object.values(checkpointAfterDataTargets.profile.ai.instancesById)).toHaveLength(1)
    expect(Object.values(checkpointAfterDataTargets.profile.ai.invocationsByKey).map((receipt: any) => receipt.instanceId))
      .toEqual([dataFirstInstance.instanceId, dataFirstInstance.instanceId, dataFirstInstance.instanceId, dataFirstInstance.instanceId])
    expect((Object.values(checkpointAfterDataTargets.profile.ai.instancesById)[0] as any).sessionId)
      .toBe(dataFirstInstance.sessionId)
    const dataStatus = await dataIdService.status("complete-agent-data-run")
    expect(dataStatus).toMatchObject({
      generation: 1,
      graph: {
        patchHistory: [expect.objectContaining({ patchId: "repair-summary-after-verifier-gap", generation: 1 })],
      },
    })
    expect(dataStatus.step_extensions.byStepId.transform["eidolon.fixture.review-policy"])
      .toEqual({
        schemaRef: "schema://eidolon.fixture.review-policy/v1",
        revision: 1,
        value: { audience: "product", reviewDepth: 2 },
      })
    const dataSummary = await dataIdService.flowSummary("complete-agent-data-run")
    const dataEvents = await dataIdService.events("complete-agent-data-run")
    expect((dataSummary?.checkpoint as any).stepExtensions.byStepId.transform["eidolon.fixture.review-policy"].revision)
      .toBe(1)
    expect((dataEvents?.checkpoint as any).stepExtensions.byStepId.transform["eidolon.fixture.review-policy"].revision)
      .toBe(1)
    expect(JSON.stringify({ dataStatus, dataSummary, dataEvents })).not.toContain("step-space/records")
    expect(JSON.stringify({ dataStatus, dataSummary, dataEvents })).not.toContain(parent)
    for (const [instanceId, runId] of [
      [ctrlInstance.instanceId, "complete-agent-ctrl-run"],
      [dataInstance.instanceId, "complete-agent-data-run"],
    ] as const) {
      const checkpointText = await readFile(path.join(
        parent,
        "runtime-session",
        "workflow-runtime",
        "instances",
        instanceId,
        "runs",
        runId,
        "checkpoint.json",
      ), "utf8")
      expect(checkpointText).toContain('"instancesById"')
      expect(checkpointText).toContain('"invocationsByKey"')
      expect(checkpointText).not.toContain('"messages"')
      expect(checkpointText).not.toContain('"modelConfig"')
    }
    const runtimeSnapshotManifest = JSON.parse(await readFile(path.join(
      parent,
      "runtime-session",
      "runtime_state",
      "manifest.json",
    ), "utf8"))
    expect(Object.keys(runtimeSnapshotManifest.actorFiles)).toHaveLength(dataRetainedActorCount)
    expect(Object.keys(runtimeSnapshotManifest.actorFiles)).toEqual(expect.arrayContaining([
      "main",
      firstInstance.metadata.actorKey,
      dataFirstInstance.metadata.actorKey,
    ]))
    expect(await readFile(path.join(parent, "runtime-session", "conversation", "history.xnl"), "utf8"))
      .toContain("schema-valid Agent result")
    for (const [runId, effectId] of [
      ["complete-agent-ctrl-run", "agent:complete-agent-ctrl:complete-agent-ctrl-run:summarize#1"],
      ["complete-agent-data-run", "agent:complete-agent-data:complete-agent-data-run:transform#0"],
      ["complete-agent-data-run", "agent:complete-agent-data:complete-agent-data-run:transform#1"],
    ] as const) {
      expect(await readRuntimeControlEffectEvidence(path.join(parent, "runtime-session"))).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "request", effectId, handlerKey: "workflow:ai.agent" }),
        expect.objectContaining({ kind: "result", effectId, handlerKey: "workflow:ai.agent" }),
      ]))
      await expect(access(path.join(
        parent, "runtime-session", "workflow-runtime", "agent-executions", runId,
      ))).rejects.toMatchObject({ code: "ENOENT" })
      await expect(access(path.join(
        parent, "runtime-session", "workflow-runtime", "ai-state", runId,
      ))).rejects.toMatchObject({ code: "ENOENT" })
    }
    const ctrlRepeat = await freshService.start({ instanceId: ctrlInstance.instanceId, runId: "complete-agent-ctrl-run", confirmed: true })
    expect(ctrlRepeat).toEqual(await freshService.status("complete-agent-ctrl-run"))
    const dataRepeat = await dataIdService.start({ instanceId: dataInstance.instanceId, runId: "complete-agent-data-run", confirmed: true })
    expect(dataRepeat).toEqual(await dataIdService.status("complete-agent-data-run"))
    expect(providerCalls).toBe(7)
  }, 120_000)
})
