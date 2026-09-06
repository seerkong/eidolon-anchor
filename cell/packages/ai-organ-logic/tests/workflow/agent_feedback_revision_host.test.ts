import { afterEach, expect, it } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AI_AGENT_DEFINITION_SELECTION_SCHEMA_VERSION, depaAIResourceKindContract, type AIAgentTaskRequirement, type ReviseExistingAIAgentDefinitionDecision } from "ai-workflow-contract"
import { RESOURCE_AUTHORING_SCHEMA_VERSION } from "halfcode-compiler.xnl/authoring-runtime"
import { VirtualFileSystem } from "xnl-vfs"
import { sha256Digest } from "halfcode-compiler.xnl/resource-core"
import { EidolonAIAgentDefinitionAuthoringAdapter } from "../../src/resources/EidolonAIAgentDefinitionAuthoringAdapter"
import { EidolonAppResourceRegistryAdapter } from "../../src/resources/EidolonAppResourceRegistryAdapter"
import { EidolonAutonomousAgentResourceHost, type EidolonAIAgentDefinitionSelectionObservation, type EidolonPreparedAIAgentDefinition } from "../../src/resources/EidolonAutonomousAgentResourceHost"
import { openAuthoringTestRuntime } from "./fixtures/agent-authoring-process"

const roots: string[] = []
const closers: (() => void)[] = []
afterEach(async () => { for (const close of closers.splice(0)) close(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const agentRef = "resource://eidolon.fixture.FeedbackAgent" as const
const target = { workflowKind: "AICtrlWorkflow" as const, workflowRef: "resource://eidolon.fixture.SummaryWorkflow" as const, nodeId: "feedback-worker" }
const requirement: AIAgentTaskRequirement = {
  schemaVersion: AI_AGENT_DEFINITION_SELECTION_SCHEMA_VERSION, requirementId: "feedback-context-completion",
  objective: "Repair the observed missing estimate completion while preserving the previous execution.",
  requiredToolRefs: [], requiredMaterialPortRefs: [], requiredMessageSourceRefs: [],
}
function agent(version: "V1" | "V2") {
  return `<AIAgentDefinition #eidolon.fixture.FeedbackAgent envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle="Active" description="Feedback ${version}" } (
    <MessagePrefix [<Message #system { role="system" promptKind="Prompt" promptRef="resource://eidolon.fixture.${version === "V1" ? "SummaryPrompt" : "RevisedPrompt"}" }>]>
    <ContextPipeline { kind="AgentContextPipeline" ref="resource://eidolon.fixture.Context${version}" }>
    <ToolRefs []><MaterialPortRefs []>
  )>`
}
function context(resourceId: string, exportName: string) {
  return `<AgentContextPipeline #${resourceId} envelopeVersion="halfcode.resource-envelope/v1" specVersion=2 { lifecycle="Active" } (
    <CodeBinding { packageName="feedback-fixture" module="./pipeline.ts" exportName="${exportName}" }><Config { value={} }>
  )>`
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-feedback-host-")); roots.push(root)
  const workspaceEidolonRoot = path.join(root, "workspace/.eidolon")
  const resourceRoot = path.join(workspaceEidolonRoot, "resources")
  await mkdir(workspaceEidolonRoot, { recursive: true })
  await cp(path.join(import.meta.dir, "fixtures/resource-native-authoring-package"), resourceRoot, { recursive: true })
  const manifestPath = path.join(resourceRoot, "manifest.xnl")
  await writeFile(manifestPath, (await readFile(manifestPath, "utf8")).replace("<Catalog #agents", '<Catalog #pipelines { kind="AgentContextPipeline" shape="single-file" root="vfs://./ContextPipelines/" }>\n<Catalog #agents'))
  await mkdir(path.join(resourceRoot, "KindDefinitions/AgentContextPipeline"), { recursive: true })
  await writeFile(path.join(resourceRoot, "KindDefinitions/AgentContextPipeline/manifest.xnl"), depaAIResourceKindContract("AgentContextPipeline", 2).kindDefinitionSource)
  await mkdir(path.join(resourceRoot, "ContextPipelines"))
  await writeFile(path.join(resourceRoot, "ContextPipelines/V1.xnl"), context("eidolon.fixture.ContextV1", "composeV1"))
  await writeFile(path.join(resourceRoot, "ContextPipelines/V2.xnl"), context("eidolon.fixture.ContextV2", "composeV1"))
  await writeFile(path.join(resourceRoot, "Agents/Feedback.xnl"), agent("V1"))
  await writeFile(path.join(resourceRoot, "Prompts/Revised.xnl"), '<Prompt #eidolon.fixture.RevisedPrompt envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle="Active" template="New V2 prefix after verified feedback." }>')
  await writeFile(path.join(resourceRoot, "pipeline.ts"), `export function composeV1(runtime, input, config) { return runtime.convert(runtime.materialize(runtime.plan())); }
export function composeV2(runtime, input, config) { const value = runtime.materialize(runtime.plan()); return runtime.convert(input.mode === "estimate" ? runtime.completeEstimate(value) : value); }`)
  const builtin = new VirtualFileSystem(); builtin.mkdir("vfs:///.eidolon/resources", { recursive: true })
  const supportRoot = path.join(root, "authoring-facts")
  const runtime = await openAuthoringTestRuntime({ databasePath: path.join(root, "vfs.sqlite"), workspaceEidolonRoot, supportRoot, builtinSnapshot: builtin.getSnapshot() })
  closers.push(() => runtime.authority.close())
  const initial = await runtime.materializer.materialize({ expectedCurrentRevision: runtime.materializer.read().snapshot.revision, overlays: await runtime.loadOverlays() })
  if (initial.status !== "admitted") throw new Error("Fixture VFS admission failed")
  const host = new EidolonAutonomousAgentResourceHost(runtime.registry, [], supportRoot, runtime.authoring)
  const authoring = new EidolonAIAgentDefinitionAuthoringAdapter(runtime.registry, [], supportRoot, runtime.authoring)
  return { ...runtime, host, authoring, resourceRoot }
}
async function select(host: EidolonAutonomousAgentResourceHost, observation: EidolonAIAgentDefinitionSelectionObservation): Promise<EidolonPreparedAIAgentDefinition> {
  const candidate = observation.candidateSet.candidates.find(value => value.agentDefinitionRef === agentRef)!
  const result = await host.prepare({ observation, target, decision: {
    schemaVersion: requirement.schemaVersion, mode: "select-existing", requirementDigest: observation.requirement.requirementDigest,
    candidateSetDigest: observation.candidateSet.candidateSetDigest, candidateRef: agentRef, candidateDigest: candidate.candidateDigest, reason: "Exact typed fixture match",
  } })
  expect(result.status).toBe("prepared"); if (result.status !== "prepared") throw new Error(JSON.stringify(result))
  return result
}
async function executeFrozen(prepared: EidolonPreparedAIAgentDefinition) {
  const registry = await EidolonAppResourceRegistryAdapter.restoreFrozenAgentExecution(JSON.parse(JSON.stringify(prepared.frozenExecution)))
  const result = await registry.prepareWorkflowAgentExecution(prepared.taskBinding.task, { payload: {} })
  const calls: string[] = []
  const execution = result.plan.agentConfig.contextPipelineExecution!
  const stage = (name: "plan" | "materialization" | "estimate" | "provider") => { calls.push(name); return Object.freeze({ stage: name }) }
  execution.execute({ plan: () => stage("plan"), materialize: () => stage("materialization"), completeEstimate: () => stage("estimate"), convert: () => stage("provider") },
    { mode: "estimate", actorKey: "feedback", sessionId: "offline", model: "no-provider" })
  const restoredBinding = await registry.freezeWorkflowAgentTaskBinding(prepared.taskBinding.task)
  return { calls, messages: result.plan.messages, executionDigest: execution.executionDigest, fingerprint: restoredBinding.semanticFingerprint }
}

it("revises an Agent through feedback admission and native reconciliation while preserving its prior frozen Context execution", async () => {
  const f = await fixture()
  const old = await select(f.host, await f.host.observe(requirement))
  const oldBundle = JSON.stringify(old.frozenExecution)
  const oldExecution = await executeFrozen(old)
  expect(oldExecution.calls).toEqual(["plan", "materialization", "provider"])
  expect(oldExecution.fingerprint).toBe(old.taskBinding.semanticFingerprint)
  // Stage an independent Context revision first; Agent admission remains the recipe switch.
  const beforeContext = await f.registry.snapshot()
  const contextReceipt = await f.authoring.author({ proposal: {
    schemaVersion: RESOURCE_AUTHORING_SCHEMA_VERSION, operation: "update", catalogId: "pipelines", resourceId: "eidolon.fixture.ContextV2", kind: "AgentContextPipeline",
    envelopeVersion: "halfcode.resource-envelope/v1", writerSpecVersion: 2, sourceShape: "single-file", documentUri: "vfs://@/ContextPipelines/V2.xnl",
    authorityText: context("eidolon.fixture.ContextV2", "composeV2"),
    expected: { state: "present", authorityDigest: beforeContext.contentIdentities.get("eidolon.fixture.ContextV2")!.authorityDigest, registryRevision: beforeContext.registryRevision },
  } })
  expect(contextReceipt.receipt.operation).toBe("update")
  const observation = await f.host.observe(requirement)
  const candidate = observation.candidateSet.candidates.find(value => value.agentDefinitionRef === agentRef)!
  const beforeAgent = await f.registry.snapshot()
  const decision: ReviseExistingAIAgentDefinitionDecision = {
    schemaVersion: requirement.schemaVersion, mode: "revise-existing", candidateRef: agentRef, candidateDigest: candidate.candidateDigest,
    requirementDigest: observation.requirement.requirementDigest, candidateSetDigest: observation.candidateSet.candidateSetDigest,
    feedback: { observationRef: "observation://feedback-1", attemptRef: "attempt://estimate-1", verificationRef: "verification://missing-estimate-completion",
      requirementDigest: observation.requirement.requirementDigest, candidateSetDigest: observation.candidateSet.candidateSetDigest,
      candidateDigest: candidate.candidateDigest, previousExecutionFingerprint: old.taskBinding.semanticFingerprint },
    proposal: { schemaVersion: RESOURCE_AUTHORING_SCHEMA_VERSION, operation: "update", catalogId: "agents", resourceId: "eidolon.fixture.FeedbackAgent", kind: "AIAgentDefinition",
      envelopeVersion: "halfcode.resource-envelope/v1", writerSpecVersion: 1, sourceShape: "single-file", documentUri: "vfs://@/Agents/Feedback.xnl", authorityText: agent("V2"),
      expected: { state: "present", authorityDigest: beforeAgent.contentIdentities.get("eidolon.fixture.FeedbackAgent")!.authorityDigest, registryRevision: observation.candidateSet.registryRevision } },
    reason: "The verified V1 attempt omits estimate completion; select the staged ContextV2 fix.",
  }
  for (const field of ["requirementDigest", "candidateSetDigest", "candidateDigest", "previousExecutionFingerprint"] as const) {
    const rejected = await f.host.prepare({ observation, target, previousExecution: old.taskBinding,
      decision: { ...decision, feedback: { ...decision.feedback, [field]: sha256Digest("forged-feedback") } } })
    expect(rejected).toMatchObject({ status: "rejected", code: "revision-feedback-invalid" })
    expect(await readFile(path.join(f.resourceRoot, "Agents/Feedback.xnl"), "utf8")).toBe(agent("V1"))
  }
  const revised = await f.host.prepare({ observation, target, previousExecution: old.taskBinding, decision })
  expect(revised.status).toBe("prepared"); if (revised.status !== "prepared") throw new Error(JSON.stringify(revised))
  expect(revised.authoringReceipt).toMatchObject({ operation: "update", kind: "AIAgentDefinition", authorityDigestBefore: decision.proposal.expected.state === "present" ? decision.proposal.expected.authorityDigest : null })
  expect(revised.admission.candidate.authoringEvidence?.revision?.feedback).toEqual(decision.feedback)
  expect(await f.host.loadAuthoringReceipt(revised.authoringReceipt!.planDigest)).toEqual(revised.authoringReceipt)
  expect(await f.materializer.lookupPublication(revised.authoringReceipt!.transactionId)).toMatchObject({ association: { receiptDigest: revised.authoringReceipt!.receiptDigest } })
  const newest = await select(f.host, await f.host.observe(requirement))
  const newExecution = await executeFrozen(newest)
  expect(newExecution.calls).toEqual(["plan", "materialization", "estimate", "provider"])
  expect(newExecution.executionDigest).not.toBe(oldExecution.executionDigest)
  expect(newest.taskBinding.semanticFingerprint).not.toBe(old.taskBinding.semanticFingerprint)
  expect(newExecution.messages.map(message => message.content)).toEqual(["New V2 prefix after verified feedback."])
  expect(JSON.stringify(old.frozenExecution)).toBe(oldBundle)
  await rm(f.resourceRoot, { recursive: true })
  expect(await executeFrozen(old)).toEqual(oldExecution)
  expect(await executeFrozen(newest)).toEqual(newExecution)
}, 30_000)
