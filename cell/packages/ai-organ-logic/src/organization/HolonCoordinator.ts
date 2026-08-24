import { createHash } from "node:crypto"

import {
  createAIOrganizationTaskProfile,
  normalizeHolonTaskSnapshotReceipt,
  normalizeHolonTaskTarget,
  type AIOrganizationTaskProfile,
} from "ai-workflow-contract"
import { parseActorRegistrationReceipt, type ActorRegistrationReceipt } from "depa-actor"
import {
  canonicalOwnDataDigest,
  type TaskClaimReceipt,
  type TaskRecord,
  type TaskSpaceSnapshot,
} from "task-manager-contract"
import { claimTask, type TaskManagerRuntime, type TaskProcessorConfig } from "task-manager-logic"
import {
  assertHolonExecutionBindingFreezeReceipt,
  type EidolonHolonExecutionBindingFreezeReceipt,
  type HolonMemberRuntimeIsolation,
} from "holarchy-eidolon-adapter"

import {
  FileHolonDeploymentRuntimeStore,
  normalizeHolonDeploymentRuntimeSnapshot,
} from "./HolonDeploymentRuntimeStore"
import { holonMemberRuntimeRef } from "./HolonMemberRuntime"

export interface CoordinateHolonTaskInput {
  readonly deploymentId: string
  readonly bindingRef: `resource://${string}`
  readonly holonRef: string
  readonly taskSpaceId: string
  readonly taskId: string
  readonly commandId: string
  readonly claimedAt: string
  readonly leaseDurationMs: number
}

export interface HolonCoordinatorActorOwnerPort {
  ensureCoordinatorActor(input: Readonly<{
    readonly deploymentId: string
    readonly holonRef: string
    readonly coordinatorRef: string
    readonly bindingReceipt: EidolonHolonExecutionBindingFreezeReceipt
  }>): Readonly<{
    readonly actorRef: string
    readonly registrationReceipt: ActorRegistrationReceipt
  }> | Promise<Readonly<{
    readonly actorRef: string
    readonly registrationReceipt: ActorRegistrationReceipt
  }>>
}

export interface HolonCoordinatorProcessorRuntime {
  readonly store: FileHolonDeploymentRuntimeStore
  readonly taskManager: TaskManagerRuntime
  readonly actorOwner: HolonCoordinatorActorOwnerPort
}

export interface HolonTaskAssignmentResult {
  readonly coordinatorRef: string
  readonly coordinatorActorRef: string
  readonly memberRef: string
  readonly memberRuntimeRef: string
  readonly memberRuntimeIsolation: HolonMemberRuntimeIsolation
  readonly claimReceipt: TaskClaimReceipt
}

export class HolonCoordinatorError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "HolonCoordinatorError"
  }
}

const invalid = (code: string, message: string): never => {
  throw new HolonCoordinatorError(code, message)
}

const compareUtf16 = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

function exactObject(
  value: unknown,
  required: readonly string[],
  location: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return invalid("EIDOLON_HOLON_COORDINATOR_INPUT_INVALID", `${location} must be one plain object.`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  const allowed = new Set(required)
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))
    || required.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key))) {
    return invalid("EIDOLON_HOLON_COORDINATOR_INPUT_INVALID", `${location} has missing or unsupported fields.`)
  }
  const output: Record<string, unknown> = Object.create(null)
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      return invalid("EIDOLON_HOLON_COORDINATOR_INPUT_INVALID", `${location}.${key} must be enumerable own data.`)
    }
    output[key] = descriptor.value
  }
  return output
}

function text(value: unknown, location: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/.test(value)) {
    return invalid("EIDOLON_HOLON_COORDINATOR_INPUT_INVALID", `${location} must be one exact string.`)
  }
  return value
}

function resourceRef(value: unknown, location: string): `resource://${string}` {
  const exact = text(value, location)
  if (!exact.startsWith("resource://") || !exact.slice("resource://".length)) {
    return invalid("EIDOLON_HOLON_COORDINATOR_INPUT_INVALID", `${location} must be one resource:// identity.`)
  }
  return exact as `resource://${string}`
}

