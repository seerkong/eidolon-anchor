import type { RuntimeLogFn } from "./Logging";

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
