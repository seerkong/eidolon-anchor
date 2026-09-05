import { createHash } from "node:crypto"

import {
  HOLON_TASK_SNAPSHOT_RECEIPT_SCHEMA_VERSION,
  type FrozenHolonTaskRuntimeAdmission,
  type HolonTaskCoordinatorWakeMessage,
  type HolonTaskRuntimeDeploymentPort,
  type HolonTaskRuntimeInvocation,
  type HolonTaskRuntimeProcessorConfig,
  type HolonTaskRuntimeSettlementObservation,
  type HolonTaskRuntimeSettlementPort,
  type HolonTaskRuntimeTaskReceipt,
  type HolonTaskRuntimeTaskSpacePort,
} from "@cell/ai-organ-contract"
import type { ClosedValue } from "holarchy-eidolon-adapter"
import type { TaskProfileEnvelope, TaskRecord, TaskSettlementReceipt, TaskSpaceOwnerPort } from "task-manager-contract"
import type { HolonTaskSubmissionWriter } from "@cell/ai-organ-contract/organization/HolonTaskRuntimeStorage"
import { createTaskSpace, TaskManagerError } from "task-manager-logic"

import type { HolonTaskRuntimeCapabilityRoute } from "./HolonTaskRuntimeCapability"
import type {
  HolonTaskPumpJournalPort,
  HolonTaskPumpRecoveryScope,
  HolonTaskPumpSubscription,
} from "@cell/ai-organ-contract/organization/HolonTaskPumpJournal"
import { createHolonTaskExecutionProfile, normalizeHolonTaskExecutionProfile } from "./HolonTaskExecutionProfile"
import { HolonTaskSpaceCoordinatorActor } from "./HolonTaskSpaceCoordinatorActor"
import type { HolonTaskProcessorRuntime } from "./HolonTaskRuntimeProcessor"

export interface LocalHolonTaskRuntimeOpenInput {
  readonly admission: FrozenHolonTaskRuntimeAdmission
  readonly invocation: HolonTaskRuntimeInvocation
  readonly taskSpaceId: string
  readonly taskId: string
  readonly commandId: string
  readonly taskName: string
  readonly snapshotReceiptId: `sha256:${string}`
  readonly config: HolonTaskRuntimeProcessorConfig
}

export interface LocalHolonTaskRuntimeOpenResult {
  readonly replayed: boolean
  readonly snapshotReceipt: HolonTaskRuntimeTaskReceipt["snapshotReceipt"]
}

export interface LocalHolonTaskRuntimeBinding {
  readonly admission: FrozenHolonTaskRuntimeAdmission
  readonly processorConfig: HolonTaskRuntimeProcessorConfig
  readonly deploymentId: string
  readonly contextRef: string
  readonly recoveryScope: HolonTaskPumpRecoveryScope
  readonly snapshotReceiptId: `sha256:${string}`
  /** Defaults to true for standalone hosts; Workflow may retain manual pump control. */
  readonly automaticPump?: () => boolean
  readonly openTask?: (
    input: LocalHolonTaskRuntimeOpenInput,
  ) => Promise<LocalHolonTaskRuntimeOpenResult>
  prepareProcessorRuntime(
    subscription: HolonTaskPumpSubscription,
  ): Promise<HolonTaskProcessorRuntime>
}

export interface HolonTaskRuntimeRoutesConfig {
  readonly waitingProbeMs?: number
}

export type HolonTaskRuntimeRouteTaskContext = Readonly<{
  readonly binding: LocalHolonTaskRuntimeBinding
  readonly invocation: HolonTaskRuntimeInvocation
  readonly subscription: HolonTaskPumpSubscription
}>

const taskKey = (taskSpaceId: string, taskId: string): string => `${taskSpaceId}\u0000${taskId}`

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
}

function taskSpaceId(
  admission: FrozenHolonTaskRuntimeAdmission,
  invocation: HolonTaskRuntimeInvocation,
): string {
  if (invocation.taskRequest.kind === "exact") return invocation.taskRequest.identity.taskSpaceId
  return `holon-task-space-${digest([
    admission.admissionId,
    invocation.requestId,
    invocation.idempotencyKey,
  ]).slice("sha256:".length, "sha256:".length + 40)}`
}

