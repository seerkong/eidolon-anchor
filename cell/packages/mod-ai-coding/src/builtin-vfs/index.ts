import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  loadResourceTreeFromReadPort,
  type LoadedResourceTree,
  type ResourcePackageReadPort,
} from "halfcode-compiler.xnl/resource-core"
import type { DataElementNode } from "xnl-core"
import {
  VirtualFileSystem,
  deserializeVfsSnapshotFromString,
  type VfsEntry,
  type VfsStat,
} from "xnl-vfs"

import {
  BUILTIN_EIDOLON_SNAPSHOT_FILE_NAME,
  BUILTIN_EIDOLON_VFS_ASSET_PATH,
  BUILTIN_EIDOLON_VFS_SCHEMA,
} from "./constants"

export * from "./constants"
export * from "./effective"

export type BuiltinEidolonVfsDigest = `sha256:${string}`

export interface BuiltinEidolonVfsAssetPort {
  readonly source: "source" | "bunfs"
  readSnapshotBytes(): Promise<Uint8Array>
}

export interface BuiltinEidolonVfsSnapshotProof {
  readonly schemaVersion: typeof BUILTIN_EIDOLON_VFS_SCHEMA
  readonly sourceRevision: BuiltinEidolonVfsDigest
  readonly treeDigest: BuiltinEidolonVfsDigest
  readonly rootPath: "/.eidolon"
  readonly nodeCount: number
}

export interface BuiltinEidolonVfsEntry {
  readonly kind: "file" | "directory"
  readonly logicalPath: string
  readonly nodeId: string
  readonly size?: number
  readonly contentDigest?: BuiltinEidolonVfsDigest
}

export interface BuiltinEidolonVfsReadPort {
  readonly snapshot: BuiltinEidolonVfsSnapshotProof
  stat(logicalPath: string): Promise<BuiltinEidolonVfsEntry | undefined>
  readDirectory(logicalPath: string): Promise<readonly BuiltinEidolonVfsEntry[] | undefined>
  readBytes(logicalPath: string): Promise<Uint8Array | undefined>
}

export interface BuiltinEidolonVfs {
  readonly snapshot: BuiltinEidolonVfsSnapshotProof
  readonly readPort: BuiltinEidolonVfsReadPort
  /** Canonical full snapshot node supplied only to the Effective VFS materializer. */
  readonly vfsSnapshot: DataElementNode
}

export interface BuiltinEidolonResourceTree {
  readonly builtin: BuiltinEidolonVfs
  readonly tree: LoadedResourceTree
}

export interface EmbeddedBuiltinFile extends Blob {
  readonly name?: string
}

function digest(bytes: string | Uint8Array): BuiltinEidolonVfsDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function normalizedLogicalPath(logicalPath: string): string {
  if (
    logicalPath !== "/.eidolon"
    && !logicalPath.startsWith("/.eidolon/")
  ) {
    throw new TypeError(`Builtin Eidolon VFS path is outside /.eidolon: ${logicalPath}`)
  }
  if (
    logicalPath.includes("\\")
    || logicalPath.endsWith("/")
    || logicalPath.split("/").some((segment, index) => index > 0 && (!segment || segment === "." || segment === ".."))
  ) {
    throw new TypeError(`Builtin Eidolon VFS path is not canonical: ${logicalPath}`)
  }
  return logicalPath
}

function toXnlVfsPath(logicalPath: string): string {
  return `vfs://${normalizedLogicalPath(logicalPath)}`
}

