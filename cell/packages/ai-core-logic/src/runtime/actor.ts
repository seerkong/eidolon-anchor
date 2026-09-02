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
import { cloneAndFreezeAgentExecutionContract } from "./AgentExecutionContract";
import { normalizeActorRuntimeFacetIndex } from "./ActorRuntimeFacet";
import type {
  ActorRuntimeFacetIndexInput,
} from "@cell/ai-core-contract/runtime/ActorRuntimeFacet";
import type { ActorDurableMaterialIndexInput } from "@cell/ai-core-contract/runtime/ActorDurableMaterial";
import { normalizeActorDurableMaterialIndex } from "./ActorDurableMaterial";
import type {
  ActorContext,
  ActorContextPolicy,
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
  DetachedTaskState,
  HolonActorState,
  LeaderLedHolonRouteState,
  LeaderLedHolonState,
  ProfileSystemPromptProvenance,
} from "@cell/ai-core-contract/runtime/AiAgentActor";

export type {
  ActorContext,
  ActorContextPolicy,
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
  DetachedTaskState,
  HolonActorState,
  LeaderLedHolonRouteState,
  LeaderLedHolonState,
  ProfileSystemPromptProvenance,
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
    contextDigest: null,
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
  profileSystemPromptProvenance?: ProfileSystemPromptProvenance;
  messages?: ChatMessage[];
  identity?: ActorIdentity;
  planApproval?: AiAgentActor["planApproval"];
  shutdownCoordination?: AiAgentActor["shutdownCoordination"];
  toolPolicy?: Partial<ActorToolPolicy>;
  contextPolicy?: Partial<ActorContextPolicy>;
  executionContract?: AiAgentActor["executionContract"];
  contextPipeline?: AiAgentActor["contextPipeline"];
  origin?: AiAgentActor["origin"];
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
  runtimeFacets?: ActorRuntimeFacetIndexInput;
  durableMaterials?: ActorDurableMaterialIndexInput;
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
      governance: "autonomous",
      holonId: holonState.holonId,
      name: holonState.name,
      memberIds: [...holonState.memberIds],
      watchState: holonState.watchState,
    };
  }

  return {
    governance: "leader_led",
    holonId: holonState.holonId,
    name: holonState.name,
    memberIds: [...holonState.memberIds],
    leaderMemberId: holonState.leaderMemberId,
    watchState: holonState.watchState,
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

  const allowedTools = [...(params.toolPolicy?.allowedTools ?? [])];
  const allowedToolsMode = params.toolPolicy?.allowedToolsMode
    ?? (allowedTools.length > 0 ? "exact" : "all");
  const configuredProviderSurface = params.toolPolicy?.providerToolSurface;
  const toolPolicy: ActorToolPolicy = {
    allowedToolsMode,
    allowedTools,
    providerToolSurface: configuredProviderSurface
      ? {
          mode: configuredProviderSurface.mode,
          toolNames: [...configuredProviderSurface.toolNames],
        }
      : {
          mode: allowedToolsMode,
          toolNames: [...allowedTools],
        },
    enabledToolKeys: [...(params.toolPolicy?.enabledToolKeys ?? [])],
    disabledToolKeys: [...(params.toolPolicy?.disabledToolKeys ?? [])],
    computedDisabledTools: [...(params.toolPolicy?.computedDisabledTools ?? [])],
  };

  const contextPolicy: ActorContextPolicy = {
    historyCompaction: "auto",
    ...params.contextPolicy,
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
    profileSystemPromptProvenance: params.profileSystemPromptProvenance
      ? { ...params.profileSystemPromptProvenance }
      : undefined,
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
    contextPolicy,
    executionContract: params.executionContract
      ? cloneAndFreezeAgentExecutionContract(params.executionContract)
      : undefined,
    contextPipeline: params.contextPipeline
      ? Object.freeze({ ...params.contextPipeline, stages: Object.freeze([...params.contextPipeline.stages]) })
      : undefined,
    origin: normalizeActorOrigin(params.origin),
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
    runtimeFacets: normalizeActorRuntimeFacetIndex(params.runtimeFacets),
    durableMaterials: normalizeActorDurableMaterialIndex(params.durableMaterials),
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

function normalizeActorOrigin(value: AiAgentActor["origin"] | undefined): AiAgentActor["origin"] | undefined {
  if (value === undefined) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (Object.getPrototypeOf(value) !== Object.prototype
    || keys.some((key) => typeof key !== "string")
    || (keys as string[]).sort().join("\0") !== ["ownerDigest", "proofDigest", "schemaVersion", "subjectDigest"].join("\0")) {
    throw new Error("ACTOR_ORIGIN_INVALID: origin must be exact closed own-data");
  }
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("ACTOR_ORIGIN_INVALID: origin must contain enumerable own-data only");
    }
  }
  const sha = /^sha256:[0-9a-f]{64}$/;
  if (value.schemaVersion !== "eidolon.actor-origin/v1"
    || !sha.test(value.ownerDigest) || !sha.test(value.subjectDigest) || !sha.test(value.proofDigest)) {
    throw new Error("ACTOR_ORIGIN_INVALID: origin digest or schema is invalid");
  }
  return Object.freeze({ ...value });
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