function exactAdmission(
  expected: FrozenHolonTaskRuntimeAdmission,
  actual: FrozenHolonTaskRuntimeAdmission,
): void {
  if (actual.admissionId !== expected.admissionId
    || actual.definitionDigest !== expected.definitionDigest
    || actual.registryRevision !== expected.registryRevision) {
    throw new Error("EIDOLON_HOLON_TASK_SUPPORT_ADMISSION_MISMATCH")
  }
}

function sameScope(left: HolonTaskPumpRecoveryScope, right: HolonTaskPumpRecoveryScope): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function terminalTaskSettlement(
  owner: TaskSpaceOwnerPort,
  requestedTaskSpaceId: string,
  requestedTaskId: string,
): Promise<Readonly<{ task: TaskRecord; receipt: TaskSettlementReceipt }> | undefined> {
  const snapshot = await owner.readSnapshot(requestedTaskSpaceId)
  const task = snapshot?.tasks.find((candidate) => candidate.taskId === requestedTaskId)
  if (!task || !["Succeeded", "Failed", "Cancelled"].includes(task.status)) return undefined
  const history = await owner.readHistory(requestedTaskSpaceId)
  const event = [...history].reverse().find((candidate) => (
    "taskId" in candidate && candidate.taskId === requestedTaskId
      && ["task.settled", "task.failed", "task.cancelled"].includes(candidate.kind)
  ))
  if (!event) return undefined
  const receipt = await owner.readReceiptByCommand(requestedTaskSpaceId, event.commandId)
  return receipt?.kind === "task-settlement-receipt"
    && receipt.taskId === requestedTaskId
    && receipt.status === task.status
    ? Object.freeze({ task, receipt })
    : undefined
}

async function taskResult(owner: TaskSpaceOwnerPort, task: TaskRecord): Promise<ClosedValue> {
  const values = await Promise.all(task.outputArtifacts.map(async ({ digest: artifactDigest }) => {
    const artifact = await owner.readArtifact(task.taskSpaceId, artifactDigest)
    if (!artifact) return Object.freeze({ artifactDigest, missing: true })
    try {
      return JSON.parse(Buffer.from(artifact.data, "base64").toString("utf8")) as ClosedValue
    } catch {
      return Object.freeze({ artifactDigest, mediaType: artifact.mediaType })
    }
  }))
  if (values.length === 1) return values[0]!
  if (values.length > 1) return Object.freeze(values)
  return Object.freeze({ status: task.status, taskId: task.taskId })
}

export type HolonTaskRuntimeCoordinatorPort = Pick<
  HolonTaskSpaceCoordinatorActor,
  "actorId" | "wake" | "scheduleWake" | "close"
>

/** Live correlations are reconstructible; TaskSpace remains the task authority. */
export interface HolonTaskRuntimeRouteState {
  readonly contexts: Map<string, Map<string, LocalHolonTaskRuntimeBinding>>
  readonly routes: Map<string, HolonTaskRuntimeCapabilityRoute>
  readonly tasks: Map<string, HolonTaskRuntimeRouteTaskContext>
  readonly wakeReceipts: Map<string, string>
  readonly coordinators: Map<string, HolonTaskRuntimeCoordinatorPort>
}

export interface HolonTaskRuntimeRoutesRuntime extends HolonTaskRuntimeRouteState {
  readonly taskManager: Readonly<{ owner: TaskSpaceOwnerPort }>
  readonly journal: HolonTaskPumpJournalPort
  readonly retainSubmission: HolonTaskSubmissionWriter
  readonly now: () => number
  readonly waitingProbeMs?: number
}

/** Allocate instance state at the composition boundary, never inside a route. */
export function createHolonTaskRuntimeRouteState(
  coordinators: Map<string, HolonTaskRuntimeCoordinatorPort> = new Map(),
): HolonTaskRuntimeRouteState {
  return Object.freeze({
    contexts: new Map(),
    routes: new Map(),
    tasks: new Map(),
    wakeReceipts: new Map(),
    coordinators,
  })
}

