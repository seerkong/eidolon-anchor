import { createHash, randomUUID } from "node:crypto"
import { link, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"

export type WorkflowAuthoringFile = {
  path: string
  content: string
}

export type WorkflowAuthoringBinaryFile = {
  path: string
  bytes: Uint8Array
}

export type WorkflowAuthoringLockOptions = {
  readonly orphanRecoveryEvidencePath?: string
}

export interface WorkflowAuthoringStore {
  readonly rootPath: string
  kind(relativePath: string): Promise<"file" | "directory" | "missing">
  ensureDirectory(relativePath: string): Promise<void>
  read(relativePath: string): Promise<string>
  readBytes(relativePath: string): Promise<Uint8Array>
  tree(relativePath?: string): Promise<string[]>
  writeAtomic(relativePath: string, content: string): Promise<void>
  writeBytesAtomic(relativePath: string, bytes: Uint8Array): Promise<void>
  replaceTreeAtomic(relativeRoot: string, files: readonly WorkflowAuthoringFile[]): Promise<void>
  replaceTreeBytesAtomic(relativeRoot: string, files: readonly WorkflowAuthoringBinaryFile[]): Promise<void>
  withExclusiveLock<T>(
    relativePath: string,
    action: () => Promise<T>,
    options?: WorkflowAuthoringLockOptions,
  ): Promise<T>
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
  return hashWorkflowBinaryFiles(files.map((file) => ({
    path: file.path,
    bytes: new TextEncoder().encode(file.content),
  })))
}

export function hashWorkflowBinaryFiles(files: readonly WorkflowAuthoringBinaryFile[]): string {
  const hash = createHash("sha256")
  for (const file of [...files].sort((left, right) => compareCodeUnits(left.path, right.path))) {
    hash.update(file.path)
    hash.update("\0")
    hash.update(file.bytes)
    hash.update("\0")
  }
  return `sha256:${hash.digest("hex")}`
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

type WorkflowAuthoringLockOwner = {
  readonly schemaVersion: "workflow.authoring-lock-owner/v1"
  readonly ownerId: string
  readonly hostname: string
  readonly pid: number
  readonly acquiredAt: string
}

const LOCK_OWNER_KEYS = Object.freeze([
  "acquiredAt",
  "hostname",
  "ownerId",
  "pid",
  "schemaVersion",
] as const)

function isCanonicalUuidV4(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 36) return false
  const hyphens = new Set([8, 13, 18, 23])
  const hex = "0123456789abcdef"
  for (let index = 0; index < value.length; index += 1) {
    if (hyphens.has(index)) {
      if (value[index] !== "-") return false
    } else if (!hex.includes(value[index]!)) {
      return false
    }
  }
  return value[14] === "4" && "89ab".includes(value[19]!)
}

function parseLockOwner(value: unknown): WorkflowAuthoringLockOwner | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort(compareCodeUnits)
  if (keys.length !== LOCK_OWNER_KEYS.length
    || keys.some((key, index) => key !== LOCK_OWNER_KEYS[index])) return undefined
  if (record.schemaVersion !== "workflow.authoring-lock-owner/v1"
    || !isCanonicalUuidV4(record.ownerId)
    || typeof record.hostname !== "string"
    || !record.hostname
    || typeof record.pid !== "number"
    || !Number.isSafeInteger(record.pid)
    || record.pid <= 0
    || typeof record.acquiredAt !== "string") return undefined
  try {
    if (new Date(record.acquiredAt).toISOString() !== record.acquiredAt) return undefined
  } catch {
    return undefined
  }
  return record as WorkflowAuthoringLockOwner
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return false
    if (code === "EPERM") return true
    throw error
  }
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

  async kind(relativePath: string): Promise<"file" | "directory" | "missing"> {
    await this.assertNoSymlinkPath(relativePath, true)
    try {
      const info = await stat(this.resolve(relativePath, true))
      if (info.isDirectory()) return "directory"
      if (info.isFile()) return "file"
      return "missing"
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"
      throw error
    }
  }

  async ensureDirectory(relativePath: string): Promise<void> {
    await this.assertNoSymlinkPath(relativePath, true)
    const target = this.resolve(relativePath, true)
    const current = await this.kind(relativePath)
    if (current === "file") throw new Error(`Workflow authoring directory path is a file: ${relativePath}`)
    await mkdir(target, { recursive: true })
  }

  async read(relativePath: string): Promise<string> {
    return new TextDecoder("utf-8", { fatal: true }).decode(await this.readBytes(relativePath))
  }

  async readBytes(relativePath: string): Promise<Uint8Array> {
    await this.assertNoSymlinkPath(relativePath)
    return readFile(this.resolve(relativePath))
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
      for (const entry of entries.sort((left, right) => compareCodeUnits(left.name, right.name))) {
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
    return this.writeBytesAtomic(relativePath, new TextEncoder().encode(content))
  }

  async writeBytesAtomic(relativePath: string, bytes: Uint8Array): Promise<void> {
    await this.assertNoSymlinkPath(relativePath, true)
    const destination = this.resolve(relativePath)
    await mkdir(path.dirname(destination), { recursive: true })
    const temporary = `${destination}.tmp-${randomUUID()}`
    try {
      await writeFile(temporary, bytes)
      await rename(temporary, destination)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  async replaceTreeAtomic(
    relativeRoot: string,
    files: readonly WorkflowAuthoringFile[],
  ): Promise<void> {
    return this.replaceTreeBytesAtomic(relativeRoot, files.map((file) => ({
      path: file.path,
      bytes: new TextEncoder().encode(file.content),
    })))
  }

  async replaceTreeBytesAtomic(
    relativeRoot: string,
    files: readonly WorkflowAuthoringBinaryFile[],
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
        await writeFile(stagedFile, file.bytes)
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
      if (backedUp) {
        await rm(backup, { recursive: true, force: true })
        backedUp = false
      }
    } catch (error) {
      if (backedUp) {
        try {
          await rm(destination, { recursive: true, force: true })
          await rename(backup, destination)
          backedUp = false
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `Workflow authoring tree swap failed and backup recovery also failed; backup retained at ${backup}`,
          )
        }
      }
      throw error
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      if (!backedUp) await rm(backup, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async withExclusiveLock<T>(
    relativePath: string,
    action: () => Promise<T>,
    options: WorkflowAuthoringLockOptions = {},
  ): Promise<T> {
    const safePath = assertRelativePath(relativePath)
    const lockPath = this.resolve(safePath)
    const recoveryMarkerPath = `${lockPath}.recovery`
    const evidencePath = options.orphanRecoveryEvidencePath === undefined
      ? undefined
      : this.resolve(assertRelativePath(options.orphanRecoveryEvidencePath))
    await this.assertNoSymlinkPath(safePath, true)
    await mkdir(path.dirname(lockPath), { recursive: true })
    const owner: WorkflowAuthoringLockOwner = Object.freeze({
      schemaVersion: "workflow.authoring-lock-owner/v1",
      ownerId: randomUUID(),
      hostname: hostname(),
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    })
    const ownerBytes = `${JSON.stringify(owner)}\n`
    const claimPath = `${lockPath}.claim-${owner.ownerId}`
    await writeFile(claimPath, ownerBytes, { encoding: "utf8", flag: "wx" })
    let claimPresent = true
    const acquireDeadline = Date.now() + 10_000
    let acquired = false
    try {
      while (!acquired) {
        if (await existsPath(recoveryMarkerPath)) {
          await this.recoverLockPathIfStale(recoveryMarkerPath, evidencePath)
          if (await existsPath(recoveryMarkerPath)) {
            if (Date.now() >= acquireDeadline) {
              throw new Error(`Workflow authoring lock timeout: ${safePath}`)
            }
            await new Promise((resolve) => setTimeout(resolve, 10))
            continue
          }
        }
        try {
          await link(claimPath, lockPath)
          acquired = true
          await rm(claimPath, { force: true })
          claimPresent = false
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        }
        if (await this.lockPathIsRecoverable(lockPath, evidencePath)) {
          let ownsRecoveryMarker = false
          try {
            await link(claimPath, recoveryMarkerPath)
            ownsRecoveryMarker = true
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
          }
          if (ownsRecoveryMarker) {
            try {
              if (await this.lockPathIsRecoverable(lockPath, evidencePath)) {
                const quarantined = `${lockPath}.recovered-${owner.ownerId}`
                try {
                  await rename(lockPath, quarantined)
                  await this.removeMatchingOrphanClaim(lockPath, quarantined)
                  await rm(quarantined, { recursive: true, force: true })
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
                }
              }
            } finally {
              await this.removeOwnedLockPath(recoveryMarkerPath, owner.ownerId)
            }
            continue
          }
        }
        if (Date.now() >= acquireDeadline) {
          throw new Error(`Workflow authoring lock timeout: ${safePath}`)
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return await action()
    } finally {
      if (acquired) await this.removeOwnedLockPath(lockPath, owner.ownerId)
      if (claimPresent) await rm(claimPath, { force: true })
    }
  }

  private async lockPathIsRecoverable(lockPath: string, evidencePath?: string): Promise<boolean> {
    try {
      const owner = parseLockOwner(JSON.parse(await readFile(lockPath, "utf8")))
      if (!owner) return evidencePath !== undefined && await existsPath(evidencePath)
      if (owner.hostname !== hostname()) return false
      return !processIsAlive(owner.pid)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT") return false
      if (code === "EISDIR" || error instanceof SyntaxError) {
        return evidencePath !== undefined && await existsPath(evidencePath)
      }
      throw error
    }
  }

  private async recoverLockPathIfStale(lockPath: string, evidencePath?: string): Promise<void> {
    if (!await this.lockPathIsRecoverable(lockPath, evidencePath)) return
    const quarantined = `${lockPath}.recovered-${randomUUID()}`
    try {
      await rename(lockPath, quarantined)
      await rm(quarantined, { recursive: true, force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }

  private async removeOwnedLockPath(lockPath: string, ownerId: string): Promise<void> {
    try {
      const owner = parseLockOwner(JSON.parse(await readFile(lockPath, "utf8")))
      if (owner?.ownerId !== ownerId) {
        throw new Error(`Workflow authoring lock ownership changed: ${path.basename(lockPath)}`)
      }
      await rm(lockPath, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }

  private async removeMatchingOrphanClaim(lockPath: string, quarantinedLockPath: string): Promise<void> {
    let owner: WorkflowAuthoringLockOwner | undefined
    try {
      owner = parseLockOwner(JSON.parse(await readFile(quarantinedLockPath, "utf8")))
    } catch {
      return
    }
    if (!owner) return
    const parent = path.dirname(lockPath)
    const claimName = `${path.basename(lockPath)}.claim-${owner.ownerId}`
    const claimPath = path.resolve(parent, claimName)
    if (path.dirname(claimPath) !== parent || path.basename(claimPath) !== claimName) return
    try {
      const [lockInfo, claimInfo] = await Promise.all([
        lstat(quarantinedLockPath),
        lstat(claimPath),
      ])
      if (!lockInfo.isFile() || !claimInfo.isFile()
        || lockInfo.dev !== claimInfo.dev
        || lockInfo.ino !== claimInfo.ino) return
      await rm(claimPath, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }

  async delete(relativePath: string): Promise<void> {
    await this.assertNoSymlinkPath(relativePath, true)
    await rm(this.resolve(relativePath), { recursive: true, force: true })
  }
}

async function existsPath(target: string): Promise<boolean> {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}
