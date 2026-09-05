import type { TaskSpaceOwnerPort } from "task-manager-contract"
import type { HolonTaskPumpJournalStorePort } from "./HolonTaskPumpJournal"

export interface HolonTaskSubmissionRecord {
  readonly taskSpaceId: string
  readonly taskId: string
  readonly commandId: string
  readonly submissionFingerprint: `sha256:${string}`
}

/** Retain exact immutable submission bytes or reject a conflicting fingerprint. */
export type HolonTaskSubmissionWriter = (value: HolonTaskSubmissionRecord) => Promise<void>

/** Physical effects supplied by the application that owns this support scope. */
export interface HolonTaskRuntimeStorage {
  readonly supportRoot: string
  readonly taskManager: Readonly<{ owner: TaskSpaceOwnerPort }>
  readonly journalStore: HolonTaskPumpJournalStorePort
  readonly retainSubmission: HolonTaskSubmissionWriter
}
