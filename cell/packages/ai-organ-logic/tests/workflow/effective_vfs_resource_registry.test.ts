import { afterEach, describe, expect, it } from "bun:test"
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { EffectiveEidolonVfsMaterializer, createMutationEidolonOverlay } from "@cell/symbiont-logic/resource/EffectiveEidolonVfsMaterializer"
import { loadBuiltinEidolonVfs, prepareEffectiveEidolonVfs } from "@cell/mod-ai-coding/builtin-vfs"
import {
  EidolonAppResourceRegistryAdapter,
  createFrozenEffectiveEidolonVfsReadPort,
} from "../../src/resources/EidolonAppResourceRegistryAdapter"
import {
  bindWorkflowComponentToRuntime,
  createWorkflowComponentForRuntimeBinding,
} from "../../src/workflow/component/WorkflowComponent"
import {
  buildWorkflowCreateResourcePackageSessionToolDef,
  buildWorkflowOpenAuthoringSessionToolDef,
  buildWorkflowValidateAuthoringSessionToolDef,
} from "../../src/workflow/tools/WorkflowAuthoringTools"
import { VirtualFileSystem } from "xnl-vfs"
import { depaAIResourceKindContract } from "ai-workflow-contract"

const resourcePackageFixtureRoot = path.join(import.meta.dir, "fixtures", "resource-native-authoring-package")
const temporaryRoots: string[] = []

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  return { promise: new Promise<void>((done) => { resolve = done }), resolve }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function kindDefinition(): string {
  return depaAIResourceKindContract("Prompt").kindDefinitionSource
}

function effectiveVfs(description = "first", duplicate = false) {
  const vfs = new VirtualFileSystem()
  vfs.mkdir("vfs:///.eidolon/resources/KindDefinitions/Prompt", { recursive: true })
  vfs.mkdir("vfs:///.eidolon/resources/Prompts", { recursive: true })
  vfs.writeFile("vfs:///.eidolon/resources/manifest.xnl", `<ResourcePackage #eidolon.fixture.effective.package envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle = "Active" packageVersion = "1.0.0" } (
  <Catalogs [
    <Catalog #kind_definitions { kind = "KindDefinition" shape = "directory" root = "vfs://./KindDefinitions/" entry = "manifest.xnl" }>
    <Catalog #prompts { kind = "Prompt" shape = "single-file" root = "vfs://./Prompts/" }>
  ]>
)>`, { fileType: "xnl", metadataId: "manifest" })
  vfs.writeFile("vfs:///.eidolon/resources/KindDefinitions/Prompt/manifest.xnl", kindDefinition(), {
    fileType: "xnl",
    metadataId: "kind-prompt",
  })
  vfs.writeFile("vfs:///.eidolon/resources/Prompts/Support.xnl", `<Prompt #eidolon.fixture.SupportPrompt envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle = "Active" description = "${description}" template = "${description}" }>`, {
    fileType: "xnl",
    metadataId: "prompt-support",
  })
  vfs.writeFile("vfs:///.eidolon/resources/Prompts/helper.txt", `helper:${description}`, {
    fileType: "text",
    metadataId: "prompt-helper",
  })
  if (duplicate) {
    vfs.writeFile("vfs:///.eidolon/resources/Prompts/Duplicate.xnl", `<Prompt #eidolon.fixture.SupportPrompt envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle = "Active" template = "duplicate" }>`, {
      fileType: "xnl",
      metadataId: "prompt-duplicate",
    })
  }
  return new EffectiveEidolonVfsMaterializer({ builtinSnapshot: vfs.getSnapshot() }).read()
}

async function readTextResourcePackageFiles(root: string): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = []
  const visit = async (directory: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name)
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(absolute, relative)
      } else if (entry.isFile() && entry.name !== "baseline.bin") {
        files.push({ path: relative, content: await readFile(absolute, "utf8") })
      }
    }
  }
  await visit(root)
  return files
}