export function bindHolonTaskRuntimeRoute(runtime: HolonTaskRuntimeRoutesRuntime, binding: LocalHolonTaskRuntimeBinding): HolonTaskRuntimeCapabilityRoute {
  const byContext = runtime.contexts.get(binding.admission.admissionId)
    ?? new Map<string, LocalHolonTaskRuntimeBinding>()
  const existing = byContext.get(binding.contextRef)
  if (existing && (existing.deploymentId !== binding.deploymentId
    || existing.snapshotReceiptId !== binding.snapshotReceiptId
    || !sameScope(existing.recoveryScope, binding.recoveryScope)
    || JSON.stringify(existing.processorConfig) !== JSON.stringify(binding.processorConfig))) {
    throw new Error("EIDOLON_HOLON_TASK_SUPPORT_CONTEXT_CONFLICT")
  }
  const deploymentIds = new Set([...byContext.values()].map((candidate) => candidate.deploymentId))
  if (deploymentIds.size > 0 && !deploymentIds.has(binding.deploymentId)) {
    throw new Error("EIDOLON_HOLON_TASK_SUPPORT_DEPLOYMENT_CONFLICT")
  }
  byContext.set(binding.contextRef, binding)
  runtime.contexts.set(binding.admission.admissionId, byContext)
  const prior = runtime.routes.get(binding.admission.admissionId)
  if (prior) return prior
  const route = createRoute(runtime, binding.admission)
  runtime.routes.set(binding.admission.admissionId, route)
  return route
}

export function listHolonTaskRuntimeSubscriptions(runtime: HolonTaskRuntimeRoutesRuntime, runId?: string): Promise<readonly HolonTaskPumpSubscription[]> {
  return runtime.journal.listSubscriptions(runId)
}

export async function recoverHolonTaskRuntimePending(runtime: HolonTaskRuntimeRoutesRuntime): Promise<Readonly<{
  readonly recovered: number
  readonly scheduled: number
  readonly terminal: number
}>> {
  let recovered = 0
  let scheduled = 0
  let terminal = 0
  for (const subscription of await runtime.journal.listSubscriptions()) {
    const settled = await terminalTaskSettlement(
      runtime.taskManager.owner,
      subscription.taskSpaceId,
      subscription.taskId,
    )
    if (settled) {
      terminal += 1
      continue
    }
    contextForSubscription(runtime, subscription)
    recovered += 1
    scheduleHolonTaskRuntimeSubscription(runtime, subscription)
    scheduled += 1
  }
  return Object.freeze({ recovered, scheduled, terminal })
}

export async function wakeHolonTaskRuntimeSubscription(runtime: HolonTaskRuntimeRoutesRuntime, subscription: HolonTaskPumpSubscription) {
  const context = contextForSubscription(runtime, subscription)
  const coordinator = ensureCoordinator(runtime, subscription.deploymentId, subscription.holonRef)
  const config = subscription.admissionId.startsWith("legacy-workflow:")
    ? context.processorConfig
    : subscription.processorConfig
  return coordinator.wake(await context.prepareProcessorRuntime(subscription), {
    subscription,
    leaseDurationMs: config.leaseDurationMs,
    maxSteps: config.maxSteps,
    observedAt: new Date(runtime.now()).toISOString(),
  })
}

export function scheduleHolonTaskRuntimeSubscription(
  runtime: HolonTaskRuntimeRoutesRuntime,
  subscription: HolonTaskPumpSubscription,
  afterWake?: () => void | Promise<void>,
): void {
  const coordinator = ensureCoordinator(runtime, subscription.deploymentId, subscription.holonRef)
  coordinator.scheduleWake({ subscription }, async () => {
    const terminal = await terminalTaskSettlement(
      runtime.taskManager.owner,
      subscription.taskSpaceId,
      subscription.taskId,
    )
    if (terminal) return
    const pumped = await wakeHolonTaskRuntimeSubscription(runtime, subscription)
    await afterWake?.()
    if (pumped.status === "waiting" || pumped.status === "yielded") {
      scheduleHolonTaskRuntimeSubscription(runtime, subscription, afterWake)
    }
  }, runtime.waitingProbeMs ?? 100)
}

export function readHolonTaskRuntimeTerminalSettlement(runtime: HolonTaskRuntimeRoutesRuntime, requestedTaskSpaceId: string, requestedTaskId: string) {
  return terminalTaskSettlement(runtime.taskManager.owner, requestedTaskSpaceId, requestedTaskId)
}