function normalizeInput(value: unknown): CoordinateHolonTaskInput {
  const input = exactObject(value, [
    "deploymentId", "bindingRef", "holonRef", "taskSpaceId", "taskId",
    "commandId", "claimedAt", "leaseDurationMs",
  ], "input")
  if (!Number.isSafeInteger(input.leaseDurationMs) || (input.leaseDurationMs as number) <= 0) {
    return invalid("EIDOLON_HOLON_COORDINATOR_INPUT_INVALID", "input.leaseDurationMs must be positive.")
  }
  return Object.freeze({
    deploymentId: text(input.deploymentId, "input.deploymentId"),
    bindingRef: resourceRef(input.bindingRef, "input.bindingRef"),
    holonRef: text(input.holonRef, "input.holonRef"),
    taskSpaceId: text(input.taskSpaceId, "input.taskSpaceId"),
    taskId: text(input.taskId, "input.taskId"),
    commandId: text(input.commandId, "input.commandId"),
    claimedAt: text(input.claimedAt, "input.claimedAt"),
    leaseDurationMs: input.leaseDurationMs as number,
  })
}

function coordinatorRef(deploymentId: string, holonRef: string): string {
  return `coordinator-${createHash("sha256").update(JSON.stringify([deploymentId, holonRef])).digest("hex").slice(0, 32)}`
}

function exactProfile(task: TaskRecord): AIOrganizationTaskProfile {
  if (task.profile.profileKind !== "depa.ai.organization-task") {
    return invalid("EIDOLON_HOLON_TASK_PROFILE_INVALID", "Ready task is not an organization-task profile.")
  }
  const facts = exactObject(task.profile.facts, [
    "target", "snapshotReceipt", "assignmentReceipt", "memberRuntimeRef",
    "settlementReceipt", "snapshotAdoptions",
  ], "task.profile.facts")
  if (facts.assignmentReceipt !== null || facts.memberRuntimeRef !== null || facts.settlementReceipt !== null) {
    return invalid("EIDOLON_HOLON_TASK_ALREADY_ASSIGNED", "Ready organization task already carries assignment or settlement facts.")
  }
  if (!Array.isArray(facts.snapshotAdoptions)) {
    return invalid("EIDOLON_HOLON_TASK_PROFILE_INVALID", "snapshotAdoptions must be an array.")
  }
  const normalized = createAIOrganizationTaskProfile(
    normalizeHolonTaskTarget(facts.target),
    normalizeHolonTaskSnapshotReceipt(facts.snapshotReceipt),
    facts.snapshotAdoptions,
  )
  if (canonicalOwnDataDigest(normalized) !== canonicalOwnDataDigest(task.profile)) {
    return invalid("EIDOLON_HOLON_TASK_PROFILE_INVALID", "Task profile is not the exact canonical organization profile.")
  }
  return normalized
}

function eligibleMembers(
  records: readonly unknown[],
  holonRef: string,
  receiptMembers: readonly string[],
  requiredRoles: readonly string[],
): readonly string[] {
  const values = records as readonly Readonly<Record<string, unknown>>[]
  const roles = new Set(requiredRoles)
  const candidates: string[] = []
  for (const memberRef of receiptMembers) {
    const member = values.find((value) => value.kind === "Member" && value.id === memberRef)
    if (!member || typeof member.subjectId !== "string") continue
    const memberships = values.filter((value) => value.kind === "HolonMembershipVersion"
      && value.parentHolonId === holonRef && value.subjectId === member.subjectId
      && value.effectiveState === true)
    if (memberships.length === 0) continue
    const membershipIds = new Set(memberships.map((value) => value.membershipId))
    const assignedRoles = new Set(values.filter((value) => value.kind === "RoleAssignmentVersion"
      && value.effectiveState === true && membershipIds.has(value.membershipId))
      .map((value) => value.roleId))
    if ([...roles].every((role) => assignedRoles.has(role))) candidates.push(memberRef)
  }
  return Object.freeze(candidates.sort(compareUtf16))
}