function missingVfsEntry(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function toEntry(stat: VfsStat | VfsEntry, contentDigest?: BuiltinEidolonVfsDigest): BuiltinEidolonVfsEntry {
  return Object.freeze({
    kind: stat.kind === "folder" ? "directory" : "file",
    logicalPath: stat.path.slice("vfs://".length),
    nodeId: stat.metadataId,
    ...(stat.kind === "file" && "size" in stat && stat.size !== undefined ? { size: stat.size } : {}),
    ...(contentDigest ? { contentDigest } : {}),
  })
}

function fileBytes(vfs: VirtualFileSystem, logicalPath: string): Uint8Array {
  const vfsPath = toXnlVfsPath(logicalPath)
  const payload = vfs.readFile(vfsPath)
  return vfs.readFileType(vfsPath) === "binary"
    ? Uint8Array.from(Buffer.from(payload, "base64"))
    : new TextEncoder().encode(payload)
}

async function treeProof(vfs: VirtualFileSystem, sourceRevision: BuiltinEidolonVfsDigest): Promise<BuiltinEidolonVfsSnapshotProof> {
  const facts: string[] = []
  const visit = (logicalPath: string): void => {
    const stat = vfs.stat(toXnlVfsPath(logicalPath))
    if (stat.kind === "folder") {
      facts.push(`directory\u0000${logicalPath}\u0000${stat.metadataId}`)
      for (const child of vfs.readdir(toXnlVfsPath(logicalPath))) visit(child.path.slice("vfs://".length))
      return
    }
    const bytes = fileBytes(vfs, logicalPath)
    facts.push(`file\u0000${logicalPath}\u0000${stat.metadataId}\u0000${digest(bytes)}`)
  }
  visit("/.eidolon")
  return Object.freeze({
    schemaVersion: BUILTIN_EIDOLON_VFS_SCHEMA,
    sourceRevision,
    treeDigest: digest(facts.join("\n")),
    rootPath: "/.eidolon",
    nodeCount: facts.length,
  })
}

function createReadPort(vfs: VirtualFileSystem, snapshot: BuiltinEidolonVfsSnapshotProof): BuiltinEidolonVfsReadPort {
  return Object.freeze({
    snapshot,
    async stat(logicalPath: string) {
      try {
        const stat = vfs.stat(toXnlVfsPath(logicalPath))
        const contentDigest = stat.kind === "file" ? digest(fileBytes(vfs, logicalPath)) : undefined
        return toEntry(stat, contentDigest)
      } catch (error) {
        if (missingVfsEntry(error)) return undefined
        throw error
      }
    },
    async readDirectory(logicalPath: string) {
      try {
        const entries = vfs.readdir(toXnlVfsPath(logicalPath)).map((entry) => toEntry(entry))
        return Object.freeze(entries)
      } catch (error) {
        if (missingVfsEntry(error) || (error instanceof Error && "code" in error && error.code === "ENOTDIR")) return undefined
        throw error
      }
    },
    async readBytes(logicalPath: string) {
      try {
        return new Uint8Array(fileBytes(vfs, logicalPath))
      } catch (error) {
        if (missingVfsEntry(error) || (error instanceof Error && "code" in error && error.code === "EISDIR")) return undefined
        throw error
      }
    },
  })
}

export function createSourceBuiltinEidolonVfsAssetPort(
  filePath = path.join(fileURLToPath(new URL(".", import.meta.url)), BUILTIN_EIDOLON_SNAPSHOT_FILE_NAME),
): BuiltinEidolonVfsAssetPort {
  return Object.freeze({
    source: "source" as const,
    async readSnapshotBytes() {
      return new Uint8Array(await readFile(filePath))
    },
  })
}

function embeddedFiles(files?: readonly EmbeddedBuiltinFile[]): readonly EmbeddedBuiltinFile[] {
  if (files) return files
  const bun = (globalThis as { Bun?: { embeddedFiles?: readonly EmbeddedBuiltinFile[] } }).Bun
  return bun?.embeddedFiles ?? []
}

function matchingEmbeddedFiles(files: readonly EmbeddedBuiltinFile[]): readonly EmbeddedBuiltinFile[] {
  return files.filter((file) => file.name?.replaceAll("\\", "/") === BUILTIN_EIDOLON_VFS_ASSET_PATH)
}

export function createEmbeddedBuiltinEidolonVfsAssetPort(
  files?: readonly EmbeddedBuiltinFile[],
): BuiltinEidolonVfsAssetPort {
  const matches = matchingEmbeddedFiles(embeddedFiles(files))
  if (matches.length !== 1) {
    throw new TypeError(`Expected exactly one BunFS Builtin Eidolon VFS asset at '${BUILTIN_EIDOLON_VFS_ASSET_PATH}', found ${matches.length}`)
  }
  const asset = matches[0]!
  return Object.freeze({
    source: "bunfs" as const,
    async readSnapshotBytes() {
      return new Uint8Array(await asset.arrayBuffer())
    },
  })
}

export function createBuiltinEidolonVfsAssetPort(
  files?: readonly EmbeddedBuiltinFile[],
): BuiltinEidolonVfsAssetPort {
  const available = embeddedFiles(files)
  return matchingEmbeddedFiles(available).length > 0
    ? createEmbeddedBuiltinEidolonVfsAssetPort(available)
    : createSourceBuiltinEidolonVfsAssetPort()
}

export function createBuiltinEidolonResourcePackageReadPort(
  readPort: Pick<BuiltinEidolonVfsReadPort, "stat" | "readDirectory" | "readBytes">,
): ResourcePackageReadPort {
  return Object.freeze({
    async stat(sourcePath: string) {
      const entry = await readPort.stat(sourcePath)
      return entry ? { kind: entry.kind } : undefined
    },
    async readDirectory(sourcePath: string) {
      const entries = await readPort.readDirectory(sourcePath)
      return entries?.map((entry) => Object.freeze({
        name: entry.logicalPath.split("/").at(-1) ?? "",
        kind: entry.kind,
      }))
    },
    async readBytes(sourcePath: string) {
      return readPort.readBytes(sourcePath)
    },
  })
}

export async function loadBuiltinEidolonVfs(port = createBuiltinEidolonVfsAssetPort()): Promise<BuiltinEidolonVfs> {
  const bytes = await port.readSnapshotBytes()
  let source: string
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new TypeError("Builtin Eidolon VFS snapshot is not valid UTF-8")
  }
  const vfs = new VirtualFileSystem(deserializeVfsSnapshotFromString(source))
  if (!vfs.exists("vfs:///.eidolon") || !vfs.exists("vfs:///.eidolon/resources")) {
    throw new TypeError("Builtin Eidolon VFS snapshot must contain /.eidolon/resources")
  }
  const snapshot = await treeProof(vfs, digest(bytes))
  return Object.freeze({ snapshot, readPort: createReadPort(vfs, snapshot), vfsSnapshot: vfs.getSnapshot() })
}

export async function loadBuiltinEidolonResourceTree(
  port = createBuiltinEidolonVfsAssetPort(),
): Promise<BuiltinEidolonResourceTree> {
  const builtin = await loadBuiltinEidolonVfs(port)
  const tree = await loadResourceTreeFromReadPort({
    port: createBuiltinEidolonResourcePackageReadPort(builtin.readPort),
    rootPath: "/.eidolon/resources",
  })
  return Object.freeze({ builtin, tree })
}
