import { createRecoveryHooks, createSnapshotCodec } from "depa-actor";

import { createActor, type AiAgentActor, type CreateActorParams } from "../actor";
import {
  RUNTIME_SNAPSHOT_SCHEMA_VERSION,
  type RuntimeSnapshotActor,
} from "./types";

const ACTOR_SNAPSHOT_CODEC = createSnapshotCodec<AiAgentActor, RuntimeSnapshotActor>({
  serialize: (actor) => {
    const nowIso = new Date().toISOString();
    const mailboxes = {
      control: actor.peekMailbox("control"),
      childDone: actor.peekMailbox("childDone"),
      coordination: actor.peekMailbox("coordination"),
      memberInbox: actor.peekMailbox("memberInbox"),
      humanInput: actor.peekMailbox("humanInput"),
      toolResult: actor.peekMailbox("toolResult"),
      aiGenerated: actor.peekMailbox("aiGenerated"),
    };

    return {
      version: RUNTIME_SNAPSHOT_SCHEMA_VERSION,
      key: actor.key,
      id: actor.id,
      type: actor.type,
      parentKey: actor.parentKey,
      systemPrompts: [...actor.systemPrompts],
      identity: actor.identity,
      agentName: actor.agentName,
      planApproval: actor.planApproval,
      shutdownCoordination: actor.shutdownCoordination,
      toolPolicy: {
        allowedTools: [...actor.toolPolicy.allowedTools],
        enabledToolKeys: [...actor.toolPolicy.enabledToolKeys],
        disabledToolKeys: [...actor.toolPolicy.disabledToolKeys],
        computedDisabledTools: [...actor.toolPolicy.computedDisabledTools],
      },
      modelConfig: { ...actor.modelConfig },
      ctrlOptions: {
        stopAfterFirstTool: actor.ctrlOptions.stopAfterFirstTool,
        stopAfterTools: [...actor.ctrlOptions.stopAfterTools],
        exitAfterToolResult: actor.ctrlOptions.exitAfterToolResult,
      },
      taskTree: structuredClone(actor.taskTree),
      mailboxes: structuredClone(mailboxes),
      toolCallStreamState: {
        toolCalls: structuredClone(actor.toolCallStreamState.toolCalls),
      },
      pendingQuestionnaires: structuredClone(actor.pendingQuestionnaires),
      workContext: structuredClone(actor.workContext),
      continuationBaseline: structuredClone(actor.continuationBaseline),
      lastMemberResultNotifiedAt: actor.lastMemberResultNotifiedAt,
      detachedTask: actor.detachedTask ? structuredClone(actor.detachedTask) : undefined,
      holonState: actor.holonState ? structuredClone(actor.holonState) : undefined,
      updatedAt: nowIso,
      recovery: actor.recovery,
    };
  },
  hydrate: (snapshot) => hydrateActorFromSnapshot(snapshot),
});

const ACTOR_RECOVERY_HOOKS = createRecoveryHooks<AiAgentActor, RuntimeSnapshotActor>({
  afterHydrate: (actor) => {
    actor.recovery = {
      restoredFromSnapshot: true,
      snapshotVersion: actor.recovery?.snapshotVersion,
      restoredAt: actor.recovery?.restoredAt ?? Date.now(),
    };
    return actor;
  },
});

export function serializeActor(actor: AiAgentActor): RuntimeSnapshotActor {
  return ACTOR_SNAPSHOT_CODEC.serialize(actor);
}

function hydrateActorFromSnapshot(
  snapshot: RuntimeSnapshotActor,
  params?: Omit<CreateActorParams, "key" | "id" | "type" | "actorType" | "actorId">,
): AiAgentActor {
  return createActor({
    ...params,
    key: snapshot.key,
    id: snapshot.id,
    type: snapshot.type,
    parentKey: snapshot.parentKey,
    systemPrompts: [...snapshot.systemPrompts],
    messages: structuredClone(params?.messages ?? []),
    identity: snapshot.identity,
    agentName: snapshot.agentName,
    planApproval: snapshot.planApproval,
    shutdownCoordination: snapshot.shutdownCoordination,
    toolPolicy: {
      allowedTools: [...snapshot.toolPolicy.allowedTools],
      enabledToolKeys: [...snapshot.toolPolicy.enabledToolKeys],
      disabledToolKeys: [...snapshot.toolPolicy.disabledToolKeys],
      computedDisabledTools: [...snapshot.toolPolicy.computedDisabledTools],
    },
    modelConfig: { ...snapshot.modelConfig },
    ctrlOptions: {
      stopAfterFirstTool: snapshot.ctrlOptions.stopAfterFirstTool,
      stopAfterTools: [...snapshot.ctrlOptions.stopAfterTools],
      exitAfterToolResult: snapshot.ctrlOptions.exitAfterToolResult,
    },
    taskTree: structuredClone(snapshot.taskTree),
    mailboxes: {
      control: structuredClone(snapshot.mailboxes.control),
      childDone: structuredClone(snapshot.mailboxes.childDone),
      coordination: structuredClone(snapshot.mailboxes.coordination),
      memberInbox: structuredClone(snapshot.mailboxes.memberInbox),
      humanInput: structuredClone(snapshot.mailboxes.humanInput),
      toolResult: structuredClone(snapshot.mailboxes.toolResult),
      aiGenerated: structuredClone(snapshot.mailboxes.aiGenerated),
    },
    toolCallStreamState: {
      toolCalls: structuredClone(snapshot.toolCallStreamState.toolCalls),
    },
    pendingQuestionnaires: structuredClone(snapshot.pendingQuestionnaires),
    workContext: snapshot.workContext ? structuredClone(snapshot.workContext) : undefined,
    continuationBaseline: snapshot.continuationBaseline ? structuredClone(snapshot.continuationBaseline) : undefined,
    lastMemberResultNotifiedAt: snapshot.lastMemberResultNotifiedAt ?? null,
    detachedTask: snapshot.detachedTask ? structuredClone(snapshot.detachedTask) : undefined,
    holonState: snapshot.holonState ? structuredClone(snapshot.holonState) : undefined,
    recovery: {
      restoredFromSnapshot: true,
      snapshotVersion: snapshot.version,
      restoredAt: Date.now(),
    },
  });
}

export function hydrateActor(
  snapshot: RuntimeSnapshotActor,
  params?: Omit<CreateActorParams, "key" | "id" | "type" | "actorType" | "actorId">,
): AiAgentActor {
  const hydrated = ACTOR_SNAPSHOT_CODEC.hydrate(snapshot);
  const actor = params ? hydrateActorFromSnapshot(snapshot, params) : hydrated;
  return ACTOR_RECOVERY_HOOKS.afterHydrate?.(actor) ?? actor;
}
