/**
 * P3 (track isolate-runtime-projection-surfaces) — domain-owned session delete
 * capability. Behavior-delta requirement `surface-destroy-via-domain-capability`,
 * case `session-delete-routes-through-capability`: surface session destroy is
 * mediated by a domain-owned delete capability that owns recursive removal of the
 * session truth dir, symmetric to the upgrade capabilities in this module.
 *
 * Unit contract for `deleteFileStoreAiRuntimeSession({ sessionDir })`:
 *  - removes the whole session truth dir (conversation files, runtime_state,
 *    snapshots, surface sidecar) recursively → reports `{ status: "deleted" }`.
 *  - idempotent on an already-absent dir → reports `{ status: "absent" }`,
 *    no throw.
 */
import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { deleteFileStoreAiRuntimeSession } from "../src"

function makeTempSessionDir(): string {
  return path.join(
    os.tmpdir(),
    `ai-runtime-control-composer-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
}

describe("deleteFileStoreAiRuntimeSession (domain-owned session destroy)", () => {
  it("recursively removes the session truth dir and reports deleted", async () => {
    const sessionDir = makeTempSessionDir()
    // Populate a representative session truth tree: conversation facts,
    // runtime_state, snapshots, and the surface sidecar — all under the dir.
    fs.mkdirSync(path.join(sessionDir, "conversation"), { recursive: true })
    fs.writeFileSync(
      path.join(sessionDir, "conversation", "session.index.json"),
      JSON.stringify({ version: 1 }),
    )
    fs.mkdirSync(path.join(sessionDir, "runtime_state"), { recursive: true })
    fs.writeFileSync(path.join(sessionDir, "runtime_state", "questionnaires.xnl"), "")
    fs.writeFileSync(path.join(sessionDir, "tui-session.json"), JSON.stringify({ title: "x" }))

    expect(fs.existsSync(sessionDir)).toBe(true)

    const result = await deleteFileStoreAiRuntimeSession({ sessionDir })

    expect(result.status).toBe("deleted")
    expect(fs.existsSync(sessionDir)).toBe(false)
  })

  it("is idempotent on an already-absent session dir and reports absent", async () => {
    const sessionDir = makeTempSessionDir()
    expect(fs.existsSync(sessionDir)).toBe(false)

    const result = await deleteFileStoreAiRuntimeSession({ sessionDir })

    expect(result.status).toBe("absent")
    expect(fs.existsSync(sessionDir)).toBe(false)
  })
})
