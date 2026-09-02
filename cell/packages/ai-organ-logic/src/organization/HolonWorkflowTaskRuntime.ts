import { createHash } from "node:crypto"

import {
  canonicalOwnDataBytes,
  canonicalOwnDataDigest,
  deepFrozenCanonicalOwnDataClone,
  type ImmutableJsonValue,
  type TaskArtifactBody,
  type TaskArtifactRef,
  type TaskClaimReceipt,
  type TaskClaimToken,
  type TaskSettlementReceipt,
} from "task-manager-contract"
import {
  settleTask,
  startTask,
  heartbeatTaskClaim,
  type TaskManagerRuntime,
  type TaskProcessorConfig,
} from "task-manager-logic"
import { normalizeHolonTaskTarget } from "ai-workflow-contract"
import type { ClosedValue, HolonExecutionInvocation } from "holarchy-eidolon-adapter"

import {
  coordinateHolonTaskAssignment,
  type HolonCoordinatorProcessorRuntime,
} from "./HolonCoordinator"
import type { FileHolonDeploymentRuntimeStore } from "./HolonDeploymentRuntimeStore"
import type { EidolonHolonLocalActorRuntime } from "./HolonLocalActorRuntime"
import { ensureHolonMemberRuntime } from "./HolonMemberRuntime"
import {
  createHolonTaskPumpDispatchIntent,
  type HolonTaskPumpJournalPort,
} from "./HolonTaskPumpJournal"

export interface HolonWorkflowTaskProcessorRuntime {
  readonly store: FileHolonDeploymentRuntimeStore
  readonly taskManager: TaskManagerRuntime
  readonly actorRuntime: EidolonHolonLocalActorRuntime
  readonly journal: HolonTaskPumpJournalPort
}

export interface ExecuteHolonWorkflowTaskInput {
  readonly deploymentId: string
  readonly bindingRef: `resource://${string}`
  readonly holonRef: string
  readonly taskSpaceId: string
  readonly taskId: string
  readonly workflowInstanceId: string
  readonly runId: string
  readonly assignmentCommandId: string
  readonly startCommandId: string
  readonly settlementCommandId: string
  readonly invocationRef: string
  readonly claimedAt: string
  readonly startedAt: string
  readonly settledAt: string
  readonly leaseDurationMs: number
  readonly input: ClosedValue
}

export interface HolonWorkflowTaskExecutionResult {
  readonly deploymentId: string
  readonly taskSpaceId: string
  readonly taskId: string
  readonly memberRef: string
  readonly memberRuntimeRef: string
  readonly settlementReceipt: TaskSettlementReceipt
  readonly outputArtifacts: readonly TaskArtifactRef[]
  readonly replayed: boolean
}

export class HolonWorkflowTaskRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "HolonWorkflowTaskRuntimeError"
  }
}

const invalid = (code: string, message: string): never => {
  throw new HolonWorkflowTaskRuntimeError(code, message)
}

/**
 * Product composition Processor. TaskSpace owns claim/start/settlement, the
 * deployment store owns only stable actor/session references, and the generic
 * actor runtime owns execution. No cross-owner transaction is introduced.
 */
