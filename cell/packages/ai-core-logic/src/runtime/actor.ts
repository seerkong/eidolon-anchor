import type { ChatMessage, Logger, XStream } from "@shared/composer";
import type { ActorDef, MailboxPriority } from "depa-actor";
import type { AiAgentVm } from "./runtime";
import { createEmptyTaskTree } from "@cell/ai-core-contract/plan/TaskTree";
import type { TaskTree } from "@cell/ai-core-contract/plan/TaskTree";
import type { QuestionnaireRequestPayload } from "@cell/ai-core-contract/runtime/Questionnaire";
import type {
  ActorWorkContextData,
  ContinuationBaselineData,
} from "@cell/ai-core-contract/runtime/ContextControl";
import { TASK_PHASES, WORK_MODES } from "@cell/ai-core-contract/runtime/ContextControl";
import type {
  ActorContext,
  ActorCtrlOptions,
  ActorIdentity,
  ActorMailboxQueues,
  ActorModelConfig,
  ActorRecoveryState,
  ActorToolPolicy,
  ActorToolcallStreamState,
  ActorType,
  AiAgentActorCallbacks,
  AiAgentActorContract,
  AiAgentMailboxSchema,
  AutonomousHolonState,
  AutonomousHolonTaskState,
  DetachedTaskState,
  HolonActorState,
  LeaderLedHolonRouteState,
  LeaderLedHolonState,
} from "@cell/ai-core-contract/runtime/AiAgentActor";

export type {
  ActorContext,
  ActorCtrlOptions,
  ActorIdentity,
  ActorLike,
  ActorMailboxQueues,
  ActorModelConfig,
  ActorRecoveryState,
  ActorToolPolicy,
  ActorToolcallStreamState,
  ActorType,
  AiAgentActorCallbacks,
  AiAgentMailboxSchema,
  AutonomousHolonState,
  AutonomousHolonTaskState,
  DetachedTaskState,
  HolonActorState,
  LeaderLedHolonRouteState,
  LeaderLedHolonState,
} from "@cell/ai-core-contract/runtime/AiAgentActor";

export const AI_AGENT_MAILBOXES = {
  control: 0,
  toolResult: 10,
  asyncCompletion: 20,
  childDone: 30,
  memberCoordination: 40,
  humanInput: 50,
  memberChatInbox: 60,
  heartbeat: 70,
} as const satisfies MailboxPriority<AiAgentMailboxSchema>;

export const AI_AGENT_WAKE_MAILBOXES = [
  "control",
  "toolResult",
  "asyncCompletion",
  "childDone",
  "memberCoordination",
  "humanInput",
  "memberChatInbox",
  "heartbeat",
] as const satisfies readonly (keyof AiAgentMailboxSchema)[];

export type AiAgentWakeMailbox = (typeof AI_AGENT_WAKE_MAILBOXES)[number];

export function listPendingAiAgentWakeMailboxes(
  actor: Pick<AiAgentActorContract<AiAgentVm, AiAgentActor>, "hasPending">,
): AiAgentWakeMailbox[] {
  return AI_AGENT_WAKE_MAILBOXES.filter((mailbox) => actor.hasPending(mailbox));
}

export function hasPendingAiAgentWakeMailbox(
  actor: Pick<AiAgentActorContract<AiAgentVm, AiAgentActor>, "hasPending">,
): boolean {
  return listPendingAiAgentWakeMailboxes(actor).length > 0;
}

function createDefaultWorkContext(): ActorWorkContextData {
  const epoch = new Date(0).toISOString();
  return {
    workMode: WORK_MODES.build,
    taskPhase: TASK_PHASES.normal,
    workModeSource: "default",
    taskPhaseSource: "default",
    workModeUpdatedAt: epoch,
    taskPhaseUpdatedAt: epoch,
    lastTrigger: "default",
  };
}

function createDefaultContinuationBaseline(): ContinuationBaselineData {
  return {
    baselineEpoch: 0,
    lastResetReason: null,
    latestResponseId: null,
    updatedAt: new Date(0).toISOString(),
  };
}

