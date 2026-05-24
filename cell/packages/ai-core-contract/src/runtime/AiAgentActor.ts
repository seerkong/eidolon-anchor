import type { LlmAdapterType, LlmModelCapabilities } from "../LlmTypes";
import type {
  ActorExecutionKind,
  ActorHolonGovernanceKind,
  ActorWatchState,
  AiAgentCoordinationDecision,
  AiAgentCoordinationStatus,
  AiAgentPlanApprovalCoordinationKind,
  AiAgentShutdownCoordinationKind,
} from "../coordination";
import type { TaskTree } from "../plan/TaskTree";
import type {
  ActorWorkContextData,
  ContinuationBaselineData,
} from "./ContextControl";
import type { QuestionnaireRequestPayload } from "./Questionnaire";
import type { ChatMessage, Logger, XStream } from "@shared/composer";

export type ActorType = ActorExecutionKind;

export type AiAgentMailboxSchema = {
  control:
    | {
        kind: "questionnaire_pending";
        toolCallId: string;
        questionnaireId: string;
        suspendPolicy: "pause_all" | "continue_others";
      }
    | {
        kind: "cancel_requested";
      }
    | {
        kind: "shutdown_requested";
      };
  childDone: {
    childFiberId: string;
    childActorKey: string;
    childActorId: string;
    mode: "sync_wait" | "detached";
    toolCallId?: string;
    outputText: string;
  };
  coordination: {
    from: string;
    text: string;
    ts: number;
  };
  memberInbox: {
    from: string;
    text: string;
    ts: number;
  };
  humanInput: string;
  toolResult: { toolCallId: string; questionnaireId?: string; content: string };
  aiGenerated: unknown;
};

export type ActorCtrlOptions = {
  stopAfterFirstTool: boolean;
  stopAfterTools: string[];
  exitAfterToolResult: boolean;
};

export type ActorModelConfig = {
  provider?: string;
  adapter?: LlmAdapterType;
  apiKind?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  maxInputTokens?: number;
  inputLimit?: number;
  outputLimit?: number;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  capabilities?: LlmModelCapabilities;
};

export type ActorContext = {
  history: ChatMessage[];
  systemPrompts: string[];
};

export type ActorToolPolicy = {
  allowedTools: string[];
  enabledToolKeys: string[];
  disabledToolKeys: string[];
  computedDisabledTools: string[];
};

export type ActorToolcallStreamState = {
  toolCalls: unknown[];
};

export type ActorLike = {
  key: string;
  id: string;
  type: ActorType;
};

export type ActorIdentity =
  | {
      kind: "member";
      memberId: string;
      name: string;
      role?: string;
      lane?: string;
      agentType?: string;
    }
  | {
      kind: "holon";
      holonId: string;
      governance: ActorHolonGovernanceKind;
      name: string;
      leaderId?: string;
    };

export type ActorMailboxQueues = {
  [K in keyof AiAgentMailboxSchema]: AiAgentMailboxSchema[K][];
};

export type ActorRecoveryState = {
  restoredFromSnapshot: boolean;
  snapshotVersion?: number;
  restoredAt?: number;
};

export type DetachedTaskState = {
  taskId: string;
  kind: "delegate" | "bash" | "tool_call";
  status: "pending" | "running" | "suspended" | "interrupted" | "completed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  toolCallId?: string;
  parentFiberId?: string;
  childFiberId?: string;
  outputText?: string;
  error?: string;
};

export type AutonomousHolonTaskState = {
  taskId: string;
  initiatorActorKey: string;
  initiatorActorId: string;
  replyMode: "final" | "none" | "stream";
  status: "pending" | "routed" | "completed" | "failed" | "cancelled";
  content: string;
  createdAt: number;
  updatedAt: number;
  ownerActorKey?: string;
  ownerActorId?: string;
  ownerMemberId?: string;
  resultText?: string;
};

export type AutonomousHolonState = {
  governance: "autonomous";
  holonId: string;
  name: string;
  memberIds: string[];
  watchState: "watched" | "unwatched";
  taskOwnership: Record<string, string>;
  tasks: Record<string, AutonomousHolonTaskState>;
};

export type LeaderLedHolonRouteState = {
  routeId: string;
  initiatorActorKey: string;
  initiatorActorId: string;
  leaderMemberId: string;
  replyMode: "final" | "none" | "stream";
  status: "pending" | "routed" | "streaming" | "completed" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  eventCount?: number;
  lastEventText?: string;
  lastEventAt?: number;
  resultText?: string;
};

export type LeaderLedHolonState = {
  governance: "leader_led";
  holonId: string;
  name: string;
  memberIds: string[];
  leaderMemberId: string | null;
  watchState: "watched" | "unwatched";
  routes: Record<string, LeaderLedHolonRouteState>;
};

export type HolonActorState =
  | AutonomousHolonState
  | LeaderLedHolonState;

export type AiAgentActorCallbacks<TVm = any, TActor = any> = {
  buildToolset: (vm: TVm, actor: TActor) => any[];
  processStream: (vm: TVm, actor: TActor, stream: any) => Promise<any>;
};

export interface AiAgentActorData<TVm = any, TActor = any> {
  key: string;
  id: string;
  type: ActorType;
  parentKey?: string;
  systemPrompts: string[];
  messages: ChatMessage[];
  identity?: ActorIdentity;
  planApproval?: {
    requestId: string;
    status: AiAgentCoordinationStatus;
    kind?: AiAgentPlanApprovalCoordinationKind;
    decision?: AiAgentCoordinationDecision;
    updatedAt: number;
  };
  shutdownCoordination?: {
    requestId: string;
    status: AiAgentCoordinationStatus;
    kind?: AiAgentShutdownCoordinationKind;
    decision?: AiAgentCoordinationDecision;
    updatedAt: number;
  };
  toolPolicy: ActorToolPolicy;
  modelConfig: ActorModelConfig;
  llmClient: object | null;
  stream: XStream<any> | null;
  agentName?: string;
  llmAbortController?: AbortController | null;
  lastMemberResultNotifiedAt?: number | null;
  ctrlOptions: ActorCtrlOptions;
  taskTree: TaskTree;
  mailboxes: ActorMailboxQueues;
  toolCallStreamState: ActorToolcallStreamState;
  pendingQuestionnaires: Record<string, QuestionnaireRequestPayload>;
  workContext: ActorWorkContextData;
  continuationBaseline: ContinuationBaselineData;
  recovery?: ActorRecoveryState;
  detachedTask?: DetachedTaskState;
  holonState?: HolonActorState;
  watchState: ActorWatchState;
  callbacks: AiAgentActorCallbacks<TVm, TActor>;
  logger?: Logger;
}

export interface AiAgentActorContract<TVm = any, TActor = any>
  extends AiAgentActorData<TVm, TActor> {
  hasPending: <TTag extends keyof AiAgentMailboxSchema>(tag: TTag) => boolean;
  peekMailbox: <TTag extends keyof AiAgentMailboxSchema>(tag: TTag) => AiAgentMailboxSchema[TTag][];
  drainMailbox: <TTag extends keyof AiAgentMailboxSchema>(tag: TTag) => AiAgentMailboxSchema[TTag][];
  send: <TTag extends keyof AiAgentMailboxSchema>(tag: TTag, payload: AiAgentMailboxSchema[TTag]) => void;
}