function exactCoordinatorActor(value: unknown, input: {
  readonly deploymentId: string
  readonly coordinatorRef: string
}): Readonly<{ readonly actorRef: string; readonly registrationReceipt: ActorRegistrationReceipt }> {
  const output = exactObject(value, ["actorRef", "registrationReceipt"], "actorOwner.output")
  const actorRef = text(output.actorRef, "actorOwner.output.actorRef")
  let registrationReceipt: ActorRegistrationReceipt
  try {
    registrationReceipt = parseActorRegistrationReceipt(output.registrationReceipt)
  } catch (error) {
    return invalid("EIDOLON_HOLON_COORDINATOR_RECEIPT_INVALID", error instanceof Error ? error.message : "Invalid receipt.")
  }
  if (registrationReceipt.address.deploymentId !== input.deploymentId
    || registrationReceipt.address.actorKind !== "coordinator"
    || registrationReceipt.address.logicalKey !== input.coordinatorRef) {
    return invalid("EIDOLON_HOLON_COORDINATOR_RECEIPT_MISMATCH", "Coordinator registration receipt has the wrong logical address.")
  }
  return Object.freeze({ actorRef, registrationReceipt })
}

async function retainCoordinatorObservation(
  runtime: HolonCoordinatorProcessorRuntime,
  input: CoordinateHolonTaskInput,
  bindingReceipt: EidolonHolonExecutionBindingFreezeReceipt,
  taskRevision: number,
): Promise<Readonly<{ readonly coordinatorRef: string; readonly actorRef: string }>> {
  const ref = coordinatorRef(input.deploymentId, input.holonRef)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await runtime.store.load(input.deploymentId)
    const existing = current.coordinators.find((value) => value.holonRef === input.holonRef)
    const actor = existing ?? exactCoordinatorActor(await runtime.actorOwner.ensureCoordinatorActor({
      deploymentId: input.deploymentId,
      holonRef: input.holonRef,
      coordinatorRef: ref,
      bindingReceipt,
    }), { deploymentId: input.deploymentId, coordinatorRef: ref })
    const subscription = Object.freeze({
      taskSpaceId: input.taskSpaceId,
      holonRef: input.holonRef,
      cursor: `task-space-revision-${taskRevision}`,
      status: "observing" as const,
    })
    const priorSubscription = current.subscriptions.find((value) => value.taskSpaceId === input.taskSpaceId)
    if (priorSubscription && (priorSubscription.holonRef !== subscription.holonRef
      || priorSubscription.status !== subscription.status)) {
      return invalid("EIDOLON_HOLON_SUBSCRIPTION_CONFLICT", "TaskSpace subscription already has different coordination facts.")
    }
    if (existing && priorSubscription?.cursor === subscription.cursor) {
      return Object.freeze({ coordinatorRef: ref, actorRef: existing.actorRef })
    }
    const next = normalizeHolonDeploymentRuntimeSnapshot({
      ...current,
      revision: current.revision + 1,
      coordinators: existing ? current.coordinators : [...current.coordinators, {
        holonRef: input.holonRef,
        status: "ready",
        actorRef: actor.actorRef,
        registrationReceipt: actor.registrationReceipt,
      }],
      subscriptions: priorSubscription
        ? current.subscriptions.map((value) => value.taskSpaceId === input.taskSpaceId ? subscription : value)
        : [...current.subscriptions, subscription],
    })
    try {
      await runtime.store.commit({
        deploymentId: input.deploymentId,
        expectedRevision: current.revision,
        next,
      })
      return Object.freeze({ coordinatorRef: ref, actorRef: actor.actorRef })
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("CAS_CONFLICT")) throw error
    }
  }
  return invalid("EIDOLON_HOLON_COORDINATOR_CAS_EXHAUSTED", "Coordinator observation did not converge.")
}

function requireTask(snapshot: TaskSpaceSnapshot, taskId: string): TaskRecord {
  const task = snapshot.tasks.find((value) => value.taskId === taskId)
  if (!task || task.definition.kind !== "task") {
    return invalid("EIDOLON_HOLON_TASK_NOT_FOUND", `Task ${taskId} is not an executable task.`)
  }
  return task
}

