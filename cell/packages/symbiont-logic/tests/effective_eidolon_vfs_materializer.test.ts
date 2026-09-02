import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  EffectiveEidolonVfsMaterializer,
  createLegacyResourceVfsProjectionFromReadPort,
  createMutationEidolonOverlay,
  loadPhysicalEidolonDirectoryOverlay,
} from "@cell/symbiont-logic/resource/EffectiveEidolonVfsMaterializer"
import { VirtualFileSystem } from "xnl-vfs"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryEidolonRoot(): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "effective-eidolon-vfs-"))
  temporaryDirectories.push(parent)
  const root = path.join(parent, ".eidolon")
  await mkdir(root)
  return root
}

function builtinVfs(): VirtualFileSystem {
  const vfs = new VirtualFileSystem()
  vfs.mkdir("vfs:///.eidolon/resources", { recursive: true })
  vfs.writeFile("vfs:///.eidolon/runtime-config.json", "builtin", { fileType: "text", metadataId: "builtin-config" })
  vfs.writeFile("vfs:///.eidolon/resources/remove.xnl", "<Remove #base>", { fileType: "xnl", metadataId: "builtin-remove" })
  vfs.writeFile("vfs:///.eidolon/resources/keep.bin", "AP8=", { fileType: "binary", metadataId: "builtin-binary" })
  return vfs
}

describe("physical Eidolon directory overlay", () => {
  it("projects every regular file with deterministic content-independent node identity", async () => {
    const root = await temporaryEidolonRoot()
    await mkdir(path.join(root, "resources", "Agents"), { recursive: true })
    const file = path.join(root, "resources", "Agents", "CodeAgent.xnl")
    await writeFile(file, "<Agent #one>")

    const first = await loadPhysicalEidolonDirectoryOverlay({
      id: "workspace", kind: "workspace", order: 0, rootDir: root,
    })
    await writeFile(file, "<Agent #two>")
    const second = await loadPhysicalEidolonDirectoryOverlay({
      id: "workspace", kind: "workspace", order: 0, rootDir: root,
    })
    const firstVfs = new VirtualFileSystem(first.intent.snapshot)
    const secondVfs = new VirtualFileSystem(second.intent.snapshot)

    expect(firstVfs.readFile("vfs:///.eidolon/resources/Agents/CodeAgent.xnl")).toBe("<Agent #one>")
    expect(secondVfs.readFile("vfs:///.eidolon/resources/Agents/CodeAgent.xnl")).toBe("<Agent #two>")
    expect(firstVfs.stat("vfs:///.eidolon/resources/Agents/CodeAgent.xnl").metadataId)
      .toBe(secondVfs.stat("vfs:///.eidolon/resources/Agents/CodeAgent.xnl").metadataId)
    expect(first.descriptor.intentDigest).not.toBe(second.descriptor.intentDigest)
  })

  it("fails closed on symlinks instead of reading outside the overlay root", async () => {
    const root = await temporaryEidolonRoot()
    const outside = path.join(path.dirname(root), "outside.txt")
    await writeFile(outside, "secret")
    await symlink(outside, path.join(root, "linked.txt"))

    await expect(loadPhysicalEidolonDirectoryOverlay({
      id: "home", kind: "home", order: 0, rootDir: root,
    })).rejects.toThrow("symlink")
  })

  it("excludes runtime-owned state before traversal and atomic temp files from the configuration overlay", async () => {
    const root = await temporaryEidolonRoot()
    await mkdir(path.join(root, "sessions", "active"), { recursive: true })
    await mkdir(path.join(root, "projects", "legacy-session"), { recursive: true })
    await mkdir(path.join(root, "skills"), { recursive: true })
    await mkdir(path.join(root, "commands"), { recursive: true })
    await mkdir(path.join(root, "resources"), { recursive: true })
    await writeFile(path.join(root, "sessions", "active", ".tmp-provider-state"), "volatile")
    await symlink(
      path.join(path.dirname(root), "outside.txt"),
      path.join(root, "projects", "legacy-session", "must-not-be-traversed"),
    )
    await writeFile(path.join(root, "skills", "README.md"), "managed elsewhere")
    await writeFile(path.join(root, "commands", "command.md"), "managed elsewhere")
    await writeFile(path.join(root, "resources", ".tmp-authoring"), "volatile")
    await writeFile(path.join(root, "resources", "Stable.xnl"), "<Stable #resource>")

    const overlay = await loadPhysicalEidolonDirectoryOverlay({
      id: "workspace", kind: "workspace", order: 0, rootDir: root,
    })
    const vfs = new VirtualFileSystem(overlay.intent.snapshot)

    expect(vfs.exists("vfs:///.eidolon/sessions")).toBe(false)
    expect(vfs.exists("vfs:///.eidolon/projects")).toBe(false)
    expect(vfs.exists("vfs:///.eidolon/skills")).toBe(false)
    expect(vfs.exists("vfs:///.eidolon/commands")).toBe(false)
    expect(vfs.exists("vfs:///.eidolon/resources/.tmp-authoring")).toBe(false)
    expect(vfs.readFile("vfs:///.eidolon/resources/Stable.xnl")).toBe("<Stable #resource>")
  })
})

