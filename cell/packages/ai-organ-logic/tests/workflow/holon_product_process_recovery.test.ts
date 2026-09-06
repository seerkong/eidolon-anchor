import { expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { testSourceTsconfig } from "./fixtures/test-source-binding"

it("recovers an actually verified order artifact after accepted-before-result in a new OS process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-product-os-"))
  const config = testSourceTsconfig()
  const entry = path.join(import.meta.dir, "fixtures/holonProductRecoveryProcess.ts")
  async function child(phase: "crash" | "recover"): Promise<number> {
    const subprocess = Bun.spawn([process.execPath, "--tsconfig-override", config, entry, root, phase], { stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => subprocess.kill("SIGKILL"), 30_000)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([subprocess.exited, new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text()])
      expect({ exitCode, stdout, stderr }, `product recovery ${phase}`).toMatchObject({ exitCode: phase === "crash" ? 73 : 0, stdout: "" })
      return subprocess.pid
    } finally { clearTimeout(timer) }
  }
  try {
    const firstPid = await child("crash")
    const crash = JSON.parse(await readFile(path.join(root, "crash-evidence.json"), "utf8"))
    expect(crash.pid).toBe(firstPid)
    expect(crash.observation.status).toBe("Running")
    expect(crash.verification.passed).toBe(true)
    expect(crash.providerRequests).toBe(1)
    expect(crash.journal.intents).toHaveLength(1)
    expect(crash.journal.results).toHaveLength(0)
    expect(crash.journal.acceptances).toHaveLength(1)
    expect(crash.journal.acceptances[0]).toMatchObject(crash.fact)
    const before = await readFile(path.join(root, "artifacts", crash.fact.output.value), "utf8")
    const secondPid = await child("recover")
    const recovered = JSON.parse(await readFile(path.join(root, "recovery-evidence.json"), "utf8"))
    expect(secondPid).not.toBe(firstPid)
    expect(secondPid).not.toBe(process.pid)
    expect(recovered.pid).toBe(secondPid)
    expect(recovered.observation.status).toBe("Succeeded")
    expect(recovered.verification.passed).toBe(true)
    expect(recovered.artifactBytes).toBe(before)
    expect(recovered.artifacts).toEqual([crash.fact.output.value])
    expect(recovered.providerRequests).toBe(0)
    expect(recovered.newArtifactAcceptances).toBe(0)
    expect(recovered.journal.results).toHaveLength(1)
    expect(recovered.journal.acceptances).toEqual(crash.journal.acceptances)
    expect(recovered.journal.results[0].output).toEqual(crash.fact.output)
    expect(recovered.repeated).toEqual(recovered.observation)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 65_000)
