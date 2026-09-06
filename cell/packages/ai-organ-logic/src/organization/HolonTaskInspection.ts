import { createHash } from "node:crypto"
import {
  canonicalOwnDataDigest,
  deepFrozenCanonicalOwnDataClone,
  type TaskArtifactBody,
  type TaskArtifactRef,
  type TaskClaimToken,
  type TaskProfileEnvelope,
  type TaskSpaceOwnerPort,
  type TaskSpaceSnapshot,
} from "task-manager-contract"
import { replanTask } from "task-manager-logic"
import type {
  FrozenHolonTaskRuntimeAdmission,
  HolonTaskIdentitySelector,
  HolonTaskInspectionPort,
  HolonTaskObservation,
  HolonTaskRepairInvocation,
  HolonTaskRepairReceipt,
  HolonTaskSnapshotReceipt,
  HolonTaskSelector,
} from "@cell/ai-organ-contract"
import type { HolonTaskPumpJournalPort, HolonTaskPumpSubscription } from "@cell/ai-organ-contract/organization/HolonTaskPumpJournal"
import { createHolonTaskExecutionProfile, normalizeHolonTaskExecutionProfile } from "./HolonTaskExecutionProfile"
import { normalizeHolonTaskSelector } from "./HolonTaskRuntimeContract"

type SubscriptionInput = Parameters<HolonTaskPumpJournalPort["subscribe"]>[0]
const MEDIA_TYPE = "application/vnd.eidolon.holon-task-repair+json;version=1"
const terminal = (status: string) => ["Succeeded", "Failed", "Cancelled"].includes(status)

/** Only owner/journal/mailbox effects; neither filesystem nor a second task store. */
export interface HolonTaskInspectionRuntime {
  readonly owner: TaskSpaceOwnerPort
  readonly journal: HolonTaskPumpJournalPort
  readonly now: () => number
  readonly wakeErrors: ReadonlyMap<string, Readonly<{ message: string; observedAt: string }>>
  resolveTarget(selector: HolonTaskSelector): FrozenHolonTaskRuntimeAdmission
  resolveMemberIdentity?(subscription: HolonTaskPumpSubscription, claim: TaskClaimToken): Promise<Readonly<{ memberRef: string; sessionRef?: string }> | undefined>
  prepareSuccessor(admission: FrozenHolonTaskRuntimeAdmission, source: HolonTaskPumpSubscription): Readonly<{
    subscription: SubscriptionInput
    snapshotReceipt: HolonTaskSnapshotReceipt
  }>
  wake(subscription: HolonTaskPumpSubscription): Promise<void>
}

interface RepairEvidence {
  readonly kind: "holon-task-repair-evidence"
  readonly schemaVersion: 1
  readonly commandId: string
  readonly fingerprint: `sha256:${string}`
  readonly selector: HolonTaskIdentitySelector
  readonly invocation: HolonTaskRepairInvocation
  readonly targetAdmission: FrozenHolonTaskRuntimeAdmission | null
  readonly subscription: SubscriptionInput
}

