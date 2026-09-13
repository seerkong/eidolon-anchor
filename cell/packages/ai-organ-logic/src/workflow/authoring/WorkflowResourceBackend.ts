import { createHash } from "node:crypto"
import path from "node:path"

import type {
  EidolonVfsEntry,
  EidolonVfsReadPort,
} from "@cell/symbiont-contract/resource/EffectiveEidolonVFS"
import { loadResourceTree, type AuthoredResourceTree } from "halfcode-compiler.xnl/resource-core"

import type {
  EidolonAppResourceRegistryAdapter,
  EidolonEffectiveVfsAuthoringPort,
  EidolonResourceRegistrySnapshot,
  ResourcePackageLayerBinding,
} from "../../resources"
import { NodeWorkflowAuthoringStore } from "./WorkflowAuthoringStore"

export type WorkflowResourceBackendFile = Readonly<{
  path: string
  bytes: Uint8Array
}>

export type WorkflowResourceBackendBinding = Readonly<{
  registry: EidolonAppResourceRegistryAdapter
  layers: readonly ResourcePackageLayerBinding[]
  effectiveVfsAuthoring?: EidolonEffectiveVfsAuthoringPort
}>

export type WorkflowResourceBackendCandidate = Readonly<{
  tree: AuthoredResourceTree
  snapshot: EidolonResourceRegistrySnapshot
  ownedPaths: ReadonlySet<string>
  effectiveReadPort?: EidolonVfsReadPort
}>

export type WorkflowResourceBackend = Readonly<{
  mode: "physical" | "effective-vfs"
  workspaceResourceRoot: string
  readBaseFiles(): Promise<WorkflowResourceBackendFile[]>
  loadLiveSnapshot(): Promise<EidolonResourceRegistrySnapshot>
  loadCandidate(input: Readonly<{
    files: readonly WorkflowResourceBackendFile[]
    physicalRoot?: string
  }>): Promise<WorkflowResourceBackendCandidate>
}>

