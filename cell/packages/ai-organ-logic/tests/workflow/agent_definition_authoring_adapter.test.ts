import { afterEach, describe, expect, it } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  RESOURCE_AUTHORING_SCHEMA_VERSION,
  type ResourceAuthoringProposal,
} from "halfcode-compiler.xnl/authoring-runtime"
import {
  DEPA_AI_RESOURCE_ENVELOPE_VERSION,
  DEPA_AI_RESOURCE_SPEC_VERSION,
} from "ai-workflow-contract"

import {
  EidolonAIAgentDefinitionAuthoringAdapter,
  EidolonAppResourceRegistryAdapter,
  type ResourcePackageLayerBinding,
} from "../../src/resources"
import {
  EffectiveEidolonVfsMaterializer,
  createMutationEidolonOverlay,
  loadPhysicalEidolonDirectoryOverlay,
  stableEidolonOverlayNodeId,
  type EidolonVfsOverlayMaterial,
} from "@cell/symbiont-logic/resource/EffectiveEidolonVfsMaterializer"
import { VirtualFileSystem } from "xnl-vfs"

const fixtureRoot = path.join(import.meta.dir, "fixtures", "resource-native-authoring-package")
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  readonly workspaceRoot: string
  readonly supportRoot: string
  readonly layers: readonly ResourcePackageLayerBinding[]
  readonly registry: EidolonAppResourceRegistryAdapter
}> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-agent-authoring-"))
  temporaryRoots.push(parent)
  const workspaceRoot = path.join(parent, "workspace-resources")
  const supportRoot = path.join(parent, "authoring-facts")
  await cp(fixtureRoot, workspaceRoot, { recursive: true })
  const layers = Object.freeze([{ id: "workspace" as const, rootDir: workspaceRoot }])
  return {
    workspaceRoot,
    supportRoot,
    layers,
    registry: new EidolonAppResourceRegistryAdapter({ layers }),
  }
}

async function effectiveFixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-agent-effective-authoring-"))
  temporaryRoots.push(parent)
  const workspaceEidolonRoot = path.join(parent, "workspace", ".eidolon")
  const workspaceRoot = path.join(workspaceEidolonRoot, "resources")
  const supportRoot = path.join(parent, "authoring-facts")
  await mkdir(workspaceEidolonRoot, { recursive: true })
  await cp(fixtureRoot, workspaceRoot, { recursive: true })
  const builtin = new VirtualFileSystem()
  builtin.mkdir("vfs:///.eidolon/resources", { recursive: true })
  const materializer = new EffectiveEidolonVfsMaterializer({ builtinSnapshot: builtin.getSnapshot() })
  const loadOverlays = (): Promise<readonly EidolonVfsOverlayMaterial[]> => Promise.all([
    loadPhysicalEidolonDirectoryOverlay({
      id: "workspace-directory",
      kind: "workspace",
      order: 0,
      rootDir: workspaceEidolonRoot,
    }),
  ])
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
  const registry = new EidolonAppResourceRegistryAdapter({
    effectiveVfs: () => materializer.read().readPort,
  })
  return { workspaceRoot, supportRoot, materializer, registry, authoring }
}

function agentAuthority(resourceId: string, description: string): string {
  return `<AIAgentDefinition #${resourceId} envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {
  lifecycle = "Active"
  description = "${description}"
} (
  <MessagePrefix [
    <Message #system { role = "system" promptKind = "Prompt" promptRef = "resource://eidolon.fixture.SummaryPrompt" }>
  ]>
  <ToolRefs []>
  <MaterialPortRefs []>
)>
`
}

function proposal(input: {
  readonly resourceId: string
  readonly fileName: string
  readonly registryRevision: string
}): ResourceAuthoringProposal {
  return Object.freeze({
    schemaVersion: RESOURCE_AUTHORING_SCHEMA_VERSION,
    operation: "create",
    catalogId: "agents",
    resourceId: input.resourceId,
    kind: "AIAgentDefinition",
    envelopeVersion: DEPA_AI_RESOURCE_ENVELOPE_VERSION,
    writerSpecVersion: DEPA_AI_RESOURCE_SPEC_VERSION,
    sourceShape: "single-file",
    documentUri: `vfs://@/Agents/${input.fileName}.xnl`,
    authorityText: agentAuthority(input.resourceId, `Generated ${input.fileName} Worker`),
    expected: Object.freeze({ state: "absent", registryRevision: input.registryRevision }),
  })
}

