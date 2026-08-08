import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

export type WorkflowAuthoringFile = {
  path: string
  content: string
}

export interface WorkflowAuthoringStore {
  readonly rootPath: string
  read(relativePath: string): Promise<string>
  tree(relativePath?: string): Promise<string[]>
  writeAtomic(relativePath: string, content: string): Promise<void>
  replaceTreeAtomic(relativeRoot: string, files: readonly WorkflowAuthoringFile[]): Promise<void>
  delete(relativePath: string): Promise<void>
}

function assertRelativePath(value: string, allowRoot = false): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "")
  if ((!normalized && !allowRoot) || path.posix.isAbsolute(normalized)) {
    throw new Error(`Workflow authoring path must be relative: ${value}`)
  }
  const segments = normalized.split("/")
  if (segments.includes("..") || (segments.includes("") && normalized !== "")) {
    throw new Error(`Workflow authoring path escapes workspace: ${value}`)
  }
  return normalized
}

export function hashWorkflowSources(files: readonly WorkflowAuthoringFile[]): string {
  const hash = createHash("sha256")
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(file.path)
    hash.update("\0")
    hash.update(file.content)
    hash.update("\0")
  }
  return `sha256:${hash.digest("hex")}`
}

export class NodeWorkflowAuthoringStore implements WorkflowAuthoringStore {
  readonly rootPath: string

  constructor(rootPath: string) {
    if (!path.isAbsolute(rootPath)) {
      throw new Error(`Workflow authoring root must be an absolute host path: ${rootPath}`)
    }
    this.rootPath = path.resolve(rootPath)
  }

  private resolve(relativePath: string, allowRoot = false): string {
    const safe = assertRelativePath(relativePath, allowRoot)
    const resolved = path.resolve(this.rootPath, safe)
    if (resolved !== this.rootPath && !resolved.startsWith(`${this.rootPath}${path.sep}`)) {
      throw new Error(`Workflow authoring path escapes workspace: ${relativePath}`)
    }
    return resolved
  }

  private async assertNoSymlinkPath(relativePath: string, allowMissing = false): Promise<void> {
    const safe = assertRelativePath(relativePath, true)
    let current = this.rootPath
    const parts = safe ? safe.split("/") : []
    for (let index = -1; index < parts.length; index += 1) {
      if (index >= 0) current = path.join(current, parts[index]!)
      try {
        const info = await lstat(current)
        if (info.isSymbolicLink()) throw new Error(`Workflow authoring path contains a symlink: ${relativePath}`)
        if (index >= 0 && index < parts.length - 1 && !info.isDirectory()) {
          throw new Error(`Workflow authoring path traverses a non-directory: ${relativePath}`)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return
        throw error
      }
    }
  }

  async read(relativePath: string): Promise<string> {
    await this.assertNoSymlinkPath(relativePath)
    return readFile(this.resolve(relativePath), "utf8")
  }

  async tree(relativePath = ""): Promise<string[]> {
    const base = this.resolve(relativePath, true)
    await this.assertNoSymlinkPath(relativePath, true)
    const prefix = assertRelativePath(relativePath, true)
    const result: string[] = []
    const visit = async (directory: string, logicalPrefix: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(directory, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
      }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const logicalPath = logicalPrefix ? `${logicalPrefix}/${entry.name}` : entry.name
        const physicalPath = path.join(directory, entry.name)
        if (entry.isSymbolicLink()) throw new Error(`Workflow authoring path contains a symlink: ${logicalPath}`)
        if (entry.isDirectory()) await visit(physicalPath, logicalPath)
        else if (entry.isFile()) result.push(logicalPath)
      }
    }
    await visit(base, prefix)
    return result
  }

  async writeAtomic(relativePath: string, content: string): Promise<void> {
    await this.assertNoSymlinkPath(relativePath, true)
    const destination = this.resolve(relativePath)
    await mkdir(path.dirname(destination), { recursive: true })
    const temporary = `${destination}.tmp-${randomUUID()}`
    try {
      await writeFile(temporary, content, "utf8")
      await rename(temporary, destination)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  async replaceTreeAtomic(
    relativeRoot: string,
    files: readonly WorkflowAuthoringFile[],
  ): Promise<void> {
    const safeRoot = assertRelativePath(relativeRoot)
    const destination = this.resolve(safeRoot)
    await this.assertNoSymlinkPath(safeRoot, true)
    const parent = path.dirname(destination)
    const token = randomUUID()
    const staging = path.join(parent, `.${path.basename(destination)}.staging-${token}`)
    const backup = path.join(parent, `.${path.basename(destination)}.backup-${token}`)
    await mkdir(staging, { recursive: true })
    let backedUp = false
    try {
      for (const file of files) {
        const safeFile = assertRelativePath(file.path)
        const stagedFile = path.resolve(staging, safeFile)
        if (!stagedFile.startsWith(`${staging}${path.sep}`)) {
          throw new Error(`Workflow bundle file escapes staging root: ${file.path}`)
        }
        await mkdir(path.dirname(stagedFile), { recursive: true })
        await writeFile(stagedFile, file.content, "utf8")
      }
      await mkdir(parent, { recursive: true })
      try {
        await stat(destination)
        await rename(destination, backup)
        backedUp = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      await rename(staging, destination)
      if (backedUp) await rm(backup, { recursive: true, force: true })
    } catch (error) {
      if (backedUp) {
        await rm(destination, { recursive: true, force: true }).catch(() => undefined)
        await rename(backup, destination).catch(() => undefined)
      }
      throw error
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      await rm(backup, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async delete(relativePath: string): Promise<void> {
    await this.assertNoSymlinkPath(relativePath, true)
    await rm(this.resolve(relativePath), { recursive: true, force: true })
  }
}
