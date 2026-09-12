import { expect, it } from "bun:test"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

for (const workflowEntry of ["ctrl", "data"] as const) it(`${workflowEntry} consumes a durable TaskSpace settlement in a new Workflow PID without live organization sources or redispatch`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-workflow-os-"))
  const entry = path.join(import.meta.dir, "fixtures/holonProductWorkflowRecoveryProcess.ts")
  async function child(phase: "crash" | "recover") {
    const process = Bun.spawn([Bun.which("bun")!, "--tsconfig-override", testSourceTsconfig(), entry, root, phase, workflowEntry], { stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => process.kill("SIGKILL"), 30_000)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()])
      expect({ exitCode, stdout, stderr }, phase).toMatchObject({ exitCode: phase === "crash" ? 74 : 0, stdout: "" })
      return process.pid
    } finally { clearTimeout(timer) }
  }
  try {
    const first = await child("crash")
    const crash = JSON.parse(await readFile(path.join(root, "workflow-crash-evidence.json"), "utf8"))
    expect(crash.pid).toBe(first)
    expect(crash.entry).toBe(workflowEntry)
    expect(crash.workflowRef).toBe(`resource://eidolon.product.${workflowEntry === "ctrl" ? "Ctrl" : "Data"}`)
    await expect(access(path.join(root, crash.resourceRoot))).rejects.toMatchObject({ code: "ENOENT" })
    expect(crash.verification.passed).toBe(true)
    expect(crash.providerRequests).toBe(1)
    expect(crash.fact.settlementReceiptIds).toHaveLength(1)
    expect(crash.snapshot.tasks[0].status).toBe("Succeeded")
    expect(crash.history.filter((event: any) => event.kind === "task.settled")).toHaveLength(1)
    const second = await child("recover")
    const recovered = JSON.parse(await readFile(path.join(root, "workflow-recovery-evidence.json"), "utf8"))
    expect(second).not.toBe(first)
    expect(second).not.toBe(process.pid)
    expect(recovered.pid).toBe(second)
    expect(recovered.entry).toBe(workflowEntry)
    expect(recovered.workflowRef).toBe(crash.workflowRef)
    expect(recovered.liveResourcesAbsent).toBe(true)
    expect(recovered.result).toMatchObject({ terminal: true, status: workflowEntry === "ctrl" ? "Completed" : "Succeeded" })
    expect(recovered.repeated).toEqual(recovered.result)
    expect(recovered.snapshot).toEqual(crash.snapshot)
    expect(recovered.history).toEqual(crash.history)
    expect(recovered.providerRequests).toBe(0)
    expect(recovered.newAcceptances).toBe(0)
    expect(recovered.artifacts).toEqual([crash.artifact])
    expect(recovered.verification.passed).toBe(true)
    expect(JSON.stringify(recovered.checkpoint)).toContain(crash.artifact)
    if (process.env.EIDOLON_HOLON_PROCESS_REPORT_DIR) {
      await mkdir(process.env.EIDOLON_HOLON_PROCESS_REPORT_DIR, { recursive: true })
      await writeFile(path.join(process.env.EIDOLON_HOLON_PROCESS_REPORT_DIR, `${workflowEntry}-workflow-process.json`), JSON.stringify({ crash, recovered }, null, 2) + "\n")
    }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 65_000)
