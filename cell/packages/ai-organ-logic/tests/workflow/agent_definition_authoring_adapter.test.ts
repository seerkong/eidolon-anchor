import { afterEach, describe, expect, it } from "bun:test"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  RESOURCE_AUTHORING_SCHEMA_VERSION,
  type ResourceAuthoringProposal,
  type ResourceAuthoringReceipt,
} from "halfcode-compiler.xnl/authoring-runtime"
import {
  DEPA_AI_RESOURCE_ENVELOPE_VERSION,
  DEPA_AI_RESOURCE_SPEC_VERSION,
  depaAIResourceKindContract,
} from "ai-workflow-contract"

import {
  EidolonAIAgentDefinitionAuthoringAdapter,
  EidolonAppResourceRegistryAdapter,
  type ResourcePackageLayerBinding,
} from "../../src/resources"
import { VirtualFileSystem } from "xnl-vfs"
import { openAuthoringTestRuntime, type AuthoringProcessInput } from "./fixtures/agent-authoring-process"
import { testSourceTsconfig } from "./fixtures/test-source-binding"

const fixtureRoot = path.join(import.meta.dir, "fixtures", "resource-native-authoring-package")
const temporaryRoots: string[] = []
const authorities: { close(): void }[] = []

afterEach(async () => {
  for (const authority of authorities.splice(0)) authority.close()
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

async function effectiveFixture(options: { builtinAgent?: string; afterCommit?: Parameters<typeof openAuthoringTestRuntime>[1] } = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-agent-effective-authoring-"))
  temporaryRoots.push(parent)
  const workspaceEidolonRoot = path.join(parent, "workspace", ".eidolon")
  const workspaceRoot = path.join(workspaceEidolonRoot, "resources")
  const supportRoot = path.join(parent, "authoring-facts")
  await mkdir(workspaceEidolonRoot, { recursive: true })
  await cp(fixtureRoot, workspaceRoot, { recursive: true })
  const builtin = new VirtualFileSystem()
  builtin.mkdir("vfs:///.eidolon/resources", { recursive: true })
  if (options.builtinAgent) {
    builtin.mkdir("vfs:///.eidolon/resources/Agents")
    builtin.writeFile("vfs:///.eidolon/resources/Agents/Inherited.xnl", options.builtinAgent, { fileType: "xnl", metadataId: "builtin-inherited-agent" })
  }
  const processInput: AuthoringProcessInput = {
    databasePath: path.join(parent, "effective-vfs.sqlite"), workspaceEidolonRoot, supportRoot, builtinSnapshot: builtin.getSnapshot(),
  }
  const runtime = await openAuthoringTestRuntime(processInput, options.afterCommit)
  authorities.push(runtime.authority)
  const { materializer, loadOverlays, authoring, registry } = runtime
  const initial = await materializer.materialize({
    expectedCurrentRevision: materializer.read().snapshot.revision,
    overlays: await loadOverlays(),
  })
  if (initial.status !== "admitted") throw new Error("effective fixture materialization failed")
  return { workspaceRoot, supportRoot, materializer, registry, authoring, processInput }
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
  it("replays the original native plan against its persisted planning pins after later publications", async () => {
    const roots = await fixture()
    const before = await roots.registry.snapshot()
    const adapter = new EidolonAIAgentDefinitionAuthoringAdapter(roots.registry, roots.layers, roots.supportRoot)
    const first = proposal({ resourceId: "eidolon.fixture.Replay", fileName: "Replay", registryRevision: before.registryRevision })
    const committed = await adapter.author({ proposal: first })
    const later = await adapter.author({ proposal: proposal({
      resourceId: "eidolon.fixture.Later", fileName: "Later", registryRevision: committed.snapshot.registryRevision,
    }) })
    const fresh = new EidolonAIAgentDefinitionAuthoringAdapter(roots.registry, roots.layers, roots.supportRoot)
    const replay = await fresh.author({ proposal: first })
    expect(replay.receipt).toEqual(committed.receipt)
    expect(replay.snapshot.registryRevision).toBe(later.snapshot.registryRevision)
  })

  it("updates the selected authority with present CAS and preserves before digest", async () => {
    const roots = await fixture()
    const before = await roots.registry.snapshot()
    const adapter = new EidolonAIAgentDefinitionAuthoringAdapter(roots.registry, roots.layers, roots.supportRoot)
    const created = await adapter.author({ proposal: proposal({
      resourceId: "eidolon.fixture.Updated", fileName: "Updated", registryRevision: before.registryRevision,
    }) })
    const update = {
      ...proposal({ resourceId: "eidolon.fixture.Updated", fileName: "Updated", registryRevision: created.snapshot.registryRevision }),
      operation: "update" as const,
      authorityText: agentAuthority("eidolon.fixture.Updated", "Revision 2"),
      expected: { state: "present" as const, authorityDigest: created.receipt.authorityDigestAfter, registryRevision: created.snapshot.registryRevision },
    }
    const updated = await adapter.author({ proposal: update })
    expect(updated.receipt.authorityDigestBefore).toBe(created.receipt.authorityDigestAfter)
    expect(updated.receipt.operation).toBe("update")
    expect(await readFile(path.join(roots.workspaceRoot, "Agents", "Updated.xnl"), "utf8")).toBe(update.authorityText)
    await expect(adapter.author({ proposal: { ...update, authorityText: agentAuthority("eidolon.fixture.Updated", "Stale update") } })).rejects.toThrow()
    await expect(adapter.author({ proposal: { ...update, authorityText: agentAuthority("eidolon.fixture.Updated", "Wrong present digest"),
      expected: { ...update.expected, registryRevision: updated.snapshot.registryRevision },
    } })).rejects.toThrow("prepare")
    expect(await readFile(path.join(roots.workspaceRoot, "Agents", "Updated.xnl"), "utf8")).toBe(update.authorityText)
  })

  it("updates a global authority into workspace while retaining the global before-image", async () => {
    const roots = await fixture()
    const globalRoot = path.join(path.dirname(roots.workspaceRoot), "global-resources")
    await cp(fixtureRoot, globalRoot, { recursive: true })
    const globalText = agentAuthority("eidolon.fixture.GlobalWorker", "Global revision")
    await writeFile(path.join(globalRoot, "Agents", "GlobalWorker.xnl"), globalText)
    const layers = [{ id: "global" as const, rootDir: globalRoot }, ...roots.layers]
    const registry = new EidolonAppResourceRegistryAdapter({ layers })
    const before = await registry.snapshot()
    const update = {
      ...proposal({ resourceId: "eidolon.fixture.GlobalWorker", fileName: "GlobalWorker", registryRevision: before.registryRevision }),
      operation: "update" as const,
      authorityText: agentAuthority("eidolon.fixture.GlobalWorker", "Workspace revision"),
      expected: { state: "present" as const, authorityDigest: before.contentIdentities.get("eidolon.fixture.GlobalWorker")!.authorityDigest, registryRevision: before.registryRevision },
    }
    const adapter = new EidolonAIAgentDefinitionAuthoringAdapter(registry, layers, roots.supportRoot)
    const updated = await adapter.author({ proposal: update })
    expect(updated.receipt.authorityDigestBefore).toBe(update.expected.authorityDigest)
    expect(updated.receipt.effectiveOrigin.layerId).toBe("workspace")
    expect(await readFile(path.join(globalRoot, "Agents", "GlobalWorker.xnl"), "utf8")).toBe(globalText)
    expect(await readFile(path.join(roots.workspaceRoot, "Agents", "GlobalWorker.xnl"), "utf8")).toBe(update.authorityText)
  })

  it("rejects final symlinks and preflight failures before any physical authority changes", async () => {
    const roots = await fixture()
    const before = await roots.registry.snapshot()
    const adapter = new EidolonAIAgentDefinitionAuthoringAdapter(roots.registry, roots.layers, roots.supportRoot)
    const linkPath = path.join(roots.workspaceRoot, "Agents", "Linked.xnl")
    const external = path.join(path.dirname(roots.workspaceRoot), "external.xnl")
    await writeFile(external, "external authority")
    await symlink(external, linkPath)
    await expect(adapter.author({ proposal: proposal({
      resourceId: "eidolon.fixture.Linked", fileName: "Linked", registryRevision: before.registryRevision,
    }) })).rejects.toThrow()
    expect(await readFile(external, "utf8")).toBe("external authority")
    await rm(linkPath)
    const preflight = roots.registry.preflightAuthoringCandidate.bind(roots.registry)
    let observed = false
    roots.registry.preflightAuthoringCandidate = async (candidate, input) => {
      expect(candidate.registry.byId.has(input.resourceId)).toBe(true)
      await expect(readFile(path.join(roots.workspaceRoot, "Agents", "Preflight.xnl"))).rejects.toMatchObject({ code: "ENOENT" })
      observed = true
      throw new Error("TEST_COMPILE_REJECTED")
    }
    await expect(adapter.author({ proposal: proposal({
      resourceId: "eidolon.fixture.Preflight", fileName: "Preflight", registryRevision: before.registryRevision,
    }) })).rejects.toThrow("refresh")
    roots.registry.preflightAuthoringCandidate = preflight
    expect(observed).toBe(true)
    await expect(readFile(path.join(roots.workspaceRoot, "Agents", "Preflight.xnl"))).rejects.toMatchObject({ code: "ENOENT" })
    expect((await roots.registry.snapshot()).registryRevision).toBe(before.registryRevision)
  })

  it("uses registered code Kinds/specs and rejects missing exports and broken recursive imports before publication", async () => {
    const roots = await fixture()
    const manifestPath = path.join(roots.workspaceRoot, "manifest.xnl")
    await writeFile(manifestPath, (await readFile(manifestPath, "utf8")).replace("<Catalog #agents", [
      '<Catalog #pipelines { kind = "AgentContextPipeline" shape = "single-file" root = "vfs://./ContextPipelines/" }>',
      '<Catalog #sources { kind = "AgentMessageSource" shape = "single-file" root = "vfs://./MessageSources/" }>',
      '<Catalog #agents',
    ].join("\n")))
    for (const kind of ["AgentContextPipeline", "AgentMessageSource"] as const) {
      const directory = path.join(roots.workspaceRoot, "KindDefinitions", kind)
      await mkdir(directory, { recursive: true })
      await writeFile(path.join(directory, "manifest.xnl"), depaAIResourceKindContract(kind, 2).kindDefinitionSource)
    }
    await mkdir(path.join(roots.workspaceRoot, "ContextPipelines"))
    await mkdir(path.join(roots.workspaceRoot, "MessageSources"))
    await writeFile(path.join(roots.workspaceRoot, "pipeline.ts"), 'import { value } from "./helper"; export function compose(runtime, input, config) { return value + input }')
    await writeFile(path.join(roots.workspaceRoot, "helper.ts"), 'export const value = "checked:"')
    await writeFile(path.join(roots.workspaceRoot, "broken.ts"), 'import { value } from "./missing-module"; export function compose() { return value }')
    const registry = new EidolonAppResourceRegistryAdapter({ layers: roots.layers })
    const adapter = new EidolonAIAgentDefinitionAuthoringAdapter(registry, roots.layers, roots.supportRoot)
    const nativeText = (kind: string, resourceId: string, module: string, exportName: string) => `<${kind} #${resourceId} envelopeVersion="halfcode.resource-envelope/v1" specVersion=2 { lifecycle="Active" } (
      <CodeBinding { packageName="test-code" module="${module}" exportName="${exportName}" }>
      <Config { value={} }>
    )>`
    for (const [kind, catalogId, directory] of [["AgentContextPipeline", "pipelines", "ContextPipelines"], ["AgentMessageSource", "sources", "MessageSources"]] as const) {
      const resourceId = `eidolon.fixture.${kind}`
      const before = await registry.snapshot()
      const create: ResourceAuthoringProposal = {
        ...proposal({ resourceId, fileName: "Code", registryRevision: before.registryRevision }),
        kind, catalogId, writerSpecVersion: 2, documentUri: `vfs://@/${directory}/Code.xnl`,
        authorityText: nativeText(kind, resourceId, "./pipeline.ts", "compose"),
      }
      const created = await adapter.author({ proposal: create })
      expect(created.receipt.kind).toBe(kind)
      expect(created.receipt.writerSpecVersion).toBe(2)
      for (const authorityText of [nativeText(kind, resourceId, "./pipeline.ts", "missing"), nativeText(kind, resourceId, "./broken.ts", "compose")]) {
        await expect(adapter.author({ proposal: { ...create, operation: "update", authorityText,
          expected: { state: "present", authorityDigest: created.receipt.authorityDigestAfter, registryRevision: created.snapshot.registryRevision },
        } })).rejects.toThrow("refresh")
        expect(await readFile(path.join(roots.workspaceRoot, directory, "Code.xnl"), "utf8")).toBe(create.authorityText)
        expect((await registry.snapshot()).registryRevision).toBe(created.snapshot.registryRevision)
      }
    }
  })

  it("does not compensate matching bytes written by another actor before this transaction wrote anything", async () => {
    const roots = await fixture()
    const before = await roots.registry.snapshot()
    const adapter = new EidolonAIAgentDefinitionAuthoringAdapter(roots.registry, roots.layers, roots.supportRoot)
    const input = proposal({ resourceId: "eidolon.fixture.Foreign", fileName: "Foreign", registryRevision: before.registryRevision })
    const target = path.join(roots.workspaceRoot, "Agents", "Foreign.xnl")
    roots.registry.preflightAuthoringCandidate = async () => {
      await writeFile(target, input.authorityText)
      throw new Error("OTHER_WRITER_DURING_PREFLIGHT")
    }
    await expect(adapter.author({ proposal: input })).rejects.toThrow("refresh")
    expect(await readFile(target, "utf8")).toBe(input.authorityText)
  })

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

  it("updates a builtin effective authority into workspace with the original node identity", async () => {
    const original = agentAuthority("eidolon.fixture.Inherited", "Builtin V1")
    const roots = await effectiveFixture({ builtinAgent: original })
    const before = await roots.registry.snapshot()
    const logicalPath = "/.eidolon/resources/Agents/Inherited.xnl"
    expect((await roots.materializer.read().readPort.stat(logicalPath))?.nodeId).toBe("builtin-inherited-agent")
    await expect(readFile(path.join(roots.workspaceRoot, "Agents", "Inherited.xnl"))).rejects.toMatchObject({ code: "ENOENT" })
    const adapter = new EidolonAIAgentDefinitionAuthoringAdapter(roots.registry, [], roots.supportRoot, roots.authoring)
    const created = await adapter.author({ proposal: {
      ...proposal({ resourceId: "eidolon.fixture.Inherited", fileName: "Inherited", registryRevision: before.registryRevision }),
      operation: "update", authorityText: agentAuthority("eidolon.fixture.Inherited", "Workspace V2"),
      expected: { state: "present", authorityDigest: before.contentIdentities.get("eidolon.fixture.Inherited")!.authorityDigest, registryRevision: before.registryRevision },
    } })
    expect(created.receipt.authorityDigestBefore).toBe(before.contentIdentities.get("eidolon.fixture.Inherited")!.authorityDigest)
    const fresh = await openAuthoringTestRuntime(roots.processInput)
    authorities.push(fresh.authority)
    expect((await fresh.materializer.read().readPort.stat(logicalPath))?.nodeId).toBe("builtin-inherited-agent")
    expect((await fresh.registry.snapshot()).contentIdentities.get("eidolon.fixture.Inherited")!.authorityDigest).toBe(created.receipt.authorityDigestAfter)
    expect(await readFile(path.join(roots.workspaceRoot, "Agents", "Inherited.xnl"), "utf8")).toBe(agentAuthority("eidolon.fixture.Inherited", "Workspace V2"))
  })

  it("restores owner projection after a durable head commit throws before workspace materialization", async () => {
    let interrupted = false
    const roots = await effectiveFixture({ afterCommit(record) {
      if (record.association && !interrupted) { interrupted = true; throw new Error("INTERRUPT_BEFORE_PROJECTION") }
    } })
    const before = await roots.registry.snapshot()
    const adapter = new EidolonAIAgentDefinitionAuthoringAdapter(roots.registry, [], roots.supportRoot, roots.authoring)
    const input = proposal({ resourceId: "eidolon.fixture.Projection", fileName: "Projection", registryRevision: before.registryRevision })
    const recovered = await adapter.author({ proposal: input })
    expect(interrupted).toBe(true)
    expect(recovered.snapshot.registryRevision).toBe(recovered.receipt.registryRevisionAfter)
    expect(await readFile(path.join(roots.workspaceRoot, "Agents", "Projection.xnl"), "utf8")).toBe(input.authorityText)
    expect(await adapter.loadReceipt(recovered.receipt.planDigest)).toEqual(recovered.receipt)
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

  it("recovers the same durable receipt after an in-process observer interrupts after VFS CAS", async () => {
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
    const completed = await interrupted.author({ proposal: proposal({
      resourceId: "eidolon.fixture.RecoveredEffectiveWorker",
      fileName: "RecoveredEffectiveWorker",
      registryRevision: before.registryRevision,
    }) })
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
    expect(receipt).toEqual(completed.receipt)
    expect((await recoveredRegistry.snapshot()).registry.byId.has(
      "eidolon.fixture.RecoveredEffectiveWorker",
    )).toBe(true)
  })

  it("recovers the original V2 receipt across SIGKILL after V3 has become live, and replays native V2 pins", async () => {
    const roots = await effectiveFixture()
    const adapter = new EidolonAIAgentDefinitionAuthoringAdapter(roots.registry, [], roots.supportRoot, roots.authoring)
    const created = await adapter.author({ proposal: proposal({
      resourceId: "eidolon.fixture.CrashWorker", fileName: "CrashWorker", registryRevision: (await roots.registry.snapshot()).registryRevision,
    }) })
    const second: ResourceAuthoringProposal = {
      ...proposal({ resourceId: "eidolon.fixture.CrashWorker", fileName: "CrashWorker", registryRevision: created.snapshot.registryRevision }),
      operation: "update", authorityText: agentAuthority("eidolon.fixture.CrashWorker", "V2"),
      expected: { state: "present", authorityDigest: created.receipt.authorityDigestAfter, registryRevision: created.snapshot.registryRevision },
    }
    const runChild = async (input: AuthoringProcessInput) => {
      const inputPath = path.join(path.dirname(roots.supportRoot), `process-${crypto.randomUUID()}.json`)
      await writeFile(inputPath, JSON.stringify(input))
      const child = Bun.spawn([process.execPath, "--tsconfig-override", testSourceTsconfig(),
        path.join(import.meta.dir, "fixtures/agent-authoring-process.ts"), inputPath], { stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      return { stdout, stderr, exitCode }
    }
    const killed = await runChild({ ...roots.processInput, proposal: second, interruptAfterAdmission: true })
    expect(killed.exitCode).not.toBe(0)
    const pendingFiles = await readdir(path.join(roots.supportRoot, "pending-receipts"))
    expect(pendingFiles).toHaveLength(1)
    const pending = JSON.parse(await readFile(path.join(roots.supportRoot, "pending-receipts", pendingFiles[0]!), "utf8")) as ResourceAuthoringReceipt
    expect(pending.authorityDigestBefore).toBe(created.receipt.authorityDigestAfter)
    await roots.materializer.restore()
    const v2 = await roots.registry.refresh()
    const third = await adapter.author({ proposal: {
      ...second, authorityText: agentAuthority("eidolon.fixture.CrashWorker", "V3"),
      expected: { state: "present", authorityDigest: pending.authorityDigestAfter, registryRevision: v2.registryRevision },
    } })
    const journalPath = path.join(roots.supportRoot, "journals", `${pending.planDigest.slice(7)}.json`)
    const originalJournal = await readFile(journalPath, "utf8")
    const corruptBefore = JSON.parse(originalJournal)
    corruptBefore.workspaceBefore.text = "corrupted before image"
    await writeFile(journalPath, JSON.stringify(corruptBefore))
    await expect(adapter.loadReceipt(pending.planDigest)).rejects.toThrow("JOURNAL_INVALID")
    await writeFile(journalPath, originalJournal)
    const evidencePath = path.join(roots.supportRoot, "candidate-evidence", `${pending.planDigest.slice(7)}.json`)
    const originalEvidence = await readFile(evidencePath, "utf8")
    await writeFile(evidencePath, JSON.stringify({ ...JSON.parse(originalEvidence), candidateTreeDigest: `sha256:${"0".repeat(64)}` }))
    await expect(adapter.loadReceipt(pending.planDigest)).rejects.toThrow("PUBLICATION_PROOF_MISMATCH")
    await writeFile(evidencePath, originalEvidence)
    const recovered = await runChild({ ...roots.processInput, planDigest: pending.planDigest })
    expect(recovered.exitCode, recovered.stderr).toBe(0)
    expect(JSON.parse(recovered.stdout)).toEqual({ receipt: pending, currentRevision: third.snapshot.registryRevision })
    const replayed = await runChild({ ...roots.processInput, proposal: second })
    expect(replayed.exitCode, replayed.stderr).toBe(0)
    expect(JSON.parse(replayed.stdout)).toEqual({ receipt: pending, currentRevision: third.snapshot.registryRevision })
    expect(await readFile(path.join(roots.workspaceRoot, "Agents", "CrashWorker.xnl"), "utf8")).toBe(agentAuthority("eidolon.fixture.CrashWorker", "V3"))
    expect((await roots.registry.snapshot()).registryRevision).toBe(third.snapshot.registryRevision)
  }, 30000)

  it("resumes a prepared v2 intent and keeps legacy v1 pending material uncertain without owner evidence", async () => {
    const roots = await effectiveFixture()
    const before = await roots.registry.snapshot()
    const input = proposal({ resourceId: "eidolon.fixture.Prepared", fileName: "Prepared", registryRevision: before.registryRevision })
    let planDigest = ""
    const interrupted = new EidolonAIAgentDefinitionAuthoringAdapter(roots.registry, [], roots.supportRoot, roots.authoring, {
      afterPrepared(input) { planDigest = input.planDigest; throw new Error("INTERRUPT_PREPARED") },
    })
    await expect(interrupted.author({ proposal: input })).rejects.toThrow("prepare")
    const journalPath = path.join(roots.supportRoot, "journals", `${planDigest.slice(7)}.json`)
    const journal = JSON.parse(await readFile(journalPath, "utf8"))
    expect(journal.schemaVersion).toBe("eidolon.resource-authoring-journal/v2")
    expect(journal.workspaceBefore).toEqual({ state: "absent" })
    await expect(readFile(path.join(roots.workspaceRoot, "Agents", "Prepared.xnl"))).rejects.toMatchObject({ code: "ENOENT" })
    const adapter = new EidolonAIAgentDefinitionAuthoringAdapter(roots.registry, [], roots.supportRoot, roots.authoring)
    const legacyJournal = {
      schemaVersion: "eidolon.resource-authoring-journal/v1", transactionId: journal.transactionId,
      planDigest, documentUri: journal.documentUri, authorityDigest: journal.authorityDigest,
      authorityText: journal.authorityText, registryRevisionBefore: journal.registryRevisionBefore,
    }
    await writeFile(journalPath, JSON.stringify(legacyJournal))
    await expect(adapter.author({ proposal: input })).rejects.toThrow("prepare")
    expect(JSON.parse(await readFile(journalPath, "utf8"))).toEqual(legacyJournal)
    await writeFile(journalPath, JSON.stringify(journal))
    const committed = await adapter.author({ proposal: input })
    const receiptPath = path.join(roots.supportRoot, "receipts", `${planDigest.slice(7)}.json`)
    await mkdir(path.join(roots.supportRoot, "pending-receipts"), { recursive: true })
    await writeFile(path.join(roots.supportRoot, "pending-receipts", `${planDigest.slice(7)}.json`), JSON.stringify(committed.receipt))
    await rm(receiptPath)
    const noProof = new EidolonAIAgentDefinitionAuthoringAdapter(roots.registry, [], roots.supportRoot, { ...roots.authoring, lookupPublication: async () => undefined })
    expect(await noProof.loadReceipt(planDigest)).toBeUndefined()
    expect((await roots.registry.snapshot()).registryRevision).toBe(committed.snapshot.registryRevision)
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
