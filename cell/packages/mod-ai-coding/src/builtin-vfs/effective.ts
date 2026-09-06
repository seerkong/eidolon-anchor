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
import { LocalFileEffectiveEidolonVfsAuthority } from "@cell/ai-support/runtime/LocalFileEffectiveEidolonVfsAuthority"
import type { EidolonVfsPublicationAssociation, EidolonVfsPublicationRecord, EidolonVfsWorkspaceWrite } from "@cell/symbiont-contract/resource/EffectiveEidolonVFS"
import type { EffectiveEidolonVfsPublicationAuthority } from "@cell/symbiont-logic/resource/EffectiveEidolonVfsPublication"

import {
  createBuiltinEidolonResourcePackageReadPort,
  loadBuiltinEidolonVfs,
  type BuiltinEidolonVfsAssetPort,
} from "./index"

export interface PrepareEffectiveEidolonVfsInput {
  readonly homeEidolonRoot: string
  readonly workspaceEidolonRoot: string
  readonly builtinAssetPort?: BuiltinEidolonVfsAssetPort
  readonly publicationAuthority?: EffectiveEidolonVfsPublicationAuthority
}

export interface PreparedEffectiveEidolonVfs {
  readonly effective: EffectiveEidolonVfsView
  readonly materializer: EffectiveEidolonVfsMaterializer
  /** Closes only the backend created by this composition root. */
  dispose(): void
  readonly authoring: Readonly<{
    workspaceResourceRoot: string
    read(): EffectiveEidolonVfsView
    prepare(input: Readonly<{
      expectedCurrentRevision: `sha256:${string}`
      logicalPath: `/.eidolon/resources/${string}`
      authorityText: string
    }>): Promise<PrepareEffectiveEidolonVfsResult>
    admit(candidate: EffectiveEidolonVfsCandidate, association?: EidolonVfsPublicationAssociation, workspaceWrite?: EidolonVfsWorkspaceWrite): Promise<EffectiveEidolonVfsMaterializationResult>
    lookupPublication(transactionId: string): Promise<EidolonVfsPublicationRecord | undefined>
    restore(): Promise<EffectiveEidolonVfsView>
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
  const authority = input.publicationAuthority ?? new LocalFileEffectiveEidolonVfsAuthority({
    databasePath: path.join(input.workspaceEidolonRoot, "projects", ".effective-vfs", "authority.sqlite"),
    workspaceEidolonRoot: input.workspaceEidolonRoot,
    builtinSnapshot: builtin.vfsSnapshot,
  })
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    if (!input.publicationAuthority) (authority as LocalFileEffectiveEidolonVfsAuthority).close()
  }
  try {
    return await initializeEffectiveEidolonVfs(input, builtin, authority, dispose)
  } catch (error) {
    dispose()
    throw error
  }
}

async function initializeEffectiveEidolonVfs(
  input: PrepareEffectiveEidolonVfsInput,
  builtin: Awaited<ReturnType<typeof loadBuiltinEidolonVfs>>,
  authority: EffectiveEidolonVfsPublicationAuthority,
  dispose: () => void,
): Promise<PreparedEffectiveEidolonVfs> {
  const materializer = new EffectiveEidolonVfsMaterializer({
    builtinSnapshot: builtin.vfsSnapshot,
    authority,
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
  await materializer.restore()
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
      const baseline = await materializer.prepare({ expectedCurrentRevision: authoringInput.expectedCurrentRevision, overlays })
      if (baseline.status !== "prepared") return baseline
      if (baseline.candidate.effective.snapshot.revision !== materializer.read().snapshot.revision) {
        throw new Error("EIDOLON_VFS_OVERLAY_SOURCE_DRIFT")
      }
      const existing = await baseline.candidate.effective.readPort.stat(authoringInput.logicalPath)
      if (existing && existing.kind !== "file") throw new Error("EIDOLON_VFS_AUTHORING_TARGET_NOT_FILE")
      return materializer.prepare({
        expectedCurrentRevision: authoringInput.expectedCurrentRevision,
        overlays: [
        ...overlays,
        createMutationEidolonOverlay({
          id: "workspace-authoring-intent",
          kind: "workspace",
          order: overlays.length,
          mutations: [{
            type: existing ? "CONTENT_UPDATE" : "FILE_CREATE",
            path: `vfs://${authoringInput.logicalPath}`,
            expectedId: existing?.nodeId ?? stableEidolonOverlayNodeId(
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
    admit: (candidate: EffectiveEidolonVfsCandidate, association?: EidolonVfsPublicationAssociation, workspaceWrite?: EidolonVfsWorkspaceWrite) => materializer.admit(candidate, association, workspaceWrite),
    lookupPublication: (transactionId: string) => materializer.lookupPublication(transactionId),
    restore: () => materializer.restore(),
  })
  return Object.freeze({ effective: result.effective, materializer, authoring,
    dispose,
  })
}
