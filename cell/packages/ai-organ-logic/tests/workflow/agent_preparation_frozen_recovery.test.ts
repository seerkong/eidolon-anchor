import { afterEach, expect, it } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { testSourceTsconfig } from "./fixtures/test-source-binding"
import { AI_AGENT_DEFINITION_SELECTION_SCHEMA_VERSION, depaAIResourceKindContract } from "ai-workflow-contract"
import { assertFrozenAIAgentTaskBinding } from "ai-workflow-logic/run-freeze"
import { sha256Digest } from "halfcode-compiler.xnl/resource-core"
import { EidolonAppResourceRegistryAdapter } from "../../src/resources/EidolonAppResourceRegistryAdapter"
import { EidolonAutonomousAgentResourceHost } from "../../src/resources/EidolonAutonomousAgentResourceHost"
import {
  AIDataAgentResourcePreparationService, EidolonFixedAgentExecutionRegistry,
  FileAIDataAgentPreparationStore, normalizeAIDataAgentPreparationReceipt,
} from "../../src/workflow/runtime/AIDataAgentResourcePreparation"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-frozen-preparation-"))
  roots.push(parent)
  const root = path.join(parent, "resources")
  await cp(path.join(import.meta.dir, "fixtures/resource-native-authoring-package"), root, { recursive: true })
  const manifest = await readFile(path.join(root, "manifest.xnl"), "utf8")
  await writeFile(path.join(root, "manifest.xnl"), manifest.replace("<Catalog #agents", [
    '<Catalog #data { kind="AIDataWorkflow" shape="single-file" root="vfs://./DataWorkflows/" }>',
    '<Catalog #context { kind="AgentContextPipeline" shape="single-file" root="vfs://./ContextPipelines/" }>',
    '<Catalog #sources { kind="AgentMessageSource" shape="single-file" root="vfs://./MessageSources/" }>',
    '<Catalog #agents',
  ].join("\n")))
  for (const kind of ["AIDataWorkflow", "AgentContextPipeline", "AgentMessageSource"] as const) {
    await mkdir(path.join(root, "KindDefinitions", kind), { recursive: true })
    await writeFile(path.join(root, "KindDefinitions", kind, "manifest.xnl"), depaAIResourceKindContract(kind, kind === "AIDataWorkflow" ? 1 : 2).kindDefinitionSource)
  }
  for (const directory of ["DataWorkflows", "ContextPipelines", "MessageSources"]) await mkdir(path.join(root, directory))
  await writeFile(path.join(root, "DataWorkflows", "Flow.xnl"), '<AIDataWorkflow #eidolon.fixture.FrozenData envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 (<FlowContract #eidolon.fixture.FrozenData>) []>')
  await writeFile(path.join(root, "Agents", "Summary.xnl"), `<AIAgentDefinition #eidolon.fixture.SummaryAgent envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle="Active" } (
    <MessagePrefix [<MessageSource #once { kind="AgentMessageSource" ref="resource://eidolon.fixture.Once" }>]>
    <ContextPipeline { kind="AgentContextPipeline" ref="resource://eidolon.fixture.Context" }><ToolRefs []><MaterialPortRefs []>
  )>`)
  await writeFile(path.join(root, "ContextPipelines", "Context.xnl"), '<AgentContextPipeline #eidolon.fixture.Context envelopeVersion="halfcode.resource-envelope/v1" specVersion=2 { lifecycle="Active" } (<CodeBinding { packageName="test" module="./context.ts" exportName="compose" }><Config { value={} }>)>')
  await writeFile(path.join(root, "MessageSources", "Once.xnl"), '<AgentMessageSource #eidolon.fixture.Once envelopeVersion="halfcode.resource-envelope/v1" specVersion=2 { lifecycle="Active" } (<CodeBinding { packageName="test" module="./once.ts" exportName="messages" }><Config { value={} }>)>')
  await writeFile(path.join(root, "context.ts"), 'import { version } from "./version"; export function compose(runtime, input) { return version }')
  await writeFile(path.join(root, "version.ts"), 'export const version = "V1"')
  await writeFile(path.join(root, "once.ts"), 'export function messages() { return [{role:"system", content:"admitted-once:" + Math.random()}] }')
  const layers = [{ id: "workspace" as const, rootDir: root }]
  const registry = new EidolonAppResourceRegistryAdapter({ layers })
  const supportRoot = path.join(parent, "support")
  const service = new AIDataAgentResourcePreparationService(new EidolonAutonomousAgentResourceHost(registry, layers, supportRoot))
  const observation = await service.observe({ schemaVersion: AI_AGENT_DEFINITION_SELECTION_SCHEMA_VERSION, requirementId: "frozen", objective: "Frozen exact recipe", requiredToolRefs: [], requiredMaterialPortRefs: [], requiredMessageSourceRefs: [] })
  const candidate = observation.candidateSet.candidates.find(candidate => candidate.agentDefinitionRef === "resource://eidolon.fixture.SummaryAgent")!
  const prepared = await service.prepare({
    instanceId: "frozen-instance", instanceName: "worker", observation,
    decision: { schemaVersion: observation.requirement.schemaVersion, mode: "select-existing", requirementDigest: observation.requirement.requirementDigest,
      candidateSetDigest: observation.candidateSet.candidateSetDigest, candidateRef: candidate.agentDefinitionRef, candidateDigest: candidate.candidateDigest, reason: "Freeze exact V1" },
    workflowRef: "resource://eidolon.fixture.FrozenData", nodeId: "prepared-node",
    capability: { capabilityId: "prepared-capability", tag: "TransformNode", inputSchemaRefs: {}, outputSchemaRefs: {}, fixedConfig: {} },
  }).catch(error => { throw new Error(JSON.stringify(error.diagnostics ?? error.message), { cause: error }) })
  if (!("receipt" in prepared)) throw new Error("preparation rejected")
  return { parent, root, layers, registry, supportRoot, prepared }
}

