import { createHash } from "node:crypto"

import {
  HOLON_TASK_COORDINATOR_WAKE_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_ASSIGNMENT_RECEIPT_SCHEMA_VERSION,
  type FrozenHolonTaskRuntimeAdmission,
  type HolonTaskRuntimeAssignmentReceipt,
  type HolonTaskRuntimeCatalogPort,
  type HolonTaskRuntimeCatalogSnapshot,
  type HolonTaskRuntimeCoordinatorMailboxPort,
  type HolonTaskRuntimeDeploymentPort,
  type HolonTaskRuntimeInvocation,
  type HolonTaskRuntimeProcessorConfig,
  type HolonTaskRuntimeService,
  type HolonTaskRuntimeSettlementPort,
  type HolonTaskRuntimeTaskSpacePort,
  type HolonTaskDigest,
  type HolonTaskSelector,
  type HolonTaskInspectionPort,
  type HolonTaskIdentitySelector,
  type HolonTaskRepairInvocation,
} from "@cell/ai-organ-contract"

import {
  normalizeFrozenHolonTaskRuntimeAdmission,
  normalizeHolonTaskRuntimeInvocation,
  normalizeHolonTaskSnapshotReceiptForAdmission,
  normalizeHolonTaskSelector,
} from "./HolonTaskRuntimeContract"

export interface HolonTaskRuntime {
  readonly inspection?: HolonTaskInspectionPort
  readonly catalog: HolonTaskRuntimeCatalogPort
  readonly deployment: HolonTaskRuntimeDeploymentPort
  readonly taskSpace: HolonTaskRuntimeTaskSpacePort
  readonly coordinatorMailbox: HolonTaskRuntimeCoordinatorMailboxPort
  readonly settlement: HolonTaskRuntimeSettlementPort
}

export class HolonTaskRuntimeServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "HolonTaskRuntimeServiceError"
  }
}

const invalid = (code: string, message: string): never => {
  throw new HolonTaskRuntimeServiceError(code, message)
}

const compareUtf16 = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

function exactText(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/.test(value)) {
    return invalid("EIDOLON_HOLON_TASK_RUNTIME_EFFECT_INVALID", `${location} must be one exact string.`)
  }
  return value
}

function normalizeConfig(value: HolonTaskRuntimeProcessorConfig): HolonTaskRuntimeProcessorConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return invalid("EIDOLON_HOLON_TASK_CONFIG_INVALID", "Processor config must be one plain object.")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.length !== 2 || !Object.prototype.hasOwnProperty.call(descriptors, "leaseDurationMs")
    || !Object.prototype.hasOwnProperty.call(descriptors, "maxSteps")
    || keys.some((key) => typeof key !== "string" || !["leaseDurationMs", "maxSteps"].includes(key))) {
    return invalid("EIDOLON_HOLON_TASK_CONFIG_INVALID", "Processor config has missing or unsupported fields.")
  }
  const leaseDurationMs = descriptors.leaseDurationMs?.value
  const maxSteps = descriptors.maxSteps?.value
  if (!Number.isSafeInteger(leaseDurationMs) || (leaseDurationMs as number) <= 0
    || !Number.isSafeInteger(maxSteps) || (maxSteps as number) <= 0) {
    return invalid("EIDOLON_HOLON_TASK_CONFIG_INVALID", "leaseDurationMs and maxSteps must be positive safe integers.")
  }
  return Object.freeze({ leaseDurationMs: leaseDurationMs as number, maxSteps: maxSteps as number })
}

function normalizeCatalog(value: HolonTaskRuntimeCatalogSnapshot): HolonTaskRuntimeCatalogSnapshot {
  if (!Number.isSafeInteger(value?.revision) || value.revision < 0 || !Array.isArray(value.admissions)) {
    return invalid("EIDOLON_HOLON_TASK_CATALOG_INVALID", "Catalog snapshot is malformed.")
  }
  const admissions = value.admissions.map(normalizeFrozenHolonTaskRuntimeAdmission)
    .sort((left, right) => compareUtf16(left.admissionId, right.admissionId))
  if (new Set(admissions.map(({ admissionId }) => admissionId)).size !== admissions.length) {
    return invalid("EIDOLON_HOLON_TASK_CATALOG_INVALID", "Catalog contains duplicate admission ids.")
  }
  return Object.freeze({ revision: value.revision, admissions: Object.freeze(admissions) })
}

