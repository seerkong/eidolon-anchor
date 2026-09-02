import {
  EffectiveEidolonVfsMaterializer,
  createMutationEidolonOverlay,
  loadPhysicalEidolonDirectoryOverlay,
  stableEidolonOverlayNodeId,
  type EffectiveEidolonVfsCandidate,
  type EffectiveEidolonVfsMaterializationResult,
  type EffectiveEidolonVfsView,
  type EidolonVfsOverlayMaterial,
  type PrepareEffectiveEidolonVfsResult,
} from "@cell/symbiont-logic/resource/EffectiveEidolonVfsMaterializer"
import path from "node:path"
import { lstat } from "node:fs/promises"
import { loadResourceTreeFromReadPort } from "halfcode-compiler.xnl/resource-core"

import {
  createBuiltinEidolonResourcePackageReadPort,
  loadBuiltinEidolonVfs,
  type BuiltinEidolonVfsAssetPort,
} from "./index"

export interface PrepareEffectiveEidolonVfsInput {
  readonly homeEidolonRoot: string
  readonly workspaceEidolonRoot: string
  readonly builtinAssetPort?: BuiltinEidolonVfsAssetPort
}

export interface PreparedEffectiveEidolonVfs {
  readonly effective: EffectiveEidolonVfsView
  readonly materializer: EffectiveEidolonVfsMaterializer
  readonly authoring: Readonly<{
    workspaceResourceRoot: string
    read(): EffectiveEidolonVfsView
    prepare(input: Readonly<{
      expectedCurrentRevision: `sha256:${string}`
      logicalPath: `/.eidolon/resources/${string}`
      authorityText: string
    }>): Promise<PrepareEffectiveEidolonVfsResult>
    admit(candidate: EffectiveEidolonVfsCandidate): Promise<EffectiveEidolonVfsMaterializationResult>
  }>
}

async function loadConfiguredOverlays(input: PrepareEffectiveEidolonVfsInput) {
  const materials: EidolonVfsOverlayMaterial[] = []
  let nextOrder = 0
  const appendLayer = async (
    id: "home-directory" | "workspace-directory",
    kind: "home" | "workspace",
    rootDir: string,
  ) => {
    let replacesResourcePackage = false
    try {
      replacesResourcePackage = (await lstat(path.join(rootDir, "resources", "manifest.xnl"))).isFile()
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
    if (replacesResourcePackage) {
      materials.push(createMutationEidolonOverlay({
        id: `${id}-resource-package-replacement`,
        kind,
        order: nextOrder++,
        mutations: [{ type: "FOLDER_DELETE", path: "vfs:///.eidolon/resources" }],
      }))
    }
    materials.push(await loadPhysicalEidolonDirectoryOverlay({
      id,
      kind,
      order: nextOrder++,
      rootDir,
    }))
  }
  await appendLayer("home-directory", "home", input.homeEidolonRoot)
  await appendLayer("workspace-directory", "workspace", input.workspaceEidolonRoot)
  return materials
}

/** Materializes Builtin → home → workspace before any runtime resource consumer is created. */
export async function prepareEffectiveEidolonVfs(
  input: PrepareEffectiveEidolonVfsInput,
): Promise<PreparedEffectiveEidolonVfs> {
  const builtin = await loadBuiltinEidolonVfs(input.builtinAssetPort)
  const materializer = new EffectiveEidolonVfsMaterializer({
    builtinSnapshot: builtin.vfsSnapshot,
    validators: [{
      id: "halfcode-effective-resource-tree",
      async validate({ readPort }) {
        await loadResourceTreeFromReadPort({
          port: createBuiltinEidolonResourcePackageReadPort(readPort),
          rootPath: "/.eidolon/resources",
        })
        return []
      },
    }],
  })
  const loadOverlays = () => loadConfiguredOverlays(input)
  const overlays = await loadOverlays()
  const result = await materializer.materialize({
    expectedCurrentRevision: materializer.read().snapshot.revision,
    overlays,
  })
  if (result.status !== "admitted") {
    const diagnostics = result.status === "planning_rejected"
      ? result.diagnostics
      : result.receipt.diagnostics
    throw new Error(`Effective Eidolon VFS materialization failed: ${diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ")}`)
  }
  const authoring = Object.freeze({
    workspaceResourceRoot: path.join(input.workspaceEidolonRoot, "resources"),
    read: () => materializer.read(),
    prepare: async (authoringInput: Readonly<{
      expectedCurrentRevision: `sha256:${string}`
      logicalPath: `/.eidolon/resources/${string}`
      authorityText: string
    }>) => {
      const overlays = await loadOverlays()
      return materializer.prepare({
        expectedCurrentRevision: authoringInput.expectedCurrentRevision,
        overlays: [
        ...overlays,
        createMutationEidolonOverlay({
          id: "workspace-authoring-intent",
          kind: "workspace",
          order: overlays.length,
          mutations: [{
            type: "FILE_CREATE",
            path: `vfs://${authoringInput.logicalPath}`,
            expectedId: stableEidolonOverlayNodeId(
              "workspace-directory",
              "file",
              authoringInput.logicalPath,
            ),
            payload: { content: authoringInput.authorityText, fileType: "xnl" },
          }],
        }),
        ],
      })
    },
    admit: (candidate: EffectiveEidolonVfsCandidate) => materializer.admit(candidate),
  })
  return Object.freeze({ effective: result.effective, materializer, authoring })
}
