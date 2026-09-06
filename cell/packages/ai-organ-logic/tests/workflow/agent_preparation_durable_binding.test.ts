import { afterEach, expect, it } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { AI_AGENT_DEFINITION_SELECTION_SCHEMA_VERSION, depaAIResourceKindContract } from "ai-workflow-contract"
import { EidolonAppResourceRegistryAdapter } from "../../src/resources/EidolonAppResourceRegistryAdapter"
import { EidolonAutonomousAgentResourceHost } from "../../src/resources/EidolonAutonomousAgentResourceHost"
import { AIDataAgentResourcePreparationService, FileAIDataAgentPreparationStore } from "../../src/workflow/runtime/AIDataAgentResourcePreparation"

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-preparation-binding-"))
  roots.push(parent)
  const root = path.join(parent, "resources")
  await cp(path.join(import.meta.dir, "fixtures/resource-native-authoring-package"), root, { recursive: true })
  const manifestPath = path.join(root, "manifest.xnl")
  await writeFile(manifestPath, (await readFile(manifestPath, "utf8")).replace("<Catalog #agents",
    '<Catalog #data { kind="AIDataWorkflow" shape="single-file" root="vfs://./DataWorkflows/" }>\n<Catalog #agents'))
  await mkdir(path.join(root, "KindDefinitions/AIDataWorkflow"), { recursive: true })
  await writeFile(path.join(root, "KindDefinitions/AIDataWorkflow/manifest.xnl"), depaAIResourceKindContract("AIDataWorkflow", 1).kindDefinitionSource)
  await mkdir(path.join(root, "DataWorkflows"))
  await writeFile(path.join(root, "DataWorkflows/Flow.xnl"), '<AIDataWorkflow #eidolon.fixture.BindingData envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 (<FlowContract #eidolon.fixture.BindingData>) []>')
  await writeFile(path.join(root, "Agents/Summary.xnl"), '<AIAgentDefinition #eidolon.fixture.SummaryAgent envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle="Active" description="Exact reusable summary Agent" } (<MessagePrefix []><ToolRefs []><MaterialPortRefs []>)>')
  const layers = [{ id: "workspace" as const, rootDir: root }]
  const registry = new EidolonAppResourceRegistryAdapter({ layers })
  const service = new AIDataAgentResourcePreparationService(new EidolonAutonomousAgentResourceHost(registry, layers, path.join(parent, "support")))
  const store = new FileAIDataAgentPreparationStore(path.join(parent, "preparations"))
  const input = { store, instanceId: "child", nodeId: "worker", identity: { parentRunId: "parent" },
    requirement: { schemaVersion: AI_AGENT_DEFINITION_SELECTION_SCHEMA_VERSION, requirementId: "binding", objective: "Use the exact observed worker",
      requiredToolRefs: [], requiredMaterialPortRefs: [], requiredMessageSourceRefs: [] } }
  const target = { workflowRef: "resource://eidolon.fixture.BindingData" as const, instanceName: "child-worker",
    capability: { capabilityId: "child-worker", tag: "TransformNode" as const, inputSchemaRefs: {}, outputSchemaRefs: {}, fixedConfig: {} } }
  return { root, registry, service, input, target }
}

function selection(observation: Awaited<ReturnType<AIDataAgentResourcePreparationService["observe"]>>) {
  const candidate = observation.candidateSet.candidates.find(item => item.agentDefinitionRef === "resource://eidolon.fixture.SummaryAgent")!
  return { schemaVersion: observation.requirement.schemaVersion, mode: "select-existing" as const,
    requirementDigest: observation.requirement.requirementDigest, candidateSetDigest: observation.candidateSet.candidateSetDigest,
    candidateRef: candidate.agentDefinitionRef, candidateDigest: candidate.candidateDigest, reason: "Use this exact observed candidate" }
}

it("rejects a genuine later observation that does not belong to the persisted preparation intent", async () => {
  const { root, service, input, target } = await fixture()
  const original = await service.observeDurably(input)
  const source = path.join(root, "Agents/Summary.xnl")
  await writeFile(source, (await readFile(source, "utf8")).replace("Exact reusable summary Agent", "Later changed Worker"))
  const later = await service.observe(input.requirement)
  expect(later.candidateSet.candidateSetDigest).not.toBe(original.candidateSet.candidateSetDigest)
  await expect(service.prepareDurably({ ...input, ...target, observation: later, decision: selection(later) })).rejects.toThrow()
  expect(await input.store.loadDecision(input.instanceId, input.nodeId)).toBeUndefined()
  expect(await input.store.list(input.instanceId)).toEqual([])
})

it("rejects an unlinked old receipt even when the new intent has the same target and requirement", async () => {
  const { service, input, target } = await fixture()
  const observation = await service.observe(input.requirement)
  const old = await service.prepare({ ...input, ...target, observation, decision: selection(observation) })
  if (!("receipt" in old)) throw new Error(JSON.stringify(old))
  await input.store.save(old.receipt)
  const durableObservation = await service.observeDurably(input)
  const decision = { ...selection(durableObservation), candidateRef: "resource://nonexistent.Agent" as const,
    candidateDigest: `sha256:${"0".repeat(64)}` as const }
  // The public direct recovery path remains compatible with legacy unlinked receipts.
  expect((await service.recover(old.receipt)).receipt.receiptDigest).toBe(old.receipt.receiptDigest)
  await expect(service.prepareDurably({ ...input, ...target, observation: durableObservation, decision })).rejects.toThrow()
})
