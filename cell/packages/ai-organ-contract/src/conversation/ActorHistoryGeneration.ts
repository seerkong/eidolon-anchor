export type ConversationHistoryCreatedReason =
  | "bootstrap"
  | "append"
  | "compaction"
  | "rollback"
  | "fork"
  | "migration";

export type ConversationCommittedToolCallData = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ConversationCommittedMessageData = {
  role: string;
  name?: string;
  content: string;
  reasoningContent?: string;
  startAt?: number;
  endAt?: number;
  toolCallId?: string;
  tool_call_id?: string;
  toolCalls?: ConversationCommittedToolCallData[];
};

export type ConversationTranscriptSourceRecord = {
  stream: string;
  payload: string;
  startAt?: number;
  endAt?: number;
};

export type ActorCommittedMessageRef = {
  recordId: string;
  actorKey: string;
  actorId: string;
  committedAt: number;
  message: ConversationCommittedMessageData;
  sourceRecords?: ConversationTranscriptSourceRecord[];
  transcriptPath?: string | null;
};

export type ActorHistoryGenerationData = {
  version: number;
  generationId: string;
  sessionId: string;
  actorKey: string;
  actorId: string;
  parentGenerationId?: string | null;
  predecessorGenerationIds: string[];
  createdReason: ConversationHistoryCreatedReason;
  sealed: boolean;
  messageCount: number;
  messages: ActorCommittedMessageRef[];
  createdAt: string;
  updatedAt: string;
};

export type ActorHistoryHeadData = {
  version: number;
  sessionId: string;
  actorKey: string;
  actorId: string;
  activeGenerationId?: string | null;
  visibleGenerationIds: string[];
  updatedAt: string;
};

export type ActorHistoryLineageData = {
  version: number;
  sessionId: string;
  actorKey: string;
  actorId: string;
  generationId: string;
  parentGenerationId?: string | null;
  rolledBackFromGenerationId?: string | null;
  predecessorGenerationIds: string[];
  successorGenerationIds: string[];
  forkGenerationIds: string[];
  branchLabel?: string | null;
  updatedAt: string;
};
