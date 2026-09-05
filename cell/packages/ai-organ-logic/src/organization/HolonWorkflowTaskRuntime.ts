import type { ClosedValue } from "holarchy-eidolon-adapter"
import type { TaskProcessorConfig } from "task-manager-logic"
import type { HolonTaskRuntimeOrigin } from "@cell/ai-organ-contract"

import {
  coordinateHolonTaskAssignment,
  type HolonCoordinatorProcessorRuntime,
} from "./HolonCoordinator"
import type { FileHolonDeploymentRuntimeStore } from "./HolonDeploymentRuntimeStore"
import type { EidolonHolonLocalActorRuntime } from "./HolonLocalActorRuntime"
import { ensureHolonMemberRuntime } from "./HolonMemberRuntime"
import type { HolonTaskPumpJournalPort } from "./HolonTaskPumpJournal"
import {
  executeHolonTask,
  type HolonTaskExecutionResult,
  type HolonTaskProcessorRuntime,
} from "./HolonTaskRuntimeProcessor"
import {
  adaptLegacyWorkflowHolonTaskProfile,
  projectLegacyWorkflowHolonTaskOrigin,
} from "./LegacyWorkflowHolonTaskProfileAdapter"
import { normalizeHolonTaskExecutionProfile } from "./HolonTaskExecutionProfile"

export interface HolonTaskProcessorInfrastructureRuntime {
  readonly store: FileHolonDeploymentRuntimeStore
  readonly taskManager: HolonTaskProcessorRuntime["taskManager"]
  readonly actorRuntime: EidolonHolonLocalActorRuntime
  readonly journal: HolonTaskPumpJournalPort
}

/** Compatibility alias for existing Workflow callers. */
export type HolonWorkflowTaskProcessorRuntime = HolonTaskProcessorInfrastructureRuntime

export interface HolonTaskProcessorRuntimeContext {
  readonly deploymentId: string
  readonly workflowSessionLineage?: Readonly<{
    readonly workflowInstanceId: string
    readonly runId: string
  }>
}

