/** Web directory metadata. Conversation, execution and TUI sidecars retain their own owners. */
export type SessionManagementAction = "rename" | "archive"
export type SessionManagementCommand = Readonly<{
  commandId: string
  expectedServerInstanceId: string
  expectedEpoch: string
  expectedMetadataRevision: number
} & ({ kind: "rename"; displayName: string } | { kind: "archive" })>

export type SessionMetadata = Readonly<{
  sessionId: string
  metadataRevision: number
  displayName: string
  lifecycle: "active" | "archived"
  archivedAt?: number
}>

/** Durable result, scoped to the submitting principal; reading it never activates a runtime. */
export type SessionManagementResult = Readonly<SessionMetadata & {
  commandId: string
  kind: SessionManagementAction
  submittedEpoch: string
}>
