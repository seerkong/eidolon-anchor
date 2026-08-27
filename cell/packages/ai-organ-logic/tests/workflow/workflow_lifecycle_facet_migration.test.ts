import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  createActor,
  createVM,
  dispatchActorRuntimeFacetEvent,
  hydrateActor,
  serializeActor,
  serializeVM,
} from "@cell/ai-core-logic"
import {
  LocalFileRuntimeSnapshotRepository,
  type RuntimeSnapshotMigrationFaultPoint,
} from "@cell/ai-support"
import {
  createWorkflowLifecycleFacetEnvelope,
  createWorkflowLifecycleFacetRegistry,
  createWorkflowLifecycleSnapshotImporter,
  migrateWorkflowLifecycleFacetV1,
  normalizeWorkflowLifecycleFacetValue,
  readWorkflowLifecycleFacet,
  WORKFLOW_LIFECYCLE_FACET_ID,
} from "../../src/workflow/runtime/WorkflowLifecycleFacet"
import { AI_WORKFLOW_PROVIDER_TOOL_SURFACE } from "../../src/workflow/tools/WorkflowLoadStageContext/StageToolPolicy"
import {
  WORKFLOW_SURFACE_STRATEGY_REGISTRY,
} from "../../src/workflow/runtime/WorkflowProviderSurfaceStrategy"

