import { readFile } from "node:fs/promises"
import { EidolonAppResourceRegistryAdapter } from "../../../src/resources/EidolonAppResourceRegistryAdapter"
import { EidolonAutonomousAgentResourceHost } from "../../../src/resources/EidolonAutonomousAgentResourceHost"
import { AIDataAgentResourcePreparationService, FileAIDataAgentPreparationStore,
  type AIDataAgentPreparationReceipt } from "../../../src/workflow/runtime/AIDataAgentResourcePreparation"

const input = JSON.parse(await readFile(process.argv[2]!, "utf8"))
const registry = new EidolonAppResourceRegistryAdapter({ layers: input.layers })
const host = new EidolonAutonomousAgentResourceHost(registry, input.layers, input.supportRoot)
const service = new AIDataAgentResourcePreparationService(host)
class ExitBeforeFinalSave extends FileAIDataAgentPreparationStore {
  override async save(_receipt: AIDataAgentPreparationReceipt): Promise<void> {
    // Native authoring has returned, but the final preparation is not durable.
    process.exit(73)
  }
}
const store = process.argv[3] === "interrupt"
  ? new ExitBeforeFinalSave(input.storeRoot) : new FileAIDataAgentPreparationStore(input.storeRoot)
const observation = await service.observeDurably({ ...input.target, store, requirement: input.requirement })
const previous = await service.recover(input.previousReceipt)
const decision = await store.loadDecision(input.target.instanceId, input.target.nodeId) ?? input.decision
const prepared = await service.prepareDurably({ ...input.target, store, observation, decision, previousExecution: previous.proof })
if (!("receipt" in prepared)) throw new Error(JSON.stringify(prepared))
const execution = await prepared.executionRegistry!.prepareWorkflowAgentExecution(prepared.receipt.task)
console.log(JSON.stringify({ receipt: prepared.receipt,
  contextVersion: execution.plan.agentConfig.contextPipelineExecution!.execute({} as never, {} as never),
  authoring: await host.loadAuthoringReceipt(prepared.receipt.authoring!.planDigest),
  savedCount: (await store.list(input.target.instanceId)).length }))