function fail(code: string): never {
  throw new Error(`EIDOLON_HOLON_TASK_${code}`)
}
function exactString(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.normalize("NFC") !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail("REPAIR_INPUT_INVALID")
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = deepFrozenCanonicalOwnDataClone(value) as Record<string, unknown>
  if (!result || typeof result !== "object" || Array.isArray(result)
    || Object.keys(result).length !== keys.length || keys.some((key) => !(key in result))) fail("REPAIR_INPUT_INVALID")
  return result
}
function normalizeSelector(value: HolonTaskIdentitySelector): HolonTaskIdentitySelector {
  const result = closed(value, ["admissionId", "taskSpaceId", "taskId"])
  for (const value of Object.values(result)) exactString(value)
  return result as unknown as HolonTaskIdentitySelector
}
function normalizeInvocation(value: HolonTaskRepairInvocation): HolonTaskRepairInvocation {
  const common = ["kind", "requestId", "expectedRevision", "reason", "occurredAt"]
  const result = closed(value, value?.kind === "successor" ? [...common, "target", "name", "input"] : common)
  if (result.kind !== "resume" && result.kind !== "successor") fail("REPAIR_INPUT_INVALID")
  for (const key of ["requestId", "reason", "occurredAt"]) exactString(result[key])
  if (!Number.isSafeInteger(result.expectedRevision) || (result.expectedRevision as number) < 0) fail("REPAIR_INPUT_INVALID")
  if (!Number.isFinite(Date.parse(result.occurredAt as string))
    || new Date(result.occurredAt as string).toISOString() !== result.occurredAt) fail("REPAIR_INPUT_INVALID")
  if (result.kind === "successor") {
    exactString(result.name)
    normalizeHolonTaskSelector(result.target)
  }
  return result as unknown as HolonTaskRepairInvocation
}
function repairCommand(selector: HolonTaskIdentitySelector, requestId: string): string {
  return `holon-task-repair-${canonicalOwnDataDigest({ selector, requestId }).slice(7)}`
}
function toArtifact(evidence: RepairEvidence): Readonly<{ body: TaskArtifactBody; ref: TaskArtifactRef }> {
  const bytes = Buffer.from(JSON.stringify(deepFrozenCanonicalOwnDataClone(evidence)))
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const
  const common = { digest, mediaType: MEDIA_TYPE, sizeBytes: bytes.byteLength }
  return {
    body: { kind: "task-artifact-body", ...common, encoding: "base64", data: bytes.toString("base64") },
    ref: { kind: "task-artifact-ref", ...common },
  }
}
function evidenceReceipt(evidence: RepairEvidence, artifactDigest: `sha256:${string}`, replayed: boolean): HolonTaskRepairReceipt {
  return Object.freeze({
    kind: "holon-task-repair-receipt", action: evidence.invocation.kind,
    requestId: evidence.invocation.requestId, source: evidence.selector,
    task: { admissionId: evidence.subscription.admissionId, taskSpaceId: evidence.subscription.taskSpaceId, taskId: evidence.subscription.taskId },
    commandId: evidence.commandId, artifactDigest, replayed,
  })
}

/** Publication requires both owner snapshot linkage AND the matching admitted receipt. */
async function readEvidence(runtime: HolonTaskInspectionRuntime, snapshot: TaskSpaceSnapshot) {
  const result: { evidence: RepairEvidence; digest: `sha256:${string}` }[] = []
  for (const task of snapshot.tasks) {
    for (const ref of task.definition.inputArtifacts.filter((ref) => ref.mediaType === MEDIA_TYPE)) {
      const body = await runtime.owner.readArtifact(snapshot.taskSpaceId, ref.digest)
      if (!body) fail("REPAIR_EVIDENCE_MISSING")
      const bytes = Buffer.from(body.data, "base64")
      if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== ref.digest) fail("REPAIR_EVIDENCE_INVALID")
      const evidence = JSON.parse(bytes.toString("utf8")) as RepairEvidence
      const receipt = await runtime.owner.readReceiptByCommand(snapshot.taskSpaceId, evidence.commandId)
      const profile = normalizeHolonTaskExecutionProfile(task.profile)
      if (evidence.kind !== "holon-task-repair-evidence" || evidence.schemaVersion !== 1
        || repairCommand(normalizeSelector(evidence.selector), evidence.invocation.requestId) !== evidence.commandId
        || canonicalOwnDataDigest({ selector: evidence.selector, invocation: normalizeInvocation(evidence.invocation) }) !== evidence.fingerprint
        || evidence.selector.taskSpaceId !== snapshot.taskSpaceId
        || evidence.subscription.admissionId !== profile.facts.admission.admissionId
        || evidence.subscription.snapshotReceiptId !== profile.facts.snapshotReceipt.issuerReceiptId
        || evidence.subscription.bindingRef !== profile.facts.admission.definition.executionBinding.ref
        || (evidence.invocation.kind === "successor"
          ? canonicalOwnDataDigest(evidence.targetAdmission) !== canonicalOwnDataDigest(profile.facts.admission)
          : evidence.targetAdmission !== null || evidence.selector.taskId !== task.taskId)
        || evidence.subscription.taskId !== task.taskId || evidence.subscription.taskSpaceId !== snapshot.taskSpaceId
        || receipt?.kind !== "task-replan-receipt" || receipt.fromRevision !== evidence.invocation.expectedRevision
        || receipt.planId !== evidence.commandId || receipt.toRevision > snapshot.revision
        || !receipt.affectedTaskIds.includes(task.taskId) || !snapshot.issuedReceiptIds.includes(receipt.receiptId)) {
        fail("REPAIR_EVIDENCE_INVALID")
      }
      result.push({ evidence, digest: ref.digest })
    }
  }
  return result
}