function tempRoot(): string {
  return path.join(os.tmpdir(), `eidolon-workflow-facet-${Date.now()}-${Math.random().toString(16).slice(2)}`, "runtime_state")
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

const managedSkill = [
  "---",
  "name: sys-eidolon-anchor-devops",
  "revision: test-v1",
  "---",
  "# Managed workflow skill",
].join("\n")

function workflowFacet() {
  return createWorkflowLifecycleFacetEnvelope({
    systemPrompts: [managedSkill],
    toolNames: AI_WORKFLOW_PROVIDER_TOOL_SURFACE,
    strategyRevision: "hybrid/v1",
    progress: {
      stageId: "coding",
      stageStartedAt: 1,
      deadlineAt: 100,
      turnsSinceProgress: 1,
      maxNoProgressTurns: 4,
      proofRepairAttempts: 0,
      maxProofRepairAttempts: 3,
      lastProgressAt: 2,
    },
  })
}

async function writeLegacyV3Fixture(rootDir: string): Promise<{
  legacyStatePath: string
  repository: LocalFileRuntimeSnapshotRepository
}> {
  const initial = new LocalFileRuntimeSnapshotRepository(rootDir)
  const main = createActor({ key: "main" })
  const worker = createActor({
    key: "workflow-worker",
    type: "delegate" as any,
    parentKey: "main",
    agentName: "workflow",
    providerContextClass: "workflow_lifecycle",
    systemPrompts: [managedSkill],
    toolPolicy: {
      allowedToolsMode: "exact",
      allowedTools: [...AI_WORKFLOW_PROVIDER_TOOL_SURFACE],
      providerToolSurface: { mode: "exact", toolNames: [...AI_WORKFLOW_PROVIDER_TOOL_SURFACE] },
      enabledToolKeys: [],
      disabledToolKeys: [],
      computedDisabledTools: [],
    },
  })
  const vm = createVM({ controlActorKey: main.key, actors: { main, [worker.key]: worker } })
  await initial.writeSnapshot({
    vm: serializeVM(vm),
    actors: { main: serializeActor(main), [worker.key]: serializeActor(worker) },
    fibers: {},
  })

  const manifestPath = path.join(rootDir, "manifest.json")
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  manifest.version = 3
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  const vmPath = path.join(rootDir, manifest.vmFile)
  const vmJson = JSON.parse(fs.readFileSync(vmPath, "utf8"))
  vmJson.version = 3
  fs.writeFileSync(vmPath, `${JSON.stringify(vmJson, null, 2)}\n`)
  for (const relative of manifest.indexFiles as string[]) {
    const absolute = path.join(rootDir, relative)
    const value = JSON.parse(fs.readFileSync(absolute, "utf8"))
    value.schemaVersion = 3
    fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`)
  }
  const actorRelative = manifest.actorFiles[worker.key]
  const actorDir = path.dirname(path.join(rootDir, actorRelative))
  for (const name of ["actor.json", "mailboxes.json"] as const) {
    const absolute = path.join(actorDir, name)
    const value = JSON.parse(fs.readFileSync(absolute, "utf8"))
    value.version = 3
    fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`)
  }
  const mainRelative = manifest.actorFiles.main
  const mainDir = path.dirname(path.join(rootDir, mainRelative))
  for (const name of ["actor.json", "state.json", "mailboxes.json"] as const) {
    const absolute = path.join(mainDir, name)
    const value = JSON.parse(fs.readFileSync(absolute, "utf8"))
    value.version = 3
    fs.writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`)
  }
  const legacyStatePath = path.join(actorDir, "state.json")
  const state = JSON.parse(fs.readFileSync(legacyStatePath, "utf8"))
  state.version = 3
  delete state.runtimeFacets
  state.workflowProgress = {
    stageId: "coding",
    stageStartedAt: 1,
    deadlineAt: 100,
    turnsSinceProgress: 1,
    maxNoProgressTurns: 4,
    proofRepairAttempts: 1,
    maxProofRepairAttempts: 3,
    lastProgressAt: 2,
    lastOutcome: "candidate_diagnostic",
    lastDiagnostic: "legacy raw diagnostic",
  }
  fs.writeFileSync(legacyStatePath, `${JSON.stringify(state, null, 2)}\n`)

  return {
    legacyStatePath,
    repository: new LocalFileRuntimeSnapshotRepository(rootDir, {
      importers: [createWorkflowLifecycleSnapshotImporter()],
    }),
  }
}

describe("Workflow lifecycle Actor facet", () => {
  it("round-trips a closed workflow payload through the neutral envelope", () => {
    const actor = createActor({ key: "workflow", runtimeFacets: [workflowFacet()] })
    const snapshot = serializeActor(actor)
    expect("workflowProgress" in snapshot).toBe(false)
    const restored = hydrateActor(snapshot, { actorFacetRuntime: createWorkflowLifecycleFacetRegistry() })
    expect(readWorkflowLifecycleFacet(restored)).toMatchObject({
      stageId: "coding",
      systemSkill: { skillName: "sys-eidolon-anchor-devops" },
      toolProfile: { profileId: "eidolon.workflow-lifecycle-tools/v1" },
      providerSurfaceStrategy: { strategyRevision: "hybrid/v1" },
    })
    expect(snapshot.runtimeFacets?.[WORKFLOW_LIFECYCLE_FACET_ID]?.schemaVersion).toBe("2")
    expect(Object.keys(restored.runtimeFacets)).toEqual([WORKFLOW_LIFECYCLE_FACET_ID])
  })

  it("imports one exact facet-v1 envelope to facet v2 and freezes stable-superset", () => {
    const v2 = workflowFacet()
    const { providerSurfaceStrategy: _removed, ...v1Value } = v2.value as any
    const actor = createActor({
      key: "legacy-facet-v1",
      systemPrompts: [managedSkill],
      runtimeFacets: [{ ...v2, schemaVersion: "1", value: v1Value }],
      toolPolicy: {
        allowedToolsMode: "exact",
        allowedTools: [...AI_WORKFLOW_PROVIDER_TOOL_SURFACE],
        providerToolSurface: { mode: "exact", toolNames: [...AI_WORKFLOW_PROVIDER_TOOL_SURFACE] },
      },
    })
    expect(migrateWorkflowLifecycleFacetV1(actor)).toBe(true)
    expect(actor.runtimeFacets[WORKFLOW_LIFECYCLE_FACET_ID]).toMatchObject({ schemaVersion: "2", revision: 1 })
    expect(readWorkflowLifecycleFacet(actor)?.providerSurfaceStrategy).toEqual({
      schemaVersion: "eidolon.workflow-provider-surface-strategy-ref/v1",
      strategyRevision: "stable-superset/v1",
      strategyDigest: WORKFLOW_SURFACE_STRATEGY_REGISTRY.resolve("stable-superset/v1").strategyDigest,
    })
    expect(migrateWorkflowLifecycleFacetV1(actor)).toBe(false)
  })

  it("fails closed on missing, conflicting, or newer-only strategy material", () => {
    const value = workflowFacet().value as any
    const { providerSurfaceStrategy: _removed, ...missing } = value
    expect(() => normalizeWorkflowLifecycleFacetValue(missing)).toThrow(/providerSurfaceStrategy/)
    expect(() => normalizeWorkflowLifecycleFacetValue({
      ...value,
      providerSurfaceStrategy: { ...value.providerSurfaceStrategy, strategyDigest: `sha256:${"9".repeat(64)}` },
    })).toThrow(/strategy/i)
    expect(() => normalizeWorkflowLifecycleFacetValue({
      ...value,
      providerSurfaceStrategy: {
        schemaVersion: "eidolon.workflow-provider-surface-strategy-ref/v1",
        strategyRevision: "hybrid/v2",
        strategyDigest: `sha256:${"8".repeat(64)}`,
      },
    })).toThrow(/strategy/i)
  })

  it("rejects raw diagnostics and accessor payloads at the domain codec boundary", () => {
    const value = workflowFacet().value as Record<string, unknown>
    expect(() => normalizeWorkflowLifecycleFacetValue({ ...value, lastDiagnostic: "raw output" }))
      .toThrow(/lastDiagnostic is not allowed/)
    const accessor = { ...value }
    Object.defineProperty(accessor, "stageId", { enumerable: true, get: () => "coding" })
    expect(() => normalizeWorkflowLifecycleFacetValue(accessor)).toThrow(/enumerable data field/)
  })

  it("keeps lifecycle hooks in the domain registry and mutates only through envelope CAS", () => {
    const actor = createActor({ key: "workflow-hook", runtimeFacets: [workflowFacet()] })
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      runtimeContext: { actorFacetRuntime: createWorkflowLifecycleFacetRegistry() },
    })
    const next = dispatchActorRuntimeFacetEvent(
      vm,
      { actorKey: actor.key, facetId: WORKFLOW_LIFECYCLE_FACET_ID },
      { kind: "beforeTurn", operationId: "turn-1", occurredAt: 3 },
      {},
    )
    expect(next?.revision).toBe(1)
    expect(readWorkflowLifecycleFacet(actor)?.turnsSinceProgress).toBe(2)
    expect(() => dispatchActorRuntimeFacetEvent(
      vm,
      { actorKey: actor.key, facetId: WORKFLOW_LIFECYCLE_FACET_ID },
      { kind: "aroundProvider", operationId: "provider-1", occurredAt: 100, providerAttempt: 1 },
      {},
    )).toThrow(/workflow_stage_deadline/)
  })

  it("imports one exact v3 witness through an immutable head-last v4 generation", async () => {
    const rootDir = tempRoot()
    const { legacyStatePath, repository } = await writeLegacyV3Fixture(rootDir)
    const legacyBytes = fs.readFileSync(legacyStatePath, "utf8")

    const loaded = await repository.loadSnapshot()
    expect(loaded?.manifest.version).toBe(4)
    expect(loaded?.manifest.generation?.id).toMatch(/^v4-/)
    expect(loaded?.actors["workflow-worker"]?.runtimeFacets?.[WORKFLOW_LIFECYCLE_FACET_ID]).toBeTruthy()
    expect("workflowProgress" in (loaded?.actors["workflow-worker"] ?? {})).toBe(false)
    expect(fs.readFileSync(legacyStatePath, "utf8")).toBe(legacyBytes)
    const facet = loaded?.actors["workflow-worker"]?.runtimeFacets?.[WORKFLOW_LIFECYCLE_FACET_ID]
    const materials = loaded?.actors["workflow-worker"]?.durableMaterials ?? {}
    expect(Object.keys(materials)).toEqual([(facet?.value as any).resourcePackage.materialDigest])
    expect(JSON.stringify(facet)).not.toContain("# Managed system Skill")
    expect((facet?.value as any).lastDiagnosticEvidence).toMatchObject({ kind: "legacy-digest" })
    expect(JSON.stringify(facet)).not.toContain("legacy raw diagnostic")

    const retry = await new LocalFileRuntimeSnapshotRepository(rootDir, {
      importers: [createWorkflowLifecycleSnapshotImporter()],
    }).loadSnapshot()
    expect(retry?.manifest.generation?.id).toBe(loaded?.manifest.generation?.id)
    expect(fs.readdirSync(path.join(rootDir, "generations"))).toHaveLength(1)

    const checkpoint = await repository.writeSnapshot({
      vm: loaded!.vm,
      actors: loaded!.actors,
      questionnaires: loaded!.questionnaires,
      fibers: loaded!.fibers,
      indexes: loaded!.indexes,
    })
    expect(checkpoint.legacyRootReadOnly).toBe(true)
    expect(checkpoint.actorFiles["workflow-worker"]).toMatch(/^checkpoints\//)
    expect(fs.readFileSync(legacyStatePath, "utf8")).toBe(legacyBytes)
    expect((await repository.loadSnapshot())?.actors["workflow-worker"]?.runtimeFacets?.[WORKFLOW_LIFECYCLE_FACET_ID]).toBeTruthy()
  })

  it("fails closed when a v3 workflow witness has no unique managed Skill", async () => {
    const rootDir = tempRoot()
    const { repository } = await writeLegacyV3Fixture(rootDir)
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8"))
    const actorPath = path.join(rootDir, manifest.actorFiles["workflow-worker"])
    const actor = JSON.parse(fs.readFileSync(actorPath, "utf8"))
    actor.systemPrompts = ["ordinary prompt"]
    fs.writeFileSync(actorPath, `${JSON.stringify(actor, null, 2)}\n`)
    await expect(repository.loadSnapshot()).rejects.toThrow(/WORKFLOW_LIFECYCLE_MIGRATION_WITNESS/)
    expect(JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8")).version).toBe(3)
  })

  it("fresh retry converges every interrupted migration phase to one admitted generation", async () => {
    const points: RuntimeSnapshotMigrationFaultPoint[] = [
      "after-staging-create",
      "after-staging-write",
      "after-staging-fsync",
      "after-generation-publish",
      "before-head-swap",
      "after-head-swap",
    ]
    for (const point of points) {
      const rootDir = tempRoot()
      await writeLegacyV3Fixture(rootDir)
      let injected = false
      const interrupted = new LocalFileRuntimeSnapshotRepository(rootDir, {
        importers: [createWorkflowLifecycleSnapshotImporter()],
        migrationFaultInjector(current) {
          if (!injected && current === point) {
            injected = true
            throw new Error(`injected:${point}`)
          }
        },
      })
      await expect(interrupted.loadSnapshot()).rejects.toThrow(`injected:${point}`)
      const recovered = await new LocalFileRuntimeSnapshotRepository(rootDir, {
        importers: [createWorkflowLifecycleSnapshotImporter()],
      }).loadSnapshot()
      expect(recovered?.manifest.version).toBe(4)
      expect(Object.keys(recovered?.actors["workflow-worker"]?.runtimeFacets ?? {})).toEqual([
        WORKFLOW_LIFECYCLE_FACET_ID,
      ])
      expect(fs.readdirSync(path.join(rootDir, "generations")).filter((name) => !name.endsWith(".staging"))).toHaveLength(1)
      expect(fs.readdirSync(path.join(rootDir, "generations")).some((name) => name.endsWith(".staging"))).toBe(false)
    }
  })

  it("rejects admitted receipt, tree and head tamper without falling back to legacy authority", async () => {
    for (const tamper of ["receipt", "tree", "head"] as const) {
      const rootDir = tempRoot()
      const { repository } = await writeLegacyV3Fixture(rootDir)
      const admitted = await repository.loadSnapshot()
      const generation = admitted!.manifest.generation!
      if (tamper === "receipt") {
        fs.appendFileSync(path.join(rootDir, generation.receiptFile), " ")
      } else if (tamper === "tree") {
        const workerFile = admitted!.manifest.actorFiles["workflow-worker"]!
        fs.appendFileSync(path.join(rootDir, path.dirname(workerFile), "state.json"), " ")
      } else {
        const head = JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8"))
        head.generation.receiptDigest = "sha256:tampered"
        fs.writeFileSync(path.join(rootDir, "manifest.json"), `${JSON.stringify(head, null, 2)}\n`)
      }
      await expect(new LocalFileRuntimeSnapshotRepository(rootDir, {
        importers: [createWorkflowLifecycleSnapshotImporter()],
      }).loadSnapshot()).rejects.toThrow(/digest mismatch|does not bind/)
      expect(JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8")).version).toBe(4)
    }
  })

  it("rejects a legacy actor path that traverses a symbolic link", async () => {
    const rootDir = tempRoot()
    const { repository } = await writeLegacyV3Fixture(rootDir)
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8"))
    const actorFile = path.join(rootDir, manifest.actorFiles["workflow-worker"])
    const realFile = `${actorFile}.real`
    fs.renameSync(actorFile, realFile)
    fs.symlinkSync(realFile, actorFile)
    await expect(repository.loadSnapshot()).rejects.toThrow(/no-symlink|traverses a symlink/)
    expect(JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8")).version).toBe(3)
  })

  it("rejects admitted head path escape and a symlinked generation authority root", async () => {
    const escapedRoot = tempRoot()
    const { repository: escapedRepository } = await writeLegacyV3Fixture(escapedRoot)
    await escapedRepository.loadSnapshot()
    const escapedHeadPath = path.join(escapedRoot, "manifest.json")
    const escapedHead = JSON.parse(fs.readFileSync(escapedHeadPath, "utf8"))
    escapedHead.actorFiles["workflow-worker"] = "../../outside/actor.json"
    fs.writeFileSync(escapedHeadPath, `${JSON.stringify(escapedHead, null, 2)}\n`)
    await expect(new LocalFileRuntimeSnapshotRepository(escapedRoot, {
      importers: [createWorkflowLifecycleSnapshotImporter()],
    }).loadSnapshot()).rejects.toThrow(/head does not bind/)

    const linkedRoot = tempRoot()
    const { repository: linkedRepository } = await writeLegacyV3Fixture(linkedRoot)
    const admitted = await linkedRepository.loadSnapshot()
    const generationDir = path.join(linkedRoot, "generations", admitted!.manifest.generation!.id)
    const realGenerationDir = `${generationDir}.real`
    fs.renameSync(generationDir, realGenerationDir)
    fs.symlinkSync(realGenerationDir, generationDir)
    await expect(new LocalFileRuntimeSnapshotRepository(linkedRoot, {
      importers: [createWorkflowLifecycleSnapshotImporter()],
    }).loadSnapshot()).rejects.toThrow(/authority root.*no-symlink/)
  })

  it("rejects a self-consistent generation authority outside the canonical direct child", async () => {
    const rootDir = tempRoot()
    const { repository } = await writeLegacyV3Fixture(rootDir)
    const admitted = await repository.loadSnapshot()
    const headPath = path.join(rootDir, "manifest.json")
    const head = JSON.parse(fs.readFileSync(headPath, "utf8"))
    const oldId = admitted!.manifest.generation!.id
    const oldPrefix = `generations/${oldId}`
    const escapedId = "../generations-escaped/forged"
    const escapedPrefix = path.posix.join("generations", escapedId)
    const oldDir = path.join(rootDir, "generations", oldId)
    const escapedDir = path.join(rootDir, "generations-escaped", "forged")
    fs.mkdirSync(path.dirname(escapedDir), { recursive: true })
    fs.renameSync(oldDir, escapedDir)

    const generationManifestPath = path.join(escapedDir, "generation-manifest.json")
    const generationManifest = JSON.parse(fs.readFileSync(generationManifestPath, "utf8"))
    const replacePrefix = (value: string) => value.replace(oldPrefix, escapedPrefix)
    generationManifest.vmFile = replacePrefix(generationManifest.vmFile)
    generationManifest.questionnairesFile = replacePrefix(generationManifest.questionnairesFile)
    generationManifest.indexFiles = generationManifest.indexFiles.map(replacePrefix)
    generationManifest.actorFiles = Object.fromEntries(Object.entries(generationManifest.actorFiles)
      .map(([key, value]) => [key, replacePrefix(String(value))]))
    generationManifest.fiberFiles = Object.fromEntries(Object.entries(generationManifest.fiberFiles ?? {})
      .map(([key, value]) => [key, replacePrefix(String(value))]))

    const referenced = new Set<string>([
      generationManifest.vmFile,
      generationManifest.questionnairesFile,
      ...generationManifest.indexFiles,
      ...Object.values(generationManifest.fiberFiles ?? {}) as string[],
    ])
    for (const actorFile of Object.values(generationManifest.actorFiles) as string[]) {
      referenced.add(actorFile)
      referenced.add(`${path.posix.dirname(actorFile)}/state.json`)
      referenced.add(`${path.posix.dirname(actorFile)}/mailboxes.json`)
    }
    const targetTreeDigest = sha256([...referenced].sort().map((relative) => {
      const absolute = path.resolve(rootDir, relative)
      return `${relative}\0${sha256(fs.readFileSync(absolute))}`
    }).join("\n"))
    const generationManifestBytes = stableJson(generationManifest)
    const targetManifestDigest = sha256(generationManifestBytes)
    fs.writeFileSync(generationManifestPath, generationManifestBytes)

    const receiptPath = path.join(escapedDir, "migration-attempt.json")
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"))
    receipt.target.generationId = escapedId
    receipt.target.manifestDigest = targetManifestDigest
    receipt.target.treeDigest = targetTreeDigest
    const receiptBytes = stableJson(receipt)
    fs.writeFileSync(receiptPath, receiptBytes)

    const { generation: _oldGeneration, legacyRootReadOnly: _legacyRootReadOnly, ...headAuthority } = head
    Object.assign(headAuthority, generationManifest)
    const escapedHead = {
      ...generationManifest,
      legacyRootReadOnly: true,
      generation: {
        id: escapedId,
        manifestFile: `${escapedPrefix}/generation-manifest.json`,
        manifestDigest: targetManifestDigest,
        treeDigest: targetTreeDigest,
        receiptFile: `${escapedPrefix}/migration-attempt.json`,
        receiptDigest: sha256(receiptBytes),
      },
    }
    fs.writeFileSync(headPath, stableJson(escapedHead))

    await expect(new LocalFileRuntimeSnapshotRepository(rootDir, {
      importers: [createWorkflowLifecycleSnapshotImporter()],
    }).loadSnapshot()).rejects.toThrow(/canonical single-segment|direct child/)
  })
})
