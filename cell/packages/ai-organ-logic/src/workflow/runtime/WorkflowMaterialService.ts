import { createHash } from "node:crypto"
import { copyFile, lstat, mkdir, readFile, readdir, rm, stat } from "node:fs/promises"
import path from "node:path"

import type { WorkflowAuthoringWorkspace } from "../authoring"
import { WorkflowFactStore } from "./WorkflowFactStore"
import type {
  WorkflowMaterialManifestEntry,
  WorkflowMaterialRevision,
  WorkflowMaterialRevisionRef,
} from "./WorkflowLifecycleFacts"

function normalizeMaterialRef(value: string): string {
  const ref = value.trim()
  if (!/^material:\/\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..")) {
    throw new Error(`Invalid Material ref: ${value}`)
  }
  return ref
}

function normalizeRelative(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "")
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").some((part) => !part || part === "..")) {
    throw new Error(`Material path must be workspace-relative and containment-safe: ${value}`)
  }
  return normalized
}

function digest(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`
}

function manifestRevision(entries: readonly WorkflowMaterialManifestEntry[]): string {
  const hash = createHash("sha256")
  for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path)
    hash.update("\0")
    hash.update(entry.digest)
    hash.update("\0")
    hash.update(String(entry.size))
    hash.update("\0")
  }
  return `sha256:${hash.digest("hex")}`
}

export class WorkflowMaterialService {
  constructor(
    private readonly workspace: WorkflowAuthoringWorkspace,
    private readonly facts: WorkflowFactStore,
  ) {}

  private root(): string {
    return path.resolve(this.workspace.store.rootPath)
  }

  private resolve(relativePath: string): string {
    const safe = normalizeRelative(relativePath)
    const resolved = path.resolve(this.root(), safe)
    if (!resolved.startsWith(`${this.root()}${path.sep}`)) {
      throw new Error(`Material path escapes workspace: ${relativePath}`)
    }
    return resolved
  }

  private async assertNoSymlink(relativePath: string, allowMissingLeaf = false): Promise<void> {
    const safe = normalizeRelative(relativePath)
    let current = this.root()
    const rootInfo = await lstat(current)
    if (rootInfo.isSymbolicLink()) throw new Error("Workflow workspace root cannot be a symlink")
    const parts = safe.split("/")
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]!)
      try {
        const info = await lstat(current)
        if (info.isSymbolicLink()) throw new Error(`Material path contains a symlink: ${relativePath}`)
        if (index < parts.length - 1 && !info.isDirectory()) {
          throw new Error(`Material path traverses a non-directory: ${relativePath}`)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissingLeaf) return
        throw error
      }
    }
  }

  async import(input: {
    materialRef: string
    sourcePath: string
    provenance?: Record<string, unknown>
    confirmed?: boolean
  }): Promise<WorkflowMaterialRevision | Record<string, unknown>> {
    const materialRef = normalizeMaterialRef(input.materialRef)
    const sourcePath = normalizeRelative(input.sourcePath)
    if (input.confirmed !== true) {
      return {
        ok: false,
        status: "confirmation_required",
        operation: "material.import",
        materialRef,
        sourcePath,
        effectDispatched: false,
      }
    }
    await this.assertNoSymlink(sourcePath)
    const source = this.resolve(sourcePath)
    const sourceStat = await stat(source)
    const files: Array<{ relative: string; absolute: string; content: Uint8Array }> = []
    const visit = async (absolute: string, relative: string): Promise<void> => {
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) throw new Error(`Material import rejects symlinks: ${sourcePath}`)
      if (info.isDirectory()) {
        for (const name of (await readdir(absolute)).sort()) {
          await visit(path.join(absolute, name), relative ? `${relative}/${name}` : name)
        }
        return
      }
      if (!info.isFile()) throw new Error(`Material import supports only regular files and directories: ${sourcePath}`)
      files.push({ relative: relative || path.basename(source), absolute, content: await readFile(absolute) })
    }
    await visit(source, sourceStat.isDirectory() ? "" : path.basename(source))
    const manifest = files.map(({ relative, content }) => ({
      path: relative,
      digest: digest(content),
      size: content.byteLength,
    }))
    const revision = manifestRevision(manifest)
    const existing = await this.facts.loadMaterialRevision(materialRef, revision)
    if (existing) return existing
    const contentRoot = this.facts.materialContentRoot(revision)
    for (const file of files) {
      const target = path.join(contentRoot, ...file.relative.split("/"))
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(file.absolute, target)
    }
    const material: WorkflowMaterialRevision = {
      materialRef,
      revision,
      manifest,
      provenance: {
        operation: "import",
        sourcePath,
        ...(input.provenance ?? {}),
      },
      createdAt: Date.now(),
    }
    await this.facts.saveMaterialRevision(material)
    return material
  }

  async inspect(ref: WorkflowMaterialRevisionRef): Promise<WorkflowMaterialRevision> {
    const materialRef = normalizeMaterialRef(ref.materialRef)
    const material = await this.facts.loadMaterialRevision(materialRef, ref.revision)
    if (!material) throw new Error(`Material revision not found: ${materialRef}@${ref.revision}`)
    return material
  }

  async export(input: {
    material: WorkflowMaterialRevisionRef
    destinationPath: string
    confirmed?: boolean
  }): Promise<Record<string, unknown>> {
    const material = await this.inspect(input.material)
    const destinationPath = normalizeRelative(input.destinationPath)
    if (input.confirmed !== true) {
      return {
        ok: false,
        status: "confirmation_required",
        operation: "material.export",
        material: input.material,
        destinationPath,
        files: material.manifest.map((entry) => entry.path),
        effectDispatched: false,
      }
    }
    await mkdir(this.root(), { recursive: true })
    await this.assertNoSymlink(destinationPath, true)
    const destination = this.resolve(destinationPath)
    const singleFile = material.manifest.length === 1
    for (const entry of material.manifest) {
      const target = singleFile ? destination : path.join(destination, ...entry.path.split("/"))
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(path.join(this.facts.materialContentRoot(material.revision), ...entry.path.split("/")), target)
    }
    return {
      ok: true,
      status: "exported",
      material: input.material,
      destinationPath,
      files: material.manifest.map((entry) => entry.path),
    }
  }

  async cleanup(input: {
    confirmed?: boolean
    materialRef?: string
  }): Promise<Record<string, unknown>> {
    const materialRef = input.materialRef ? normalizeMaterialRef(input.materialRef) : undefined
    const revisions = await this.facts.listMaterialRevisions(materialRef)
    const bindings = await this.facts.listMaterialBindings()
    const receipts = await this.facts.listRunReceipts()
    const leased = new Set<string>()
    for (const binding of bindings) leased.add(`${binding.material.materialRef}@${binding.material.revision}`)
    for (const receipt of receipts) {
      for (const binding of receipt.inputMaterials) leased.add(`${binding.material.materialRef}@${binding.material.revision}`)
      for (const output of receipt.outputMaterials) leased.add(`${output.materialRef}@${output.revision}`)
    }
    const candidates = revisions.filter((item) => !leased.has(`${item.materialRef}@${item.revision}`))
    if (input.confirmed !== true) {
      return {
        ok: false,
        status: "confirmation_required",
        operation: "material.cleanup",
        candidates: candidates.map(({ materialRef: ref, revision }) => ({ materialRef: ref, revision })),
        effectDispatched: false,
      }
    }
    for (const item of candidates) await this.facts.removeMaterialRevision(item.materialRef, item.revision)
    return {
      ok: true,
      status: "cleaned",
      removed: candidates.map(({ materialRef: ref, revision }) => ({ materialRef: ref, revision })),
    }
  }
}
