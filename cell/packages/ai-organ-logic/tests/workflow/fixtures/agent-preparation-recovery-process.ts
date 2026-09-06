import { readFile } from "node:fs/promises"
import { assertFrozenAIAgentTaskBinding } from "ai-workflow-logic/run-freeze"
import { EidolonAppResourceRegistryAdapter } from "../../../src/resources/EidolonAppResourceRegistryAdapter"
import { EidolonAutonomousAgentResourceHost } from "../../../src/resources/EidolonAutonomousAgentResourceHost"
import { AIDataAgentResourcePreparationService, EidolonFixedAgentExecutionRegistry } from "../../../src/workflow/runtime/AIDataAgentResourcePreparation"

const input = JSON.parse(await readFile(process.argv[2]!, "utf8"))
const layers = [{ id: "workspace" as const, rootDir: input.removedResourceRoot }]
const unavailable = new EidolonAppResourceRegistryAdapter({ layers })
const host = new EidolonAutonomousAgentResourceHost(unavailable, layers, input.supportRoot)
const recovered = await new AIDataAgentResourcePreparationService(host).recover(input.receipt)
const proof = assertFrozenAIAgentTaskBinding(recovered.proof)
const prepared = await new EidolonFixedAgentExecutionRegistry(undefined, unavailable, [recovered]).prepareWorkflowAgentExecution(proof.task)
const contextVersion = prepared.plan.agentConfig.contextPipelineExecution!.execute({
  plan: () => ({ stage: "plan" }), materialize: () => ({ stage: "materialization" }),
  completeEstimate: () => ({ stage: "estimate" }), convert: () => ({ stage: "provider" }),
}, { mode: "record", actorKey: "fixture", sessionId: "fixture", model: "fixture" })
process.stdout.write(JSON.stringify({ semanticFingerprint: proof.semanticFingerprint, snapshotRevision: proof.snapshotRevision, messages: prepared.plan.messages, contextVersion }))
