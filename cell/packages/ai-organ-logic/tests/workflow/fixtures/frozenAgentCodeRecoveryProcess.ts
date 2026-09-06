import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { hydrateActor, serializeActor } from "@cell/ai-core-logic/runtime/snapshot/actorSnapshot"
import type { AgentContextPipelineExecution, AgentContextPipelineRuntime, AgentContextPipelineStage } from "@cell/ai-core-contract/runtime/AgentContextPipeline"
import { EidolonAppResourceRegistryAdapter, restoreAgentContextPipelineExecution } from "../../../src/resources/EidolonAppResourceRegistryAdapter"

function executeMarkers(execution: AgentContextPipelineExecution, mode: "record" | "estimate") {
  const calls: string[] = []
  const planned = Object.freeze({ stage: "plan" as const })
  const materialized = Object.freeze({ stage: "materialization" as const })
  const estimated = Object.freeze({ stage: "estimate" as const })
  const provider = Object.freeze({ stage: "provider" as const })
  const exact = (actual: AgentContextPipelineStage, expected: AgentContextPipelineStage) => {
    if (actual !== expected) throw new Error("MATURE_PROCESSOR_TOKEN_CHANGED")
  }
  const runtime: AgentContextPipelineRuntime = Object.freeze({
    plan() { calls.push("plan"); return planned },
    materialize(input) { exact(input, planned); calls.push("materialize"); return materialized },
    completeEstimate(input) { exact(input, materialized); calls.push("completeEstimate"); return estimated },
    convert(input) { exact(input, mode === "estimate" ? estimated : materialized); calls.push("convert"); return provider },
  })
  const result = execution.execute(runtime, { mode, actorKey: "frozen-code", sessionId: "session", model: "offline-fixture" })
  exact(result as AgentContextPipelineStage, provider)
  return { calls, stage: provider.stage }
}

const [phase, root, snapshotPath] = process.argv.slice(2)
try {
  let actor
  if (phase === "capture") {
    const registry = new EidolonAppResourceRegistryAdapter({ workspaceRoot: root!, layers: [{ id: "workspace", rootDir: path.join(root!, ".eidolon/resources") }] })
    const plan = await registry.materializeAgentExecutionPlan("resource://eidolon.coding.CodeAgent", { scope: "standalone" })
    if (!plan.agentConfig.contextPipelineExecution) throw new Error("CODE_EXECUTION_NOT_ADMITTED")
    actor = createActor({ key: "frozen-code", systemPrompts: plan.agentConfig.seedMessages?.map(message => message.content),
      executionContract: plan.agentConfig.executionContract, contextPipeline: plan.agentConfig.contextPipeline,
      contextPipelineExecution: plan.agentConfig.contextPipelineExecution, durableMaterials: plan.agentConfig.durableMaterials })
    const snapshot = serializeActor(actor)
    if ("contextPipelineExecution" in snapshot) throw new Error("EXECUTABLE_LEAKED_INTO_SNAPSHOT")
    await writeFile(snapshotPath!, JSON.stringify(snapshot), "utf8")
  } else {
    actor = hydrateActor(JSON.parse(await readFile(snapshotPath!, "utf8")))
    if (actor.contextPipelineExecution) throw new Error("EXECUTABLE_RESTORED_WITHOUT_OWNER")
    actor.contextPipelineExecution = await restoreAgentContextPipelineExecution(actor)
  }
  const execution = actor.contextPipelineExecution
  if (!execution) throw new Error("CODE_EXECUTION_MISSING")
  process.stdout.write(JSON.stringify({ pid: process.pid, binding: actor.contextPipeline,
    systemPrompts: actor.systemPrompts, record: executeMarkers(execution, "record"),
    estimate: executeMarkers(execution, "estimate"), executionDigest: execution.executionDigest }))
} catch (error) {
  process.stderr.write(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = 1
}