async function requireTask(runtime: HolonTaskInspectionRuntime, selector: HolonTaskIdentitySelector) {
  const snapshot = await runtime.owner.readSnapshot(selector.taskSpaceId)
  const task = snapshot?.tasks.find((task) => task.taskId === selector.taskId)
  if (!snapshot || !task) return fail("NOT_FOUND")
  const profile = normalizeHolonTaskExecutionProfile(task.profile)
  if (profile.facts.admission.admissionId !== selector.admissionId) fail("ADMISSION_MISMATCH")
  return { snapshot, task, profile }
}

function recommendedActions(status: string, claimed: boolean): HolonTaskObservation["recommendedActions"] {
  if (status === "Succeeded") return Object.freeze(["none"])
  if (terminal(status)) return Object.freeze(["successor"])
  if (claimed) return Object.freeze(["observe", "resume"])
  return Object.freeze(["resume"])
}

export async function observeHolonTask(runtime: HolonTaskInspectionRuntime, selectorValue: HolonTaskIdentitySelector): Promise<HolonTaskObservation> {
  const selector = normalizeSelector(selectorValue)
  const { snapshot, task, profile } = await requireTask(runtime, selector)
  const history = (await runtime.owner.readHistory(selector.taskSpaceId)).filter((event) => (
    "taskId" in event && event.taskId === selector.taskId && event.toRevision <= snapshot.revision
  ))
  const lastClaim = [...history].reverse().find((event) => event.kind === "task.claimed")
  const failure = [...history].reverse().find((event) => event.kind === "task.failed")
  const subscription = (await runtime.journal.listSubscriptions()).find((sub) => (
    sub.taskSpaceId === selector.taskSpaceId && sub.taskId === selector.taskId && sub.admissionId === selector.admissionId
  ))
  const evidence = await readEvidence(runtime, snapshot)
  const lineage = evidence.find(({ evidence }) => evidence.invocation.kind === "successor" && evidence.subscription.taskId === selector.taskId)
  const memberRef = profile.facts.admission.executionTarget.kind === "member" ? profile.facts.admission.executionTarget.memberRef : null
  const claim = task.activeClaim ?? lastClaim?.claim
  const memberRuntimeRef = claim?.assigneeRef ?? null
  const member = subscription && claim ? await runtime.resolveMemberIdentity?.(subscription, claim) : undefined
  return Object.freeze({
    selector, revision: snapshot.revision, status: task.status, attempt: task.attempt,
    claim: task.activeClaim, memberRef: member?.memberRef ?? memberRef, memberRuntimeRef,
    sessionRef: member?.sessionRef ?? null,
    sessionUnavailableReason: member?.sessionRef ? null : "TaskSpace does not persist an authoritative member-session mapping; observation never creates a member runtime.",
    lastProgress: history.at(-1) ?? null, lastFailure: failure?.failure ?? null,
    subscriptionId: subscription?.subscriptionId ?? null,
    lastWakeError: runtime.wakeErrors.get(`${selector.taskSpaceId}\u0000${selector.taskId}`) ?? null,
    recommendedActions: recommendedActions(task.status, task.activeClaim !== null),
    successors: evidence.filter(({ evidence }) => evidence.invocation.kind === "successor" && evidence.selector.taskId === selector.taskId)
      .map(({ evidence }) => ({ admissionId: evidence.subscription.admissionId, taskSpaceId: selector.taskSpaceId, taskId: evidence.subscription.taskId })),
    lineage: lineage ? evidenceReceipt(lineage.evidence, lineage.digest, true) : null,
  })
}

