import { createActor, type AiAgentActor, type CreateActorParams } from "@cell/ai-core-logic/runtime/actor";
import { ensureVmRuntimeContext, type AiAgentVm } from "@cell/ai-core-logic/runtime/runtime";
import type { AiAgentOrchestratorDriver } from "../OrchestratorDriver";
import {
  bindActorConversationProjectionToVm,
  emitConversationDomainEvent,
  ensureVmConversationDomainRuntime,
  resolveConversationSessionIdFromVm,
} from "../conversation/ConversationDomainRuntime";

export type InteractiveActorRuntime = {
  vm: AiAgentVm;
  driver: AiAgentOrchestratorDriver;
  newId: () => string;
  now: () => number;
};

export type CreateInteractiveActorInput = Pick<CreateActorParams,
  "modelConfig" | "llmClient" | "systemPrompts" | "callbacks" | "toolPolicy" | "contextPolicy"
> & { displayName?: string };

export function createInteractiveActor(
  runtime: InteractiveActorRuntime,
  input: CreateInteractiveActorInput,
  config: { basePriority?: number } = {},
): { actor: AiAgentActor; fiberId: string } {
  const id = runtime.newId();
  const key = `interactive:${id}`;
  if (!id || runtime.vm.actors[key] || runtime.vm.actorRuntime.has(key) || Object.values(runtime.vm.actors).some((actor) => actor.id === id)) {
    throw new Error("interactive_actor_identity_conflict");
  }
  const actor = createActor({ ...input, id, key, type: "interactive", agentName: input.displayName });
  const fiberId = `${key}:${id}`;
  const now = runtime.now();
  runtime.vm.effects.actorRegistration?.beforeRegister({ actorId: actor.id, actorKey: actor.key, actorType: actor.type, identity: actor.identity });
  const conversation = ensureVmConversationDomainRuntime(runtime.vm);
  runtime.vm.actors[key] = actor;
  try {
    runtime.vm.actorRuntime.register(key, actor);
    bindActorConversationProjectionToVm(runtime.vm, actor);
    runtime.driver.spawnFiber({
      fiberId, vm: runtime.vm, actor, messages: actor.messages,
      basePriority: config.basePriority ?? 1, lane: "interactive", workload: "session_turn",
    });
    runtime.driver.suspendFiber(fiberId, now, "idle_external" as any, "continue_others");
  } catch (error) {
    delete runtime.vm.actors[key];
    if (runtime.vm.actorRuntime.has(key)) runtime.vm.actorRuntime.unregister(key);
    throw error;
  }
  ensureVmRuntimeContext(runtime.vm).driver = runtime.driver;
  emitConversationDomainEvent(conversation, {
    type: "local_conversation_session_actor_bound",
    sessionId: resolveConversationSessionIdFromVm(runtime.vm),
    actorKey: key, actorId: id, actorName: input.displayName, actorKind: "interactive",
    occurredAt: new Date(now).toISOString(),
  });
  return { actor, fiberId };
}
