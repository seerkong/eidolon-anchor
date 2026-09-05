import { createHash } from "node:crypto"
import path from "node:path"
import { mkdir, open, readFile } from "node:fs/promises"

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
import type { TaskProfileEnvelope, TaskRecord, TaskSettlementReceipt } from "task-manager-contract"
import { createTaskSpace, TaskManagerError } from "task-manager-logic"
import { FileTaskSpaceOwner } from "task-manager-file-support"

import type { HolonTaskRuntimeCapabilityRoute } from "@cell/ai-organ-logic/organization/HolonTaskRuntimeCapability"
import {
  FileHolonTaskPumpJournal,
  type HolonTaskPumpJournalFaultObserver,
  type HolonTaskPumpRecoveryScope,
  type HolonTaskPumpSubscription,
} from "@cell/ai-organ-logic/organization/HolonTaskPumpJournal"
import { createHolonTaskExecutionProfile, normalizeHolonTaskExecutionProfile } from "@cell/ai-organ-logic/organization/HolonTaskExecutionProfile"
import { HolonTaskSpaceCoordinatorActor } from "@cell/ai-organ-logic/organization/HolonTaskSpaceCoordinatorActor"
import type { HolonTaskProcessorRuntime } from "@cell/ai-organ-logic/organization/HolonTaskRuntimeProcessor"

const SUPPORT_FACET = "eidolon.local-holon-task-runtime-support/v1"
const COORDINATOR_FACET = "eidolon.holon-task-runtime-coordinators/v1"

type Vm = Readonly<{
  readonly actorRuntime: Readonly<{
    ensureFacet<T>(key: string, factory: () => T): T
  }>
}>

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

export interface LocalHolonTaskRuntimeSupportOptions {
  readonly journalFaults?: HolonTaskPumpJournalFaultObserver
  readonly waitingProbeMs?: number
}