export function closeHolonTaskRuntimeRoutes(runtime: HolonTaskRuntimeRoutesRuntime): void {
  const coordinators = runtime.coordinators
  for (const coordinator of coordinators.values()) coordinator.close()
  coordinators.clear()
  runtime.tasks.clear()
  runtime.wakeReceipts.clear()
}

function createRoute(runtime: HolonTaskRuntimeRoutesRuntime, admission: FrozenHolonTaskRuntimeAdmission): HolonTaskRuntimeCapabilityRoute {
  const routeRef = `resource://eidolon.local-holon-task-route/${admission.definitionDigest.slice("sha256:".length)}` as const
  return Object.freeze({
    routeRef,
    deployment: {
      ensure: async ({ admission: actual }: Parameters<HolonTaskRuntimeDeploymentPort["ensure"]>[0]) => {
        exactAdmission(admission, actual)
        const deploymentIds = new Set(
          [...requiredContexts(runtime, admission.admissionId).values()].map(({ deploymentId }) => deploymentId),
        )
        if (deploymentIds.size !== 1) throw new Error("EIDOLON_HOLON_TASK_SUPPORT_DEPLOYMENT_AMBIGUOUS")
        return Object.freeze({ deploymentId: [...deploymentIds][0]! })
      },
    },
    taskSpace: {
      submit: async (input: Parameters<HolonTaskRuntimeTaskSpacePort["submit"]>[0]) => {
        exactAdmission(admission, input.admission)
        const context = contextForInvocation(runtime, admission.admissionId, input.invocation)
        if (JSON.stringify(input.config) !== JSON.stringify(context.processorConfig)) {
          throw new Error("EIDOLON_HOLON_TASK_SUPPORT_PROCESSOR_CONFIG_CONFLICT")
        }
        const requestedTaskSpaceId = taskSpaceId(admission, input.invocation)
        await runtime.retainSubmission({
          taskSpaceId: requestedTaskSpaceId,
          taskId: input.taskId,
          commandId: input.commandId,
          submissionFingerprint: input.submissionFingerprint,
        })
        const opened = await (context.openTask ?? ((value) => openCanonicalTask(runtime, value)))({
          admission,
          invocation: input.invocation,
          taskSpaceId: requestedTaskSpaceId,
          taskId: input.taskId,
          commandId: input.commandId,
          taskName: input.invocation.taskRequest.name,
          snapshotReceiptId: context.snapshotReceiptId,
          config: input.config,
        })
        const subscription = await runtime.journal.subscribe({
          admissionId: admission.admissionId,
          deploymentId: context.deploymentId,
          bindingRef: admission.definition.executionBinding.ref,
          holonRef: admission.definition.rootHolonRef,
          snapshotReceiptId: opened.snapshotReceipt.issuerReceiptId,
          taskSpaceId: requestedTaskSpaceId,
          taskId: input.taskId,
          origin: input.invocation.origin,
          recoveryScope: context.recoveryScope,
          processorConfig: context.processorConfig,
          input: input.invocation.input,
          createdAt: input.invocation.occurredAt,
        })
        runtime.tasks.set(taskKey(requestedTaskSpaceId, input.taskId), Object.freeze({
          binding: context,
          invocation: input.invocation,
          subscription,
        }))
        return Object.freeze({
          taskSpaceId: requestedTaskSpaceId,
          taskId: input.taskId,
          commandId: input.commandId,
          submissionFingerprint: input.submissionFingerprint,
          replayed: opened.replayed,
          snapshotReceipt: opened.snapshotReceipt,
        })
      },
    },
    coordinatorMailbox: {
      sendWake: async (message: HolonTaskCoordinatorWakeMessage) => {
        const task = await taskContext(runtime, admission.admissionId, message.taskSpaceId, message.taskId)
        const coordinator = ensureCoordinator(runtime, message.deploymentId, message.holonRef)
        const settledBefore = await terminalTaskSettlement(
          runtime.taskManager.owner,
          message.taskSpaceId,
          message.taskId,
        )
        const replayed = runtime.wakeReceipts.has(message.messageId) || settledBefore !== undefined
        if (!replayed) {
          runtime.wakeReceipts.set(message.messageId, coordinator.actorId)
          const automaticPump = task.binding.automaticPump?.() ?? true
          if (!automaticPump) {
            return Object.freeze({
              coordinatorActorRef: coordinator.actorId,
              messageId: message.messageId,
              replayed,
            })
          }
          if (task.invocation.replyMode === "final") {
            const pumped = await wakeHolonTaskRuntimeSubscription(runtime, task.subscription)
            if (pumped.status === "waiting" || pumped.status === "yielded") {
              scheduleHolonTaskRuntimeSubscription(runtime, task.subscription)
            }
          } else {
            scheduleHolonTaskRuntimeSubscription(runtime, task.subscription)
          }
        }
        return Object.freeze({
          coordinatorActorRef: coordinator.actorId,
          messageId: message.messageId,
          replayed,
        })
      },
    },
    settlement: {
      observe: async ({ taskSpaceId: requestedTaskSpaceId, taskId: requestedTaskId }:
        Parameters<HolonTaskRuntimeSettlementPort["observe"]>[0]): Promise<HolonTaskRuntimeSettlementObservation> => {
        const terminal = await terminalTaskSettlement(
          runtime.taskManager.owner,
          requestedTaskSpaceId,
          requestedTaskId,
        )
        if (!terminal) throw new Error("EIDOLON_HOLON_TASK_SETTLEMENT_PENDING")
        return Object.freeze({
          status: terminal.receipt.status === "Succeeded" ? "succeeded" : "failed",
          settlementCommandId: terminal.receipt.commandId,
          result: await taskResult(runtime.taskManager.owner, terminal.task),
          outputArtifactRefs: Object.freeze(terminal.task.outputArtifacts.map(({ digest: value }) => value)),
          replayed: true,
        })
      },
    },
  })
}

