export type ActorPromptTransformKind =
  | "history_compaction_summary"
  | "micro_compact"
  | "context_asset_attach"
  | "context_asset_extract_text"
  | "context_asset_select_fragment"
  | "context_asset_bind_summary"
  | "context_asset_detach_all"
  | "overlay";

export type ActorPromptGenerationReason =
  | "request_build"
  | "micro_compact"
  | "overlay"
  | "asset_attach"
  | "restore"
  | "manual"
  | "unknown";

export type ActorPromptBasisRefKind =
  | "history_generation"
  | "message"
  | "context_block"
  | "session_asset"
  | "workflow_status"
  | "overlay"
  | "unknown";

export type ActorPromptBasisRefData = {
  refKind: ActorPromptBasisRefKind;
  refId: string;
  metadata?: Record<string, unknown>;
};

export type ActorPromptBasisData = {
  version: number;
  basisHistoryGenerationIds: string[];
  basisMessageRecordIds: string[];
  basisRefs?: ActorPromptBasisRefData[];
};

export type ActorPromptTransformData = {
  transformId: string;
  kind: ActorPromptTransformKind;
  payload: Record<string, unknown>;
  appliedAt: string;
};

export type ActorPromptGenerationData = {
  version: number;
  promptGenerationId: string;
  sessionId: string;
  actorKey: string;
  actorId: string;
  basedOnPromptGenerationId?: string | null;
  basis: ActorPromptBasisData;
  transforms: ActorPromptTransformData[];
  createdReason?: ActorPromptGenerationReason | null;
  materializedContext?: string | null;
  sealed: boolean;
  createdAt: string;
  sealedAt?: string | null;
  updatedAt: string;
  metadata?: Record<string, unknown>;
};

export type ActorPromptHeadData = {
  version: number;
  sessionId: string;
  actorKey: string;
  actorId: string;
  activePromptGenerationId?: string | null;
  updatedAt: string;
};