describe("Eidolon Halfcode AIAgentDefinition authoring adapter", () => {
  it("validates an unpublished Effective VFS candidate before admitting the workspace overlay intent", async () => {
    const roots = await effectiveFixture()
    const before = await roots.registry.snapshot()
    const logicalPath = "/.eidolon/resources/Agents/EffectiveGeneratedWorker.xnl"
    let preparedWhileInvisible = false
    const authoring = Object.freeze({
      ...roots.authoring,
      prepare: async (input: Parameters<typeof roots.authoring.prepare>[0]) => {
        expect(await roots.materializer.read().readPort.stat(logicalPath)).toBeUndefined()
        await expect(readFile(path.join(roots.workspaceRoot, "Agents", "EffectiveGeneratedWorker.xnl"), "utf8"))
          .rejects.toMatchObject({ code: "ENOENT" })
        const result = await roots.authoring.prepare(input)
        expect(await roots.materializer.read().readPort.stat(logicalPath)).toBeUndefined()
        if (result.status === "prepared") {
          expect(await result.candidate.effective.readPort.stat(logicalPath)).toMatchObject({ kind: "file" })
          preparedWhileInvisible = true
        }
        return result
      },
    })
    const adapter = new EidolonAIAgentDefinitionAuthoringAdapter(
      roots.registry,
      [],
      roots.supportRoot,
      authoring,
    )

    const authored = await adapter.author({ proposal: proposal({
      resourceId: "eidolon.fixture.EffectiveGeneratedWorker",
      fileName: "EffectiveGeneratedWorker",
      registryRevision: before.registryRevision,
    }) })

    expect(preparedWhileInvisible).toBe(true)
    expect(await roots.materializer.read().readPort.stat(logicalPath)).toMatchObject({ kind: "file" })
    expect(authored.snapshot.effectiveVfs).toMatchObject({
      revision: roots.materializer.read().snapshot.revision,
      materializationReceiptId: roots.materializer.read().snapshot.materializationReceiptId,
    })
    expect(authored.receipt.effectiveOrigin).toMatchObject({ layerId: "effective-vfs" })
    expect(authored.snapshot.registry.byId.has("eidolon.fixture.EffectiveGeneratedWorker")).toBe(true)
  })

  it("publishes exact workspace authority and persists an immutable external receipt", async () => {
    const roots = await fixture()
    const before = await roots.registry.snapshot()
    const beforeIds = [...before.registry.byId.keys()]
    const adapter = new EidolonAIAgentDefinitionAuthoringAdapter(
      roots.registry,
      roots.layers,
      roots.supportRoot,
    )
    const authored = await adapter.author({
      proposal: proposal({
        resourceId: "eidolon.fixture.GeneratedWorker",
        fileName: "GeneratedWorker",
        registryRevision: before.registryRevision,
      }),
    })

    expect(await readFile(path.join(roots.workspaceRoot, "Agents", "GeneratedWorker.xnl"), "utf8"))
      .toBe(agentAuthority("eidolon.fixture.GeneratedWorker", "Generated GeneratedWorker Worker"))
    expect(authored.receipt).toMatchObject({
      operation: "create",
      resourceId: "eidolon.fixture.GeneratedWorker",
      kind: "AIAgentDefinition",
      documentUri: "vfs://@/Agents/GeneratedWorker.xnl",
      authorityDigestBefore: null,
      registryRevisionBefore: before.registryRevision,
      registryRevisionAfter: authored.snapshot.registryRevision,
      effectiveOrigin: {
        layerId: "workspace",
        documentUri: "vfs://@/Agents/GeneratedWorker.xnl",
      },
      authorityResourceIds: ["eidolon.fixture.GeneratedWorker"],
    })
    expect(authored.snapshot.agentResources.agentDefinitions.some(
      ({ resource }) => resource.resourceId === "eidolon.fixture.GeneratedWorker",
    )).toBe(true)
    expect(before.registry.byId.has("eidolon.fixture.GeneratedWorker")).toBe(false)
    expect([...before.registry.byId.keys()]).toEqual(beforeIds)

    const recovered = new EidolonAIAgentDefinitionAuthoringAdapter(
      roots.registry,
      roots.layers,
      roots.supportRoot,
    )
    expect(await recovered.loadReceipt(authored.receipt.planDigest)).toEqual(authored.receipt)
  })

  it("rejects the second stale Effective VFS authoring proposal without admitting partial bytes", async () => {
    const roots = await effectiveFixture()
    const before = await roots.registry.snapshot()
    const adapter = new EidolonAIAgentDefinitionAuthoringAdapter(
      roots.registry,
      [],
      roots.supportRoot,
      roots.authoring,
    )
    const results = await Promise.allSettled([
      adapter.author({ proposal: proposal({
        resourceId: "eidolon.fixture.EffectiveConcurrentA",
        fileName: "EffectiveConcurrentA",
        registryRevision: before.registryRevision,
      }) }),
      adapter.author({ proposal: proposal({
        resourceId: "eidolon.fixture.EffectiveConcurrentB",
        fileName: "EffectiveConcurrentB",
        registryRevision: before.registryRevision,
      }) }),
    ])

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1)
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1)
    const current = await roots.registry.snapshot()
    const admitted = ["eidolon.fixture.EffectiveConcurrentA", "eidolon.fixture.EffectiveConcurrentB"]
      .filter((resourceId) => current.registry.byId.has(resourceId))
    expect(admitted).toHaveLength(1)
    const rejected = admitted[0]!.endsWith("A") ? "EffectiveConcurrentB" : "EffectiveConcurrentA"
    await expect(readFile(path.join(roots.workspaceRoot, "Agents", `${rejected}.xnl`), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" })
  })

  it("recovers a durable receipt when the process boundary interrupts after Effective VFS CAS", async () => {
    const roots = await effectiveFixture()
    const before = await roots.registry.snapshot()
    let interruptedPlanDigest: string | undefined
    const interrupted = new EidolonAIAgentDefinitionAuthoringAdapter(
      roots.registry,
      [],
      roots.supportRoot,
      roots.authoring,
      {
        afterEffectiveVfsAdmission({ planDigest }) {
          interruptedPlanDigest = planDigest
          throw new Error("SIMULATED_PROCESS_INTERRUPTION_AFTER_VFS_CAS")
        },
      },
    )
    await expect(interrupted.author({ proposal: proposal({
      resourceId: "eidolon.fixture.RecoveredEffectiveWorker",
      fileName: "RecoveredEffectiveWorker",
      registryRevision: before.registryRevision,
    }) })).rejects.toThrow("commit")
    expect(interruptedPlanDigest).toMatch(/^sha256:/)
    expect(roots.materializer.read().snapshot.revision).not.toBe(before.effectiveVfs?.revision)

    const recoveredRegistry = new EidolonAppResourceRegistryAdapter({
      effectiveVfs: () => roots.materializer.read().readPort,
    })
    const recoveredAdapter = new EidolonAIAgentDefinitionAuthoringAdapter(
      recoveredRegistry,
      [],
      roots.supportRoot,
      roots.authoring,
    )
    const receipt = await recoveredAdapter.loadReceipt(interruptedPlanDigest!)

    expect(receipt).toMatchObject({
      resourceId: "eidolon.fixture.RecoveredEffectiveWorker",
      planDigest: interruptedPlanDigest,
    })
    expect((await recoveredRegistry.snapshot()).registry.byId.has(
      "eidolon.fixture.RecoveredEffectiveWorker",
    )).toBe(true)
  })

  it("serializes concurrent stale proposals so only one can cross the publication fence", async () => {
    const roots = await fixture()
    const before = await roots.registry.snapshot()
    const adapter = new EidolonAIAgentDefinitionAuthoringAdapter(
      roots.registry,
      roots.layers,
      roots.supportRoot,
    )
    const results = await Promise.allSettled([
      adapter.author({ proposal: proposal({
        resourceId: "eidolon.fixture.ConcurrentWorkerA",
        fileName: "ConcurrentWorkerA",
        registryRevision: before.registryRevision,
      }) }),
      adapter.author({ proposal: proposal({
        resourceId: "eidolon.fixture.ConcurrentWorkerB",
        fileName: "ConcurrentWorkerB",
        registryRevision: before.registryRevision,
      }) }),
    ])

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1)
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1)
    const snapshot = await roots.registry.snapshot()
    expect(snapshot.agentResources.agentDefinitions.filter(
      ({ resource }) => resource.resourceId.startsWith("eidolon.fixture.ConcurrentWorker"),
    )).toHaveLength(1)
  })

  it("rejects an authority target outside the admitted Agent catalog without writing bytes", async () => {
    const roots = await fixture()
    const before = await roots.registry.snapshot()
    const adapter = new EidolonAIAgentDefinitionAuthoringAdapter(
      roots.registry,
      roots.layers,
      roots.supportRoot,
    )
    const unsafe = {
      ...proposal({
        resourceId: "eidolon.fixture.OutsideWorker",
        fileName: "OutsideWorker",
        registryRevision: before.registryRevision,
      }),
      documentUri: "vfs://@/Prompts/OutsideWorker.xnl" as const,
    }

    await expect(adapter.author({ proposal: unsafe })).rejects.toThrow("catalog")
    await expect(readFile(path.join(roots.workspaceRoot, "Prompts", "OutsideWorker.xnl"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" })
    expect((await roots.registry.snapshot()).registryRevision).toBe(before.registryRevision)
  })
})
