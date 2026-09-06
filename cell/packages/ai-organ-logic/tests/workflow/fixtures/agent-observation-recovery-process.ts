import { readFile } from "node:fs/promises"
import { EidolonAppResourceRegistryAdapter } from "../../../src/resources/EidolonAppResourceRegistryAdapter"
import { EidolonAutonomousAgentResourceHost } from "../../../src/resources/EidolonAutonomousAgentResourceHost"
import { openAuthoringTestRuntime } from "./agent-authoring-process"

const data = JSON.parse(await readFile(process.argv[2]!, "utf8"))
const runtime = await openAuthoringTestRuntime(data.input)
try {
  const host = new EidolonAutonomousAgentResourceHost(runtime.registry, [], data.input.supportRoot, runtime.authoring)
  const previousRegistry = await EidolonAppResourceRegistryAdapter.restoreFrozenAgentExecution(data.previousBundle)
  const previousExecution = await previousRegistry.freezeWorkflowAgentTaskBinding(data.previousTask)
  const observation = await host.restoreObservation(data.material)
  const result = await host.prepare({ observation, decision: data.decision, target: data.target, previousExecution })
  if (result.status !== "prepared") throw Error(JSON.stringify(result))
  const frozen = await EidolonAppResourceRegistryAdapter.restoreFrozenAgentExecution(result.frozenExecution)
  const proof = await frozen.freezeWorkflowAgentTaskBinding(result.taskBinding.task)
  process.stdout.write(JSON.stringify({ receipt: result.authoringReceipt, feedback: result.admission.candidate.authoringEvidence?.revision?.feedback,
    originalRevision: result.snapshot.registryRevision, liveRevision: (await runtime.registry.snapshot()).registryRevision,
    fingerprint: result.taskBinding.semanticFingerprint, restoredFingerprint: proof.semanticFingerprint }))
} finally { runtime.authority.close() }
