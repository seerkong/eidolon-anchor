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
  childDone: 10,
  coordination: 20,
  memberInbox: 30,
  heartbeatWake: 40,
  humanInput: 50,
  toolResult: 60,
  aiGenerated: 70,
} as const satisfies MailboxPriority<AiAgentMailboxSchema>;

function createDefaultWorkContext(): ActorWorkContextData {
  const epoch = new Date(0).toISOString();
  return {
    workMode: WORK_MODES.general_execution,
    taskPhase: TASK_PHASES.implementation,
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
    coordination: [...(params.mailboxes?.coordination ?? [])],
    memberInbox: [...(params.mailboxes?.memberInbox ?? [])],
    heartbeatWake: [...(params.mailboxes?.heartbeatWake ?? [])],
    humanInput: [...(params.mailboxes?.humanInput ?? [])],
    toolResult: [...(params.mailboxes?.toolResult ?? [])],
    aiGenerated: [...(params.mailboxes?.aiGenerated ?? [])],
  };

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
    messages: params.messages ?? [],
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