async function openCanonicalTask(
  runtime: HolonTaskRuntimeRoutesRuntime,
  input: LocalHolonTaskRuntimeOpenInput,
): Promise<LocalHolonTaskRuntimeOpenResult> {
  const snapshotReceipt = Object.freeze({
    kind: "holon-task-snapshot-receipt" as const,
    schemaVersion: HOLON_TASK_SNAPSHOT_RECEIPT_SCHEMA_VERSION,
    taskSpaceId: input.taskSpaceId,
    holonRef: input.admission.snapshotAuthority.holonRef,
    effectiveAt: input.admission.snapshotAuthority.effectiveAt,
    holonSnapshotRef: input.admission.snapshotAuthority.holonSnapshotRef,
    holonSnapshotDigest: input.admission.snapshotAuthority.holonSnapshotDigest,
    snapshotArtifactDigest: input.admission.snapshotAuthority.snapshotArtifactDigest,
    issuerReceiptId: input.snapshotReceiptId,
    issuerReceiptArtifactDigest: input.snapshotReceiptId,
    executionBindingRef: input.admission.snapshotAuthority.executionBindingRef,
    executionBindingDigest: input.admission.snapshotAuthority.executionBindingDigest,
    eligibleMemberRefs: input.admission.snapshotAuthority.eligibleMemberRefs,
    eligibleRoleRefs: input.admission.snapshotAuthority.eligibleRoleRefs,
  })
  const existing = await runtime.taskManager.owner.readSnapshot(input.taskSpaceId)
  if (existing) {
    const task = existing.tasks.find((candidate) => candidate.taskId === input.taskId)
    if (!task || task.definition.kind !== "task") {
      throw new Error("EIDOLON_HOLON_TASK_SUPPORT_EXISTING_TASK_MISSING")
    }
    const profile = normalizeHolonTaskExecutionProfile(task.profile)
    if (profile.facts.admission.admissionId !== input.admission.admissionId
      || JSON.stringify(profile.facts.snapshotReceipt) !== JSON.stringify(snapshotReceipt)) {
      throw new Error("EIDOLON_HOLON_TASK_SUPPORT_EXISTING_TASK_CONFLICT")
    }
    const receipt = await runtime.taskManager.owner.readReceiptByCommand(
      input.taskSpaceId,
      input.commandId,
    )
    if (!receipt || receipt.kind !== "task-transition-receipt") {
      throw new Error("EIDOLON_HOLON_TASK_SUPPORT_CREATE_RECEIPT_MISSING")
    }
    return Object.freeze({ replayed: true, snapshotReceipt })
  }
  try {
    const created = await createTaskSpace(runtime.taskManager, {
      kind: "task-space.create",
      commandId: input.commandId,
      taskSpaceId: input.taskSpaceId,
      createdAt: input.invocation.occurredAt,
      definition: {
        kind: "task-space-definition",
        taskSpaceId: input.taskSpaceId,
        name: input.taskName,
        schemaVersion: 1,
        tasks: [{
          kind: "task",
          taskId: input.taskId,
          name: input.taskName,
          order: 0,
          // TaskSpace intentionally treats domain profiles as a closed generic
          // envelope. HolonTaskExecutionProfile is canonical immutable JSON, but
          // its concrete facts interface does not expose a string index signature.
          profile: createHolonTaskExecutionProfile(
            input.admission,
            snapshotReceipt,
          ) as unknown as TaskProfileEnvelope,
          inputArtifacts: [],
        }],
        relations: [{
          kind: "parent-child",
          relationId: `root:${input.taskId}`,
          parentTaskId: null,
          childTaskId: input.taskId,
          order: 0,
        }],
      },
    }, {
      maxTasks: 1_024,
      maxRelations: 4_096,
      maxLeaseDurationMs: Math.max(24 * 60 * 60 * 1_000, input.config.leaseDurationMs),
    })
    return Object.freeze({ replayed: created.replayed, snapshotReceipt })
  } catch (error) {
    if (!(error instanceof TaskManagerError) || error.code !== "task-space-already-exists") throw error
    return openCanonicalTask(runtime, input)
  }
}

