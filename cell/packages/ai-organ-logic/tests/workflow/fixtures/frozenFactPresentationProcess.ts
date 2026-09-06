import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createActor } from "@cell/ai-core-logic/runtime/actor";
import { hydrateActor, serializeActor } from "@cell/ai-core-logic/runtime/snapshot/actorSnapshot";
import { createVM, ensureVmRuntimeContext } from "@cell/ai-core-logic/runtime/runtime";
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry";
import { EidolonAppResourceRegistryAdapter, restoreAgentContextPipelineExecution } from "../../../src/resources/EidolonAppResourceRegistryAdapter";
import { buildProviderPromptForActorTurn, seedConversationDomainFromActorSeedMessages } from "../../../src/exec/AiAgentExecutor";
import { appendActorProviderContextFactToConversationDomainRuntime, createConversationDomainRuntime, getConversationActorRawStateFromVm, injectConversationActorRawState } from "../../../src/conversation/ConversationDomainRuntime";

const [phase, root, snapshotPath] = process.argv.slice(2);
try {
  const saved = phase === "restore" ? JSON.parse(await readFile(snapshotPath!, "utf8")) : undefined;
  const plan = phase === "capture" ? await new EidolonAppResourceRegistryAdapter({
    workspaceRoot: root!, layers: [{ id: "workspace", rootDir: path.join(root!, ".eidolon/resources") }],
  }).materializeAgentExecutionPlan("resource://fixture.Agent", { scope: "standalone" }) : undefined;
  const actor = saved ? hydrateActor(saved.actor) : createActor({
    key: "main", systemPrompts: plan!.agentConfig.seedMessages?.map(message => message.content),
    executionContract: plan!.agentConfig.executionContract, contextPipeline: plan!.agentConfig.contextPipeline,
    contextPipelineExecution: plan!.agentConfig.contextPipelineExecution, durableMaterials: plan!.agentConfig.durableMaterials,
  });
  if (saved) {
    if (actor.contextPipelineExecution) throw new Error("EXECUTABLE_RESTORED_WITHOUT_OWNER");
    actor.contextPipelineExecution = await restoreAgentContextPipelineExecution(actor);
  }
  if (!actor.contextPipelineExecution?.factPresentation) throw new Error("FROZEN_PRESENTATION_NOT_ADMITTED");
  const runtime = createConversationDomainRuntime();
  const vm = createVM({ controlActorKey: actor.key, actors: { main: actor },
    registries: { toolRegistry: new ToolFuncRegistry() }, options: { storage: { logs: false, files: false } },
    outerCtx: { metadata: { sessionId: "frozen-fact" } } });
  ensureVmRuntimeContext(vm).conversationDomainRuntime = runtime;
  if (saved) injectConversationActorRawState(runtime, saved.conversation);
  else {
    seedConversationDomainFromActorSeedMessages({ vm, actor, seedMessages: [{ role: "user", content: "original history anchor" }] });
    appendActorProviderContextFactToConversationDomainRuntime({ runtime, sessionId: "frozen-fact", actorKey: actor.key,
      actorId: actor.id, namespace: "workflow-stage-context", occurredAt: "2026-09-06T00:00:00.000Z",
      payload: { stage: "coding", context: "already admitted instructions", allowedTools: ["read"], packageProvenanceDigest: "original provenance" } });
    const snapshot = serializeActor(actor);
    if ("contextPipelineExecution" in snapshot) throw new Error("EXECUTABLE_LEAKED_INTO_SNAPSHOT");
    await writeFile(snapshotPath!, JSON.stringify({ actor: snapshot, conversation: getConversationActorRawStateFromVm({ vm, actorKey: actor.key }) }));
  }
  const before = JSON.stringify(getConversationActorRawStateFromVm({ vm, actorKey: actor.key }));
  const build = (recordPromptPlan: boolean) => buildProviderPromptForActorTurn({ vm, actor, tools: [], model: "offline",
    llmAdapter: { type: "openai" } as any, recordPromptPlan });
  const estimate = build(false).providerMessages;
  if (JSON.stringify(getConversationActorRawStateFromVm({ vm, actorKey: actor.key })) !== before) throw new Error("ESTIMATE_CHANGED_FACTS");
  const record = build(true).providerMessages;
  process.stdout.write(JSON.stringify({ pid: process.pid, binding: actor.contextPipeline,
    recipe: actor.contextPipelineExecution.factPresentation, estimate, record,
    generations: runtime.promptStateSignal.get()["frozen-fact::main"].generations.length }));
} catch (error) {
  process.stderr.write(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
}
