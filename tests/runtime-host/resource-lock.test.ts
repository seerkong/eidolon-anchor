import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHostResourceEffects } from "../../cell/packages/ai-runtime-host-support/src"

describe("host workspace effect leases", () => {
  test("canonical aliases serialize mutation while read IO and other workspaces proceed", async () => {
    const root = await mkdtemp(join(tmpdir(), "anchor-effect-"))
    const other = await mkdtemp(join(tmpdir(), "anchor-effect-other-"))
    const alias = `${root}-alias`
    const locks = createHostResourceEffects()
    try {
      await symlink(root, alias)
      const first = await locks.acquire({ workDir: root, kind: "workspace_mutation" })
      let secondEntered = false
      const second = locks.acquire({ workDir: alias, kind: "unclassified" }).then((lease) => {
        secondEntered = true
        return lease
      })
      const read = await locks.acquire({ workDir: root, kind: "read_only" })
      const independent = await locks.acquire({ workDir: other, kind: "workspace_mutation" })
      expect(secondEntered).toBe(false)
      first.release()
      const next = await second
      expect(secondEntered).toBe(true)
      first.release()
      let thirdEntered = false
      const third = locks.acquire({ workDir: root, kind: "workspace_mutation" }).then((lease) => {
        thirdEntered = true
        return lease
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(thirdEntered).toBe(false)
      next.release()
      ;(await third).release()
      read.release()
      independent.release()
    } finally {
      locks.close()
      await Promise.all([rm(root, { recursive: true, force: true }), rm(other, { recursive: true, force: true }), rm(alias, { force: true })])
    }
  })

  test("aborting a waiter does not release the held leaf effect or cancel the next actor", async () => {
    const root = await mkdtemp(join(tmpdir(), "anchor-effect-abort-"))
    const locks = createHostResourceEffects()
    try {
      const held = await locks.acquire({ workDir: root, kind: "workspace_mutation" })
      const abort = new AbortController()
      const cancelled = locks.acquire({ workDir: root, kind: "unclassified", signal: abort.signal })
      abort.abort(new Error("stop waiting"))
      await expect(cancelled).rejects.toThrow("stop waiting")
      let entered = false
      const following = locks.acquire({ workDir: root, kind: "workspace_mutation" }).then((lease) => {
        entered = true
        return lease
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(entered).toBe(false)
      held.release()
      ;(await following).release()
      expect(entered).toBe(true)
    } finally {
      locks.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test("close rejects pending and future work without pretending an active effect completed", async () => {
    const root = await mkdtemp(join(tmpdir(), "anchor-effect-close-"))
    const locks = createHostResourceEffects()
    try {
      const held = await locks.acquire({ workDir: root, kind: "unclassified" })
      const pending = locks.acquire({ workDir: root, kind: "workspace_mutation" })
      locks.close()
      await expect(pending).rejects.toThrow("resource_lock_closed")
      await expect(locks.acquire({ workDir: root, kind: "read_only" })).rejects.toThrow("resource_lock_closed")
      held.release()
      held.release()
    } finally {
      locks.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