export async function coordinateHolonTaskAssignment(
  runtime: HolonCoordinatorProcessorRuntime,
  inputValue: CoordinateHolonTaskInput,
  config: TaskProcessorConfig,
): Promise<HolonTaskAssignmentResult> {
  const input = normalizeInput(inputValue)
  if (!runtime || typeof runtime !== "object" || !(runtime.store instanceof FileHolonDeploymentRuntimeStore)
    || typeof runtime.taskManager?.owner?.readSnapshot !== "function"
    || typeof runtime.actorOwner?.ensureCoordinatorActor !== "function") {
    return invalid("EIDOLON_HOLON_COORDINATOR_RUNTIME_INVALID", "Coordinator runtime ports are incomplete.")
  }
  const deployment = await runtime.store.loadDefinition(input.deploymentId)
  if (deployment.definition.bindingRef !== input.bindingRef
    || deployment.definition.rootHolonRef !== input.holonRef) {
    return invalid("EIDOLON_HOLON_COORDINATOR_DEPLOYMENT_MISMATCH", "Input does not match the frozen deployment definition.")
  }
  const bindingReceipt = assertHolonExecutionBindingFreezeReceipt(deployment.bindingFreezeReceipt)
  const bindingResourceId = input.bindingRef.slice("resource://".length)
  const bindingContentDigest = bindingReceipt.closure.find(
    (entry) => entry.resourceId === bindingResourceId,
  )?.contentDigest
  if (!bindingContentDigest) {
    return invalid("EIDOLON_HOLON_BINDING_CONTENT_IDENTITY_MISSING", "Frozen binding closure has no effective content identity.")
  }
  const snapshot = await runtime.taskManager.owner.readSnapshot(input.taskSpaceId)
  if (!snapshot) return invalid("EIDOLON_HOLON_TASK_SPACE_NOT_FOUND", "TaskSpace does not exist.")
  const task = requireTask(snapshot, input.taskId)
  const profile = exactProfile(task)
  const taskReceipt = profile.facts.snapshotReceipt
  if (taskReceipt.taskSpaceId !== input.taskSpaceId || taskReceipt.holonRef !== input.holonRef
    || taskReceipt.holonSnapshotDigest !== deployment.bindingProjection.snapshot.treeDigest
    || taskReceipt.issuerReceiptId !== deployment.definition.snapshotReceiptDigest
    || taskReceipt.executionBindingRef !== input.bindingRef
    || taskReceipt.executionBindingDigest !== bindingContentDigest) {
    return invalid("EIDOLON_HOLON_TASK_SNAPSHOT_MISMATCH", "TaskSpace is not bound to the deployment's frozen organization and binding.")
  }
  const requiredRoles = new Set(profile.facts.target.taskSpace.requiredRoleRefs)
  const bindingTarget = deployment.bindingProjection.binding.target
  if (bindingTarget.kind === "role") requiredRoles.add(bindingTarget.roleRef)
  let members = eligibleMembers(
    deployment.bindingProjection.snapshot.records,
    input.holonRef,
    taskReceipt.eligibleMemberRefs,
    [...requiredRoles],
  )
  if (bindingTarget.kind === "member") {
    members = Object.freeze(members.filter((memberRef) => memberRef === bindingTarget.memberRef))
  }
  if (members.length === 0) {
    return invalid("EIDOLON_HOLON_NO_ELIGIBLE_MEMBER", "Frozen Role/Policy facts produce no eligible Member.")
  }
  const memberRef = members[0]!
  const isolation: HolonMemberRuntimeIsolation = deployment.bindingProjection.binding.policy.runtime.mode === "isolated-task-runtime"
    ? Object.freeze({ mode: "isolated", scope: "task-space", isolationKey: input.taskSpaceId })
    : Object.freeze({ mode: "shared" })
  const memberRuntimeRef = holonMemberRuntimeRef({ deploymentId: input.deploymentId, memberRef, runtime: isolation })
  const existingReceipt = await runtime.taskManager.owner.readReceiptByCommand(
    input.taskSpaceId,
    input.commandId,
  )
  const assignmentRevision = existingReceipt?.fromRevision ?? snapshot.revision
  const coordinator = await retainCoordinatorObservation(runtime, input, bindingReceipt, assignmentRevision)
  const assigned = await claimTask(runtime.taskManager, {
    kind: "task.claim",
    commandId: input.commandId,
    taskSpaceId: input.taskSpaceId,
    expectedRevision: assignmentRevision,
    taskId: input.taskId,
    assigneeRef: memberRuntimeRef,
    claimedAt: input.claimedAt,
    leaseDurationMs: input.leaseDurationMs,
  }, config)
  return Object.freeze({
    coordinatorRef: coordinator.coordinatorRef,
    coordinatorActorRef: coordinator.actorRef,
    memberRef,
    memberRuntimeRef,
    memberRuntimeIsolation: isolation,
    claimReceipt: assigned.receipt,
  })
}