describe("Effective VFS Halfcode registry projection", () => {
  it("admits standard KindDefinitions from the immutable contracts package without author copies and freezes that authority", async () => {
    const builtin = await loadBuiltinEidolonVfs()
    const authoredCustom = await new EidolonAppResourceRegistryAdapter({
      effectiveVfs: new EffectiveEidolonVfsMaterializer({ builtinSnapshot: builtin.vfsSnapshot }).read().readPort,
    }).snapshot()
    // Custom kinds remain self-contained author material; imports only supply
    // installed public contracts.
    expect(authoredCustom.registry.kindDefinitions.has("HolonTaskRuntimeDefinition")).toBe(true)
    const materializer = new EffectiveEidolonVfsMaterializer({ builtinSnapshot: builtin.vfsSnapshot })
    const result = await materializer.materialize({
      expectedCurrentRevision: materializer.read().snapshot.revision,
      overlays: [createMutationEidolonOverlay({
        id: "remove-legacy-standard-definitions", kind: "workspace", order: 0,
        mutations: [
          { type: "FOLDER_DELETE", path: "vfs:///.eidolon/resources/KindDefinitions" },
          { type: "FOLDER_CREATE", path: "vfs:///.eidolon/resources/KindDefinitions" },
        ],
      })],
    })
    expect(result.status).toBe("admitted")
    if (result.status !== "admitted") return
    const adapter = new EidolonAppResourceRegistryAdapter({ effectiveVfs: result.effective.readPort })
    const snapshot = await adapter.snapshot()
    expect(snapshot.registry.kindDefinitions.has("Prompt")).toBe(true)
    expect(await result.effective.readPort.stat("/.eidolon/resources/KindDefinitions/Prompt/manifest.xnl")).toBeUndefined()

    const closure = await adapter.captureAgentResourceObservation(snapshot)
    expect(closure.files[".agent-resources/effective-vfs/.eidolon/contracts/ai-workflow/KindDefinitions/Prompt/manifest.xnl"]).toBeDefined()
    const restored = await EidolonAppResourceRegistryAdapter.restoreAgentResourceObservation(closure)
    expect((await restored.snapshot()).registry.kindDefinitions.has("Prompt")).toBe(true)

    const forged = structuredClone(closure)
    forged.files[".agent-resources/effective-vfs/.eidolon/contracts/ai-workflow/KindDefinitions/Prompt/manifest.xnl"] =
      Buffer.from("<KindDefinition #forged>").toString("base64")
    await expect(EidolonAppResourceRegistryAdapter.restoreAgentResourceObservation(forged)).rejects.toBeDefined()
  })

  it("projects exactly one Halfcode tree and records its admitted VFS provenance", async () => {
    const effective = effectiveVfs()
    const adapter = new EidolonAppResourceRegistryAdapter({ effectiveVfs: effective.readPort })
    const snapshot = await adapter.snapshot()

    expect(snapshot.registry.layers.map((layer) => layer.id)).toEqual(["effective-vfs"])
    expect(snapshot.contentIdentityLayers.map((layer) => layer.id)).toEqual(["effective-vfs"])
    expect(snapshot.effectiveVfs).toEqual({
      revision: effective.snapshot.revision,
      treeDigest: effective.snapshot.treeDigest,
      materializationReceiptId: effective.snapshot.materializationReceiptId,
      packageRoot: "/.eidolon/resources",
    })
    expect(snapshot.registry.byId.get("eidolon.fixture.SupportPrompt")?.effectiveLayerId).toBe("effective-vfs")
  })

  it("keeps source and dependency reads bound to their original VFS revision across refresh", async () => {
    const first = effectiveVfs("first")
    const second = effectiveVfs("second")
    let current = first.readPort
    const adapter = new EidolonAppResourceRegistryAdapter({ effectiveVfs: () => current })
    const owner = await adapter.readEffectiveSource("eidolon.fixture.SupportPrompt")

    current = second.readPort
    const refreshed = await adapter.refresh()

    expect(refreshed.effectiveVfs.revision).toBe(second.snapshot.revision)
    expect((await adapter.readEffectiveSource("eidolon.fixture.SupportPrompt", refreshed)).source).toContain("second")
    expect(owner.source).toContain("first")
    expect(await adapter.readEffectiveDependencySource(owner, "helper.txt")).toBe("helper:first")
  })

  it("captures one deterministic frozen effective closure with revision provenance", async () => {
    const effective = effectiveVfs("frozen-b1")
    const closure = await new EidolonAppResourceRegistryAdapter({ effectiveVfs: effective.readPort })
      .captureFrozenResourceClosure()

    expect(closure[".agent-resources/effective-vfs/.eidolon/resources/manifest.xnl"]).toContain("ResourcePackage")
    expect(JSON.parse(closure[".agent-resources/effective-vfs/provenance.json"]!)).toMatchObject({
      schemaVersion: "eidolon.frozen-effective-vfs/v1",
      effectiveVfsRevision: effective.snapshot.revision,
      treeDigest: effective.snapshot.treeDigest,
    })
    expect(Object.keys(closure).some((path) => path.includes("/global/") || path.includes("/workspace/"))).toBe(false)

    const recoveredAdapter = new EidolonAppResourceRegistryAdapter({
      effectiveVfs: createFrozenEffectiveEidolonVfsReadPort(closure),
    })
    const recovered = await recoveredAdapter.snapshot()
    expect(recovered.registryRevision).toBe((await new EidolonAppResourceRegistryAdapter({
      effectiveVfs: effective.readPort,
    }).snapshot()).registryRevision)
    expect(recovered.effectiveVfs?.revision).toBe(effective.snapshot.revision)
    expect((await recoveredAdapter.readEffectiveSource("eidolon.fixture.SupportPrompt")).source)
      .toContain("frozen-b1")

    const liveB2 = new EidolonAppResourceRegistryAdapter({
      effectiveVfs: effectiveVfs("live-b2").readPort,
    })
    expect((await liveB2.readEffectiveSource("eidolon.fixture.SupportPrompt")).source)
      .toContain("live-b2")
    expect((await recoveredAdapter.readEffectiveSource("eidolon.fixture.SupportPrompt")).source)
      .toContain("frozen-b1")
  })

  it("fails closed when the final VFS contains duplicate Halfcode FQNs", async () => {
    const effective = effectiveVfs("duplicate", true)
    await expect(new EidolonAppResourceRegistryAdapter({ effectiveVfs: effective.readPort }).snapshot())
      .rejects.toBeDefined()
  })

  it("isolates production physical ResourcePackage metadata when Effective VFS is injected", async () => {
    const effective = effectiveVfs()
    const effectiveVfsAuthoring = Object.freeze({
      workspaceResourceRoot: "/tmp/eidolon-effective-authoring-fixture",
      read: () => effective,
      prepare: async () => { throw new Error("not exercised") },
      admit: async () => { throw new Error("not exercised") },
    })
    const component = createWorkflowComponentForRuntimeBinding({
      workDir: process.cwd(),
      metadata: {
        resourcePackages: {
          effectiveVfs: () => effective.readPort,
          effectiveVfsAuthoring,
          layers: [
            { id: "global", rootDir: "/tmp/eidolon-global-resource-fixture" },
            { id: "workspace", rootDir: "/tmp/eidolon-workspace-resource-fixture" },
          ],
        },
      },
    })

    expect((await component.resourceRegistry.snapshot()).effectiveVfs?.revision)
      .toBe(effective.snapshot.revision)
    expect((await component.resourceRegistry.snapshot()).registry.layers.map(({ id }) => id))
      .toEqual(["effective-vfs"])
    expect(component.effectiveVfsAuthoring).toBe(effectiveVfsAuthoring)
    expect(component.resourceLayers).toEqual([])
    expect(component.resourcePackagePublisher).toBeDefined()
  })

  it("opens the actual builtin package in an empty production workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-empty-workspace-authoring-"))
    temporaryRoots.push(root)
    const effective = await prepareEffectiveEidolonVfs({ homeEidolonRoot: path.join(root, "home"), workspaceEidolonRoot: path.join(root, ".eidolon") })
    try {
      const component = createWorkflowComponentForRuntimeBinding({ workDir: root, metadata: { resourcePackages: {
        effectiveVfs: () => effective.authoring.read().readPort, effectiveVfsAuthoring: effective.authoring,
      } } })
      const runtime = { vm: { outerCtx: { workDir: root, metadata: {} } }, actor: {} } as any
      bindWorkflowComponentToRuntime(runtime, component)
      const result = JSON.parse(await buildWorkflowOpenAuthoringSessionToolDef().run(runtime, {}, {}))
      expect(result).toMatchObject({ ok: true, artifactKind: "resource-package", target: { packageVersion: "1.0.0" } })
      expect(result.workflow_progress.transition).toBe("workspace_opened")
      // Opening the seed Agent package is valid; a Workflow must be authored before a Workflow publication proof exists.
      await expect(component.sessions.prepareResourcePackagePublication({ sessionId: result.sessionId }))
        .rejects.toThrow("requires at least one exact App, workflow and entrypoint projection")
    } finally { effective.dispose() }
  })

  it("opens existing and fresh ResourcePackages through public tools in the production Effective VFS composition", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-effective-resource-package-authoring-"))
    temporaryRoots.push(root)
    const workspaceEidolonRoot = path.join(root, ".eidolon")
    await cp(resourcePackageFixtureRoot, path.join(workspaceEidolonRoot, "resources"), { recursive: true })
    const effective = await prepareEffectiveEidolonVfs({
      homeEidolonRoot: path.join(root, "home"),
      workspaceEidolonRoot,
    })
    try {
      const component = createWorkflowComponentForRuntimeBinding({
        workDir: root,
        metadata: {
          resourcePackages: {
            layers: [{ id: "workspace", rootDir: path.join(workspaceEidolonRoot, "resources") }],
            effectiveVfs: () => effective.materializer.read().readPort,
            effectiveVfsAuthoring: effective.authoring,
          },
        },
      })
      const runtime = { vm: { outerCtx: { workDir: root, metadata: {} } }, actor: {} } as any
      bindWorkflowComponentToRuntime(runtime, component)
      const before = await component.resourceRegistry.snapshot()
      const explicitFiles = await readTextResourcePackageFiles(path.join(workspaceEidolonRoot, "resources"))

      expect(before.effectiveVfs?.revision).toBe(effective.materializer.read().snapshot.revision)
      expect(before.registry.layers.map(({ id }) => id)).toEqual(["effective-vfs"])
      expect(before.registry.byId.get("eidolon.fixture.SummaryWorkflow")?.effectiveLayerId).toBe("effective-vfs")
      expect(component.resourceLayers).toEqual([])
      expect(component.resourcePackagePublisher).toBeDefined()

      const opened = await Promise.allSettled([
        buildWorkflowOpenAuthoringSessionToolDef().run(runtime, {
          artifact_kind: "resource-package",
          source_kind: "workspace-layer",
          session_id: "effective-existing-resource-package",
          selected_resource_refs: ["resource://eidolon.fixture.SummaryWorkflow"],
        }, {}),
        buildWorkflowCreateResourcePackageSessionToolDef().run(runtime, {
          session_id: "effective-fresh-resource-package",
          files: explicitFiles,
          selected_resource_refs: ["resource://eidolon.fixture.SummaryWorkflow"],
        }, {}),
      ])

      expect(opened.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"])
      for (const result of opened) {
        if (result.status !== "fulfilled") throw result.reason
        expect(JSON.parse(result.value)).toMatchObject({
          ok: true,
          artifactKind: "resource-package",
          workflow_progress: { owner: "workflow.authoring", transition: "workspace_opened" },
        })
      }
      const proofs = await Promise.all([
        component.sessions.prepareResourcePackagePublication({ sessionId: "effective-existing-resource-package" }),
        component.sessions.prepareResourcePackagePublication({ sessionId: "effective-fresh-resource-package" }),
      ])
      for (const proof of proofs) {
        expect(proof.proofSet).toMatchObject({
          kind: "workflow.resourcePackagePublicationProofSet",
          baseRegistryRevision: before.registryRevision,
          registryProjectionReceipt: { resourceCount: expect.any(Number) },
        })
      }
      const candidateEntered = deferred()
      const releaseCandidate = deferred()
      const locked = component.sessions.withResourcePackagePublicationCandidate({
        sessionId: "effective-existing-resource-package",
        expectedRevision: proofs[0]!.revision,
      }, async (candidate) => {
        candidateEntered.resolve()
        await releaseCandidate.promise
        return candidate.revision
      })
      await candidateEntered.promise
      let patchSettled = false
      const patch = component.sessions.applyPatch({
        sessionId: "effective-existing-resource-package",
        expectedWorkingRevision: proofs[0]!.revision,
        operations: [{ kind: "update", path: "/work/Apps/Summary.xnl", content: (await component.sessions.read(
          "effective-existing-resource-package", "/work/Apps/Summary.xnl",
        )).replace("Baseline summary app", "Locked edit") }],
      }).then(() => { patchSettled = true })
      await Promise.resolve()
      expect(patchSettled).toBe(false)
      releaseCandidate.resolve()
      await locked
      await patch
      await component.sessions.write("effective-fresh-resource-package", "/work/Apps/Summary.xnl",
        (await component.sessions.read("effective-fresh-resource-package", "/work/Apps/Summary.xnl"))
          .replaceAll("resource://eidolon.fixture.SummaryWorkflow", "resource://eidolon.fixture.MissingWorkflow"))
      const rejected = JSON.parse(await buildWorkflowValidateAuthoringSessionToolDef().run(runtime, {
        session_id: "effective-fresh-resource-package",
      }, {}))
      expect(rejected).toMatchObject({ status: "authoring_error", error: { category: "invalid_candidate" },
        publicationEffectDispatched: false, runtimeEffectDispatched: false })
      expect(rejected.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
        code: expect.any(String), location: expect.stringContaining("Summary"), message: expect.stringContaining("MissingWorkflow"),
      })]))
      await component.sessions.write("effective-fresh-resource-package", "/work/Apps/Summary.xnl",
        (await component.sessions.read("effective-fresh-resource-package", "/work/Apps/Summary.xnl"))
          .replaceAll("resource://eidolon.fixture.MissingWorkflow", "resource://eidolon.fixture.SummaryWorkflow"))
      await component.sessions.write("effective-fresh-resource-package", "/work/Apps/Summary.xnl",
        (await component.sessions.read("effective-fresh-resource-package", "/work/Apps/Summary.xnl"))
          .replace("entrypoint = true", "entrypoint = false"))
      const invalidProjection = JSON.parse(await buildWorkflowValidateAuthoringSessionToolDef().run(runtime, {
        session_id: "effective-fresh-resource-package",
      }, {}))
      expect(invalidProjection.status).toBe("authoring_error")
      expect(invalidProjection.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
        code: expect.any(String), message: expect.stringMatching(/entrypoint/),
      })]))
      const after = await component.resourceRegistry.snapshot()
      expect(after.effectiveVfs?.revision).toBe(before.effectiveVfs?.revision)
      expect(after.registryRevision).toBe(before.registryRevision)
    } finally {
      effective.dispose()
    }
  })
})