export interface ExecuteHolonWorkflowTaskInput {
  readonly deploymentId: string
  readonly bindingRef: `resource://${string}`
  readonly holonRef: string
  readonly taskSpaceId: string
  readonly taskId: string
  readonly workflowInstanceId: string
  readonly runId: string
  readonly origin?: HolonTaskRuntimeOrigin
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

export type HolonWorkflowTaskExecutionResult = HolonTaskExecutionResult
export { HolonTaskRuntimeProcessorError as HolonWorkflowTaskRuntimeError } from "./HolonTaskRuntimeProcessor"

/**
 * Shared Processor assembly for product, service, and Workflow origins. The
 * infrastructure contains only explicit TaskSpace/deployment/actor/journal
 * effect ports; Workflow lineage is an optional session projection.
 */
export async function createHolonTaskProcessorRuntime(
  runtime: HolonTaskProcessorInfrastructureRuntime,
  context: HolonTaskProcessorRuntimeContext,
): Promise<HolonTaskProcessorRuntime> {
  const definition = await runtime.store.loadDefinition(context.deploymentId)
  const executionTarget = definition.bindingProjection.binding.target
  const processorRuntime: HolonTaskProcessorRuntime = {
    taskManager: runtime.taskManager,
    assignment: {
      assign: (assignmentInput, processorConfig) => coordinateHolonTaskAssignment({
        store: runtime.store,
        taskManager: runtime.taskManager,
        actorOwner: runtime.actorRuntime,
      } satisfies HolonCoordinatorProcessorRuntime, assignmentInput, processorConfig),
    },
    memberRuntime: {
      async ensure(memberInput) {
        const lineage = context.workflowSessionLineage
        const member = await ensureHolonMemberRuntime({
          store: runtime.store,
          actorOwner: runtime.actorRuntime,
          sessions: runtime.actorRuntime,
        }, {
          deploymentId: memberInput.deploymentId,
          bindingRef: memberInput.bindingRef,
          holonRef: memberInput.holonRef,
          memberRef: memberInput.memberRef,
          runtime: memberInput.runtime,
          taskAttempt: {
            taskSpaceId: memberInput.taskAttempt.taskSpaceId,
            taskId: memberInput.taskAttempt.taskId,
            claimId: memberInput.taskAttempt.claimId,
            attempt: memberInput.taskAttempt.attempt,
            ...(lineage === undefined ? {} : lineage),
          },
          session: { mode: "task-attempt" },
        }, {})
        return Object.freeze({
          runtimeRef: member.runtimeRef,
          memberRef: memberInput.memberRef,
          sessionRef: member.sessionRef,
        })
      },
      async resolve(memberInput) {
        const snapshot = await runtime.store.load(memberInput.deploymentId)
        const member = snapshot.members.find((candidate) => candidate.runtimeRef === memberInput.runtimeRef)
        return member
          ? Object.freeze({ runtimeRef: member.runtimeRef, memberRef: member.memberRef })
          : undefined
      },
    },
    profile: {
      normalize: (value) => {
        const profileKind = value && typeof value === "object" && "profileKind" in value
          ? (value as { readonly profileKind?: unknown }).profileKind
          : undefined
        return profileKind === "eidolon.ai.holon-task"
          ? normalizeHolonTaskExecutionProfile(value)
          : adaptLegacyWorkflowHolonTaskProfile(value, {
              executionTarget,
              registryRevision: definition.definition.registryRevision,
              definitionDigest: definition.definition.bindingSemanticFingerprint,
            })
      },
    },
    actorDispatch: {
      async dispatch(dispatchInput) {
        const result = await runtime.actorRuntime.dispatchMember(
          dispatchInput.memberRuntimeRef,
          dispatchInput.invocation,
          dispatchInput.idempotencyKey,
        )
        return Object.freeze({ output: result.output, replayed: false })
      },
    },
    journal: runtime.journal,
    clock: { nowEpochMs: () => Date.now() },
    timer: { wait: waitForHeartbeat },
  }
  return Object.freeze(processorRuntime)
}

/**
 * Legacy adapter only. Workflow identity is converted to neutral origin data;
 * the canonical execution loop lives in executeHolonTask.
 */
export async function executeHolonWorkflowTask(
  runtime: HolonWorkflowTaskProcessorRuntime,
  inputValue: ExecuteHolonWorkflowTaskInput,
  config: TaskProcessorConfig,
): Promise<HolonWorkflowTaskExecutionResult> {
  const input = normalizeInput(inputValue)
  const definition = await runtime.store.loadDefinition(input.deploymentId)
  const taskSnapshot = await runtime.taskManager.owner.readSnapshot(input.taskSpaceId)
  const task = taskSnapshot?.tasks.find((candidate) => candidate.taskId === input.taskId)
  if (!task) throw new Error("EIDOLON_HOLON_TASK_NOT_FOUND: Workflow task is missing.")
  const origin = input.origin ?? projectLegacyWorkflowHolonTaskOrigin(task.profile, input.runId)
  const processorRuntime = await createHolonTaskProcessorRuntime(runtime, {
    deploymentId: definition.definition.deploymentId,
    workflowSessionLineage: {
      workflowInstanceId: input.workflowInstanceId,
      runId: input.runId,
    },
  })
  return executeHolonTask(processorRuntime, {
    deploymentId: input.deploymentId,
    bindingRef: input.bindingRef,
    holonRef: input.holonRef,
    taskSpaceId: input.taskSpaceId,
    taskId: input.taskId,
    origin,
    assignmentCommandId: input.assignmentCommandId,
    startCommandId: input.startCommandId,
    settlementCommandId: input.settlementCommandId,
    invocationRef: input.invocationRef,
    claimedAt: input.claimedAt,
    startedAt: input.startedAt,
    settledAt: input.settledAt,
    leaseDurationMs: input.leaseDurationMs,
    input: input.input,
  }, config)
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

function normalizeInput(value: unknown): ExecuteHolonWorkflowTaskInput {
  const required = [
    "deploymentId", "bindingRef", "holonRef", "taskSpaceId", "taskId", "workflowInstanceId",
    "runId", "assignmentCommandId", "startCommandId", "settlementCommandId", "invocationRef",
    "claimedAt", "startedAt", "settledAt", "leaseDurationMs", "input",
  ] as const
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error("EIDOLON_HOLON_TASK_INPUT_INVALID: Input must be one plain object.")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if ((keys.length !== required.length && keys.length !== required.length + 1)
    || keys.some((key) => typeof key !== "string" || (key !== "origin" && !required.includes(key as any)))
    || required.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key))) {
    throw new Error("EIDOLON_HOLON_TASK_INPUT_INVALID: Input has missing or unsupported fields.")
  }
  const fields: Record<string, unknown> = Object.create(null)
  for (const key of required) {
    const descriptor = descriptors[key]
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new Error(`EIDOLON_HOLON_TASK_INPUT_INVALID: input.${key} must be enumerable own data.`)
    }
    fields[key] = descriptor.value
  }
  const text = (key: string): string => {
    const field = fields[key]
    if (typeof field !== "string" || !field || field !== field.trim()
      || field !== field.normalize("NFC") || /[\u0000-\u001f\u007f]/.test(field)) {
      throw new Error(`EIDOLON_HOLON_TASK_INPUT_INVALID: input.${key} must be one exact string.`)
    }
    return field
  }
  const bindingRef = text("bindingRef")
  if (!bindingRef.startsWith("resource://") || !bindingRef.slice("resource://".length)) {
    throw new Error("EIDOLON_HOLON_TASK_INPUT_INVALID: bindingRef must be one resource:// identity.")
  }
  if (!Number.isSafeInteger(fields.leaseDurationMs) || (fields.leaseDurationMs as number) <= 0) {
    throw new Error("EIDOLON_HOLON_TASK_INPUT_INVALID: leaseDurationMs must be positive.")
  }
  return Object.freeze({
    deploymentId: text("deploymentId"),
    bindingRef: bindingRef as `resource://${string}`,
    holonRef: text("holonRef"),
    taskSpaceId: text("taskSpaceId"),
    taskId: text("taskId"),
    workflowInstanceId: text("workflowInstanceId"),
    runId: text("runId"),
    ...(descriptors.origin === undefined
      ? {}
      : { origin: descriptors.origin.value as HolonTaskRuntimeOrigin }),
    assignmentCommandId: text("assignmentCommandId"),
    startCommandId: text("startCommandId"),
    settlementCommandId: text("settlementCommandId"),
    invocationRef: text("invocationRef"),
    claimedAt: text("claimedAt"),
    startedAt: text("startedAt"),
    settledAt: text("settledAt"),
    leaseDurationMs: fields.leaseDurationMs as number,
    input: fields.input as ClosedValue,
  })
}
