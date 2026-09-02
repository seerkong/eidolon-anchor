import { createHash } from "node:crypto"

import {
  type TaskRecord,
  type TaskSettlementReceipt,
} from "task-manager-contract"
import {
  expireTaskClaim,
  failTask,
  heartbeatTaskClaim,
  TaskManagerError,
  type TaskProcessorConfig,
} from "task-manager-logic"
import { normalizeHolonTaskSnapshotReceipt, normalizeHolonTaskTarget } from "ai-workflow-contract"

import {
  executeHolonWorkflowTask,
  type HolonWorkflowTaskExecutionResult,
  type HolonWorkflowTaskProcessorRuntime,
} from "./HolonWorkflowTaskRuntime"
import type { HolonTaskPumpSubscription } from "./HolonTaskPumpJournal"

export interface PumpHolonTaskSpaceInput {
  readonly subscription: HolonTaskPumpSubscription
  readonly leaseDurationMs: number
  readonly maxSteps: number
  readonly observedAt: string
}

export interface HolonTaskSpacePumpResult {
  readonly kind: "holon-task-space-pump-result"
  readonly taskSpaceId: string
  readonly observedRevision: number
  readonly status: "terminal" | "waiting" | "yielded"
  readonly steps: number
  readonly settlements: readonly TaskSettlementReceipt[]
}

export class HolonTaskSpacePumpError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "HolonTaskSpacePumpError"
  }
}

const fail = (code: string, message: string): never => {
  throw new HolonTaskSpacePumpError(code, message)
}

const compareTask = (left: TaskRecord, right: TaskRecord): number => (
  left.definition.order - right.definition.order
  || (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0)
)

function commandId(kind: string, value: unknown): string {
  return `holon-pump-${kind}-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 40)}`
}

function timestamp(value: string, offsetMs = 0): string {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return fail("EIDOLON_HOLON_PUMP_INPUT_INVALID", "observedAt must be one ISO timestamp.")
  return new Date(time + offsetMs).toISOString()
}

function canonicalTask(task: TaskRecord, subscription: HolonTaskPumpSubscription): boolean {
  if (task.definition.kind !== "task" || task.profile.profileKind !== "depa.ai.organization-task") return false
  try {
    const target = normalizeHolonTaskTarget(task.profile.facts.target)
    const receipt = normalizeHolonTaskSnapshotReceipt(task.profile.facts.snapshotReceipt)
    return target.executionBinding.ref === subscription.bindingRef
      && target.holon.rootHolonRef === subscription.holonRef
      && receipt.issuerReceiptId === subscription.snapshotReceiptId
      && receipt.taskSpaceId === subscription.taskSpaceId
      && receipt.holonRef === subscription.holonRef
  } catch {
    return false
  }
}

function attemptIdentity(task: TaskRecord): Readonly<{ readonly attempt: number; readonly leaseEpoch: number }> {
  return Object.freeze({
    attempt: Math.max(1, task.attempt),
    leaseEpoch: Math.max(1, task.leaseEpoch),
  })
}

function assignmentCommand(taskSpaceId: string, task: TaskRecord): string {
  if (!task.activeClaim) return fail("EIDOLON_HOLON_PUMP_CLAIM_MISSING", "Recovering task has no live claim.")
  return deriveHolonTaskPumpExecutionIds({
    taskSpaceId,
    taskId: task.taskId,
    ...attemptIdentity(task),
    claimedAt: task.activeClaim.claimedAt,
  }).assignmentCommandId
}

export function deriveHolonTaskPumpExecutionIds(input: Readonly<{
  readonly taskSpaceId: string
  readonly taskId: string
  readonly attempt: number
  readonly leaseEpoch: number
  readonly claimedAt: string
}>): Readonly<{
  readonly assignmentCommandId: string
  readonly startCommandId: string
  readonly settlementCommandId: string
  readonly invocationRef: string
}> {
  const identity = {
    taskSpaceId: input.taskSpaceId,
    taskId: input.taskId,
    attempt: input.attempt,
    leaseEpoch: input.leaseEpoch,
  }
  return Object.freeze({
    assignmentCommandId: commandId("claim", { ...identity, claimedAt: timestamp(input.claimedAt) }),
    startCommandId: commandId("start", identity),
    settlementCommandId: commandId("settle", identity),
    // External acceptance belongs to the logical task, not to one replaceable
    // lease attempt. A reclaimed attempt must replay the same adapter key.
    invocationRef: commandId("invoke", { taskSpaceId: input.taskSpaceId, taskId: input.taskId }),
  })
}