function requiredContexts(runtime: HolonTaskRuntimeRoutesRuntime, admissionId: string): Map<string, LocalHolonTaskRuntimeBinding> {
  const contexts = runtime.contexts.get(admissionId)
  if (!contexts || contexts.size === 0) throw new Error("EIDOLON_HOLON_TASK_SUPPORT_CONTEXT_MISSING")
  return contexts
}

function contextForInvocation(
  runtime: HolonTaskRuntimeRoutesRuntime,
  admissionId: string,
  invocation: HolonTaskRuntimeInvocation,
): LocalHolonTaskRuntimeBinding {
  const contexts = requiredContexts(runtime, admissionId)
  const origin = invocation.origin
  if (origin.kind === "workflow") {
    const matches = [...contexts.values()].filter((context) => (
      context.recoveryScope.kind === "workflow"
      && context.recoveryScope.runId === origin.runId
      && context.recoveryScope.nodeId === origin.nodeId
    ))
    if (matches.length !== 1) throw new Error("EIDOLON_HOLON_TASK_SUPPORT_WORKFLOW_CONTEXT_MISSING")
    return matches[0]!
  }
  const matches = [...contexts.values()].filter(
    (context) => context.recoveryScope.kind === "standalone",
  )
  if (matches.length !== 1) throw new Error("EIDOLON_HOLON_TASK_SUPPORT_STANDALONE_CONTEXT_AMBIGUOUS")
  return matches[0]!
}

function contextForSubscription(runtime: HolonTaskRuntimeRoutesRuntime, subscription: HolonTaskPumpSubscription): LocalHolonTaskRuntimeBinding {
  const exact = runtime.contexts.get(subscription.admissionId)
  const candidates = exact
    ? [...exact.values()]
    : [...runtime.contexts.values()].flatMap((contexts) => [...contexts.values()])
  const matches = candidates.filter((context) => (
    context.deploymentId === subscription.deploymentId
    && context.admission.definition.executionBinding.ref === subscription.bindingRef
    && context.admission.definition.rootHolonRef === subscription.holonRef
    && context.snapshotReceiptId === subscription.snapshotReceiptId
    && sameScope(context.recoveryScope, subscription.recoveryScope)
    && (subscription.admissionId.startsWith("legacy-workflow:")
      || JSON.stringify(context.processorConfig) === JSON.stringify(subscription.processorConfig))
  ))
  if (matches.length !== 1) {
    throw new Error("EIDOLON_HOLON_TASK_SUPPORT_SUBSCRIPTION_CONTEXT_MISSING")
  }
  return matches[0]!
}