type TaskContext = Readonly<{
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
  owner: FileTaskSpaceOwner,
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

async function taskResult(owner: FileTaskSpaceOwner, task: TaskRecord): Promise<ClosedValue> {
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

export class LocalHolonTaskRuntimeSupport {
  readonly taskManager: Readonly<{ owner: FileTaskSpaceOwner }>
  readonly journal: FileHolonTaskPumpJournal
  private readonly contexts = new Map<string, Map<string, LocalHolonTaskRuntimeBinding>>()
  private readonly routes = new Map<string, HolonTaskRuntimeCapabilityRoute>()
  private readonly tasks = new Map<string, TaskContext>()
  private readonly wakeReceipts = new Map<string, string>()

  constructor(
    private readonly vm: Vm,
    readonly supportRoot: string,
    private readonly options: LocalHolonTaskRuntimeSupportOptions,
  ) {
    this.taskManager = Object.freeze({
      owner: new FileTaskSpaceOwner({ root: path.join(supportRoot, "task-spaces") }),
    })
    this.journal = new FileHolonTaskPumpJournal({
      supportRoot,
      faults: options.journalFaults,
    })
  }

  bind(binding: LocalHolonTaskRuntimeBinding): HolonTaskRuntimeCapabilityRoute {
    const byContext = this.contexts.get(binding.admission.admissionId)
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
    this.contexts.set(binding.admission.admissionId, byContext)
    const prior = this.routes.get(binding.admission.admissionId)
    if (prior) return prior
    const route = this.createRoute(binding.admission)
    this.routes.set(binding.admission.admissionId, route)
    return route
  }

  listSubscriptions(runId?: string): Promise<readonly HolonTaskPumpSubscription[]> {
    return this.journal.listSubscriptions(runId)
  }

  async recoverPending(): Promise<Readonly<{
    readonly recovered: number
    readonly scheduled: number
    readonly terminal: number
  }>> {
    let recovered = 0
    let scheduled = 0
    let terminal = 0
    for (const subscription of await this.journal.listSubscriptions()) {
      const settled = await terminalTaskSettlement(
        this.taskManager.owner,
        subscription.taskSpaceId,
        subscription.taskId,
      )
      if (settled) {
        terminal += 1
        continue
      }
      this.contextForSubscription(subscription)
      recovered += 1
      this.scheduleSubscription(subscription)
      scheduled += 1
    }
    return Object.freeze({ recovered, scheduled, terminal })
  }

  async wakeSubscription(subscription: HolonTaskPumpSubscription) {
    const context = this.contextForSubscription(subscription)
    const coordinator = this.coordinator(subscription.deploymentId, subscription.holonRef)
    const config = subscription.admissionId.startsWith("legacy-workflow:")
      ? context.processorConfig
      : subscription.processorConfig
    return coordinator.wake(await context.prepareProcessorRuntime(subscription), {
      subscription,
      leaseDurationMs: config.leaseDurationMs,
      maxSteps: config.maxSteps,
      observedAt: new Date().toISOString(),
    })
  }

  scheduleSubscription(
    subscription: HolonTaskPumpSubscription,
    afterWake?: () => void | Promise<void>,
  ): void {
    const coordinator = this.coordinator(subscription.deploymentId, subscription.holonRef)
    coordinator.scheduleWake({ subscription }, async () => {
      const terminal = await terminalTaskSettlement(
        this.taskManager.owner,
        subscription.taskSpaceId,
        subscription.taskId,
      )
      if (terminal) return
      const pumped = await this.wakeSubscription(subscription)
      await afterWake?.()
      if (pumped.status === "waiting" || pumped.status === "yielded") {
        this.scheduleSubscription(subscription, afterWake)
      }
    }, this.options.waitingProbeMs ?? 100)
  }

  terminalSettlement(requestedTaskSpaceId: string, requestedTaskId: string) {
    return terminalTaskSettlement(this.taskManager.owner, requestedTaskSpaceId, requestedTaskId)
  }

  close(): void {
    const coordinators = this.vm.actorRuntime.ensureFacet(
      COORDINATOR_FACET,
      () => new Map<string, HolonTaskSpaceCoordinatorActor>(),
    )
    for (const coordinator of coordinators.values()) coordinator.close()
    coordinators.clear()
    this.tasks.clear()
    this.wakeReceipts.clear()
  }

  private createRoute(admission: FrozenHolonTaskRuntimeAdmission): HolonTaskRuntimeCapabilityRoute {
    const routeRef = `resource://eidolon.local-holon-task-route/${admission.definitionDigest.slice("sha256:".length)}` as const
    return Object.freeze({
      routeRef,
      deployment: {
        ensure: async ({ admission: actual }: Parameters<HolonTaskRuntimeDeploymentPort["ensure"]>[0]) => {
          exactAdmission(admission, actual)
          const deploymentIds = new Set(
            [...this.requiredContexts(admission.admissionId).values()].map(({ deploymentId }) => deploymentId),
          )
          if (deploymentIds.size !== 1) throw new Error("EIDOLON_HOLON_TASK_SUPPORT_DEPLOYMENT_AMBIGUOUS")
          return Object.freeze({ deploymentId: [...deploymentIds][0]! })
        },
      },
      taskSpace: {
        submit: async (input: Parameters<HolonTaskRuntimeTaskSpacePort["submit"]>[0]) => {
          exactAdmission(admission, input.admission)
          const context = this.contextForInvocation(admission.admissionId, input.invocation)
          if (JSON.stringify(input.config) !== JSON.stringify(context.processorConfig)) {
            throw new Error("EIDOLON_HOLON_TASK_SUPPORT_PROCESSOR_CONFIG_CONFLICT")
          }
          const requestedTaskSpaceId = taskSpaceId(admission, input.invocation)
          await this.retainSubmission({
            taskSpaceId: requestedTaskSpaceId,
            taskId: input.taskId,
            commandId: input.commandId,
            submissionFingerprint: input.submissionFingerprint,
          })
          const opened = await (context.openTask ?? ((value) => this.openCanonicalTask(value)))({
            admission,
            invocation: input.invocation,
            taskSpaceId: requestedTaskSpaceId,
            taskId: input.taskId,
            commandId: input.commandId,
            taskName: input.invocation.taskRequest.name,
            snapshotReceiptId: context.snapshotReceiptId,
            config: input.config,
          })
          const subscription = await this.journal.subscribe({
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
          this.tasks.set(taskKey(requestedTaskSpaceId, input.taskId), Object.freeze({
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
          const task = await this.taskContext(admission.admissionId, message.taskSpaceId, message.taskId)
          const coordinator = this.coordinator(message.deploymentId, message.holonRef)
          const settledBefore = await terminalTaskSettlement(
            this.taskManager.owner,
            message.taskSpaceId,
            message.taskId,
          )
          const replayed = this.wakeReceipts.has(message.messageId) || settledBefore !== undefined
          if (!replayed) {
            this.wakeReceipts.set(message.messageId, coordinator.actorId)
            const automaticPump = task.binding.automaticPump?.() ?? true
            if (!automaticPump) {
              return Object.freeze({
                coordinatorActorRef: coordinator.actorId,
                messageId: message.messageId,
                replayed,
              })
            }
            if (task.invocation.replyMode === "final") {
              const pumped = await this.wakeSubscription(task.subscription)
              if (pumped.status === "waiting" || pumped.status === "yielded") {
                this.scheduleSubscription(task.subscription)
              }
            } else {
              this.scheduleSubscription(task.subscription)
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
            this.taskManager.owner,
            requestedTaskSpaceId,
            requestedTaskId,
          )
          if (!terminal) throw new Error("EIDOLON_HOLON_TASK_SETTLEMENT_PENDING")
          return Object.freeze({
            status: terminal.receipt.status === "Succeeded" ? "succeeded" : "failed",
            settlementCommandId: terminal.receipt.commandId,
            result: await taskResult(this.taskManager.owner, terminal.task),
            outputArtifactRefs: Object.freeze(terminal.task.outputArtifacts.map(({ digest: value }) => value)),
            replayed: true,
          })
        },
      },
    })
  }

  private async openCanonicalTask(
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
    const existing = await this.taskManager.owner.readSnapshot(input.taskSpaceId)
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
      const receipt = await this.taskManager.owner.readReceiptByCommand(
        input.taskSpaceId,
        input.commandId,
      )
      if (!receipt || receipt.kind !== "task-transition-receipt") {
        throw new Error("EIDOLON_HOLON_TASK_SUPPORT_CREATE_RECEIPT_MISSING")
      }
      return Object.freeze({ replayed: true, snapshotReceipt })
    }
    try {
      const created = await createTaskSpace(this.taskManager, {
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
      return this.openCanonicalTask(input)
    }
  }

  private requiredContexts(admissionId: string): Map<string, LocalHolonTaskRuntimeBinding> {
    const contexts = this.contexts.get(admissionId)
    if (!contexts || contexts.size === 0) throw new Error("EIDOLON_HOLON_TASK_SUPPORT_CONTEXT_MISSING")
    return contexts
  }

  private contextForInvocation(
    admissionId: string,
    invocation: HolonTaskRuntimeInvocation,
  ): LocalHolonTaskRuntimeBinding {
    const contexts = this.requiredContexts(admissionId)
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

  private contextForSubscription(subscription: HolonTaskPumpSubscription): LocalHolonTaskRuntimeBinding {
    const exact = this.contexts.get(subscription.admissionId)
    const candidates = exact
      ? [...exact.values()]
      : [...this.contexts.values()].flatMap((contexts) => [...contexts.values()])
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

  private async taskContext(
    admissionId: string,
    requestedTaskSpaceId: string,
    requestedTaskId: string,
  ): Promise<TaskContext> {
    const key = taskKey(requestedTaskSpaceId, requestedTaskId)
    const live = this.tasks.get(key)
    if (live) return live
    const subscription = (await this.journal.listSubscriptions()).find((candidate) => (
      candidate.taskSpaceId === requestedTaskSpaceId && candidate.taskId === requestedTaskId
    ))
    if (!subscription) throw new Error("EIDOLON_HOLON_TASK_SUPPORT_TASK_CORRELATION_MISSING")
    const binding = this.contextForSubscription(subscription)
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
    this.tasks.set(key, recovered)
    return recovered
  }

  private coordinator(deploymentId: string, holonRef: string): HolonTaskSpaceCoordinatorActor {
    const coordinators = this.vm.actorRuntime.ensureFacet(
      COORDINATOR_FACET,
      () => new Map<string, HolonTaskSpaceCoordinatorActor>(),
    )
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

  private async retainSubmission(value: Readonly<{
    taskSpaceId: string
    taskId: string
    commandId: string
    submissionFingerprint: `sha256:${string}`
  }>): Promise<void> {
    const directory = path.join(this.supportRoot, "holon-task-submissions")
    await mkdir(directory, { recursive: true })
    const target = path.join(directory, `${digest([value.taskSpaceId, value.taskId, value.commandId]).slice(7)}.json`)
    const bytes = Buffer.from(JSON.stringify(value))
    try {
      const handle = await open(target, "wx", 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (!Buffer.from(await readFile(target)).equals(bytes)) {
        throw new Error("EIDOLON_HOLON_TASK_SUBMISSION_FINGERPRINT_CONFLICT")
      }
    }
  }
}

export function mountLocalHolonTaskRuntimeSupport(input: Readonly<{
  readonly vm: Vm
  readonly supportRoot: string
  readonly options?: LocalHolonTaskRuntimeSupportOptions
}>): LocalHolonTaskRuntimeSupport {
  const supportRoot = path.resolve(input.supportRoot)
  const support = input.vm.actorRuntime.ensureFacet(
    SUPPORT_FACET,
    () => new LocalHolonTaskRuntimeSupport(input.vm, supportRoot, input.options ?? {}),
  )
  if (support.supportRoot !== supportRoot) {
    throw new Error("EIDOLON_HOLON_TASK_SUPPORT_SCOPE_CONFLICT")
  }
  return support
}