export async function executeHolonWorkflowTask(
  runtime: HolonWorkflowTaskProcessorRuntime,
  inputValue: ExecuteHolonWorkflowTaskInput,
  config: TaskProcessorConfig,
): Promise<HolonWorkflowTaskExecutionResult> {
  const input = normalizeInput(inputValue)
  assertRuntime(runtime)

  const existingSettlement = await runtime.taskManager.owner.readReceiptByCommand(
    input.taskSpaceId,
    input.settlementCommandId,
  )
  if (existingSettlement) return replayResult(runtime, input, existingSettlement)

  const assignment = await coordinateHolonTaskAssignment({
    store: runtime.store,
    taskManager: runtime.taskManager,
    actorOwner: runtime.actorRuntime,
  } satisfies HolonCoordinatorProcessorRuntime, {
    deploymentId: input.deploymentId,
    bindingRef: input.bindingRef,
    holonRef: input.holonRef,
    taskSpaceId: input.taskSpaceId,
    taskId: input.taskId,
    commandId: input.assignmentCommandId,
    claimedAt: input.claimedAt,
    leaseDurationMs: input.leaseDurationMs,
  }, config)

  const claimedSnapshot = await runtime.taskManager.owner.readSnapshot(input.taskSpaceId)
  const claimedTask = claimedSnapshot?.tasks.find((candidate) => candidate.taskId === input.taskId)
  const liveAssignmentClaim = claimedTask?.activeClaim
  if (!liveAssignmentClaim || !sameClaimAttempt(liveAssignmentClaim, assignment.claimReceipt.claim)) {
    return invalid("EIDOLON_HOLON_TASK_ATTEMPT_STALE", "Assignment no longer owns the live TaskSpace attempt.")
  }

  const member = await ensureHolonMemberRuntime({
    store: runtime.store,
    actorOwner: runtime.actorRuntime,
    sessions: runtime.actorRuntime,
  }, {
    deploymentId: input.deploymentId,
    bindingRef: input.bindingRef,
    holonRef: input.holonRef,
    memberRef: assignment.memberRef,
    runtime: assignment.memberRuntimeIsolation,
    taskAttempt: {
      taskSpaceId: input.taskSpaceId,
      taskId: input.taskId,
      claimId: assignment.claimReceipt.claim.claimId,
      attempt: assignment.claimReceipt.claim.attempt,
      workflowInstanceId: input.workflowInstanceId,
      runId: input.runId,
    },
    session: { mode: "task-attempt" },
  }, {})

  const existingStart = await runtime.taskManager.owner.readReceiptByCommand(input.taskSpaceId, input.startCommandId)
  const startClaim = existingStart ? assignment.claimReceipt.claim : liveAssignmentClaim
  const startRevision = existingStart ? assignment.claimReceipt.toRevision : claimedSnapshot!.revision
  const startedAt = laterTimestamp(input.startedAt, startClaim.heartbeatAt, 1)
  const started = await startTask(runtime.taskManager, {
    kind: "task.start",
    commandId: input.startCommandId,
    taskSpaceId: input.taskSpaceId,
    expectedRevision: startRevision,
    claim: startClaim,
    occurredAt: startedAt,
  }, config)
  const task = started.snapshot.tasks.find((candidate) => candidate.taskId === input.taskId)
  if (!task || task.definition.kind !== "task" || task.profile.profileKind !== "depa.ai.organization-task") {
    return invalid("EIDOLON_HOLON_TASK_PROFILE_INVALID", "Started task lost its organization-task profile.")
  }
  const target = normalizeHolonTaskTarget(task.profile.facts.target)
  if (target.executionBinding.ref !== input.bindingRef || target.holon.rootHolonRef !== input.holonRef) {
    return invalid("EIDOLON_HOLON_TASK_TARGET_MISMATCH", "Started task no longer matches the frozen deployment target.")
  }
  const invocation: HolonExecutionInvocation = Object.freeze({
    apiVersion: "eidolon.ai/v1",
    kind: "HolonExecutionInvocation",
    taskSpaceRef: input.taskSpaceId,
    taskRef: input.taskId,
    claimRef: assignment.claimReceipt.claim.claimId,
    invocationRef: input.invocationRef,
    targetBindingRef: input.bindingRef,
    input: input.input,
    materialRefs: target.output.materialPortRefs,
    resultContractRef: target.output.schemaRef,
  })
  const intent = createHolonTaskPumpDispatchIntent({
    deploymentId: input.deploymentId,
    taskSpaceId: input.taskSpaceId,
    taskId: input.taskId,
    claimId: assignment.claimReceipt.claim.claimId,
    attempt: assignment.claimReceipt.claim.attempt,
    leaseEpoch: assignment.claimReceipt.claim.leaseEpoch,
    invocationRef: input.invocationRef,
    input: input.input,
    preparedAt: assignment.claimReceipt.claim.claimedAt,
  })
  const dispatchStartedAt = Date.now()
  const heartbeatAbort = new AbortController()
  let heartbeatFailure: unknown
  const heartbeat = maintainClaimHeartbeat(
    runtime,
    input,
    task.activeClaim ?? startClaim,
    config,
    heartbeatAbort.signal,
  ).catch((error) => { heartbeatFailure = error })
  let dispatched: Awaited<ReturnType<HolonTaskPumpJournalPort["dispatch"]>>
  try {
    dispatched = await runtime.journal.dispatch(intent, async (idempotencyKey) => {
      try {
        return (await runtime.actorRuntime.dispatchMember(member.runtimeRef, invocation, idempotencyKey)).output
      } catch (error) {
        if (error instanceof Error && "code" in error
          && error.code === "EIDOLON_WORKFLOW_EFFECT_PROCESS_CRASH") throw error
        throw new HolonWorkflowTaskRuntimeError(
          "EIDOLON_HOLON_MEMBER_EXECUTION_FAILED",
          error instanceof Error ? error.message : String(error),
        )
      }
    })
  } finally {
    heartbeatAbort.abort()
    await heartbeat
  }
  if (heartbeatFailure) throw heartbeatFailure
  const settlementSnapshot = await runtime.taskManager.owner.readSnapshot(input.taskSpaceId)
  const settlementTask = settlementSnapshot?.tasks.find((candidate) => candidate.taskId === input.taskId)
  const settlementClaim = settlementTask?.activeClaim
  if (!settlementSnapshot || !settlementTask || settlementTask.status !== "Running"
    || !settlementClaim || !sameClaimAttempt(settlementClaim, assignment.claimReceipt.claim)) {
    return invalid("EIDOLON_HOLON_TASK_RESULT_STALE", "A durable result cannot settle a replaced or expired TaskSpace attempt.")
  }
  const elapsedSettlementAt = new Date(Date.parse(startedAt) + (Date.now() - dispatchStartedAt)).toISOString()
  const settledAt = laterTimestamp(input.settledAt, laterTimestamp(elapsedSettlementAt, settlementClaim.heartbeatAt, 1), 1)
  if (Date.parse(settledAt) >= Date.parse(settlementClaim.expiresAt)) {
    return invalid("EIDOLON_HOLON_TASK_RESULT_STALE", "A durable result arrived after its live lease expired.")
  }
  const materials = settlementMaterials(target.output.materialPortRefs, dispatched.receipt.output)
  const settled = await settleTask(runtime.taskManager, {
    kind: "task.settle",
    commandId: input.settlementCommandId,
    taskSpaceId: input.taskSpaceId,
    expectedRevision: settlementSnapshot.revision,
    claim: settlementClaim,
    occurredAt: settledAt,
    outputArtifacts: materials.map(({ ref }) => ref),
    artifactBodies: materials.map(({ body }) => body),
    result: deepFrozenCanonicalOwnDataClone(dispatched.receipt.output) as ImmutableJsonValue,
  }, config)
  return Object.freeze({
    deploymentId: input.deploymentId,
    taskSpaceId: input.taskSpaceId,
    taskId: input.taskId,
    memberRef: assignment.memberRef,
    memberRuntimeRef: member.runtimeRef,
    settlementReceipt: settled.receipt,
    outputArtifacts: Object.freeze(materials.map(({ ref }) => ref)),
    replayed: settled.replayed || dispatched.replayed,
  })
}