it("persists a frozen preparation and restores its exact proof, code, and realized prefix after live bytes disappear", async () => {
  const f = await fixture()
  expect(f.prepared.receipt.schemaVersion).toBe("eidolon.ai-data-agent-preparation/v2")
  const fixed = new EidolonFixedAgentExecutionRegistry(undefined, f.registry, [f.prepared])
  const first = await fixed.prepareWorkflowAgentExecution(f.prepared.receipt.task, { payload: "first" })
  const store = new FileAIDataAgentPreparationStore(path.join(f.parent, "preparations"))
  await store.save(f.prepared.receipt)
  const persisted = (await store.list("frozen-instance"))[0]!
  await writeFile(path.join(f.root, "version.ts"), 'export const version = "V2"')
  const second = await fixed.prepareWorkflowAgentExecution(f.prepared.receipt.task, { payload: "second" })
  expect(second.plan.messages).toEqual(first.plan.messages)
  expect(second.plan.agentConfig.contextPipelineExecution!.execute({} as never, {} as never)).toBe("V1")
  await rm(f.root, { recursive: true, force: true })
  const fresh = new AIDataAgentResourcePreparationService(new EidolonAutonomousAgentResourceHost(new EidolonAppResourceRegistryAdapter({ layers: f.layers }), f.layers, f.supportRoot))
  const recovered = await fresh.recover(persisted)
  expect(assertFrozenAIAgentTaskBinding(recovered.proof).semanticFingerprint).toBe(f.prepared.proof.semanticFingerprint)
  expect(recovered.proof.snapshotRevision).toBe(f.prepared.proof.snapshotRevision)
  const execution = await new EidolonFixedAgentExecutionRegistry(undefined, f.registry, [recovered]).prepareWorkflowAgentExecution(persisted.task)
  expect(execution.plan.messages).toEqual(first.plan.messages)
  expect(execution.plan.agentConfig.contextPipelineExecution!.execute({} as never, {} as never)).toBe("V1")
  const inputPath = path.join(f.parent, "fresh-process.json")
  await writeFile(inputPath, JSON.stringify({ receipt: persisted, removedResourceRoot: f.root, supportRoot: f.supportRoot }))
  const child = Bun.spawn([process.execPath, "--tsconfig-override", testSourceTsconfig(),
    path.join(import.meta.dir, "fixtures/agent-preparation-recovery-process.ts"), inputPath], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(exitCode, stderr).toBe(0)
  expect(JSON.parse(stdout)).toEqual({ semanticFingerprint: f.prepared.proof.semanticFingerprint,
    snapshotRevision: f.prepared.proof.snapshotRevision, messages: first.plan.messages, contextVersion: "V1" })
  const corrupt = JSON.parse(JSON.stringify(persisted))
  corrupt.frozenExecution.messages[0].content = "changed"
  expect(() => normalizeAIDataAgentPreparationReceipt(corrupt)).toThrow("DIGEST_MISMATCH")
  const corruptArtifact = JSON.parse(JSON.stringify(persisted))
  corruptArtifact.frozenExecution.codeArtifacts[0].artifactDigest = `sha256:${"0".repeat(64)}`
  const { receiptDigest: _originalDigest, ...unsigned } = corruptArtifact
  corruptArtifact.receiptDigest = sha256Digest(canonicalJson(unsigned))
  await expect(fresh.recover(corruptArtifact)).rejects.toThrow()
}, 30000)

it("keeps legacy v1 recovery fail-closed on code drift and makes preparation receipts immutable", async () => {
  const f = await fixture()
  const { frozenExecution: _bundle, receiptDigest: _digest, ...legacyFields } = f.prepared.receipt
  const unsigned = { ...legacyFields, schemaVersion: "eidolon.ai-data-agent-preparation/v1" as const }
  const legacy = { ...unsigned, receiptDigest: sha256Digest(canonicalJson(unsigned)) }
  const fresh = new AIDataAgentResourcePreparationService(new EidolonAutonomousAgentResourceHost(f.registry, f.layers, f.supportRoot))
  const recovered = await fresh.recover(legacy)
  expect(assertFrozenAIAgentTaskBinding(recovered.proof).semanticFingerprint).toBe(f.prepared.proof.semanticFingerprint)
  await writeFile(path.join(f.root, "version.ts"), 'export const version = "V2"')
  await expect(fresh.recover(legacy)).rejects.toThrow("PROOF_DRIFT")
  const store = new FileAIDataAgentPreparationStore(path.join(f.parent, "preparations"))
  await store.save(f.prepared.receipt)
  await store.save(f.prepared.receipt)
  await expect(store.save(legacy)).rejects.toThrow("IMMUTABLE_CONFLICT")
  expect(await store.list("frozen-instance")).toEqual([f.prepared.receipt])
})

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`
  return JSON.stringify(value)
}

it("forwards the genuine prior execution through child preparation revision admission", async () => {
  const f = await fixture()
  const service = new AIDataAgentResourcePreparationService(new EidolonAutonomousAgentResourceHost(f.registry, f.layers, f.supportRoot))
  const observation = await service.observe(f.prepared.receipt.requirement)
  const candidate = observation.candidateSet.candidates.find(item => item.agentDefinitionRef === f.prepared.receipt.agentDefinitionRef)!
  const snapshot = await f.registry.snapshot()
  const before = await readFile(path.join(f.root, "Agents/Summary.xnl"), "utf8")
  const input = {
    instanceId: "next-child", instanceName: "next-worker", nodeId: "next-node",
    workflowRef: "resource://eidolon.fixture.FrozenData" as const,
    observation, previousExecution: f.prepared.proof,
    capability: { capabilityId: "next-worker", tag: "TransformNode" as const, inputSchemaRefs: {}, outputSchemaRefs: {}, fixedConfig: {} },
    decision: {
      schemaVersion: observation.requirement.schemaVersion, mode: "revise-existing" as const,
      candidateRef: candidate.agentDefinitionRef, candidateDigest: candidate.candidateDigest,
      requirementDigest: observation.requirement.requirementDigest, candidateSetDigest: observation.candidateSet.candidateSetDigest,
      reason: "Use genuine failed execution as revision evidence",
      feedback: { observationRef: "observation://parent", attemptRef: "attempt://parent-worker", verificationRef: "verification://parent-output",
        requirementDigest: observation.requirement.requirementDigest, candidateSetDigest: observation.candidateSet.candidateSetDigest,
        candidateDigest: candidate.candidateDigest, previousExecutionFingerprint: f.prepared.proof.semanticFingerprint },
      proposal: { schemaVersion: "halfcode.resource-authoring/v1" as const, operation: "update" as const,
        catalogId: "agents", resourceId: candidate.agentDefinitionRef.slice("resource://".length), kind: "AIAgentDefinition",
        envelopeVersion: "halfcode.resource-envelope/v1", writerSpecVersion: 1, sourceShape: "single-file" as const,
        documentUri: "vfs://@/Agents/Summary.xnl", authorityText: before.replace('lifecycle="Active"', 'lifecycle="Active" description="Revised from failed parent"'),
        expected: { state: "present" as const, registryRevision: observation.candidateSet.registryRevision,
          authorityDigest: snapshot.contentIdentities.get(candidate.agentDefinitionRef.slice("resource://".length))!.authorityDigest } },
    },
  }
  const withoutPrior = await service.prepare({ ...input, previousExecution: undefined })
  expect(withoutPrior).toMatchObject({ status: "rejected", code: "revision-feedback-invalid" })
  expect(await readFile(path.join(f.root, "Agents/Summary.xnl"), "utf8")).toBe(before)
  const revised = await service.prepare(input)
  expect("receipt" in revised).toBe(true)
  if (!("receipt" in revised)) throw new Error(JSON.stringify(revised))
  expect(revised.receipt.instanceId).toBe("next-child")
  expect(revised.receipt.authoring?.planDigest).toMatch(/^sha256:/)
  expect(revised.proof.semanticFingerprint).not.toBe(f.prepared.proof.semanticFingerprint)
  const recovered = await service.recover(f.prepared.receipt)
  expect(recovered.proof.semanticFingerprint).toBe(f.prepared.proof.semanticFingerprint)
})

it("journals preparation observation and decision without mixing them into admitted receipts", async () => {
  const f = await fixture()
  const store = new FileAIDataAgentPreparationStore(path.join(f.parent, "durable"))
  const createService = () => new AIDataAgentResourcePreparationService(new EidolonAutonomousAgentResourceHost(
    new EidolonAppResourceRegistryAdapter({ layers: f.layers }), f.layers, f.supportRoot))
  const service = createService()
  const identity = { parentRunId: "parent-run", nodeId: "source", generation: 0 }
  const observedInput = { store, instanceId: "child", nodeId: "worker", identity, requirement: f.prepared.receipt.requirement }
  const observation = await service.observeDurably(observedInput)
  expect(await store.list("child")).toEqual([])
  expect(await store.loadDecision("child", "worker")).toBeUndefined()
  const candidate = observation.candidateSet.candidates.find(item => item.agentDefinitionRef === f.prepared.receipt.agentDefinitionRef)!
  const decision = { schemaVersion: observation.requirement.schemaVersion, mode: "select-existing" as const,
    requirementDigest: observation.requirement.requirementDigest, candidateSetDigest: observation.candidateSet.candidateSetDigest,
    candidateRef: candidate.agentDefinitionRef, candidateDigest: candidate.candidateDigest, reason: "Exact observed worker" }
  const preparation = { ...observedInput, observation, decision, workflowRef: "resource://eidolon.fixture.FrozenData" as const,
    instanceName: "child-worker", capability: { capabilityId: "child-worker", tag: "TransformNode" as const,
      inputSchemaRefs: {}, outputSchemaRefs: {}, fixedConfig: {} } }
  // A crash before dispatch must recover the observed bytes, not freshly select V2.
  await writeFile(path.join(f.root, "version.ts"), 'export const version = "V2"')
  const restoredService = createService()
  const restoredObservation = await restoredService.observeDurably(observedInput)
  expect(restoredObservation.candidateSet.candidateSetDigest).toBe(observation.candidateSet.candidateSetDigest)
  const prepared = await restoredService.prepareDurably({ ...preparation, observation: restoredObservation })
  if (!("receipt" in prepared)) throw new Error(JSON.stringify(prepared))
  expect(await store.loadDecision("child", "worker")).toEqual(decision)
  expect(await store.list("child")).toEqual([prepared.receipt])
  await expect(store.assertReceiptBinding(prepared.receipt)).resolves.toBeUndefined()
  const { receiptDigest: _receiptDigest, ...unlinked } = prepared.receipt
  const corrupted = { ...unlinked, preparation: { ...unlinked.preparation!, intentDigest: sha256Digest("another-intent") } }
  await expect(store.assertReceiptBinding({ ...corrupted, receiptDigest: sha256Digest(canonicalJson(corrupted)) })).rejects.toThrow("RECEIPT_INTENT_MISMATCH")
  const execution = await prepared.executionRegistry!.prepareWorkflowAgentExecution(prepared.receipt.task)
  expect(execution.plan.agentConfig.contextPipelineExecution!.execute({} as never, {} as never)).toBe("V1")
  await rm(f.root, { recursive: true, force: true })
  const restartedService = createService()
  const restartedObservation = await restartedService.observeDurably(observedInput)
  const recovered = await restartedService.prepareDurably({ ...preparation, observation: restartedObservation })
  expect(recovered).toHaveProperty("receipt.receiptDigest", prepared.receipt.receiptDigest)
  await expect(restartedService.observeDurably({ ...observedInput, identity: { ...identity, generation: 1 } })).rejects.toThrow("INTENT_IDENTITY_MISMATCH")
  await expect(restartedService.observeDurably({ ...observedInput, requirement: { ...observedInput.requirement, objective: "A different task" } })).rejects.toThrow("INTENT_IDENTITY_MISMATCH")
  await expect(restartedService.prepareDurably({ ...preparation, observation: restartedObservation,
    decision: { ...decision, reason: "Another model result" } })).rejects.toThrow("IMMUTABLE_CONFLICT")
  await expect(restartedService.prepareDurably({ ...preparation, observation: restartedObservation, instanceName: "different-worker" })).rejects.toThrow("IMMUTABLE_CONFLICT")
}, 30000)

it("rejects an unrelated pre-existing receipt at a durable preparation target", async () => {
  const f = await fixture()
  const store = new FileAIDataAgentPreparationStore(path.join(f.parent, "collision"))
  await store.save(f.prepared.receipt)
  const service = new AIDataAgentResourcePreparationService(new EidolonAutonomousAgentResourceHost(f.registry, f.layers, f.supportRoot))
  const input = { store, instanceId: f.prepared.receipt.instanceId, nodeId: f.prepared.receipt.task.nodeId,
    identity: { parentRunId: "different-parent" }, requirement: f.prepared.receipt.requirement }
  const observation = await service.observeDurably(input)
  const candidate = observation.candidateSet.candidates.find(item => item.agentDefinitionRef === f.prepared.receipt.agentDefinitionRef)!
  await expect(service.prepareDurably({ ...input, observation, instanceName: "another-worker",
    workflowRef: "resource://eidolon.fixture.OtherFlow", capability: { capabilityId: "other", tag: "TransformNode",
      inputSchemaRefs: {}, outputSchemaRefs: {}, fixedConfig: {} },
    decision: { schemaVersion: observation.requirement.schemaVersion, mode: "select-existing",
      requirementDigest: observation.requirement.requirementDigest, candidateSetDigest: observation.candidateSet.candidateSetDigest,
      candidateRef: candidate.agentDefinitionRef, candidateDigest: candidate.candidateDigest, reason: "Must not recover unrelated receipt" },
  })).rejects.toThrow("RECEIPT_TARGET_MISMATCH")
})

it("resumes the native revision after an OS process exits before final preparation save", async () => {
  const f = await fixture()
  const storeRoot = path.join(f.parent, "crash-preparation")
  const store = new FileAIDataAgentPreparationStore(storeRoot)
  const service = new AIDataAgentResourcePreparationService(new EidolonAutonomousAgentResourceHost(f.registry, f.layers, f.supportRoot))
  const target = { instanceId: "crash-child", nodeId: "next-worker", instanceName: "child-worker",
    workflowRef: "resource://eidolon.fixture.FrozenData" as const,
    identity: { parentRunId: "failed-parent", generation: 0, previousExecutionFingerprint: f.prepared.proof.semanticFingerprint },
    capability: { capabilityId: "next-worker", tag: "TransformNode" as const, inputSchemaRefs: {}, outputSchemaRefs: {}, fixedConfig: {} } }
  const requirement = f.prepared.receipt.requirement
  const observation = await service.observeDurably({ ...target, store, requirement })
  const candidate = observation.candidateSet.candidates.find(item => item.agentDefinitionRef === f.prepared.receipt.agentDefinitionRef)!
  const before = await readFile(path.join(f.root, "Agents/Summary.xnl"), "utf8")
  const snapshot = await f.registry.snapshot()
  const decision = { schemaVersion: observation.requirement.schemaVersion, mode: "revise-existing",
    requirementDigest: observation.requirement.requirementDigest, candidateSetDigest: observation.candidateSet.candidateSetDigest,
    candidateRef: candidate.agentDefinitionRef, candidateDigest: candidate.candidateDigest, reason: "Repair failed worker",
    feedback: { observationRef: "observation://parent", attemptRef: "attempt://worker", verificationRef: "verification://artifact",
      requirementDigest: observation.requirement.requirementDigest, candidateSetDigest: observation.candidateSet.candidateSetDigest,
      candidateDigest: candidate.candidateDigest, previousExecutionFingerprint: f.prepared.proof.semanticFingerprint },
    proposal: { schemaVersion: "halfcode.resource-authoring/v1", operation: "update", catalogId: "agents",
      resourceId: "eidolon.fixture.SummaryAgent", kind: "AIAgentDefinition", envelopeVersion: "halfcode.resource-envelope/v1",
      writerSpecVersion: 1, sourceShape: "single-file", documentUri: "vfs://@/Agents/Summary.xnl",
      authorityText: before.replace('lifecycle="Active"', 'lifecycle="Active" description="V2 repair"'),
      expected: { state: "present", registryRevision: observation.candidateSet.registryRevision,
        authorityDigest: snapshot.contentIdentities.get("eidolon.fixture.SummaryAgent")!.authorityDigest } } }
  const inputPath = path.join(f.parent, "crash-input.json")
  await writeFile(inputPath, JSON.stringify({ target, requirement, decision, previousReceipt: f.prepared.receipt,
    layers: f.layers, supportRoot: f.supportRoot, storeRoot }))
  const run = async (mode: string) => {
    const child = Bun.spawn([process.execPath, "--tsconfig-override", testSourceTsconfig(),
      path.join(import.meta.dir, "fixtures/agent-durable-preparation-process.ts"), inputPath, mode], { stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { stdout, stderr, exitCode }
  }
  const interrupted = await run("interrupt")
  expect(interrupted.exitCode, interrupted.stderr).toBe(73)
  expect(await store.loadDecision(target.instanceId, target.nodeId)).toEqual(decision)
  expect(await store.list(target.instanceId)).toEqual([])
  expect(await readFile(path.join(f.root, "Agents/Summary.xnl"), "utf8")).toContain("V2 repair")
  const liveV3 = before.replace('lifecycle="Active"', 'lifecycle="Active" description="V3 unrelated live update"')
  await writeFile(path.join(f.root, "Agents/Summary.xnl"), liveV3)
  const resumed = await run("resume")
  expect(resumed.exitCode, resumed.stderr).toBe(0)
  const result = JSON.parse(resumed.stdout)
  expect(result.contextVersion).toBe("V1")
  expect(result.savedCount).toBe(1)
  expect(result.receipt.semanticFingerprint).not.toBe(f.prepared.proof.semanticFingerprint)
  expect(result.authoring.receiptDigest).toBe(result.receipt.authoring.receiptDigest)
  const frozenSource = Object.values(result.receipt.frozenExecution.files as Record<string, string>)
    .map(bytes => Buffer.from(bytes, "base64").toString()).find(text => text.includes("<AIAgentDefinition #eidolon.fixture.SummaryAgent"))!
  expect(frozenSource).toContain("V2 repair")
  expect(frozenSource).not.toContain("V3 unrelated")
  const repeated = await run("resume")
  expect(repeated.exitCode, repeated.stderr).toBe(0)
  expect(JSON.parse(repeated.stdout).receipt).toEqual(result.receipt)
  expect(await readFile(path.join(f.root, "Agents/Summary.xnl"), "utf8")).toBe(liveV3)
}, 30000)
