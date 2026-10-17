/** Public publication facts, separate from execution replay and private proof. */
export type ConversationOperationResult =
  | Readonly<{ kind: "fork"; targetSessionId: string; targetActorId: string; cutoffMessageId?: string; transactionId: string }>
  | Readonly<{ kind: "rewind"; retainedMessageCount: number; removedMessageCount: number; cutoffMessageId: string; historyRevision: string; transactionId: string }>

export type ConversationOperation = Readonly<{
  operationId: string
  sessionId: string
  actorId: string
  commandId: string
  epoch: string
  submittedEpoch: string
  kind: "fork" | "rewind"
  state: "pending" | "unknown" | "applied" | "rejected"
  result?: ConversationOperationResult
  errorCode?: string
}>
export type ConversationOperationList = Readonly<{ epoch: string; operations: readonly ConversationOperation[] }>
