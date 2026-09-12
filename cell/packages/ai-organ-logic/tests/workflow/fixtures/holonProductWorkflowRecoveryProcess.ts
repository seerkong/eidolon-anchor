import { access, open, readFile, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { FileTaskSpaceOwner } from "task-manager-file-support"
import { WorkflowRuntimeService } from "../../../src/workflow/runtime/WorkflowRuntimeService"
import { workflowHolonTaskSpaceId } from "../../../src/workflow/runtime"
import { createHolonRepairResourceProductFixture } from "./holonRepairResourceProductRuntime"
import { productRefs } from "./holonRepairResourceProductPackage"

const [root, phase, entry = "ctrl"] = process.argv.slice(2)
if (!root || !["crash", "recover"].includes(phase!) || !["ctrl", "data"].includes(entry!)) throw new Error("Invalid workflow recovery arguments")
const workflowRef = productRefs[entry as "ctrl" | "data"]
const fixture = await createHolonRepairResourceProductFixture({ root, existing: phase === "recover" })
const instanceId = `product-${entry}-process`, runId = `product-${entry}-process-run`
const owner = new FileTaskSpaceOwner({ root: path.join(fixture.supportRoot, "task-spaces") })
const taskSpaceId = workflowHolonTaskSpaceId(runId, "orders")
async function writeDurable(name: string, value: unknown) {
  const file = await open(path.join(root!, name), "wx")
  try { await file.writeFile(JSON.stringify(value)); await file.sync() } finally { await file.close() }
  const directory = await open(root!, "r")
  try { await directory.sync() } finally { await directory.close() }
}
const service = new WorkflowRuntimeService({ vm: fixture.vm, actor: fixture.actor } as any, {
  holonFaults: { afterTaskSpaceSettlement: async (fact) => {
    if (phase !== "crash") return
    const artifact = fixture.effects.at(-1)!.value
    await writeDurable("workflow-crash-evidence.json", { pid: process.pid, entry, workflowRef, resourceRoot: path.relative(root!, fixture.resources), fact, artifact, verification: await fixture.verify(artifact),
      snapshot: await owner.readSnapshot(taskSpaceId), history: await owner.readHistory(taskSpaceId),
      checkpoint: await service.depa.checkpointStore.load({ instanceId, runId }), providerRequests: fixture.transport.requests.length })
    // Frozen deployment and workflow proofs must survive removal of live sources.
    await rm(fixture.resources, { recursive: true, force: true })
    process.exit(74)
  } },
})
try {
  if (phase === "crash") {
    await service.createInstance({ workflowRef, instanceId, initialInput: fixture.input })
    await service.start({ instanceId, runId, confirmed: true })
    throw new Error("Workflow settlement crash window was not reached")
  }
  const crash = JSON.parse(await readFile(path.join(root, "workflow-crash-evidence.json"), "utf8"))
  const result = await service.start({ instanceId, runId, confirmed: true })
  const repeated = await service.start({ instanceId, runId, confirmed: true })
  await writeDurable("workflow-recovery-evidence.json", { pid: process.pid, entry, workflowRef, result, repeated,
    liveResourcesAbsent: await access(fixture.resources).then(() => false, () => true),
    snapshot: await owner.readSnapshot(taskSpaceId), history: await owner.readHistory(taskSpaceId),
    checkpoint: await service.depa.checkpointStore.load({ instanceId, runId }), artifact: crash.artifact,
    verification: await fixture.verify(crash.artifact), artifacts: await readdir(path.join(root, "artifacts")),
    providerRequests: fixture.transport.requests.length, newAcceptances: fixture.effects.filter(effect => effect.accepted).length })
} finally { await fixture.transport.close() }
