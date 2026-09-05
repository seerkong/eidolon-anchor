import { afterEach, describe, expect, it } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  AI_AGENT_DEFINITION_SELECTION_SCHEMA_VERSION,
  DEPA_AI_RESOURCE_ENVELOPE_VERSION,
  DEPA_AI_RESOURCE_SPEC_VERSION,
  depaAIResourceKindContract,
  type AIAgentTaskRequirement,
} from "ai-workflow-contract"
import { RESOURCE_AUTHORING_SCHEMA_VERSION } from "halfcode-compiler.xnl/authoring-runtime"
import {
  createAIDataControlRuntime,
  freezeAIDataControlCapabilityCatalog,
} from "ai-data-workflow-logic"

import {
  EidolonAppResourceRegistryAdapter,
  EidolonAutonomousAgentResourceHost,
  type ResourcePackageLayerBinding,
} from "../../src/resources"
import {
  EffectiveEidolonVfsMaterializer,
  createMutationEidolonOverlay,
  loadPhysicalEidolonDirectoryOverlay,
  stableEidolonOverlayNodeId,
} from "@cell/symbiont-logic/resource/EffectiveEidolonVfsMaterializer"
import { VirtualFileSystem } from "xnl-vfs"
import {
  AI_DATA_AGENT_PREPARATION_EXTENSION_KIND,
  AI_DATA_AGENT_PREPARATION_EXTENSION_SCHEMA_REF,
  AIDataAgentResourcePreparationService,
  EidolonFixedAgentExecutionRegistry,
  FileAIDataAgentPreparationStore,
  emptyAIDataAgentPreparationExtensionValue,
  mergeAIDataPreparedAgentProofs,
  readAIDataAgentPreparationReceipts,
  writeAIDataAgentPreparationExtensions,
  writeAIDataPreparedAgentCapabilities,
} from "../../src/workflow/runtime/AIDataAgentResourcePreparation"
import {
  createAIDataAutonomousControlState,
  findAIDataAutonomousControlStateInExtensions,
  selectAIDataAgentDispatch,
  writeAIDataAutonomousControlExtension,
} from "../../src/workflow/runtime/AIDataAutonomousControlLoop"

const fixtureRoot = path.join(import.meta.dir, "fixtures", "resource-native-authoring-package")
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  readonly workspaceRoot: string
  readonly layers: readonly ResourcePackageLayerBinding[]
  readonly registry: EidolonAppResourceRegistryAdapter
  readonly host: EidolonAutonomousAgentResourceHost
}> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-agent-resource-host-"))
  temporaryRoots.push(parent)
  const workspaceRoot = path.join(parent, "workspace-resources")
  await cp(fixtureRoot, workspaceRoot, { recursive: true })
  const layers = Object.freeze([{ id: "workspace" as const, rootDir: workspaceRoot }])
  const registry = new EidolonAppResourceRegistryAdapter({ layers })
  return {
    workspaceRoot,
    layers,
    registry,
    host: new EidolonAutonomousAgentResourceHost(
      registry,
      layers,
      path.join(parent, "authoring-facts"),
    ),
  }
}

