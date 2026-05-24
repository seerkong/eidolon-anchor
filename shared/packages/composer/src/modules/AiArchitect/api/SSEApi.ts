import type { TechDesignDslMutationItem, TechDesignSnapshotDsl } from "@shared/core";

export enum SSEChatEventType {
  start = 'start',
  message = 'message',
  result = 'result',
  ping = 'ping',
  done = 'done',
}

export interface SSEChatData {
  event: SSEChatEventType;
  conversationId: string;
  messageId: string;
  content?: string;
  data?: unknown;
}

export interface SSEChatDataResultData {
  answerMutation: { [key: string]: { [key: string]: TechDesignDslMutationItem } };
  conversationMutation: { [key: string]: { [key: string]: TechDesignDslMutationItem } };
  newState: TechDesignSnapshotDsl;
  confirmForm: unknown[];
}

export interface ResetInputAndInitModulesRequest {
  projectKey: string;
  prdLink: string;
  prdContent: string;
  techConstraintsLink: string;
  techConstraintsContent: string;
  enablePrdTransform?: boolean;
  cookie?: string;
}

export interface ModuleDesignRequest {
  projectKey: string;
  conversationId?: string;
  userCommand: string;
}