function executionIds(taskSpaceId: string, task: TaskRecord, claimedAt: string) {
  return deriveHolonTaskPumpExecutionIds({
    taskSpaceId,
    taskId: task.taskId,
    ...attemptIdentity(task),
    claimedAt,
  })
}

async function recoveringTask(
  runtime: HolonWorkflowTaskProcessorRuntime,
  taskSpaceId: string,
  tasks: readonly TaskRecord[],
): Promise<TaskRecord | undefined> {
  for (const task of tasks) {
    if (!task.activeClaim || !["Claimed", "Running", "Waiting"].includes(task.status)) continue
    const receipt = await runtime.taskManager.owner.readReceiptByCommand(
      taskSpaceId,
      assignmentCommand(taskSpaceId, task),
    )
    if (receipt?.kind === "task-claim-receipt" && receipt.taskId === task.taskId
      && receipt.claim.claimId === task.activeClaim.claimId
      && receipt.claim.attempt === task.activeClaim.attempt
      && receipt.claim.leaseEpoch === task.activeClaim.leaseEpoch) return task
  }
  return undefined
}

function recoverableRace(error: unknown): boolean {
  if (error instanceof TaskManagerError) return [
      "revision-conflict",
      "task-not-ready",
      "claim-token-mismatch",
      "terminal-task-immutable",
    ].includes(error.code)
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
  return code === "EIDOLON_HOLON_TASK_RESULT_STALE" || code === "EIDOLON_HOLON_TASK_ATTEMPT_STALE"
}