async function taskContext(
  runtime: HolonTaskRuntimeRoutesRuntime,
  admissionId: string,
  requestedTaskSpaceId: string,
  requestedTaskId: string,
): Promise<HolonTaskRuntimeRouteTaskContext> {
  const key = taskKey(requestedTaskSpaceId, requestedTaskId)
  const live = runtime.tasks.get(key)
  if (live) return live
  const subscription = (await runtime.journal.listSubscriptions()).find((candidate) => (
    candidate.taskSpaceId === requestedTaskSpaceId && candidate.taskId === requestedTaskId
  ))
  if (!subscription) throw new Error("EIDOLON_HOLON_TASK_SUPPORT_TASK_CORRELATION_MISSING")
  const binding = contextForSubscription(runtime, subscription)
  if (binding.admission.admissionId !== admissionId
    && !subscription.admissionId.startsWith("legacy-workflow:")) {
    throw new Error("EIDOLON_HOLON_TASK_SUPPORT_TASK_ADMISSION_MISMATCH")
  }
  const invocation = Object.freeze({
    kind: "holon-task-runtime-invocation" as const,
    schemaVersion: "eidolon.holon-task-runtime-invocation/v1" as const,
    requestId: `recovered:${subscription.subscriptionId}`,
    idempotencyKey: `recovered:${subscription.subscriptionId}`,
    replyMode: "none" as const,
    occurredAt: subscription.createdAt,
    origin: subscription.origin,
    taskRequest: Object.freeze({
      kind: "exact" as const,
      identity: Object.freeze({
        taskSpaceId: requestedTaskSpaceId,
        taskId: requestedTaskId,
        commandId: `recovered:${subscription.subscriptionId}`,
      }),
      name: requestedTaskId,
    }),
    input: subscription.input,
  })
  const recovered = Object.freeze({ binding, invocation, subscription })
  runtime.tasks.set(key, recovered)
  return recovered
}

function ensureCoordinator(runtime: HolonTaskRuntimeRoutesRuntime, deploymentId: string, holonRef: string): HolonTaskRuntimeCoordinatorPort {
  const coordinators = runtime.coordinators
  const key = `${deploymentId}\u0000${holonRef}`
  let coordinator = coordinators.get(key)
  if (!coordinator) {
    coordinator = new HolonTaskSpaceCoordinatorActor({ deploymentId, holonRef }, {
      maxTasks: 1_024,
      maxRelations: 4_096,
      maxLeaseDurationMs: 24 * 60 * 60 * 1_000,
    })
    coordinators.set(key, coordinator)
  }
  return coordinator
}


/** Public method-shaped adapter; all decisions execute in runtime-first functions. */
export function createHolonTaskRuntimeRoutes(
  runtime: HolonTaskRuntimeRoutesRuntime,
  config: HolonTaskRuntimeRoutesConfig = {},
) {
  const configured = Object.freeze({ ...runtime, waitingProbeMs: config.waitingProbeMs ?? runtime.waitingProbeMs })
  return Object.freeze({
    taskManager: runtime.taskManager,
    journal: runtime.journal,
    bind: (binding: LocalHolonTaskRuntimeBinding) => bindHolonTaskRuntimeRoute(configured, binding),
    listSubscriptions: (runId?: string) => listHolonTaskRuntimeSubscriptions(configured, runId),
    recoverPending: () => recoverHolonTaskRuntimePending(configured),
    wakeSubscription: (subscription: HolonTaskPumpSubscription) => wakeHolonTaskRuntimeSubscription(configured, subscription),
    scheduleSubscription: (subscription: HolonTaskPumpSubscription, afterWake?: () => void | Promise<void>) =>
      scheduleHolonTaskRuntimeSubscription(configured, subscription, afterWake),
    terminalSettlement: (taskSpaceId: string, taskId: string) => readHolonTaskRuntimeTerminalSettlement(configured, taskSpaceId, taskId),
    close: () => closeHolonTaskRuntimeRoutes(configured),
  })
}

export type HolonTaskRuntimeRoutes = ReturnType<typeof createHolonTaskRuntimeRoutes>
