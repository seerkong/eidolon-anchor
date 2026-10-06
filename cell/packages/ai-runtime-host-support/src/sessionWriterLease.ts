/// <reference types="bun-types" />
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { closeSync, constants, existsSync, mkdirSync, openSync, realpathSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import type { SessionWriterLeaseEffects } from "@cell/ai-runtime-host-contract"

// Resolve existing ancestors without creating the (possibly lazy) session directory.
function canonicalStorageKey(storageKey: string): string {
  let ancestor = resolve(storageKey)
  const suffix: string[] = []
  while (!existsSync(ancestor)) {
    suffix.unshift(basename(ancestor))
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error("session_storage_unavailable")
    ancestor = parent
  }
  return join(realpathSync(ancestor), ...suffix)
}

/** A held SQLite transaction is a kernel-backed process lease, never a PID claim.
 * Do not unlink the lock file: replacing its inode would let two writers coexist.
 * Process termination releases the lock without stale-file deletion or PID reuse races.
 */
export function createSessionWriterLeaseEffects(): SessionWriterLeaseEffects {
  return {
    async acquire(sessionStorageKey) {
      const key = canonicalStorageKey(sessionStorageKey)
      const lockRoot = join(dirname(key), ".writer-locks")
      mkdirSync(lockRoot, { recursive: true, mode: 0o700 })
      const filename = join(lockRoot, `${createHash("sha256").update(key).digest("hex")}.sqlite`)
      const fd = openSync(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
      closeSync(fd)
      let database: Database | undefined
      try {
        database = new Database(filename, { strict: true })
        database.exec("PRAGMA busy_timeout=0")
        database.exec("PRAGMA journal_mode=DELETE")
        database.exec("BEGIN EXCLUSIVE")
      } catch (error) {
        database?.close()
        const code = (error as { code?: string }).code
        if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") throw new Error("session_writer_conflict")
        throw new Error("session_writer_unavailable")
      }
      const held = database
      let released = false
      return {
        release() {
          if (released) return
          released = true
          try { held.exec("ROLLBACK") } finally { held.close() }
        },
      }
    },
  }
}
