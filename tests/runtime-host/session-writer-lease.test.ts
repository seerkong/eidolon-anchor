import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSessionWriterLeaseEffects } from "../../cell/packages/ai-runtime-host-support/src/sessionWriterLease"

test("writer lease covers canonical aliases and preserves lazy session materialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "anchor-writer-"))
  const alias = `${root}-alias`
  try {
    await symlink(root, alias)
    const effects = createSessionWriterLeaseEffects()
    const key = join(root, "sessions", "s1")
    const first = await effects.acquire(key)
    try {
      expect(existsSync(key)).toBe(false)
      await expect(createSessionWriterLeaseEffects().acquire(join(alias, "sessions", "s1"))).rejects.toThrow("session_writer_conflict")
      const independent = await effects.acquire(join(root, "sessions", "s2"))
      independent.release()
    } finally { first.release() }
    const replacement = await effects.acquire(key)
    first.release()
    await expect(effects.acquire(key)).rejects.toThrow("session_writer_conflict")
    replacement.release()
  } finally {
    await rm(alias, { force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test("another process cannot write; SIGKILL releases the lease without deleting its inode", async () => {
  const root = await mkdtemp(join(tmpdir(), "anchor-writer-process-"))
  const key = join(root, "session")
  const module = new URL("../../cell/packages/ai-runtime-host-support/src/sessionWriterLease.ts", import.meta.url).pathname
  const child = Bun.spawn([process.execPath, "--eval", `
    import { createSessionWriterLeaseEffects } from ${JSON.stringify(module)};
    await createSessionWriterLeaseEffects().acquire(${JSON.stringify(key)});
    console.log("lease-held");
    setInterval(() => {}, 1000);
  `], { stdout: "pipe", stderr: "pipe" })
  try {
    const reader = child.stdout.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain("lease-held")
    reader.releaseLock()
    await expect(createSessionWriterLeaseEffects().acquire(key)).rejects.toThrow("session_writer_conflict")
    child.kill("SIGKILL")
    await child.exited
    const replacement = await createSessionWriterLeaseEffects().acquire(key)
    replacement.release()
  } finally {
    child.kill()
    await child.exited
    await rm(root, { recursive: true, force: true })
  }
}, 10000)
