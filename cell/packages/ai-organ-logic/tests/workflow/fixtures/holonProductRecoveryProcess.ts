import { open, readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { createHolonRepairResourceProductFixture } from "./holonRepairResourceProductRuntime"

const [root, phase] = process.argv.slice(2)
if (!root || !["crash", "recover"].includes(phase!)) throw new Error("Invalid product recovery arguments")

async function writeDurable(name: string, value: unknown): Promise<void> {
  const handle = await open(path.join(root!, name), "wx")
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
  const directory = await open(root!, "r")
  try { await directory.sync() } finally { await directory.close() }
}

async function readJson(name: string): Promise<any> {
  return JSON.parse(await readFile(path.join(root!, name), "utf8"))
}

const fixture = await createHolonRepairResourceProductFixture({ root, version: 2, existing: phase === "recover" })
async function records(directory: string): Promise<unknown[]> {
  const names = await readdir(directory)
  return Promise.all(names.filter(name => name.endsWith(".json")).sort().map(async name => JSON.parse(await readFile(path.join(directory, name), "utf8"))))
}

async function journalEvidence() {
  return {
    intents: await records(path.join(fixture.supportRoot, "holon-task-pump", "intents")),
    results: await records(path.join(fixture.supportRoot, "holon-task-pump", "results")),
    acceptances: await records(fixture.acceptanceRoot),
  }
}

const host = await fixture.openStandalone({ afterAccepted: async (fact) => {
  if (phase !== "crash") return
  // Assignment receipt publication is independent of the asynchronous actor wake.
  for (let count = 0; count < 500; count++) {
    try { await readJson("assignment-receipt.json"); break } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await Bun.sleep(10)
    }
  }
  const receipt = await readJson("assignment-receipt.json")
  const selector = { admissionId: host.admissionIds[0]!, taskSpaceId: receipt.task.taskSpaceId, taskId: receipt.task.taskId }
  const observation = await host.capability.service.observe(selector)
  await writeDurable("crash-evidence.json", {
    pid: process.pid, fact, observation,
    verification: await fixture.verify((fact.output as { value: string }).value),
    providerRequests: fixture.transport.requests.length,
    journal: await journalEvidence(),
  })
  // Simulate an accepted adapter effect whose pump result has not yet returned.
  process.exit(73)
} })

try {
  if (phase === "crash") {
    const receipt = await host.capability.service.assign({ kind: "admission", admissionId: host.admissionIds[0]! }, {
      kind: "holon-task-runtime-invocation", schemaVersion: "eidolon.holon-task-runtime-invocation/v1",
      requestId: "product-os-order", idempotencyKey: "product-os-order", replyMode: "none", occurredAt: new Date().toISOString(),
      origin: { kind: "product", surface: "HolonAssign", requestRef: "request:product-os-order" },
      taskRequest: { kind: "derive", name: "Compute order artifact across process exit" }, input: fixture.input,
    }, { leaseDurationMs: 5_000, maxSteps: 16 })
    await writeDurable("assignment-receipt.json", receipt)
    for (let count = 0; count < 2_000; count++) {
      const observation = await host.capability.service.observe({ admissionId: host.admissionIds[0]!, taskSpaceId: receipt.task.taskSpaceId, taskId: receipt.task.taskId })
      if (observation.status === "Failed") throw new Error(`Product task failed before acceptance: ${JSON.stringify({ observation, transportFailures: fixture.transport.failures.map(String) })}`)
      await Bun.sleep(10)
    }
    throw new Error("Product accepted-before-result crash window was not reached")
  }
  const receipt = await readJson("assignment-receipt.json")
  const crash = await readJson("crash-evidence.json")
  const selector = { admissionId: crash.observation.admissionId ?? host.admissionIds[0]!, taskSpaceId: receipt.task.taskSpaceId, taskId: receipt.task.taskId }
  let observation = await host.capability.service.observe(selector)
  for (let count = 0; count < 1_500 && observation.status !== "Succeeded" && observation.status !== "Failed"; count++) {
    await Bun.sleep(10)
    observation = await host.capability.service.observe(selector)
  }
  if (observation.status !== "Succeeded") throw new Error(`Product recovery did not succeed: ${JSON.stringify(observation)}`)
  const artifacts = await readdir(path.join(root, "artifacts"))
  await writeDurable("recovery-evidence.json", {
    pid: process.pid, observation, artifacts,
    artifactBytes: await readFile(path.join(root, "artifacts", crash.fact.output.value), "utf8"),
    verification: await fixture.verify(crash.fact.output.value), providerRequests: fixture.transport.requests.length,
    newArtifactAcceptances: fixture.effects.filter(effect => effect.accepted).length,
    journal: await journalEvidence(),
    repeated: await host.capability.service.observe(selector),
  })
} finally {
  host.close()
  await fixture.transport.close()
}
