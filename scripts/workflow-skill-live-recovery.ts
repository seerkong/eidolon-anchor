import { strict as assert } from "node:assert"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { WorkflowDepaPersistence } from "../cell/packages/ai-organ-logic/src/workflow/runtime/WorkflowDepaPersistence"
import { WorkflowFactStore } from "../cell/packages/ai-organ-logic/src/workflow/runtime/WorkflowFactStore"

/** Reopen real frozen instances and canonical checkpoints in a separate, provider-free process. */
export async function recoverLiveWorkflowFacts(factRoot: string) {
  const facts = new WorkflowFactStore(factRoot)
  const instances = await facts.listInstances()
  assert(instances.length > 0, "No persisted workflow instances")
  const persistence = new WorkflowDepaPersistence(factRoot)
  const recovered = []
  for (const instance of instances) {
    if (instance.status !== "Completed") continue
    const definition = await facts.loadDefinitionRevision(instance.definitionRevision)
    assert(definition, `Missing frozen definition for ${instance.instanceId}`)
    const materialized = persistence.load(instance.instanceId)
    assert.equal(materialized.descriptor.definition.revision, instance.definitionRevision)
    for (const [relative, expected] of Object.entries(definition.files)) {
      assert.equal(await readFile(path.join(facts.frozenDefinitionRoot(definition.revision), relative), "utf8"), expected,
        `Frozen source changed: ${relative}`)
    }
    for (const runId of instance.runIds) {
      const descriptor = await facts.loadDescriptor(runId)
      const receipt = await facts.loadRunReceipt(runId)
      assert.equal(descriptor?.instanceId, instance.instanceId)
      assert.equal(descriptor?.definitionRevision, instance.definitionRevision)
      assert.equal(receipt?.definitionRevision, instance.definitionRevision)
      const checkpoint = await persistence.checkpointStore.load({ instanceId: instance.instanceId, runId })
      assert(checkpoint, `Missing canonical checkpoint for ${runId}`)
      const state = await persistence.stateProjection(instance.instanceId).loadRunState({
        workflow: { scheme: "resource", ref: instance.workflowRef }, runId, generation: descriptor!.generation,
      })
      assert.equal(state?.status, "Succeeded", `Run ${runId} did not recover a successful checkpoint`)
      // Ctrl stores its returned value in execution state; Data has a direct output.
      const execution = checkpoint.state.__flow_execution__ as { returned?: boolean; output?: unknown } | undefined
      const output = checkpoint.profile.kind === "AICtrlWorkflow"
        ? (assert.equal(execution?.returned, true), execution?.output)
        : checkpoint.output
      assert.notEqual(output, undefined, `Run ${runId} has no recovered output`)
      recovered.push({ instanceId: instance.instanceId, runId, workflowRef: instance.workflowRef,
        definitionRevision: instance.definitionRevision, profileKind: checkpoint.profile.kind,
        status: state?.status, output })
    }
  }
  assert(recovered.length > 0, "No completed runs recovered")
  return { schemaVersion: "workflow.skill-live-recovery/v1", pid: process.pid, providerRequests: 0,
    factRoot: path.resolve(factRoot), recovered }
}

if (import.meta.main) {
  const [factRoot, output] = process.argv.slice(2)
  assert(factRoot, "Usage: bun run scripts/workflow-skill-live-recovery.ts <fact-root> [output.json]")
  const report = JSON.stringify(await recoverLiveWorkflowFacts(path.resolve(factRoot)), null, 2) + "\n"
  if (output) await writeFile(output, report)
  else process.stdout.write(report)
}
