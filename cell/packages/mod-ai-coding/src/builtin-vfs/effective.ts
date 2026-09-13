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
import { createHash } from "node:crypto"
import { lstat, readFile, readdir } from "node:fs/promises"
import type { Dirent } from "node:fs"
import type { VfsMutation } from "xnl-vfs"
import { loadResourceTreeFromReadPort } from "halfcode-compiler.xnl/resource-core"
import { LocalFileEffectiveEidolonVfsAuthority } from "@cell/ai-support/runtime/LocalFileEffectiveEidolonVfsAuthority"
import type { EidolonVfsPublicationAssociation, EidolonVfsPublicationRecord, EidolonVfsWorkspaceByteWrite, EidolonVfsWorkspaceWrite } from "@cell/symbiont-contract/resource/EffectiveEidolonVFS"
import type { EffectiveEidolonVfsPublicationAuthority } from "@cell/symbiont-logic/resource/EffectiveEidolonVfsPublication"
import type { EidolonEffectiveVfsAuthoringPort, EidolonResourcePackageFile } from "@cell/symbiont-logic/resource/EffectiveEidolonVfsAuthoring"

import {
  createBuiltinEidolonResourcePackageReadPort,
  loadEidolonTrustedKindDefinitionImports,
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
  readonly authoring: EidolonEffectiveVfsAuthoringPort
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
        const kindDefinitionImports = await loadEidolonTrustedKindDefinitionImports(readPort)
        await loadResourceTreeFromReadPort({
          port: createBuiltinEidolonResourcePackageReadPort(readPort),
          rootPath: "/.eidolon/resources",
          kindDefinitionImports,
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
  const workspaceResourceRoot = path.join(input.workspaceEidolonRoot, "resources")
  const packageCandidates = new WeakMap<EffectiveEidolonVfsCandidate, { readonly writes: readonly EidolonVfsWorkspaceByteWrite[]; readonly sourceDigest: string }>()
  const prepareWrites = async (expectedCurrentRevision: `sha256:${string}`, mutations: readonly VfsMutation[], writes: readonly EidolonVfsWorkspaceByteWrite[]): Promise<PrepareEffectiveEidolonVfsResult> => {
    const overlays = await loadOverlays()
    const sourceDigest = configuredOverlayDigest(overlays)
    const baseline = await materializer.prepare({ expectedCurrentRevision, overlays })
    if (baseline.status !== "prepared") return baseline
    if (baseline.candidate.effective.snapshot.revision !== materializer.read().snapshot.revision) throw new Error("EIDOLON_VFS_OVERLAY_SOURCE_DRIFT")
    const prepared = await materializer.prepare({ expectedCurrentRevision, overlays: [...overlays, createMutationEidolonOverlay({
      id: "workspace-authoring-intent", kind: "workspace", order: overlays.length, mutations,
    })] })
    if (prepared.status === "prepared") packageCandidates.set(prepared.candidate, Object.freeze({ writes: Object.freeze([...writes]), sourceDigest }))
    return prepared
  }
  const authoring: EidolonEffectiveVfsAuthoringPort = Object.freeze({
    workspaceResourceRoot,
    read: () => materializer.read(),
    prepare: async (authoringInput: Readonly<{
      expectedCurrentRevision: `sha256:${string}`
      logicalPath: `/.eidolon/resources/${string}`
      authorityText: string
    }>) => {
      const prefix = "/.eidolon/resources/"
      if (!authoringInput.logicalPath.startsWith(prefix)) throw new Error("EIDOLON_VFS_AUTHORING_PATH_INVALID")
      const relativePath = authoringInput.logicalPath.slice(prefix.length)
      normalizePackageFiles([{ path: relativePath, bytes: new Uint8Array() }])
      const overlays = await loadOverlays()
      const baseline = await materializer.prepare({ expectedCurrentRevision: authoringInput.expectedCurrentRevision, overlays })
      if (baseline.status !== "prepared") return baseline
      if (baseline.candidate.effective.snapshot.revision !== materializer.read().snapshot.revision) throw new Error("EIDOLON_VFS_OVERLAY_SOURCE_DRIFT")
      const existing = await baseline.candidate.effective.readPort.stat(authoringInput.logicalPath)
      if (existing && existing.kind !== "file") throw new Error("EIDOLON_VFS_AUTHORING_TARGET_NOT_FILE")
      const before = await physicalBytes(path.join(workspaceResourceRoot, relativePath))
      const after = new TextEncoder().encode(authoringInput.authorityText)
      return prepareWrites(authoringInput.expectedCurrentRevision, [{
            type: existing ? "CONTENT_UPDATE" : "FILE_CREATE",
            path: `vfs://${authoringInput.logicalPath}`,
            expectedId: existing?.nodeId ?? stableEidolonOverlayNodeId(
              "workspace-directory",
              "file",
              authoringInput.logicalPath,
            ),
            payload: { content: authoringInput.authorityText, fileType: "xnl" },
          }], [{ logicalPath: authoringInput.logicalPath, before: image(before), after: image(after) }])
    },
    admit: async (candidate: EffectiveEidolonVfsCandidate, association?: EidolonVfsPublicationAssociation, workspaceWrite?: EidolonVfsWorkspaceWrite) => {
      const prepared = packageCandidates.get(candidate)
      if (!prepared) return materializer.admit(candidate, association, workspaceWrite)
      if (configuredOverlayDigest(await loadOverlays()) !== prepared.sourceDigest) throw new Error("EIDOLON_VFS_OVERLAY_SOURCE_DRIFT")
      packageCandidates.delete(candidate)
      return materializer.admit(candidate, association, undefined, prepared.writes)
    },
    preparePackage: async ({ expectedCurrentRevision, files }: Readonly<{ expectedCurrentRevision: `sha256:${string}`; files: readonly EidolonResourcePackageFile[] }>) => {
      const desired = normalizePackageFiles(files)
      const existing = await physicalTree(workspaceResourceRoot)
      const writes = new Map<string, EidolonVfsWorkspaceByteWrite>()
      for (const [relative, bytes] of desired) writes.set(relative, { logicalPath: `/.eidolon/resources/${relative}`, before: image(existing.get(relative)), after: image(bytes) })
      for (const [relative, bytes] of existing) if (!desired.has(relative)) writes.set(relative, { logicalPath: `/.eidolon/resources/${relative}`, before: image(bytes), after: { state: "absent" } })
      const folders = new Set<string>()
      for (const relative of desired.keys()) {
        const parts = relative.split("/"); parts.pop()
        while (parts.length) { folders.add(parts.join("/")); parts.pop() }
      }
      const mutations: VfsMutation[] = [
        { type: "FOLDER_DELETE", path: "vfs:///.eidolon/resources" },
        { type: "FOLDER_CREATE", path: "vfs:///.eidolon/resources", expectedId: stableEidolonOverlayNodeId("workspace-directory", "directory", "/.eidolon/resources") },
      ]
      for (const folder of [...folders].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) mutations.push({ type: "FOLDER_CREATE", path: `vfs:///.eidolon/resources/${folder}`, expectedId: stableEidolonOverlayNodeId("workspace-directory", "directory", `/.eidolon/resources/${folder}`) })
      for (const [relative, bytes] of [...desired].sort(([a], [b]) => a.localeCompare(b))) {
        const logicalPath = `/.eidolon/resources/${relative}`
        const decoded = packageFileType(relative, bytes)
        mutations.push({ type: "FILE_CREATE", path: `vfs://${logicalPath}`, expectedId: stableEidolonOverlayNodeId("workspace-directory", "file", logicalPath), payload: { content: decoded.content, fileType: decoded.fileType } })
      }
      return prepareWrites(expectedCurrentRevision, mutations, [...writes.values()])
    },
    admitPackage: async (candidate: EffectiveEidolonVfsCandidate, association: EidolonVfsPublicationAssociation) => {
      const prepared = packageCandidates.get(candidate)
      if (!prepared) throw new Error("EIDOLON_VFS_AUTHORING_CANDIDATE_INVALID")
      if (configuredOverlayDigest(await loadOverlays()) !== prepared.sourceDigest) throw new Error("EIDOLON_VFS_OVERLAY_SOURCE_DRIFT")
      packageCandidates.delete(candidate)
      return materializer.admit(candidate, association, undefined, prepared.writes)
    },
    lookupPublication: (transactionId: string) => materializer.lookupPublication(transactionId),
    restore: () => materializer.restore(),
  })
  return Object.freeze({ effective: result.effective, materializer, authoring,
    dispose,
  })
}

function configuredOverlayDigest(overlays: readonly EidolonVfsOverlayMaterial[]): string {
  return createHash("sha256").update(JSON.stringify(overlays.map(({ descriptor }) => descriptor))).digest("hex")
}
function image(bytes: Uint8Array | undefined): EidolonVfsWorkspaceByteWrite["before"] {
  if (!bytes) return { state: "absent" }
  return { state: "present", bytesBase64: Buffer.from(bytes).toString("base64"), digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }
}
async function physicalBytes(file: string): Promise<Uint8Array | undefined> {
  try {
    const status = await lstat(file)
    if (status.isSymbolicLink()) throw new Error("EIDOLON_VFS_WORKSPACE_SYMLINK")
    if (!status.isFile()) throw new Error("EIDOLON_VFS_AUTHORING_TARGET_NOT_FILE")
    return new Uint8Array(await readFile(file))
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
}
async function physicalTree(root: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>()
  const visit = async (directory: string, relative: string): Promise<void> => {
    let entries: Dirent<string>[]
    try { entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" }) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error }
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name
      const child = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error("EIDOLON_VFS_WORKSPACE_SYMLINK")
      if (entry.isDirectory()) { await visit(child, childRelative); continue }
      if (!entry.isFile()) throw new Error("EIDOLON_VFS_WORKSPACE_ENTRY_INVALID")
      files.set(childRelative, new Uint8Array(await readFile(child)))
    }
  }
  await visit(root, "")
  return files
}
function normalizePackageFiles(files: readonly EidolonResourcePackageFile[]): Map<string, Uint8Array> {
  const normalized = new Map<string, Uint8Array>()
  for (const file of files) {
    if (!file || typeof file.path !== "string" || !(file.bytes instanceof Uint8Array)) throw new Error("EIDOLON_VFS_AUTHORING_FILE_INVALID")
    const relative = file.path.replace(/^\/+/, "")
    if (!relative || relative !== file.path || relative.split("/").some(part => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) throw new Error("EIDOLON_VFS_AUTHORING_PATH_INVALID")
    if (normalized.has(relative)) throw new Error("EIDOLON_VFS_AUTHORING_PATH_DUPLICATE")
    normalized.set(relative, new Uint8Array(file.bytes))
  }
  return normalized
}
function packageFileType(relative: string, bytes: Uint8Array): { readonly fileType: "text" | "xnl" | "binary"; readonly content: string } {
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return { fileType: relative.toLowerCase().endsWith(".xnl") ? "xnl" : "text", content }
  } catch {
    if (relative.toLowerCase().endsWith(".xnl")) throw new Error("EIDOLON_VFS_AUTHORING_XNL_UTF8_INVALID")
    return { fileType: "binary", content: Buffer.from(bytes).toString("base64") }
  }
}
