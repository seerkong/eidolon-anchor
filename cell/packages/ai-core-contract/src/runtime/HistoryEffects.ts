import type { RuntimeLogFn } from "./Logging";

export type MessageHistoryAppendEvent = {
  stream: string;
  payload: string;
  startAt?: number;
  endAt?: number;
  agentKey: string;
  agentActorId: string;
  persistConversationHistory?: boolean;
  actorType?: string;
  agentName?: string;
  memberName?: string;
};

export type MessageHistoryBackupParams = {
  agentKey: string;
  agentActorId: string;
  actorType?: string;
  agentName?: string;
  memberName?: string;
};

export type MessageHistoryEffects = {
  appendMessage: (event: MessageHistoryAppendEvent) => void;
  backupHistory?: (params: MessageHistoryBackupParams) => Promise<void>;
};

export type OrchestrationHistoryAppendEvent = {
  stream: string;
  kind: string;
  payload: Record<string, unknown>;
};

export type OrchestrationHistoryEffects = {
  appendEvent: (event: OrchestrationHistoryAppendEvent) => void;
  backupHistory?: () => Promise<void>;
};

export type RuntimeSessionPathProvider = () => string | null | undefined;

export type RuntimeHistorySupportParams = {
  sessionPathProvider: RuntimeSessionPathProvider;
  log?: RuntimeLogFn;
};
