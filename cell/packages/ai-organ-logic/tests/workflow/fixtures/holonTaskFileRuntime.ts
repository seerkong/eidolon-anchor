import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import {
  HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
  type FrozenHolonTaskRuntimeAdmission,
  type HolonTaskReplyMode,
} from "@cell/ai-organ-contract"
import {
  bootstrapLocalHolonTaskRuntime,
  mountLocalHolonTaskRuntimeSupport,
} from "../../../src/organization/HolonTaskRuntimeComposition"
import { createLocalHolonTaskRuntimeStorage } from "@cell/ai-support/organization/LocalHolonTaskRuntimeSupport"
import { claimTask } from "task-manager-logic"

import {
  registerHolonTaskRuntimeCapabilityBinding,
  type HolonTaskRuntimeCapabilityVm,
  type HolonTaskRuntimeCapabilityBinding,
} from "../../../src/organization/HolonTaskRuntimeCapability"
import { normalizeHolonTaskExecutionProfile } from "../../../src/organization/HolonTaskExecutionProfile"
import type { HolonTaskProcessorRuntime } from "../../../src/organization/HolonTaskRuntimeProcessor"

const digest = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}` as const
export const processorConfig = Object.freeze({ leaseDurationMs: 5_000, maxSteps: 16 })

function admission(): FrozenHolonTaskRuntimeAdmission {
  return Object.freeze({
    kind: "frozen-holon-task-runtime-admission",
    schemaVersion: HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
    admissionId: "admission:standalone-review",
    registryRevision: "registry:standalone-review",
    definitionDigest: digest("a"),
    definition: Object.freeze({
      kind: "holon-task-runtime-definition",
      schemaVersion: HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
      definitionRef: "resource://fixture.task-runtime.review",
      version: "1.0.0",
      rootHolonRef: "holon-review",
      executionBinding: Object.freeze({
        ref: "resource://fixture.binding.review",
        digest: digest("b"),
      }),
      taskSpace: Object.freeze({
        profileRef: "resource://fixture.profile.review",
        policyRef: "resource://fixture.policy.review",
        requiredRoleRefs: Object.freeze(["role-reviewer"]),
        requiredCapabilityRefs: Object.freeze(["resource://fixture.capability.review"]),
      }),
      input: Object.freeze({ schemaRef: "resource://fixture.schema.input" }),
      output: Object.freeze({
        schemaRef: "resource://fixture.schema.output",
        materialPortRefs: Object.freeze(["resource://fixture.port.output"]),
      }),
      defaultForHolon: true,
    }),
    executionTarget: Object.freeze({ kind: "member", memberRef: "member-reviewer" }),
    snapshotAuthority: Object.freeze({
      kind: "holon-task-runtime-snapshot-authority",
      schemaVersion: HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
      holonRef: "holon-review",
      effectiveAt: "2026-01-01T00:00:00.000Z",
      holonSnapshotRef: "snapshot-review",
      holonSnapshotDigest: digest("c"),
      snapshotArtifactDigest: digest("d"),
      executionBindingRef: "resource://fixture.binding.review",
      executionBindingDigest: digest("b"),
      eligibleMemberRefs: Object.freeze(["member-reviewer"]),
      eligibleRoleRefs: Object.freeze(["role-reviewer"]),
    }),
  })
}

function runtimeVm(): HolonTaskRuntimeCapabilityVm {
  const actor = createActor({ key: "main", id: "main" })
  return createVM({ controlActorKey: actor.key, actors: { [actor.key]: actor } }) as any
}

function abortableTimer(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
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

type AcceptedEffects = Readonly<{
  values: Map<string, Readonly<{ summary: string }>>
  onAccepted(): void
}>

function processorRuntime(
  taskManager: HolonTaskProcessorRuntime["taskManager"],
  journal: HolonTaskProcessorRuntime["journal"],
  accepted: AcceptedEffects | undefined,
  actorDispatch?: HolonTaskProcessorRuntime["actorDispatch"],
): HolonTaskProcessorRuntime {
  const members = new Map<string, Readonly<{ runtimeRef: string; memberRef: string }>>()
  return Object.freeze({
    taskManager,
    assignment: {
      async assign(input, config) {
        const memberRuntimeRef = "member-runtime:reviewer"
        const existing = await taskManager.owner.readReceiptByCommand(
          input.taskSpaceId,
          input.commandId,
        )
        const expectedRevision = existing?.kind === "task-claim-receipt"
          ? existing.fromRevision
          : (await taskManager.owner.readSnapshot(input.taskSpaceId))!.revision
        const claimed = await claimTask(taskManager, {
          kind: "task.claim",
          commandId: input.commandId,
          taskSpaceId: input.taskSpaceId,
          expectedRevision,
          taskId: input.taskId,
          assigneeRef: memberRuntimeRef,
          claimedAt: input.claimedAt,
          leaseDurationMs: input.leaseDurationMs,
        }, config)
        return Object.freeze({
          memberRef: "member-reviewer",
          memberRuntimeRef,
          memberRuntimeIsolation: Object.freeze({ mode: "shared" as const }),
          claimReceipt: claimed.receipt,
        })
      },
    },
    memberRuntime: {
      ensure(input) {
        const retained = Object.freeze({
          runtimeRef: "member-runtime:reviewer",
          memberRef: input.memberRef,
          sessionRef: `session:${input.taskAttempt.taskSpaceId}:${input.taskAttempt.taskId}`,
        })
        members.set(retained.runtimeRef, retained)
        return Promise.resolve(retained)
      },
      resolve({ runtimeRef }) {
        return Promise.resolve(members.get(runtimeRef))
      },
    },
    profile: { normalize: normalizeHolonTaskExecutionProfile },
    actorDispatch: actorDispatch ?? {
      async dispatch({ idempotencyKey, invocation }) {
        const prior = accepted!.values.get(idempotencyKey)
        if (prior) return Object.freeze({ output: prior, replayed: true })
        accepted!.onAccepted()
        const output = Object.freeze({ summary: `completed:${invocation.taskRef}` })
        accepted!.values.set(idempotencyKey, output)
        return Object.freeze({ output, replayed: false })
      },
    },
    journal,
    clock: { nowEpochMs: Date.now },
    timer: { wait: abortableTimer },
  })
}

export function invocation(requestId: string, replyMode: HolonTaskReplyMode) {
  return Object.freeze({
    kind: "holon-task-runtime-invocation" as const,
    schemaVersion: HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION,
    requestId,
    idempotencyKey: `idempotency:${requestId}`,
    replyMode,
    occurredAt: "2026-01-01T00:00:01.000Z",
    origin: Object.freeze({
      kind: "product" as const,
      surface: "HolonAssign",
      requestRef: `request:${requestId}`,
    }),
    taskRequest: Object.freeze({ kind: "derive" as const, name: `Review ${requestId}` }),
    input: Object.freeze({ requestId }),
  })
}

export async function openHost(input: Readonly<{
  root: string
  accepted?: AcceptedEffects
  actorDispatch?: HolonTaskProcessorRuntime["actorDispatch"]
  processorConfig?: HolonTaskRuntimeCapabilityBinding["processorConfig"]
  transformRoute?: (route: HolonTaskRuntimeCapabilityBinding["route"]) => HolonTaskRuntimeCapabilityBinding["route"]
  waitingProbeMs?: number
  crashAfterEffect?: boolean
}>) {
  const vm = runtimeVm()
  const frozenAdmission = admission()
  const config = input.processorConfig ?? processorConfig
  const capability = bootstrapLocalHolonTaskRuntime({
    vm,
    supportRoot: input.root,
    registryRef: "resource://fixture.registry.standalone",
  }, { storageFactory: createLocalHolonTaskRuntimeStorage, now: Date.now })
  const support = mountLocalHolonTaskRuntimeSupport({
    vm,
    supportRoot: input.root,
    options: {
      waitingProbeMs: input.waitingProbeMs ?? 5,
      ...(input.crashAfterEffect
        ? { journalFaults: { afterEffect: () => { throw new Error("INJECTED_AFTER_EFFECT_CRASH") } } }
        : {}),
    },
  })
  const route = support.bind({
    admission: frozenAdmission,
    processorConfig: config,
    deploymentId: "deployment-review",
    contextRef: frozenAdmission.admissionId,
    recoveryScope: Object.freeze({
      kind: "standalone" as const,
      scopeRef: frozenAdmission.admissionId,
    }),
    snapshotReceiptId: digest("e"),
    prepareProcessorRuntime: () => Promise.resolve(processorRuntime(
      support.taskManager,
      support.journal,
      input.accepted,
      input.actorDispatch,
    )),
  })
  registerHolonTaskRuntimeCapabilityBinding(vm, capability.scope, {
    admission: frozenAdmission,
    route: input.transformRoute?.(route) ?? route,
    processorConfig: config,
  })
  return Object.freeze({ vm, capability, support, route, admission: frozenAdmission })
}

export async function waitForTerminal(
  host: Awaited<ReturnType<typeof openHost>>,
  taskSpaceId: string,
  taskId: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await host.support.terminalSettlement(taskSpaceId, taskId)) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${taskSpaceId}/${taskId}`)
}