export interface AiAgentActor
  extends ActorDef<any, AiAgentMailboxSchema, Record<string, never>>,
    AiAgentActorContract<AiAgentVm, AiAgentActor> {}

export namespace AiAgentActor {
  export type ActorCallbacks = AiAgentActorCallbacks<AiAgentVm, AiAgentActor>;
}

export type ControlActor = AiAgentActor & {
  type: "primary";
  behaviorTree: object | null;
};

export type DelegateActor = AiAgentActor & {
  type: "delegate";
  parentKey: string;
};

export type DetachedActor = AiAgentActor & {
  type: "detached";
};

export type CreateActorParams = {
  key: string;
  type?: ActorType;
  id?: string;
  actorType?: ActorType;
  actorId?: string;
  parentKey?: string;
  systemPrompts?: string[];
  messages?: ChatMessage[];
  identity?: ActorIdentity;
  planApproval?: AiAgentActor["planApproval"];
  shutdownCoordination?: AiAgentActor["shutdownCoordination"];
  toolPolicy?: Partial<ActorToolPolicy>;
  modelConfig?: ActorModelConfig;
  llmClient?: object | null;
  stream?: XStream<any> | null;
  agentName?: string;
  lastMemberResultNotifiedAt?: number | null;
  ctrlOptions?: Partial<ActorCtrlOptions>;
  taskTree?: TaskTree;
  mailboxes?: Partial<ActorMailboxQueues>;
  toolCallStreamState?: Partial<ActorToolcallStreamState>;
  pendingQuestionnaires?: Record<string, QuestionnaireRequestPayload>;
  workContext?: ActorWorkContextData;
  continuationBaseline?: ContinuationBaselineData;
  recovery?: ActorRecoveryState;
  detachedTask?: DetachedTaskState;
  holonState?: HolonActorState;
  callbacks?: Partial<AiAgentActor.ActorCallbacks>;
  logger?: Logger;
};

export type AppliedActorModelConfigControl = {
  modelConfig: ActorModelConfig;
  modelRef?: string;
  source?: string;
  requestedAt?: number;
  requestedBy?: string;
};

let actorCounter = 0;

function makeActorId(): string {
  actorCounter += 1;
  return `actor-${Date.now()}-${actorCounter}`;
}

function cloneHolonState(holonState: HolonActorState): HolonActorState {
  if (holonState.governance === "autonomous") {
    return {
      ...holonState,
      memberIds: [...holonState.memberIds],
      taskOwnership: { ...holonState.taskOwnership },
      tasks: Object.fromEntries(
        Object.entries(holonState.tasks ?? {}).map(([taskId, task]) => [
          taskId,
          { ...task },
        ]),
      ),
    };
  }

  return {
    ...holonState,
    memberIds: [...holonState.memberIds],
    routes: Object.fromEntries(
      Object.entries(holonState.routes ?? {}).map(([routeId, route]) => [
        routeId,
        { ...route },
      ]),
    ),
  };
}