async function effectiveFixture(): Promise<Awaited<ReturnType<typeof fixture>>> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-effective-agent-host-"))
  temporaryRoots.push(parent)
  const workspaceEidolonRoot = path.join(parent, "workspace", ".eidolon")
  const workspaceRoot = path.join(workspaceEidolonRoot, "resources")
  await mkdir(workspaceEidolonRoot, { recursive: true })
  await cp(fixtureRoot, workspaceRoot, { recursive: true })
  const builtin = new VirtualFileSystem()
  builtin.mkdir("vfs:///.eidolon/resources", { recursive: true })
  const materializer = new EffectiveEidolonVfsMaterializer({ builtinSnapshot: builtin.getSnapshot() })
  const loadOverlays = async () => [await loadPhysicalEidolonDirectoryOverlay({
    id: "workspace-directory",
    kind: "workspace",
    order: 0,
    rootDir: workspaceEidolonRoot,
  })]
  const initial = await materializer.materialize({
    expectedCurrentRevision: materializer.read().snapshot.revision,
    overlays: await loadOverlays(),
  })
  if (initial.status !== "admitted") throw new Error("effective fixture materialization failed")
  const authoring = Object.freeze({
    workspaceResourceRoot: workspaceRoot,
    read: () => materializer.read(),
    prepare: async (input: Readonly<{
      expectedCurrentRevision: `sha256:${string}`
      logicalPath: `/.eidolon/resources/${string}`
      authorityText: string
    }>) => materializer.prepare({
      expectedCurrentRevision: input.expectedCurrentRevision,
      overlays: [
        ...await loadOverlays(),
        createMutationEidolonOverlay({
          id: "workspace-authoring-intent",
          kind: "workspace",
          order: 1,
          mutations: [{
            type: "FILE_CREATE",
            path: `vfs://${input.logicalPath}`,
            expectedId: stableEidolonOverlayNodeId("workspace-directory", "file", input.logicalPath),
            payload: { content: input.authorityText, fileType: "xnl" },
          }],
        }),
      ],
    }),
    admit: materializer.admit.bind(materializer),
  })
  const registry = new EidolonAppResourceRegistryAdapter({ effectiveVfs: () => materializer.read().readPort })
  const layers = Object.freeze([] as ResourcePackageLayerBinding[])
  return {
    workspaceRoot,
    layers,
    registry,
    host: new EidolonAutonomousAgentResourceHost(
      registry,
      layers,
      path.join(parent, "authoring-facts"),
      authoring,
    ),
  }
}

async function dataFixture(): Promise<Awaited<ReturnType<typeof fixture>>> {
  const roots = await fixture()
  const manifestPath = path.join(roots.workspaceRoot, "manifest.xnl")
  await writeFile(manifestPath, (await readFile(manifestPath, "utf8")).replace(
    "    <Catalog #workflows",
    "    <Catalog #data_workflows { kind = \"AIDataWorkflow\" shape = \"single-file\" root = \"vfs://./DataWorkflows/\" }>\n    <Catalog #workflows",
  ))
  await mkdir(path.join(roots.workspaceRoot, "KindDefinitions", "AIDataWorkflow"), { recursive: true })
  await writeFile(
    path.join(roots.workspaceRoot, "KindDefinitions", "AIDataWorkflow", "manifest.xnl"),
    depaAIResourceKindContract("AIDataWorkflow").kindDefinitionSource,
  )
  await mkdir(path.join(roots.workspaceRoot, "DataWorkflows"), { recursive: true })
  await writeFile(
    path.join(roots.workspaceRoot, "DataWorkflows", "Autonomous.xnl"),
    `<AIDataWorkflow #eidolon.fixture.AutonomousData envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 (
  <FlowContract #eidolon.fixture.AutonomousData>
) []>
`,
  )
  return roots
}

function requirement(
  requirementId: string,
  requiredMaterialPortRefs: readonly `resource://${string}`[],
): AIAgentTaskRequirement {
  return {
    schemaVersion: AI_AGENT_DEFINITION_SELECTION_SCHEMA_VERSION,
    requirementId,
    objective: "Choose an exact Worker from typed resource facts.",
    requiredToolRefs: [],
    requiredMaterialPortRefs,
    requiredMessageSourceRefs: [],
  }
}

function generatedAuthority(): string {
  return `<AIAgentDefinition #eidolon.fixture.GeneratedExactWorker envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {
  lifecycle = "Active"
  description = "Runtime-authored exact Worker"
} (
  <MessagePrefix [
    <Message #system { role = "system" promptKind = "Prompt" promptRef = "resource://eidolon.fixture.SummaryPrompt" }>
  ]>
  <ToolRefs []>
  <MaterialPortRefs []>
)>
`
}

const target = Object.freeze({
  workflowKind: "AICtrlWorkflow" as const,
  workflowRef: "resource://eidolon.fixture.SummaryWorkflow" as const,
  nodeId: "summarize",
})