async function maintainClaimHeartbeat(
  runtime: HolonWorkflowTaskProcessorRuntime,
  input: ExecuteHolonWorkflowTaskInput,
  initialClaim: TaskClaimToken,
  config: TaskProcessorConfig,
  signal: AbortSignal,
): Promise<void> {
  const intervalMs = Math.max(1, Math.floor(input.leaseDurationMs / 3))
  const startedAt = Date.now()
  const authorityStart = Date.parse(initialClaim.heartbeatAt)
  let claim = initialClaim
  while (!signal.aborted) {
    if (!await waitForHeartbeat(intervalMs, signal)) return
    const heartbeatAt = new Date(authorityStart + (Date.now() - startedAt)).toISOString()
    if (Date.parse(heartbeatAt) >= Date.parse(claim.expiresAt)) {
      return invalid("EIDOLON_HOLON_TASK_ATTEMPT_STALE", "The live task lease expired before its heartbeat could commit.")
    }
    const snapshot = await runtime.taskManager.owner.readSnapshot(input.taskSpaceId)
    const task = snapshot?.tasks.find((candidate) => candidate.taskId === input.taskId)
    if (!snapshot || !task?.activeClaim || task.status !== "Running"
      || !sameClaimAttempt(task.activeClaim, claim)) {
      return invalid("EIDOLON_HOLON_TASK_ATTEMPT_STALE", "Heartbeat no longer owns the live TaskSpace attempt.")
    }
    const heartbeated = await heartbeatTaskClaim(runtime.taskManager, {
      kind: "task.claim-heartbeat",
      commandId: `holon-task-heartbeat-${createHash("sha256")
        .update(`${claim.claimId}\u0000${claim.leaseEpoch}\u0000${heartbeatAt}`)
        .digest("hex")
        .slice(0, 40)}`,
      taskSpaceId: input.taskSpaceId,
      expectedRevision: snapshot.revision,
      claim,
      heartbeatAt,
      extendByMs: input.leaseDurationMs,
    }, config)
    const renewed = heartbeated.snapshot.tasks.find((candidate) => candidate.taskId === input.taskId)?.activeClaim
    if (!renewed) return invalid("EIDOLON_HOLON_TASK_ATTEMPT_STALE", "Heartbeat lost the renewed claim projection.")
    claim = renewed
  }
}

