import { createHash, randomUUID } from "node:crypto"
import process from "node:process"
import path from "node:path"
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  unlink,
} from "node:fs/promises"

import {
  HolonTaskPumpJournalError,
  type HolonTaskPumpJournalCollection,
  type HolonTaskPumpJournalStorePort,
} from "@cell/ai-organ-contract/organization/HolonTaskPumpJournal"

const fail = (code: string, message: string): never => {
  throw new HolonTaskPumpJournalError(code, message)
}

const compareUtf16 = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

function fileKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
}

async function writeImmutable(directory: string, target: string, bytes: Uint8Array): Promise<void> {
  const candidate = path.join(directory, `.${path.basename(target)}.${randomUUID()}.candidate`)
  const handle = await open(candidate, "wx", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await link(candidate, target)
    const directoryHandle = await open(directory, "r")
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if (!sameBytes(await readFile(target), bytes)) {
      return fail("EIDOLON_HOLON_PUMP_JOURNAL_CONFLICT", `Immutable fact '${path.basename(target)}' conflicts.`)
    }
  } finally {
    await unlink(candidate).catch(() => undefined)
  }
}

type Lock = Readonly<{ readonly file: string; readonly token: string }>

export interface FileHolonTaskPumpJournalStoreRuntime {
  readonly now: () => number
}

export interface FileHolonTaskPumpJournalStoreConfig {
  readonly supportRoot: string
  readonly lockTimeoutMs?: number
}

/** Physical bytes and exclusive locks only; journal rules are owned by the caller. */
export class FileHolonTaskPumpJournalStore implements HolonTaskPumpJournalStorePort {
  private readonly root: string
  private readonly lockTimeoutMs: number

  constructor(
    private readonly runtime: FileHolonTaskPumpJournalStoreRuntime,
    config: FileHolonTaskPumpJournalStoreConfig,
  ) {
    this.root = path.join(config.supportRoot, "holon-task-pump")
    this.lockTimeoutMs = config.lockTimeoutMs ?? 5_000
  }

  async read(collection: HolonTaskPumpJournalCollection, identity: string): Promise<Uint8Array> {
    const directory = await this.directory(collection)
    return readFile(path.join(directory, `${fileKey(identity)}.json`))
  }

  async list(collection: HolonTaskPumpJournalCollection): Promise<readonly Uint8Array[]> {
    const directory = await this.directory(collection)
    return Promise.all((await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort(compareUtf16)
      .map((name) => readFile(path.join(directory, name))))
  }

  async writeImmutable(
    collection: HolonTaskPumpJournalCollection,
    identity: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const directory = await this.directory(collection)
    // Preserve dispatch's original layout preparation before publishing its intent.
    if (collection === "intents") await this.directory("results")
    await writeImmutable(directory, path.join(directory, `${fileKey(identity)}.json`), bytes)
  }

  async withExclusive<T>(identity: string, operation: () => Promise<T>): Promise<T> {
    const lock = await this.acquire(identity)
    try {
      return await operation()
    } finally {
      await this.release(lock)
    }
  }

  private async directory(name: string): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const directory = path.join(this.root, name)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    return directory
  }

  private async acquire(identity: string): Promise<Lock> {
    const directory = await this.directory("locks")
    const file = path.join(directory, `${fileKey(identity)}.lock`)
    const deadline = this.runtime.now() + this.lockTimeoutMs
    while (true) {
      const token = randomUUID()
      try {
        const handle = await open(file, "wx", 0o600)
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: this.runtime.now() }))
        await handle.close()
        return Object.freeze({ file, token })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        const facts = await stat(file).catch(() => undefined)
        if (facts && this.runtime.now() - facts.mtimeMs > this.lockTimeoutMs) {
          const owner = JSON.parse(await readFile(file, "utf8")) as { readonly pid?: unknown }
          if (typeof owner.pid !== "number" || !this.pidAlive(owner.pid)) {
            await unlink(file).catch(() => undefined)
            continue
          }
        }
        if (this.runtime.now() >= deadline) return fail("EIDOLON_HOLON_PUMP_JOURNAL_LOCK_TIMEOUT", "Dispatch result lock did not become available.")
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
  }

  private async release(lock: Lock): Promise<void> {
    const owner = JSON.parse(await readFile(lock.file, "utf8")) as { readonly token?: unknown }
    if (owner.token !== lock.token) return fail("EIDOLON_HOLON_PUMP_JOURNAL_LOCK_CONFLICT", "Dispatch lock ownership changed.")
    await unlink(lock.file)
  }

  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }
}