export async function repairHolonTask(runtime: HolonTaskInspectionRuntime, input: Parameters<HolonTaskInspectionPort["repair"]>[0]): Promise<HolonTaskRepairReceipt> {
  const selector = normalizeSelector(input.selector)
  const invocation = normalizeInvocation(input.invocation)
  const { snapshot, task, profile } = await requireTask(runtime, selector)
  const commandId = repairCommand(selector, invocation.requestId)
  const fingerprint = canonicalOwnDataDigest({ selector, invocation })
  const prior = (await readEvidence(runtime, snapshot)).find(({ evidence }) => evidence.commandId === commandId)
  if (prior) {
    if (prior.evidence.fingerprint !== fingerprint) fail("REPAIR_CONFLICT")
    const subscription = await runtime.journal.subscribe(prior.evidence.subscription)
    if (!terminal(snapshot.tasks.find((task) => task.taskId === subscription.taskId)!.status)) await runtime.wake(subscription)
    return evidenceReceipt(prior.evidence, prior.digest, true)
  }
  if (snapshot.revision !== invocation.expectedRevision) fail("REPAIR_REVISION_CONFLICT")
  if (invocation.kind === "resume" ? terminal(task.status) : !["Failed", "Cancelled"].includes(task.status)) {
    fail("REPAIR_ACTION_NOT_ALLOWED")
  }
  const source = (await runtime.journal.listSubscriptions()).find((subscription) => (
    subscription.taskSpaceId === selector.taskSpaceId && subscription.taskId === selector.taskId && subscription.admissionId === selector.admissionId
  ))
  if (!source) fail("REPAIR_SUBSCRIPTION_MISSING")
  const { schemaVersion: _schema, subscriptionId: _id, inputDigest: _digest, ...sourceInput } = source
  let subscriptionInput: SubscriptionInput = sourceInput
  let snapshotReceipt = profile.facts.snapshotReceipt
  let targetAdmission: FrozenHolonTaskRuntimeAdmission | null = null
  const successorId = `holon-task-successor-${canonicalOwnDataDigest({ selector, requestId: invocation.requestId }).slice(7)}`
  if (invocation.kind === "successor") {
    targetAdmission = runtime.resolveTarget(invocation.target)
    const prepared = runtime.prepareSuccessor(targetAdmission, source)
    snapshotReceipt = prepared.snapshotReceipt
    subscriptionInput = { ...prepared.subscription, taskId: successorId, input: invocation.input, createdAt: invocation.occurredAt }
  }
  const evidence: RepairEvidence = { kind: "holon-task-repair-evidence", schemaVersion: 1, commandId, fingerprint,
    selector, invocation, targetAdmission, subscription: subscriptionInput }
  const artifact = toArtifact(evidence)
  const tasks = invocation.kind === "resume"
    ? snapshot.definition.tasks.map((definition) => definition.taskId === task.taskId
      ? { ...definition, inputArtifacts: [...definition.inputArtifacts, artifact.ref] } : definition)
    : [...snapshot.definition.tasks, {
      kind: "task" as const, taskId: successorId, name: invocation.name, order: snapshot.definition.tasks.length,
      profile: createHolonTaskExecutionProfile(targetAdmission!, snapshotReceipt) as unknown as TaskProfileEnvelope,
      inputArtifacts: [artifact.ref],
    }]
  const relations = invocation.kind === "resume" ? snapshot.definition.relations : [...snapshot.definition.relations, {
    kind: "parent-child" as const, relationId: `root:${successorId}`, parentTaskId: null, childTaskId: successorId, order: snapshot.definition.tasks.length,
  }]
  const replanned = await replanTask({ owner: runtime.owner }, {
    kind: "task.replan", commandId, taskSpaceId: selector.taskSpaceId, expectedRevision: invocation.expectedRevision,
    replannedAt: invocation.occurredAt, plan: { kind: "task-plan", planId: commandId, tasks, relations, reason: invocation.reason },
    artifactBodies: [artifact.body],
  }, { maxTasks: 1024, maxRelations: 4096, maxLeaseDurationMs: Math.max(86400000, subscriptionInput.processorConfig.leaseDurationMs) })
  const subscription = await runtime.journal.subscribe(subscriptionInput)
  await runtime.wake(subscription)
  return evidenceReceipt(evidence, artifact.ref.digest, replanned.replayed)
}

/** Recover only committed references from already-known task spaces, never orphan artifact files. */
export async function recoverHolonTaskRepairSubscriptions(runtime: HolonTaskInspectionRuntime): Promise<void> {
  const taskSpaces = new Set((await runtime.journal.listSubscriptions()).map((subscription) => subscription.taskSpaceId))
  for (const taskSpaceId of taskSpaces) {
    const snapshot = await runtime.owner.readSnapshot(taskSpaceId)
    if (!snapshot) continue
    for (const { evidence } of await readEvidence(runtime, snapshot)) await runtime.journal.subscribe(evidence.subscription)
  }
}