function waitForHeartbeat(delayMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false)
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve(true)
    }, delayMs)
    const abort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener("abort", abort, { once: true })
  })
}

function sameClaimAttempt(left: TaskClaimToken, right: TaskClaimToken): boolean {
  return left.claimId === right.claimId
    && left.taskSpaceId === right.taskSpaceId
    && left.taskId === right.taskId
    && left.assigneeRef === right.assigneeRef
    && left.attempt === right.attempt
    && left.leaseEpoch === right.leaseEpoch
}

function laterTimestamp(requested: string, boundary: string, offsetMs: number): string {
  const requestedMs = Date.parse(requested)
  const boundaryMs = Date.parse(boundary)
  if (!Number.isFinite(requestedMs) || !Number.isFinite(boundaryMs)) {
    return invalid("EIDOLON_HOLON_TASK_INPUT_INVALID", "Task transition timestamps must be valid ISO timestamps.")
  }
  return new Date(Math.max(requestedMs, boundaryMs + offsetMs)).toISOString()
}

async function replayResult(
  runtime: HolonWorkflowTaskProcessorRuntime,
  input: ExecuteHolonWorkflowTaskInput,
  settlementValue: Awaited<ReturnType<TaskManagerRuntime["owner"]["readReceiptByCommand"]>>,
): Promise<HolonWorkflowTaskExecutionResult> {
  if (!settlementValue || settlementValue.kind !== "task-settlement-receipt"
    || settlementValue.taskId !== input.taskId || settlementValue.status !== "Succeeded") {
    return invalid("EIDOLON_HOLON_TASK_SETTLEMENT_CONFLICT", "Settlement command is bound to another terminal fact.")
  }
  const assignmentValue = await runtime.taskManager.owner.readReceiptByCommand(
    input.taskSpaceId,
    input.assignmentCommandId,
  )
  if (!assignmentValue || assignmentValue.kind !== "task-claim-receipt"
    || assignmentValue.taskId !== input.taskId) {
    return invalid("EIDOLON_HOLON_TASK_ASSIGNMENT_RECEIPT_MISSING", "Settled task has no exact assignment receipt.")
  }
  const snapshot = await runtime.taskManager.owner.readSnapshot(input.taskSpaceId)
  const task = snapshot?.tasks.find((candidate) => candidate.taskId === input.taskId)
  if (!task || task.status !== "Succeeded" || task.outputArtifacts.length === 0) {
    return invalid("EIDOLON_HOLON_TASK_SETTLEMENT_PROJECTION_MISMATCH", "Settlement receipt differs from the live TaskSpace projection.")
  }
  const deployment = await runtime.store.load(input.deploymentId)
  const member = deployment.members.find((candidate) => (
    candidate.runtimeRef === (assignmentValue as TaskClaimReceipt).claim.assigneeRef
  ))
  if (!member) {
    return invalid("EIDOLON_HOLON_MEMBER_RUNTIME_MISSING", "Settlement assignment has no retained MemberRuntime reference.")
  }
  return Object.freeze({
    deploymentId: input.deploymentId,
    taskSpaceId: input.taskSpaceId,
    taskId: input.taskId,
    memberRef: member.memberRef,
    memberRuntimeRef: member.runtimeRef,
    settlementReceipt: settlementValue,
    outputArtifacts: task.outputArtifacts,
    replayed: true,
  })
}

function settlementMaterials(
  materialPortRefs: readonly `resource://${string}`[],
  output: ClosedValue,
): readonly Readonly<{ readonly ref: TaskArtifactRef; readonly body: TaskArtifactBody }>[] {
  const values = materialPortRefs.length === 1 ? [output] : exactOutputValues(materialPortRefs, output)
  return Object.freeze(materialPortRefs.map((name, index) => {
    const value = deepFrozenCanonicalOwnDataClone(values[index])
    const bytes = canonicalOwnDataBytes(value)
    const digest = canonicalOwnDataDigest(value)
    return Object.freeze({
      ref: Object.freeze({
        kind: "task-artifact-ref" as const,
        digest,
        mediaType: "application/json",
        sizeBytes: bytes.byteLength,
        name,
      }),
      body: Object.freeze({
        kind: "task-artifact-body" as const,
        digest,
        mediaType: "application/json",
        sizeBytes: bytes.byteLength,
        encoding: "base64" as const,
        data: Buffer.from(bytes).toString("base64"),
      }),
    })
  }))
}