describe("Eidolon autonomous AIAgentDefinition resource host", () => {
  it("authors, reconciles and freezes a Worker from the admitted Effective VFS revision", async () => {
    const roots = await effectiveFixture()
    const observation = await roots.host.observe(requirement("effective-author-worker", []))
    const prepared = await roots.host.prepare({
      observation,
      decision: {
        schemaVersion: observation.requirement.schemaVersion,
        mode: "author-new",
        requirementDigest: observation.requirement.requirementDigest,
        candidateSetDigest: observation.candidateSet.candidateSetDigest,
        agentDefinitionRef: "resource://eidolon.fixture.GeneratedExactWorker",
        proposal: {
          schemaVersion: RESOURCE_AUTHORING_SCHEMA_VERSION,
          operation: "create",
          catalogId: "agents",
          resourceId: "eidolon.fixture.GeneratedExactWorker",
          kind: "AIAgentDefinition",
          envelopeVersion: DEPA_AI_RESOURCE_ENVELOPE_VERSION,
          writerSpecVersion: DEPA_AI_RESOURCE_SPEC_VERSION,
          sourceShape: "single-file",
          documentUri: "vfs://@/Agents/GeneratedExactWorker.xnl",
          authorityText: generatedAuthority(),
          expected: { state: "absent", registryRevision: observation.candidateSet.registryRevision },
        },
        reason: "Create and freeze one Worker from the Effective VFS authority.",
      },
      target: { ...target, nodeId: "effective-authored-worker" },
    })

    expect(prepared.status).toBe("prepared")
    if (prepared.status !== "prepared") throw new Error("effective authoring must prepare")
    expect(prepared.snapshot.effectiveVfs).toBeDefined()
    expect(prepared.authoringReceipt?.effectiveOrigin).toMatchObject({ layerId: "effective-vfs" })
    expect(prepared.taskBinding.task.agentDefinitionRef)
      .toBe("resource://eidolon.fixture.GeneratedExactWorker")
    expect(prepared.taskBinding.snapshotRevision).toMatch(/^sha256:/)
    expect(prepared.taskBinding.closureResourceIds).toContain("eidolon.fixture.GeneratedExactWorker")
  })

  it("selects and freezes one exact existing resource without authoring bytes", async () => {
    const roots = await fixture()
    const observation = await roots.host.observe(requirement(
      "existing-summary-worker",
      ["resource://eidolon.fixture.ArticlePort"],
    ))
    const candidate = observation.candidateSet.candidates.find(
      ({ agentDefinitionRef }) => agentDefinitionRef === "resource://eidolon.fixture.SummaryAgent",
    )!
    const beforeFiles = await readdir(path.join(roots.workspaceRoot, "Agents"))
    const prepared = await roots.host.prepare({
      observation,
      decision: {
        schemaVersion: observation.requirement.schemaVersion,
        mode: "select-existing",
        requirementDigest: observation.requirement.requirementDigest,
        candidateSetDigest: observation.candidateSet.candidateSetDigest,
        candidateRef: candidate.agentDefinitionRef,
        candidateDigest: candidate.candidateDigest,
        reason: "The candidate contains every required typed material port.",
      },
      target,
    })

    expect(prepared.status).toBe("prepared")
    if (prepared.status !== "prepared") throw new Error("exact selection must prepare")
    expect(prepared.authoringReceipt).toBeUndefined()
    expect(prepared.taskBinding.task.agentDefinitionRef)
      .toBe("resource://eidolon.fixture.SummaryAgent")
    expect(prepared.taskBinding.closureResourceIds).toEqual(expect.arrayContaining([
      "eidolon.fixture.SummaryAgent",
      "eidolon.fixture.SummaryPrompt",
      "eidolon.fixture.ArticlePort",
    ]))
    expect(await readdir(path.join(roots.workspaceRoot, "Agents"))).toEqual(beforeFiles)
  })

  it("rejects copied observations and tampered candidate identities before freeze", async () => {
    const roots = await fixture()
    const observation = await roots.host.observe(requirement(
      "tamper-proof-summary-worker",
      ["resource://eidolon.fixture.ArticlePort"],
    ))
    const candidate = observation.candidateSet.candidates[0]!
    const decision = {
      schemaVersion: observation.requirement.schemaVersion,
      mode: "select-existing" as const,
      requirementDigest: observation.requirement.requirementDigest,
      candidateSetDigest: observation.candidateSet.candidateSetDigest,
      candidateRef: candidate.agentDefinitionRef,
      candidateDigest: `sha256:${"0".repeat(64)}` as `sha256:${string}`,
      reason: "tampered",
    }

    const rejected = await roots.host.prepare({ observation, decision, target })
    expect(rejected).toMatchObject({ status: "rejected", code: "candidate-digest-mismatch" })
    await expect(roots.host.prepare({
      observation: { ...observation },
      decision,
      target,
    })).rejects.toThrow("EIDOLON_AGENT_SELECTION_OBSERVATION_UNTRUSTED")
  })

  it("authors through Halfcode, reconciles the durable receipt and only then freezes", async () => {
    const roots = await fixture()
    const parentSnapshot = await roots.registry.snapshot()
    const parentIds = [...parentSnapshot.registry.byId.keys()]
    const observation = await roots.host.observe(requirement("author-exact-worker", []))
    const authorityText = generatedAuthority()
    const prepared = await roots.host.prepare({
      observation,
      decision: {
        schemaVersion: observation.requirement.schemaVersion,
        mode: "author-new",
        requirementDigest: observation.requirement.requirementDigest,
        candidateSetDigest: observation.candidateSet.candidateSetDigest,
        agentDefinitionRef: "resource://eidolon.fixture.GeneratedExactWorker",
        proposal: {
          schemaVersion: RESOURCE_AUTHORING_SCHEMA_VERSION,
          operation: "create",
          catalogId: "agents",
          resourceId: "eidolon.fixture.GeneratedExactWorker",
          kind: "AIAgentDefinition",
          envelopeVersion: DEPA_AI_RESOURCE_ENVELOPE_VERSION,
          writerSpecVersion: DEPA_AI_RESOURCE_SPEC_VERSION,
          sourceShape: "single-file",
          documentUri: "vfs://@/Agents/GeneratedExactWorker.xnl",
          authorityText,
          expected: {
            state: "absent",
            registryRevision: observation.candidateSet.registryRevision,
          },
        },
        reason: "Create a reusable resource rather than an ad-hoc executable callback.",
      },
      target: { ...target, nodeId: "authored-worker" },
    })

    expect(prepared.status).toBe("prepared")
    if (prepared.status !== "prepared") throw new Error("authored selection must prepare")
    expect(prepared.authoringReceipt).toMatchObject({
      resourceId: "eidolon.fixture.GeneratedExactWorker",
      authorityDigestBefore: null,
    })
    expect(prepared.admission.candidate.authoringEvidence).toMatchObject({
      receiptDigest: prepared.authoringReceipt?.receiptDigest,
      planDigest: prepared.authoringReceipt?.planDigest,
    })
    expect(prepared.taskBinding.task.agentDefinitionRef)
      .toBe("resource://eidolon.fixture.GeneratedExactWorker")
    expect(prepared.taskBinding.closureResourceIds).toEqual(expect.arrayContaining([
      "eidolon.fixture.GeneratedExactWorker",
      "eidolon.fixture.SummaryPrompt",
    ]))
    expect(parentSnapshot.registry.byId.has("eidolon.fixture.GeneratedExactWorker")).toBe(false)
    expect([...parentSnapshot.registry.byId.keys()]).toEqual(parentIds)
    expect(prepared.snapshot.registry.byId.has("eidolon.fixture.GeneratedExactWorker")).toBe(true)
  })

  it("freezes an AI Data capability before run and rebuilds the same proof in a fresh host", async () => {
    const roots = await dataFixture()
    const supportRoot = path.join(path.dirname(roots.workspaceRoot), "agent-preparation-facts")
    const frozenRoot = path.join(path.dirname(roots.workspaceRoot), "frozen-parent-resources")
    await cp(roots.workspaceRoot, frozenRoot, { recursive: true })
    const frozenRegistry = new EidolonAppResourceRegistryAdapter({
      layers: [{ id: "workspace", rootDir: frozenRoot }],
    })
    const service = new AIDataAgentResourcePreparationService(
      new EidolonAutonomousAgentResourceHost(roots.registry, roots.layers, supportRoot),
    )
    const observation = await service.observe(requirement("prepare-data-worker", []))
    const prepared = await service.prepare({
      instanceId: "instance-data-1",
      observation,
      decision: {
        schemaVersion: observation.requirement.schemaVersion,
        mode: "author-new",
        requirementDigest: observation.requirement.requirementDigest,
        candidateSetDigest: observation.candidateSet.candidateSetDigest,
        agentDefinitionRef: "resource://eidolon.fixture.GeneratedExactWorker",
        proposal: {
          schemaVersion: RESOURCE_AUTHORING_SCHEMA_VERSION,
          operation: "create",
          catalogId: "agents",
          resourceId: "eidolon.fixture.GeneratedExactWorker",
          kind: "AIAgentDefinition",
          envelopeVersion: DEPA_AI_RESOURCE_ENVELOPE_VERSION,
          writerSpecVersion: DEPA_AI_RESOURCE_SPEC_VERSION,
          sourceShape: "single-file",
          documentUri: "vfs://@/Agents/GeneratedExactWorker.xnl",
          authorityText: generatedAuthority(),
          expected: { state: "absent", registryRevision: observation.candidateSet.registryRevision },
        },
        reason: "Author one exact Worker before freezing the run-local capability catalog.",
      },
      workflowRef: "resource://eidolon.fixture.AutonomousData",
      nodeId: "generated-worker",
      instanceName: "mission-worker",
      capability: {
        capabilityId: "generated-worker-capability",
        tag: "TransformNode",
        inputSchemaRefs: { value: "schema://fixture/value" },
        outputSchemaRefs: { value: "schema://fixture/value" },
        fixedConfig: {},
      },
    })
    expect("receipt" in prepared).toBe(true)
    if (!("receipt" in prepared)) throw new Error("Agent preparation must succeed")
    const store = new FileAIDataAgentPreparationStore(path.join(supportRoot, "receipts"))
    await store.save(prepared.receipt)
    await store.save(prepared.receipt)
    expect(await store.list("instance-data-1")).toEqual([prepared.receipt])
    const merged = mergeAIDataPreparedAgentProofs({ taskProofs: {}, taskProofRefs: {}, prepared: [prepared] })
    expect(merged.taskProofs["generated-worker"]?.semanticFingerprint)
      .toBe(prepared.proof.semanticFingerprint)
    expect(merged.taskProofRefs["generated-worker"])
      .toEqual(["resource://eidolon.fixture.GeneratedExactWorker"])
    const execution = await new EidolonFixedAgentExecutionRegistry(
      frozenRegistry,
      roots.registry,
      [prepared],
    ).prepareWorkflowAgentExecution(prepared.receipt.task, { payload: { value: "execute" } })
    expect(execution.plan.agentDefinitionRef).toBe(prepared.receipt.agentDefinitionRef)
    expect(execution.receipt.semanticFingerprint).toBe(prepared.receipt.semanticFingerprint)

    const catalog = freezeAIDataControlCapabilityCatalog(createAIDataControlRuntime(), {
      schemaVersion: "depa.ai-data-control/v1",
      catalogId: "run-fixed-catalog",
      foundationNodes: {
        control: { protected: true, inputSchemaRefs: {}, outputSchemaRefs: {} },
      },
      capabilities: {},
    }, {})
    const control = createAIDataAutonomousControlState({
      controlNodeId: "control",
      goal: {
        schemaVersion: "depa.ai-data-control/v1",
        goalId: "mission-goal",
        objective: "Produce a verified result",
        verifierRef: "resource://eidolon.fixture.Verifier",
        requiredOutputSchemaRef: "schema://fixture/value",
      },
      catalog,
      budget: {
        schemaVersion: "depa.ai-data-control/v1",
        limits: { maxIterations: 3, maxOperationsPerDecision: 2, maxNoProgressIterations: 2 },
        usage: { iteration: 0, noProgressIterations: 0 },
      },
      controller: {
        taskProofRef: "resource://eidolon.fixture.ControllerProof",
        agentDefinitionRef: "resource://eidolon.fixture.SummaryAgent",
        instanceName: "controller",
      },
      maxObservedNodes: 16,
    })
    const initial = writeAIDataAutonomousControlExtension(undefined, control)
    const withPreparationSlot = {
      ...initial!,
      byStepId: {
        ...initial!.byStepId,
        control: {
          ...initial!.byStepId.control,
          [AI_DATA_AGENT_PREPARATION_EXTENSION_KIND]: {
            schemaRef: AI_DATA_AGENT_PREPARATION_EXTENSION_SCHEMA_REF,
            revision: 0,
            value: emptyAIDataAgentPreparationExtensionValue(),
          },
        },
      },
    }
    const receiptExtensions = writeAIDataAgentPreparationExtensions(withPreparationSlot, [prepared.receipt])
    const extensions = writeAIDataPreparedAgentCapabilities(receiptExtensions, [prepared.receipt])
    expect(readAIDataAgentPreparationReceipts(extensions)).toEqual([prepared.receipt])
    expect(findAIDataAutonomousControlStateInExtensions(extensions)?.binding.catalog.capabilities)
      .toMatchObject({
        "generated-worker-capability": {
          nodeType: "agent",
          implementation: {
            agentDefinitionRef: "resource://eidolon.fixture.GeneratedExactWorker",
            taskProofRef: "resource://eidolon.fixture.GeneratedExactWorker",
          },
          fixedConfig: { instanceName: "mission-worker" },
        },
      })

    await writeFile(
      path.join(roots.workspaceRoot, "Prompts", "Unrelated.xnl"),
      `<Prompt #eidolon.fixture.UnrelatedPrompt envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle = "Active" template = "unrelated" }>\n`,
    )
    const fresh = new AIDataAgentResourcePreparationService(
      new EidolonAutonomousAgentResourceHost(roots.registry, roots.layers, supportRoot),
    )
    const recovered = await fresh.recover(JSON.parse(JSON.stringify(prepared.receipt)))
    expect(recovered.proof.semanticFingerprint).toBe(prepared.proof.semanticFingerprint)
    expect(recovered.proof.closureResourceIds).toEqual(prepared.proof.closureResourceIds)
    expect(recovered.proof.snapshotRevision).not.toBe(prepared.proof.snapshotRevision)

    const emptyAi = {
      schemaVersion: "depa.ai-agent-state/v1" as const,
      instancesById: {},
      instanceIdByName: {},
      invocationsByKey: {},
    }
    expect(selectAIDataAgentDispatch(emptyAi, {
      instanceName: recovered.receipt.instanceName,
      agentDefinitionRef: recovered.receipt.agentDefinitionRef,
      payload: { value: "first" },
    })).toMatchObject({ mode: "new", config: { instanceName: "mission-worker" } })
    expect(selectAIDataAgentDispatch({
      ...emptyAi,
      instancesById: {
        "actor-1": {
          authority: "eidolon.actor-runtime/v1",
          instanceId: "actor-1",
          instanceName: "mission-worker",
          agentDefinitionRef: recovered.receipt.agentDefinitionRef,
        },
      },
      instanceIdByName: { "mission-worker": "actor-1" },
    }, {
      instanceName: recovered.receipt.instanceName,
      agentDefinitionRef: recovered.receipt.agentDefinitionRef,
      payload: { value: "again" },
    })).toMatchObject({ mode: "targeted", selector: { byId: "actor-1" } })

    await writeFile(
      path.join(roots.workspaceRoot, "Agents", "GeneratedExactWorker.xnl"),
      generatedAuthority().replace("Runtime-authored exact Worker", "Tampered Worker"),
    )
    await expect(fresh.recover(prepared.receipt))
      .rejects.toThrow("AI_DATA_AGENT_PREPARATION_RESOURCE_DRIFT")
  })
})