export function transitionHolonTaskRuntimeCatalog(
  currentValue: HolonTaskRuntimeCatalogSnapshot,
  admissionValue: unknown,
): HolonTaskRuntimeCatalogSnapshot {
  const current = normalizeCatalog(currentValue)
  const admission = normalizeFrozenHolonTaskRuntimeAdmission(admissionValue)
  const existing = current.admissions.find((candidate) => candidate.admissionId === admission.admissionId)
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(admission)) {
      return invalid(
        "EIDOLON_HOLON_TASK_ADMISSION_CONFLICT",
        `Admission '${admission.admissionId}' is already bound to different frozen facts.`,
      )
    }
    return currentValue
  }
  return Object.freeze({
    revision: current.revision + 1,
    admissions: Object.freeze([...current.admissions, admission]
      .sort((left, right) => compareUtf16(left.admissionId, right.admissionId))),
  })
}

export async function registerHolonTaskRuntimeAdmission(
  runtime: Pick<HolonTaskRuntime, "catalog">,
  admission: unknown,
): Promise<HolonTaskRuntimeCatalogSnapshot> {
  if (typeof runtime?.catalog?.read !== "function" || typeof runtime.catalog.compareAndSet !== "function") {
    return invalid("EIDOLON_HOLON_TASK_RUNTIME_UNBOUND", "Admission catalog port is missing.")
  }
  const current = await runtime.catalog.read()
  const next = transitionHolonTaskRuntimeCatalog(current, admission)
  if (next === current) return current
  return runtime.catalog.compareAndSet({ expectedRevision: current.revision, next })
}

export function resolveHolonTaskRuntimeAdmission(
  catalogValue: HolonTaskRuntimeCatalogSnapshot,
  selectorValue: unknown,
): FrozenHolonTaskRuntimeAdmission {
  const catalog = normalizeCatalog(catalogValue)
  const selector = normalizeHolonTaskSelector(selectorValue)
  if (selector.kind === "admission") {
    const exact = catalog.admissions.find((admission) => admission.admissionId === selector.admissionId)
    if (!exact) {
      return invalid(
        "EIDOLON_HOLON_TASK_BINDING_REQUIRED",
        `Admission '${selector.admissionId}' is not present in the frozen runtime catalog.`,
      )
    }
    return exact
  }
  const candidates = catalog.admissions.filter((admission) => {
    if (admission.definition.rootHolonRef !== selector.holonRef) return false
    if (selector.kind === "holon") return admission.definition.defaultForHolon
    return admission.executionTarget.kind === "member"
      && admission.executionTarget.memberRef === selector.memberRef
  })
  if (candidates.length === 0) {
    return invalid(
      "EIDOLON_HOLON_TASK_BINDING_REQUIRED",
      `Selector '${selector.kind}:${selector.holonRef}' has no frozen runtime admission.`,
    )
  }
  if (candidates.length > 1) {
    return invalid(
      "EIDOLON_HOLON_TASK_BINDING_AMBIGUOUS",
      `Selector '${selector.kind}:${selector.holonRef}' resolves ${candidates.length} frozen admissions.`,
    )
  }
  return candidates[0]!
}

