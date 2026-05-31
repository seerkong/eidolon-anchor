import type { ActorIdentity, ActorType } from "./AiAgentActor";
import type { ActorHolonGovernanceKind } from "../coordination";
import type {
  QuestionnaireRequestPayload,
  QuestionnaireResultPayload,
  QuestionnaireSuspendPolicy,
} from "./Questionnaire";

export type ActorSurfaceBackendIdentityKind =
  | "primary"
  | "agent"
  | "member"
  | "holon"
  | "actor_definition";

export type ActorSurfaceBackendIdentityData = {
  kind: ActorSurfaceBackendIdentityKind;
  name?: string;
  agentName?: string;
  agentType?: string;
  actorDefinitionName?: string;
  memberId?: string;
  role?: string;
  holonId?: string;
  governance?: ActorHolonGovernanceKind;
  leaderMemberId?: string | null;
  metadata?: Record<string, unknown>;
};

export type ActorConversationLaneKind =
  | "primary"
  | "agent"
  | "member"
  | "holon"
  | "actor";

export type ActorSurfaceLaneStatus =
  | "idle"
  | "running"
  | "waiting_for_human"
  | "cancel_requested"
  | "suspended"
  | "completed"
  | "failed"
  | "unknown";

export type ActorConversationLaneData = {
  laneId: string;
  kind: ActorConversationLaneKind;
  displayName: string;
  backendIdentity: ActorSurfaceBackendIdentityData;
  actorId?: string;
  actorKey?: string;
  initialized: boolean;
  status: ActorSurfaceLaneStatus;
  metadata?: Record<string, unknown>;
};

export type ActorTranscriptKeyData = {
  sessionId?: string;
  actorId: string;
  actorKey: string;
};

export type ActorRuntimeLaneData = {
  actorId: string;
  actorKey: string;
  actorType: ActorType;
  displayName: string;
  identity?: ActorIdentity;
  transcriptKey: ActorTranscriptKeyData;
  runtimeStatus: ActorSurfaceLaneStatus;
  activeTurnId?: string;
  cancellable: boolean;
  metadata?: Record<string, unknown>;
};

export type QuestionnaireSurfaceLifecycleState =
  | "pending"
  | "answered"
  | "cancelled"
  | "expired";

export type QuestionnaireSurfaceItemData = {
  questionnaireId: string;
  sessionId?: string;
  ownerActorId?: string;
  ownerActorKey?: string;
  ownerFiberId?: string;
  toolCallId: string;
  request: QuestionnaireRequestPayload;
  result?: QuestionnaireResultPayload;
  suspendPolicy: QuestionnaireSuspendPolicy;
  lifecycleState: QuestionnaireSurfaceLifecycleState;
  createdAt?: number;
  updatedAt?: number;
  metadata?: Record<string, unknown>;
};

export type ActorSurfaceSelectedTargetData = {
  laneId?: string;
  actorId?: string;
};

export type ActorSurfaceTargetSelectorData = {
  laneId?: string;
  actorId?: string;
};

export type ActorSurfaceLaneActorBindingData = {
  laneId: string;
  actorId: string;
  actorKey: string;
  initializedAt: number;
};

export type ActorSurfaceRuntimeStateData = {
  primaryBackendIdentity?: ActorSurfaceBackendIdentityData;
  selectedLaneId?: string;
  selectedActorId?: string;
  laneActorBindings: Record<string, ActorSurfaceLaneActorBindingData>;
  pendingQuestionnaires: Record<string, QuestionnaireSurfaceItemData>;
  answeredQuestionnaires: Record<string, QuestionnaireSurfaceItemData>;
};

export type ActorSurfaceCancelRequestData = {
  actorId: string;
  turnId?: string;
};

export type QuestionnaireSurfaceSubmitStatus =
  | "submitted"
  | "not_pending"
  | "owner_missing";

export type QuestionnaireSurfaceSubmitResultData = {
  status: QuestionnaireSurfaceSubmitStatus;
  projection: ActorSurfaceProjectionData;
};

export type ActorSurfaceProjectionData = {
  conversationLanes: ActorConversationLaneData[];
  actorLanes: ActorRuntimeLaneData[];
  selectedLaneId: string;
  selectedActorId?: string;
  selectedTarget: ActorSurfaceSelectedTargetData;
  questionnaireSurface: QuestionnaireSurfaceItemData[];
  metadata?: Record<string, unknown>;
};