export async function pumpHolonTaskSpace(
  runtime: HolonWorkflowTaskProcessorRuntime,
  input: PumpHolonTaskSpaceInput,
  config: TaskProcessorConfig,
): Promise<HolonTaskSpacePumpResult> {
  if (!Number.isSafeInteger(input.maxSteps) || input.maxSteps <= 0
    || !Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 3) {
    return fail("EIDOLON_HOLON_PUMP_INPUT_INVALID", "maxSteps must be positive and leaseDurationMs must be at least 3ms.")
  }
  const observedAtBase = timestamp(input.observedAt)
  const pumpStartedAt = Date.now()
  const settlements: TaskSettlementReceipt[] = []
  let steps = 0
  while (steps < input.maxSteps) {
    const observedAt = timestamp(observedAtBase, Date.now() - pumpStartedAt)
    const snapshot = await runtime.taskManager.owner.readSnapshot(input.subscription.taskSpaceId)
    if (!snapshot) return fail("EIDOLON_HOLON_PUMP_TASK_SPACE_MISSING", "Subscribed TaskSpace does not exist.")
    const tasks = snapshot.tasks.filter((task) => canonicalTask(task, input.subscription)).sort(compareTask)
    if (tasks.length === 0) return fail("EIDOLON_HOLON_PUMP_TASK_AUTHORITY_MISMATCH", "Subscription has no canonical organization tasks.")

    const expired = tasks.find((task) => task.activeClaim && Date.parse(task.activeClaim.expiresAt) <= Date.parse(observedAt))
    if (expired?.activeClaim) {
      const claim = expired.activeClaim
      try {
        await expireTaskClaim(runtime.taskManager, {
          kind: "task.claim-expire",
          commandId: commandId("expire", {
            taskSpaceId: snapshot.taskSpaceId,
            taskId: expired.taskId,
            claimId: claim.claimId,
            attempt: claim.attempt,
            leaseEpoch: claim.leaseEpoch,
          }),
          taskSpaceId: snapshot.taskSpaceId,
          expectedRevision: snapshot.revision,
          claim,
          observedAt,
        }, config)
      } catch (error) {
        if (!recoverableRace(error)) throw error
      }
      steps += 1
      continue
    }

    const ready = tasks.find((task) => task.status === "Ready")
    const recovering = await recoveringTask(runtime, snapshot.taskSpaceId, tasks)
    if (!ready && recovering?.activeClaim) {
      const claim = recovering.activeClaim
      const observedMs = Date.parse(observedAt)
      const heartbeatMs = Date.parse(claim.heartbeatAt)
      const expiresMs = Date.parse(claim.expiresAt)
      if (observedMs > heartbeatMs && observedMs < expiresMs
        && expiresMs - observedMs <= Math.ceil(input.leaseDurationMs / 2)) {
        try {
          await heartbeatTaskClaim(runtime.taskManager, {
            kind: "task.claim-heartbeat",
            commandId: commandId("heartbeat", {
              taskSpaceId: snapshot.taskSpaceId,
              taskId: recovering.taskId,
              claimId: claim.claimId,
              attempt: claim.attempt,
              leaseEpoch: claim.leaseEpoch,
              observedAt,
            }),
            taskSpaceId: snapshot.taskSpaceId,
            expectedRevision: snapshot.revision,
            claim,
            heartbeatAt: observedAt,
            extendByMs: input.leaseDurationMs,
          }, config)
        } catch (error) {
          if (!recoverableRace(error)) throw error
        }
        steps += 1
        continue
      }
    }
    const selected = ready ?? recovering
    if (!selected) {
      const terminal = tasks.every((task) => ["Succeeded", "Failed", "Cancelled"].includes(task.status))
      return Object.freeze({
        kind: "holon-task-space-pump-result",
        taskSpaceId: snapshot.taskSpaceId,
        observedRevision: snapshot.revision,
        status: terminal ? "terminal" : "waiting",
        steps,
        settlements: Object.freeze(settlements),
      })
    }

    const claim = selected.activeClaim
    const claimedAt = claim?.claimedAt ?? observedAt
    const ids = executionIds(snapshot.taskSpaceId, selected, claimedAt)
    try {
      const result: HolonWorkflowTaskExecutionResult = await executeHolonWorkflowTask(runtime, {
        deploymentId: input.subscription.deploymentId,
        bindingRef: input.subscription.bindingRef,
        holonRef: input.subscription.holonRef,
        taskSpaceId: input.subscription.taskSpaceId,
        taskId: selected.taskId,
        workflowInstanceId: input.subscription.workflowInstanceId,
        runId: input.subscription.runId,
        ...ids,
        claimedAt,
        startedAt: timestamp(claimedAt, 1),
        settledAt: timestamp(claimedAt, 2),
        leaseDurationMs: input.leaseDurationMs,
        input: input.subscription.input,
      }, config)
      settlements.push(result.settlementReceipt)
    } catch (error) {
      if (recoverableRace(error)) {
        steps += 1
        continue
      }
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : ""
      if (code !== "EIDOLON_HOLON_MEMBER_EXECUTION_FAILED") throw error
      const current = await runtime.taskManager.owner.readSnapshot(snapshot.taskSpaceId)
      const failed = current?.tasks.find((task) => task.taskId === selected.taskId)
      if (failed?.activeClaim && ["Running", "Waiting"].includes(failed.status)) {
        const occurredAt = timestamp(failed.activeClaim.heartbeatAt, 1)
        const settled = await failTask(runtime.taskManager, {
          kind: "task.fail",
          commandId: commandId("fail", {
            taskSpaceId: snapshot.taskSpaceId,
            taskId: failed.taskId,
            claimId: failed.activeClaim.claimId,
          }),
          taskSpaceId: snapshot.taskSpaceId,
          expectedRevision: current!.revision,
          claim: failed.activeClaim,
          occurredAt,
          failure: {
            kind: "task-failure",
            code: error instanceof Error && "code" in error ? String(error.code) : "EIDOLON_HOLON_MEMBER_EXECUTION_FAILED",
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        }, config)
        settlements.push(settled.receipt)
      } else {
        throw error
      }
    }
    steps += 1
  }
  const snapshot = await runtime.taskManager.owner.readSnapshot(input.subscription.taskSpaceId)
  if (!snapshot) return fail("EIDOLON_HOLON_PUMP_TASK_SPACE_MISSING", "Subscribed TaskSpace disappeared.")
  return Object.freeze({
    kind: "holon-task-space-pump-result",
    taskSpaceId: snapshot.taskSpaceId,
    observedRevision: snapshot.revision,
    status: "yielded",
    steps,
    settlements: Object.freeze(settlements),
  })
}
