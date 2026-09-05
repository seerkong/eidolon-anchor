import type { ClosedValue } from "holarchy-eidolon-adapter"
import type { HolonTaskRuntimeOrigin, HolonTaskRuntimeProcessorConfig } from "./HolonTaskRuntime"

/** Accepted-effect intent/result bytes stay on v1; only subscriptions evolved. */
export const HOLON_TASK_PUMP_JOURNAL_SCHEMA_VERSION = "eidolon.holon-task-pump/v1" as const
export const LEGACY_HOLON_TASK_PUMP_SUBSCRIPTION_SCHEMA_VERSION =
  HOLON_TASK_PUMP_JOURNAL_SCHEMA_VERSION
export const HOLON_TASK_PUMP_SUBSCRIPTION_SCHEMA_VERSION = "eidolon.holon-task-pump/v2" as const

export type HolonTaskPumpRecoveryScope =
  | Readonly<{ readonly kind: "standalone"; readonly scopeRef: string }>
  | Readonly<{
      readonly kind: "workflow"
      readonly workflowInstanceId: string
      readonly runId: string
      readonly nodeId: string
    }>

export interface HolonTaskPumpSubscription {
  readonly schemaVersion: typeof HOLON_TASK_PUMP_SUBSCRIPTION_SCHEMA_VERSION
  readonly subscriptionId: `sha256:${string}`
  readonly admissionId: string
  readonly deploymentId: string
  readonly bindingRef: `resource://${string}`
  readonly holonRef: string
  readonly snapshotReceiptId: string
  readonly taskSpaceId: string
  readonly taskId: string
  readonly origin: HolonTaskRuntimeOrigin
  readonly recoveryScope: HolonTaskPumpRecoveryScope
  readonly processorConfig: HolonTaskRuntimeProcessorConfig
  readonly input: ClosedValue
  readonly inputDigest: `sha256:${string}`
  readonly createdAt: string
}

export interface HolonTaskPumpDispatchIntent {
  readonly schemaVersion: typeof HOLON_TASK_PUMP_JOURNAL_SCHEMA_VERSION
  readonly intentId: `sha256:${string}`
  readonly deploymentId: string
  readonly taskSpaceId: string
  readonly taskId: string
  readonly claimId: string
  readonly attempt: number
  readonly leaseEpoch: number
  readonly invocationRef: string
  readonly input: ClosedValue
  readonly inputDigest: `sha256:${string}`
  readonly preparedAt: string
}

export interface HolonTaskPumpResultReceipt {
  readonly schemaVersion: typeof HOLON_TASK_PUMP_JOURNAL_SCHEMA_VERSION
  readonly intentId: `sha256:${string}`
  readonly invocationRef: string
  readonly output: ClosedValue
  readonly outputDigest: `sha256:${string}`
  readonly acceptedAt: string
  readonly receiptDigest: `sha256:${string}`
}

export interface HolonTaskPumpJournalPort {
  subscribe(input: Omit<HolonTaskPumpSubscription, "schemaVersion" | "subscriptionId" | "inputDigest">): Promise<HolonTaskPumpSubscription>
  listSubscriptions(runId?: string): Promise<readonly HolonTaskPumpSubscription[]>
  dispatch(
    intent: HolonTaskPumpDispatchIntent,
    effect: (idempotencyKey: string) => Promise<ClosedValue>,
  ): Promise<Readonly<{ readonly receipt: HolonTaskPumpResultReceipt; readonly replayed: boolean }>>
  readResult(intentId: string): Promise<HolonTaskPumpResultReceipt | undefined>
}

export class HolonTaskPumpJournalError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "HolonTaskPumpJournalError"
  }
}

export type HolonTaskPumpJournalFaultObserver = Readonly<{
  afterEffect?(intent: HolonTaskPumpDispatchIntent, output: ClosedValue): void | Promise<void>
}>

/** Closed immutable byte collections; identities never expose filesystem paths. */
export type HolonTaskPumpJournalCollection = "subscriptions" | "intents" | "results"

export interface HolonTaskPumpJournalStorePort {
  /** Missing facts reject with code ENOENT; other read errors propagate unchanged. */
  read(collection: HolonTaskPumpJournalCollection, identity: string): Promise<Uint8Array>
  /** Records are returned in stable storage-key order, matching the file protocol. */
  list(collection: HolonTaskPumpJournalCollection): Promise<readonly Uint8Array[]>
  /** Equal bytes are idempotent; differing bytes reject with JOURNAL_CONFLICT. */
  writeImmutable(collection: HolonTaskPumpJournalCollection, identity: string, bytes: Uint8Array): Promise<void>
  /** The operation runs under the identity lock, released even if it throws. */
  withExclusive<T>(identity: string, operation: () => Promise<T>): Promise<T>
}

export interface HolonTaskPumpJournalRuntime {
  readonly store: HolonTaskPumpJournalStorePort
  readonly now: () => number
  readonly faults?: HolonTaskPumpJournalFaultObserver
}