const EFFECTIVE_RESOURCE_ROOT = "/.eidolon/resources"

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function exactRelativePath(value: string): string {
  if (!value || value.includes("\\") || value.startsWith("/") || value.endsWith("/")
    || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Workflow ResourcePackage file path is not canonical: ${value}`)
  }
  return value
}

function digest(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function candidateReadPort(base: EidolonVfsReadPort, files: readonly WorkflowResourceBackendFile[]): EidolonVfsReadPort {
  const entries = new Map<string, Uint8Array>()
  for (const file of files) {
    const relative = exactRelativePath(file.path)
    if (entries.has(relative)) throw new Error(`Workflow ResourcePackage candidate has duplicate path: ${relative}`)
    entries.set(relative, new Uint8Array(file.bytes))
  }
  const paths = [...entries.keys()].sort(compareCodeUnits)
  const directories = new Set<string>([EFFECTIVE_RESOURCE_ROOT])
  for (const relative of paths) {
    const parts = relative.split("/")
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(`${EFFECTIVE_RESOURCE_ROOT}/${parts.slice(0, index).join("/")}`)
    }
  }
  const candidateDigest = digest(JSON.stringify(paths.map((relative) => ({
    path: relative,
    digest: digest(entries.get(relative)!),
  }))))
  const snapshot = Object.freeze({
    ...base.snapshot,
    baseRevision: base.snapshot.revision,
    revision: candidateDigest,
    treeDigest: candidateDigest,
    materializationReceiptId: `candidate:${candidateDigest.slice("sha256:".length)}`,
  })
  const inCandidateRoot = (logicalPath: string) => (
    logicalPath === EFFECTIVE_RESOURCE_ROOT || logicalPath.startsWith(`${EFFECTIVE_RESOURCE_ROOT}/`)
  )
  const relative = (logicalPath: string) => logicalPath.slice(`${EFFECTIVE_RESOURCE_ROOT}/`.length)
  const entry = (logicalPath: string): EidolonVfsEntry | undefined => {
    if (logicalPath === EFFECTIVE_RESOURCE_ROOT || directories.has(logicalPath)) {
      return Object.freeze({ kind: "directory" as const, logicalPath, nodeId: `candidate-directory:${digest(logicalPath)}` })
    }
    const bytes = entries.get(relative(logicalPath))
    return bytes === undefined ? undefined : Object.freeze({
      kind: "file" as const,
      logicalPath,
      nodeId: `candidate-file:${digest(logicalPath)}`,
      size: bytes.byteLength,
      contentDigest: digest(bytes),
    })
  }
  return Object.freeze({
    snapshot,
    async stat(logicalPath: string) {
      return inCandidateRoot(logicalPath) ? entry(logicalPath) : base.stat(logicalPath)
    },
    async readDirectory(logicalPath: string) {
      if (!inCandidateRoot(logicalPath)) return base.readDirectory(logicalPath)
      if (!directories.has(logicalPath)) return undefined
      const prefix = logicalPath === EFFECTIVE_RESOURCE_ROOT ? `${EFFECTIVE_RESOURCE_ROOT}/` : `${logicalPath}/`
      const children = new Map<string, EidolonVfsEntry>()
      for (const directory of directories) {
        if (!directory.startsWith(prefix)) continue
        const tail = directory.slice(prefix.length)
        if (tail && !tail.includes("/")) children.set(tail, entry(directory)!)
      }
      for (const filePath of paths) {
        const absolute = `${EFFECTIVE_RESOURCE_ROOT}/${filePath}`
        if (!absolute.startsWith(prefix)) continue
        const tail = absolute.slice(prefix.length)
        if (tail && !tail.includes("/")) children.set(tail, entry(absolute)!)
      }
      return Object.freeze([...children.entries()].sort(([left], [right]) => compareCodeUnits(left, right)).map(([, value]) => value))
    },
    async readBytes(logicalPath: string) {
      if (!inCandidateRoot(logicalPath)) return base.readBytes(logicalPath)
      const bytes = entries.get(relative(logicalPath))
      return bytes === undefined ? undefined : new Uint8Array(bytes)
    },
  })
}

async function physicalTree(rootDir: string): Promise<WorkflowResourceBackendFile[]> {
  const store = new NodeWorkflowAuthoringStore(rootDir)
  const paths = await store.tree()
  return Promise.all(paths.map(async (filePath) => ({ path: filePath, bytes: await store.readBytes(filePath) })))
}

function physicalBackend(binding: WorkflowResourceBackendBinding): WorkflowResourceBackend {
  const workspace = binding.layers.find((layer) => layer.id === "workspace")
  if (!workspace) throw new Error("Workflow resource-package authoring requires one injected workspace layer")
  const candidateLayers = (candidateRoot: string) => Object.freeze(binding.layers.map((layer) => Object.freeze(
    layer.id === "workspace" ? { id: "workspace" as const, rootDir: candidateRoot } : layer,
  )))
  return Object.freeze({
    mode: "physical" as const,
    workspaceResourceRoot: workspace.rootDir,
    readBaseFiles: () => physicalTree(workspace.rootDir),
    loadLiveSnapshot: () => binding.registry.loadIsolatedSnapshot({ layers: binding.layers }),
    async loadCandidate(input) {
      if (!input.physicalRoot) throw new Error("Workflow physical ResourcePackage candidate requires its authored session root")
      const tree = await loadResourceTree({ rootDir: input.physicalRoot })
      const snapshot = await binding.registry.loadIsolatedSnapshot({ layers: candidateLayers(input.physicalRoot) })
      return Object.freeze({
        tree,
        snapshot,
        ownedPaths: new Set(input.files.map((file) => exactRelativePath(file.path))),
      })
    },
  })
}

function effectiveBackend(binding: WorkflowResourceBackendBinding): WorkflowResourceBackend {
  const authoring = binding.effectiveVfsAuthoring!
  return Object.freeze({
    mode: "effective-vfs" as const,
    workspaceResourceRoot: authoring.workspaceResourceRoot,
    async readBaseFiles() {
      const readPort = authoring.read().readPort
      const files: WorkflowResourceBackendFile[] = []
      const visit = async (logicalPath: string): Promise<void> => {
        const children = await readPort.readDirectory(logicalPath)
        if (children) {
          for (const child of children) await visit(child.logicalPath)
          return
        }
        const bytes = await readPort.readBytes(logicalPath)
        if (bytes === undefined) throw new Error(`Effective ResourcePackage source disappeared: ${logicalPath}`)
        files.push({ path: logicalPath.slice(`${EFFECTIVE_RESOURCE_ROOT}/`.length), bytes })
      }
      await visit(EFFECTIVE_RESOURCE_ROOT)
      return files.sort((left, right) => compareCodeUnits(left.path, right.path))
    },
    loadLiveSnapshot: () => binding.registry.loadIsolatedEffectiveVfsSnapshot(authoring.read().readPort),
    async loadCandidate(input) {
      const readPort = candidateReadPort(authoring.read().readPort, input.files)
      const snapshot = await binding.registry.loadIsolatedEffectiveVfsSnapshot(readPort)
      return Object.freeze({
        tree: snapshot.contentIdentityLayers[0]!.tree,
        snapshot,
        ownedPaths: new Set(input.files.map((file) => exactRelativePath(file.path))),
        effectiveReadPort: readPort,
      })
    },
  })
}

export function createWorkflowResourceBackend(binding: WorkflowResourceBackendBinding): WorkflowResourceBackend {
  return binding.effectiveVfsAuthoring ? effectiveBackend(binding) : physicalBackend(binding)
}

export function workflowResourceBackendOwnsPath(
  candidate: WorkflowResourceBackendCandidate,
  logicalPath: string,
): boolean {
  return candidate.ownedPaths.has(exactRelativePath(logicalPath))
}