export function createActor(params: CreateActorParams): AiAgentActor {
  const type = params.type ?? params.actorType ?? "primary";
  const id = params.id ?? params.actorId ?? makeActorId();
  const lastMemberResultNotifiedAt = params.lastMemberResultNotifiedAt ?? null;

  const ctrlOptions: ActorCtrlOptions = {
    stopAfterFirstTool: false,
    stopAfterTools: [],
    exitAfterToolResult: false,
    ...params.ctrlOptions,
  };

  const toolPolicy: ActorToolPolicy = {
    allowedTools: [],
    enabledToolKeys: [],
    disabledToolKeys: [],
    computedDisabledTools: [],
    ...params.toolPolicy,
  };

  const mailboxes: ActorMailboxQueues = {
    control: [...(params.mailboxes?.control ?? [])],
    childDone: [...(params.mailboxes?.childDone ?? [])],
    toolResult: [...(params.mailboxes?.toolResult ?? [])],
    asyncCompletion: [...(params.mailboxes?.asyncCompletion ?? [])],
    memberCoordination: [...(params.mailboxes?.memberCoordination ?? [])],
    humanInput: [...(params.mailboxes?.humanInput ?? [])],
    memberChatInbox: [...(params.mailboxes?.memberChatInbox ?? [])],
    heartbeat: [...(params.mailboxes?.heartbeat ?? [])],
  };

  // P7 mirror elimination (spec single-in-memory-truth/mirror-eliminated):
  // `messages` is a read-only view. Until the actor is bound to a vm's
  // conversation domain runtime it exposes the frozen creation seed (the
  // hydration input for the domains); once bound it IS the History-domain
  // projection. There is no writable message array on the actor.
  const seedMessages: readonly ChatMessage[] = Object.freeze([...(params.messages ?? [])]);
  let conversationProjection: (() => readonly ChatMessage[]) | null = null;

  return {
    initialState: {},
    priority: AI_AGENT_MAILBOXES,
    handler: (_self, envelope) => {
      mailboxes[envelope.tag].push(envelope.payload as never);
    },
    key: params.key,
    type,
    id,
    parentKey: params.parentKey,
    systemPrompts: params.systemPrompts ?? [],
    get messages(): readonly ChatMessage[] {
      return conversationProjection ? conversationProjection() : seedMessages;
    },
    bindConversationProjection(provider: () => readonly ChatMessage[]): void {
      conversationProjection = provider;
    },
    identity: params.identity,
    planApproval: params.planApproval,
    shutdownCoordination: params.shutdownCoordination,
    toolPolicy,
    modelConfig: params.modelConfig ?? {},
    llmClient: params.llmClient ?? null,
    stream: params.stream ?? null,
    agentName: params.agentName,
    llmAbortController: null,
    lastMemberResultNotifiedAt,
    ctrlOptions,
    taskTree: params.taskTree ?? createEmptyTaskTree(),
    mailboxes,
    toolCallStreamState: {
      toolCalls: [...(params.toolCallStreamState?.toolCalls ?? [])],
    },
    pendingQuestionnaires: { ...(params.pendingQuestionnaires ?? {}) },
    workContext: {
      ...createDefaultWorkContext(),
      ...(params.workContext ?? {}),
      actorKey: params.key,
      actorId: id,
    },
    continuationBaseline: {
      ...createDefaultContinuationBaseline(),
      ...(params.continuationBaseline ?? {}),
    },
    recovery: params.recovery,
    detachedTask: params.detachedTask ? { ...params.detachedTask } : undefined,
    holonState: params.holonState ? cloneHolonState(params.holonState) : undefined,
    watchState: "unwatched",
    hasPending: (tag) => mailboxes[tag].length > 0,
    peekMailbox: <TTag extends keyof AiAgentMailboxSchema>(tag: TTag) => {
      return [...mailboxes[tag]] as AiAgentMailboxSchema[TTag][];
    },
    drainMailbox: <TTag extends keyof AiAgentMailboxSchema>(tag: TTag) => {
      const values = [...mailboxes[tag]] as AiAgentMailboxSchema[TTag][];
      mailboxes[tag].length = 0;
      return values;
    },
    send: (tag, payload) => {
      mailboxes[tag].push(payload);
    },
    callbacks: {
      buildToolset: params.callbacks?.buildToolset ?? (() => []),
      processStream: params.callbacks?.processStream ?? (async () => ({ role: "assistant", content: "" })),
    },
    logger: params.logger,
  };
}

export function applyActorModelConfigControlSignals(actor: AiAgentActor): AppliedActorModelConfigControl | null {
  if (!actor.hasPending("control")) return null;

  const entries = actor.drainMailbox("control") as AiAgentMailboxSchema["control"][];
  let latest: AppliedActorModelConfigControl | null = null;

  for (const entry of entries) {
    if (entry.kind === "set_active_model_config") {
      latest = {
        modelConfig: { ...entry.modelConfig },
        modelRef: entry.modelRef,
        source: entry.source,
        requestedAt: entry.requestedAt,
        requestedBy: entry.requestedBy,
      };
      continue;
    }
    actor.send("control", entry);
  }

  if (!latest) return null;
  actor.modelConfig = {
    ...actor.modelConfig,
    ...latest.modelConfig,
  };
  return latest;
}