export async function assignHolonTask(
  runtime: HolonTaskRuntime,
  selectorValue: HolonTaskSelector,
  invocationValue: HolonTaskRuntimeInvocation,
  configValue: HolonTaskRuntimeProcessorConfig,
): Promise<HolonTaskRuntimeAssignmentReceipt> {
  assertRuntime(runtime)
  const selector = normalizeHolonTaskSelector(selectorValue)
  const invocation = normalizeHolonTaskRuntimeInvocation(invocationValue)
  const config = normalizeConfig(configValue)
  const admission = resolveHolonTaskRuntimeAdmission(await runtime.catalog.read(), selector)
  const deployment = await runtime.deployment.ensure({ admission })
  const deploymentId = exactText(deployment.deploymentId, "deployment.deploymentId")
  const identity = createHash("sha256").update(JSON.stringify([
    admission.admissionId,
    invocation.requestId,
    invocation.idempotencyKey,
  ])).digest("hex").slice(0, 40)
  const taskId = invocation.taskRequest.kind === "exact"
    ? invocation.taskRequest.identity.taskId
    : `holon-task-${identity}`
  const commandId = invocation.taskRequest.kind === "exact"
    ? invocation.taskRequest.identity.commandId
    : `holon-task-submit-${identity}`
  // occurredAt records when a caller observed/issued an attempt. A retry with
  // the same durable request identity may observe a later wall-clock instant,
  // while the first accepted invocation remains authoritative in TaskSpace.
  // Keep every semantic request fact in the conflict fingerprint, but do not
  // turn this transport observation into a false idempotency conflict.
  const { occurredAt: _occurredAt, ...replayStableInvocation } = invocation
  const submissionFingerprint = `sha256:${createHash("sha256").update(JSON.stringify({
    admissionId: admission.admissionId,
    definitionDigest: admission.definitionDigest,
    invocation: replayStableInvocation,
    config,
    taskId,
    commandId,
  })).digest("hex")}` as HolonTaskDigest
  const task = await runtime.taskSpace.submit({
    admission,
    invocation,
    commandId,
    taskId,
    submissionFingerprint,
    config,
  })
  if (task.taskId !== taskId || task.commandId !== commandId) {
    return invalid("EIDOLON_HOLON_TASK_SUBMIT_RECEIPT_MISMATCH", "TaskSpace receipt differs from the submitted command.")
  }
  if (task.submissionFingerprint !== submissionFingerprint) {
    return invalid(
      "EIDOLON_HOLON_TASK_SUBMIT_FINGERPRINT_CONFLICT",
      "TaskSpace receipt was accepted for different invocation facts.",
    )
  }
  const taskSpaceId = exactText(task.taskSpaceId, "task.taskSpaceId")
  if (invocation.taskRequest.kind === "exact"
    && taskSpaceId !== invocation.taskRequest.identity.taskSpaceId) {
    return invalid(
      "EIDOLON_HOLON_TASK_SUBMIT_RECEIPT_MISMATCH",
      "TaskSpace receipt differs from the explicitly requested identity.",
    )
  }
  const snapshotReceipt = normalizeHolonTaskSnapshotReceiptForAdmission(
    admission,
    task.snapshotReceipt,
    taskSpaceId,
  )
  const messageId = `holon-task-wake-${identity}`
  const coordinatorWake = await runtime.coordinatorMailbox.sendWake(Object.freeze({
    kind: "holon-task.coordinator-wake",
    schemaVersion: HOLON_TASK_COORDINATOR_WAKE_SCHEMA_VERSION,
    deploymentId,
    holonRef: admission.definition.rootHolonRef,
    taskSpaceId: task.taskSpaceId,
    taskId: task.taskId,
    messageId,
  }))
  if (coordinatorWake.messageId !== messageId) {
    return invalid("EIDOLON_HOLON_TASK_WAKE_RECEIPT_MISMATCH", "Coordinator wake receipt has a different message id.")
  }
  const settlement = invocation.replyMode === "final"
    ? await runtime.settlement.observe({
        taskSpaceId: task.taskSpaceId,
        taskId: task.taskId,
        requestId: invocation.requestId,
      })
    : null
  return Object.freeze({
    kind: "holon-task-runtime-assignment-receipt",
    schemaVersion: HOLON_TASK_RUNTIME_ASSIGNMENT_RECEIPT_SCHEMA_VERSION,
    requestId: invocation.requestId,
    admissionId: admission.admissionId,
    definitionRef: admission.definition.definitionRef,
    replyMode: invocation.replyMode,
    task: Object.freeze({ ...task, taskSpaceId, snapshotReceipt }),
    coordinatorWake: Object.freeze({ ...coordinatorWake }),
    settlement: settlement === null ? null : Object.freeze({ ...settlement }),
  })
}

export function createHolonTaskRuntimeService(runtime: HolonTaskRuntime): HolonTaskRuntimeService {
  assertRuntime(runtime)
  return Object.freeze({
    observe: (selector: HolonTaskIdentitySelector) => {
      if (!runtime.inspection) return invalid("EIDOLON_HOLON_TASK_INSPECTION_UNBOUND", "Task inspection port is missing.")
      return runtime.inspection.observe(selector)
    },
    repair: async (selector: HolonTaskIdentitySelector, invocation: HolonTaskRepairInvocation) => {
      if (!runtime.inspection) return invalid("EIDOLON_HOLON_TASK_INSPECTION_UNBOUND", "Task inspection port is missing.")
      return runtime.inspection.repair({ selector, invocation })
    },
    assign: (
      selector: HolonTaskSelector,
      invocation: HolonTaskRuntimeInvocation,
      config: HolonTaskRuntimeProcessorConfig,
    ) => assignHolonTask(runtime, selector, invocation, config),
  })
}

function assertRuntime(runtime: HolonTaskRuntime): void {
  if (!runtime || typeof runtime !== "object"
    || typeof runtime.catalog?.read !== "function"
    || typeof runtime.catalog?.compareAndSet !== "function"
    || typeof runtime.deployment?.ensure !== "function"
    || typeof runtime.taskSpace?.submit !== "function"
    || typeof runtime.coordinatorMailbox?.sendWake !== "function"
    || typeof runtime.settlement?.observe !== "function") {
    invalid("EIDOLON_HOLON_TASK_RUNTIME_UNBOUND", "Holon task runtime ports are incomplete.")
  }
}
