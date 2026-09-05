import { describe, expect, it } from "bun:test"

import { EffectiveEidolonVfsMaterializer } from "@cell/symbiont-logic/resource/EffectiveEidolonVfsMaterializer"
import {
  EidolonAppResourceRegistryAdapter,
  createFrozenEffectiveEidolonVfsReadPort,
} from "../../src/resources/EidolonAppResourceRegistryAdapter"
import { createWorkflowComponentForRuntimeBinding } from "../../src/workflow/component/WorkflowComponent"
import { VirtualFileSystem } from "xnl-vfs"
import { depaAIResourceKindContract } from "ai-workflow-contract"

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

describe("Effective VFS Halfcode registry projection", () => {
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
    expect(component.resourcePackagePublisher).toBeUndefined()
  })
})