function exactOutputValues(
  materialPortRefs: readonly `resource://${string}`[],
  output: ClosedValue,
): readonly ClosedValue[] {
  if (output === null || typeof output !== "object" || Array.isArray(output)) {
    return invalid("EIDOLON_HOLON_OUTPUT_PORT_MISMATCH", "Multi-port output must be one exact object.")
  }
  const keys = Object.keys(output)
  if (keys.length !== materialPortRefs.length
    || keys.some((key) => !materialPortRefs.includes(key as `resource://${string}`))) {
    return invalid("EIDOLON_HOLON_OUTPUT_PORT_MISMATCH", "Output keys must equal the frozen MaterialPort refs.")
  }
  const outputRecord = output as Readonly<Record<string, ClosedValue>>
  return Object.freeze(materialPortRefs.map((ref) => outputRecord[ref]!))
}

function assertRuntime(runtime: HolonWorkflowTaskProcessorRuntime): void {
  if (!runtime || typeof runtime !== "object" || typeof runtime.store?.load !== "function"
    || typeof runtime.taskManager?.owner?.readSnapshot !== "function"
    || typeof runtime.actorRuntime?.dispatchMember !== "function"
    || typeof runtime.journal?.dispatch !== "function") {
    invalid("EIDOLON_HOLON_TASK_RUNTIME_INVALID", "Task execution runtime ports are incomplete.")
  }
}

function normalizeInput(value: unknown): ExecuteHolonWorkflowTaskInput {
  const required = [
    "deploymentId", "bindingRef", "holonRef", "taskSpaceId", "taskId", "workflowInstanceId",
    "runId", "assignmentCommandId", "startCommandId", "settlementCommandId", "invocationRef",
    "claimedAt", "startedAt", "settledAt", "leaseDurationMs", "input",
  ] as const
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return invalid("EIDOLON_HOLON_TASK_INPUT_INVALID", "Input must be one plain object.")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length !== required.length || keys.some((key) => typeof key !== "string")
    || required.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key))) {
    return invalid("EIDOLON_HOLON_TASK_INPUT_INVALID", "Input has missing or unsupported fields.")
  }
  const fields: Record<string, unknown> = Object.create(null)
  for (const key of required) {
    const descriptor = descriptors[key]
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      return invalid("EIDOLON_HOLON_TASK_INPUT_INVALID", `input.${key} must be enumerable own data.`)
    }
    fields[key] = descriptor.value
  }
  if (!Number.isSafeInteger(fields.leaseDurationMs) || (fields.leaseDurationMs as number) <= 0) {
    return invalid("EIDOLON_HOLON_TASK_INPUT_INVALID", "leaseDurationMs must be one positive safe integer.")
  }
  const text = (key: string): string => {
    const field = fields[key]
    if (typeof field !== "string" || !field || field !== field.trim() || field !== field.normalize("NFC")) {
      return invalid("EIDOLON_HOLON_TASK_INPUT_INVALID", `input.${key} must be one exact string.`)
    }
    return field
  }
  const bindingRef = text("bindingRef")
  if (!bindingRef.startsWith("resource://") || !bindingRef.slice("resource://".length)) {
    return invalid("EIDOLON_HOLON_TASK_INPUT_INVALID", "bindingRef must be one resource:// identity.")
  }
  return Object.freeze({
    deploymentId: text("deploymentId"),
    bindingRef: bindingRef as `resource://${string}`,
    holonRef: text("holonRef"),
    taskSpaceId: text("taskSpaceId"),
    taskId: text("taskId"),
    workflowInstanceId: text("workflowInstanceId"),
    runId: text("runId"),
    assignmentCommandId: text("assignmentCommandId"),
    startCommandId: text("startCommandId"),
    settlementCommandId: text("settlementCommandId"),
    invocationRef: text("invocationRef"),
    claimedAt: text("claimedAt"),
    startedAt: text("startedAt"),
    settledAt: text("settledAt"),
    leaseDurationMs: fields.leaseDurationMs as number,
    input: deepFrozenCanonicalOwnDataClone(fields.input) as ClosedValue,
  })
}