describe("Effective Eidolon VFS materialization", () => {
  it("prepares an immutable candidate without exposing it until the issued handle is admitted", async () => {
    const root = await temporaryEidolonRoot()
    await writeFile(path.join(root, "runtime-config.json"), "candidate")
    const materializer = new EffectiveEidolonVfsMaterializer({ builtinSnapshot: builtinVfs().getSnapshot() })
    const before = materializer.read()
    const overlay = await loadPhysicalEidolonDirectoryOverlay({ id: "workspace", kind: "workspace", order: 0, rootDir: root })

    const prepared = await materializer.prepare({
      expectedCurrentRevision: before.snapshot.revision,
      overlays: [overlay],
    })

    expect(prepared.status).toBe("prepared")
    if (prepared.status !== "prepared") throw new Error("expected prepared candidate")
    expect(new TextDecoder().decode(await prepared.candidate.effective.readPort.readBytes("/.eidolon/runtime-config.json")))
      .toBe("candidate")
    expect(new TextDecoder().decode(await materializer.read().readPort.readBytes("/.eidolon/runtime-config.json")))
      .toBe("builtin")

    const candidateBytes = await prepared.candidate.effective.readPort.readBytes("/.eidolon/runtime-config.json")
    if (candidateBytes) candidateBytes[0] = 0
    expect(new TextDecoder().decode(await prepared.candidate.effective.readPort.readBytes("/.eidolon/runtime-config.json")))
      .toBe("candidate")

    const forged = Object.freeze({ ...prepared.candidate })
    const forgedAdmission = await materializer.admit(forged)
    expect(forgedAdmission.status).toBe("rejected")
    expect(forgedAdmission.status === "rejected" ? forgedAdmission.receipt.diagnostics[0]?.code : undefined)
      .toBe("candidate_handle_invalid")
    expect(materializer.read().snapshot.revision).toBe(before.snapshot.revision)

    const admitted = await materializer.admit(prepared.candidate)
    expect(admitted.status).toBe("admitted")
    expect(new TextDecoder().decode(await materializer.read().readPort.readBytes("/.eidolon/runtime-config.json")))
      .toBe("candidate")
  })

  it("admits at most one of two independently prepared candidates for the same revision", async () => {
    const firstRoot = await temporaryEidolonRoot()
    const secondRoot = await temporaryEidolonRoot()
    await writeFile(path.join(firstRoot, "runtime-config.json"), "first")
    await writeFile(path.join(secondRoot, "runtime-config.json"), "second")
    const materializer = new EffectiveEidolonVfsMaterializer({ builtinSnapshot: builtinVfs().getSnapshot() })
    const expectedCurrentRevision = materializer.read().snapshot.revision
    const firstOverlay = await loadPhysicalEidolonDirectoryOverlay({ id: "first", kind: "workspace", order: 0, rootDir: firstRoot })
    const secondOverlay = await loadPhysicalEidolonDirectoryOverlay({ id: "second", kind: "workspace", order: 0, rootDir: secondRoot })

    const [first, second] = await Promise.all([
      materializer.prepare({ expectedCurrentRevision, overlays: [firstOverlay] }),
      materializer.prepare({ expectedCurrentRevision, overlays: [secondOverlay] }),
    ])
    expect(first.status).toBe("prepared")
    expect(second.status).toBe("prepared")
    if (first.status !== "prepared" || second.status !== "prepared") throw new Error("expected prepared candidates")

    const results = await Promise.all([
      materializer.admit(first.candidate),
      materializer.admit(second.candidate),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(["admitted", "rejected"])
    const rejected = results.find((result) => result.status === "rejected")
    expect(rejected?.status === "rejected" ? rejected.receipt.diagnostics[0]?.code : undefined)
      .toBe("publish_conflict")
  })

  it("rebuilds from Builtin so replacement removal falls back while explicit delete removes", async () => {
    const root = await temporaryEidolonRoot()
    await writeFile(path.join(root, "runtime-config.json"), "workspace")
    const materializer = new EffectiveEidolonVfsMaterializer({ builtinSnapshot: builtinVfs().getSnapshot() })
    const initial = materializer.read()
    const replacement = await loadPhysicalEidolonDirectoryOverlay({
      id: "workspace", kind: "workspace", order: 0, rootDir: root,
    })

    const replaced = await materializer.materialize({
      expectedCurrentRevision: initial.snapshot.revision,
      overlays: [replacement],
    })
    expect(replaced.status).toBe("admitted")
    expect(new TextDecoder().decode(await materializer.read().readPort.readBytes("/.eidolon/runtime-config.json")))
      .toBe("workspace")

    await rm(path.join(root, "runtime-config.json"))
    const noOpinion = await loadPhysicalEidolonDirectoryOverlay({
      id: "workspace", kind: "workspace", order: 0, rootDir: root,
    })
    const fallenBack = await materializer.materialize({
      expectedCurrentRevision: materializer.read().snapshot.revision,
      overlays: [noOpinion],
    })
    expect(fallenBack.status).toBe("admitted")
    expect(new TextDecoder().decode(await materializer.read().readPort.readBytes("/.eidolon/runtime-config.json")))
      .toBe("builtin")

    const deletion = createMutationEidolonOverlay({
      id: "workspace-delete",
      kind: "workspace",
      order: 0,
      mutations: [{ type: "FILE_DELETE", path: "vfs:///.eidolon/resources/remove.xnl", expectedId: "builtin-remove" }],
    })
    expect((await materializer.materialize({
      expectedCurrentRevision: materializer.read().snapshot.revision,
      overlays: [deletion],
    })).status).toBe("admitted")
    expect(await materializer.read().readPort.stat("/.eidolon/resources/remove.xnl")).toBeUndefined()
  })

  it("applies home then workspace, preserves base identity, and rejects stale mutation atomically", async () => {
    const homeRoot = await temporaryEidolonRoot()
    const workspaceRoot = await temporaryEidolonRoot()
    await writeFile(path.join(homeRoot, "runtime-config.json"), "home")
    await writeFile(path.join(workspaceRoot, "runtime-config.json"), "workspace")
    const materializer = new EffectiveEidolonVfsMaterializer({ builtinSnapshot: builtinVfs().getSnapshot() })
    const home = await loadPhysicalEidolonDirectoryOverlay({ id: "home", kind: "home", order: 0, rootDir: homeRoot })
    const workspace = await loadPhysicalEidolonDirectoryOverlay({ id: "workspace", kind: "workspace", order: 1, rootDir: workspaceRoot })

    expect((await materializer.materialize({
      expectedCurrentRevision: materializer.read().snapshot.revision,
      overlays: [workspace, home],
    })).status).toBe("admitted")
    const admitted = materializer.read()
    expect(new TextDecoder().decode(await admitted.readPort.readBytes("/.eidolon/runtime-config.json"))).toBe("workspace")
    expect((await admitted.readPort.stat("/.eidolon/runtime-config.json"))?.nodeId).toBe("builtin-config")

    const rejected = await materializer.materialize({
      expectedCurrentRevision: admitted.snapshot.revision,
      overlays: [createMutationEidolonOverlay({
        id: "stale", kind: "workspace", order: 0,
        mutations: [
          { type: "CONTENT_UPDATE", path: "vfs:///.eidolon/runtime-config.json", expectedId: "wrong", payload: { content: "bad" } },
        ],
      })],
    })
    expect(rejected.status).toBe("planning_rejected")
    expect(rejected.status === "planning_rejected" ? rejected.diagnostics[0] : undefined)
      .toMatchObject({ code: "identity_mismatch", overlayId: "stale", mutationIndex: 0 })
    expect(materializer.read().snapshot.revision).toBe(admitted.snapshot.revision)
    expect(new TextDecoder().decode(await materializer.read().readPort.readBytes("/.eidolon/runtime-config.json"))).toBe("workspace")
  })

  it("runs every candidate validator before CAS and keeps revision-bound readers immutable", async () => {
    const root = await temporaryEidolonRoot()
    await writeFile(path.join(root, "runtime-config.json"), "candidate")
    let validatorCalls = 0
    const materializer = new EffectiveEidolonVfsMaterializer({
      builtinSnapshot: builtinVfs().getSnapshot(),
      validators: [{
        id: "halfcode-readback",
        async validate() {
          validatorCalls += 1
          return [{ code: "duplicate_resource", message: "duplicate resource://same", logicalPath: "/.eidolon/resources" }]
        },
      }],
    })
    const before = materializer.read()
    const overlay = await loadPhysicalEidolonDirectoryOverlay({ id: "workspace", kind: "workspace", order: 0, rootDir: root })
    const rejected = await materializer.materialize({ expectedCurrentRevision: before.snapshot.revision, overlays: [overlay] })

    expect(validatorCalls).toBe(1)
    expect(rejected.status).toBe("rejected")
    expect(materializer.read().snapshot.revision).toBe(before.snapshot.revision)
    expect(new TextDecoder().decode(await before.readPort.readBytes("/.eidolon/runtime-config.json"))).toBe("builtin")

    const firstBytes = await before.readPort.readBytes("/.eidolon/runtime-config.json")
    if (firstBytes) firstBytes[0] = 0
    expect(new TextDecoder().decode(await before.readPort.readBytes("/.eidolon/runtime-config.json"))).toBe("builtin")
  })

  it("admits exactly one whole candidate when concurrent plans race on the same revision", async () => {
    const firstRoot = await temporaryEidolonRoot()
    const secondRoot = await temporaryEidolonRoot()
    await writeFile(path.join(firstRoot, "runtime-config.json"), "first")
    await writeFile(path.join(secondRoot, "runtime-config.json"), "second")

    let waiting = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const materializer = new EffectiveEidolonVfsMaterializer({
      builtinSnapshot: builtinVfs().getSnapshot(),
      validators: [{
        id: "race-barrier",
        async validate() {
          waiting += 1
          if (waiting === 2) release()
          await gate
          return []
        },
      }],
    })
    const expectedCurrentRevision = materializer.read().snapshot.revision
    const first = await loadPhysicalEidolonDirectoryOverlay({ id: "first", kind: "workspace", order: 0, rootDir: firstRoot })
    const second = await loadPhysicalEidolonDirectoryOverlay({ id: "second", kind: "workspace", order: 0, rootDir: secondRoot })

    const results = await Promise.all([
      materializer.materialize({ expectedCurrentRevision, overlays: [first] }),
      materializer.materialize({ expectedCurrentRevision, overlays: [second] }),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(["admitted", "rejected"])
    const rejected = results.find((result) => result.status === "rejected")
    expect(rejected?.status === "rejected" ? rejected.receipt.diagnostics[0]?.code : undefined)
      .toBe("publish_conflict")
    const content = new TextDecoder().decode(await materializer.read().readPort.readBytes("/.eidolon/runtime-config.json"))
    expect(["first", "second"]).toContain(content)
  })

  it("rejects a stale host revision and derives a deeply read-only text-only legacy projection", async () => {
    const materializer = new EffectiveEidolonVfsMaterializer({ builtinSnapshot: builtinVfs().getSnapshot() })
    const current = materializer.read()
    const rejected = await materializer.materialize({
      expectedCurrentRevision: `sha256:${"0".repeat(64)}`,
      overlays: [],
    })
    expect(rejected.status).toBe("rejected")
    expect(rejected.status === "rejected" ? rejected.receipt.diagnostics[0]?.code : undefined).toBe("publish_conflict")

    const projection = await createLegacyResourceVfsProjectionFromReadPort(current.readPort)
    expect(projection.snapshotRevision).toBe(current.snapshot.revision)
    expect(projection.vfs.files["/.eidolon/runtime-config.json"]?.content).toBe("builtin")
    expect(projection.vfs.files["/.eidolon/resources/keep.bin"]).toBeUndefined()
    expect(Object.isFrozen(projection)).toBe(true)
    expect(Object.isFrozen(projection.vfs.files)).toBe(true)
  })

  it("replays a compatible B1 mutation on B2 and keeps B2 admitted when an identity fence is stale", async () => {
    const b1 = builtinVfs()
    const b1Materializer = new EffectiveEidolonVfsMaterializer({ builtinSnapshot: b1.getSnapshot() })
    const compatible = createMutationEidolonOverlay({
      id: "workspace-runtime-config",
      kind: "workspace",
      order: 0,
      mutations: [{
        type: "CONTENT_UPDATE",
        path: "vfs:///.eidolon/runtime-config.json",
        expectedId: "builtin-config",
        payload: { content: "workspace-compatible", fileType: "text" },
      }],
    })
    expect((await b1Materializer.materialize({
      expectedCurrentRevision: b1Materializer.read().snapshot.revision,
      overlays: [compatible],
    })).status).toBe("admitted")

    const b2 = builtinVfs()
    b2.writeFile("vfs:///.eidolon/resources/B2.xnl", "<B2 #added>", {
      fileType: "xnl",
      metadataId: "builtin-b2-added",
    })
    const b2Materializer = new EffectiveEidolonVfsMaterializer({ builtinSnapshot: b2.getSnapshot() })
    const replayed = await b2Materializer.materialize({
      expectedCurrentRevision: b2Materializer.read().snapshot.revision,
      overlays: [compatible],
    })
    expect(replayed.status).toBe("admitted")
    expect(new TextDecoder().decode(await b2Materializer.read().readPort.readBytes("/.eidolon/runtime-config.json")))
      .toBe("workspace-compatible")
    expect(await b2Materializer.read().readPort.stat("/.eidolon/resources/B2.xnl")).toBeDefined()

    const admittedB2 = b2Materializer.read()
    const stale = createMutationEidolonOverlay({
      id: "workspace-stale",
      kind: "workspace",
      order: 0,
      mutations: [{
        type: "CONTENT_UPDATE",
        path: "vfs:///.eidolon/runtime-config.json",
        expectedId: "removed-b1-id",
        payload: { content: "must-not-publish", fileType: "text" },
      }],
    })
    const rejected = await b2Materializer.materialize({
      expectedCurrentRevision: admittedB2.snapshot.revision,
      overlays: [stale],
    })
    expect(rejected.status).toBe("planning_rejected")
    expect(b2Materializer.read()).toBe(admittedB2)
    expect(new TextDecoder().decode(await admittedB2.readPort.readBytes("/.eidolon/runtime-config.json")))
      .toBe("workspace-compatible")
  })
})
