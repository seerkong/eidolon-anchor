import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

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
} from "../../src/organization/HolonTaskRuntimeComposition"
import { createLocalHolonTaskRuntimeStorage } from "@cell/ai-support/organization/LocalHolonTaskRuntimeSupport"
import { claimTask } from "task-manager-logic"

import {
  registerHolonTaskRuntimeCapabilityBinding,
  type HolonTaskRuntimeCapabilityVm,
} from "../../src/organization/HolonTaskRuntimeCapability"
import { normalizeHolonTaskExecutionProfile } from "../../src/organization/HolonTaskExecutionProfile"
import type { HolonTaskProcessorRuntime } from "../../src/organization/HolonTaskRuntimeProcessor"

const roots: string[] = []
const digest = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}` as const
const processorConfig = Object.freeze({ leaseDurationMs: 5_000, maxSteps: 16 })

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function supportRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-standalone-holon-runtime-"))
  roots.push(root)
  return root
}

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
  accepted: AcceptedEffects,
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
    actorDispatch: {
      async dispatch({ idempotencyKey, invocation }) {
        const prior = accepted.values.get(idempotencyKey)
        if (prior) return Object.freeze({ output: prior, replayed: true })
        accepted.onAccepted()
        const output = Object.freeze({ summary: `completed:${invocation.taskRef}` })
        accepted.values.set(idempotencyKey, output)
        return Object.freeze({ output, replayed: false })
      },
    },
    journal,
    clock: { nowEpochMs: Date.now },
    timer: { wait: abortableTimer },
  })
}

function invocation(requestId: string, replyMode: HolonTaskReplyMode) {
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

async function openHost(input: Readonly<{
  root: string
  accepted: AcceptedEffects
  waitingProbeMs?: number
  crashAfterEffect?: boolean
}>) {
  const vm = runtimeVm()
  const frozenAdmission = admission()
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
    processorConfig,
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
    )),
  })
  registerHolonTaskRuntimeCapabilityBinding(vm, capability.scope, {
    admission: frozenAdmission,
    route,
    processorConfig,
  })
  return Object.freeze({ vm, capability, support, admission: frozenAdmission })
}

async function waitForTerminal(
  host: Awaited<ReturnType<typeof openHost>>,
  taskSpaceId: string,
  taskId: string,
): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (await host.support.terminalSettlement(taskSpaceId, taskId)) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${taskSpaceId}/${taskId}`)
}

function acceptedEffects() {
  let acceptedCount = 0
  const state = {
    values: new Map<string, Readonly<{ summary: string }>>(),
    onAccepted: () => { acceptedCount += 1 },
  }
  return Object.freeze({ state, count: () => acceptedCount })
}

describe("standalone Holon task runtime File TaskSpace E2E", () => {
  it("executes final/none/stream and replays one logical product assignment", async () => {
    const root = await supportRoot()
    const accepted = acceptedEffects()
    const host = await openHost({ root, accepted: accepted.state, waitingProbeMs: 20 })

    const final = await host.capability.service.assign(
      { kind: "holon", holonRef: "holon-review" },
      invocation("final", "final"),
      processorConfig,
    )
    expect(final.settlement).toMatchObject({
      status: "succeeded",
      result: { summary: expect.stringContaining("completed:") },
    })

    const none = await host.capability.service.assign(
      { kind: "member", holonRef: "holon-review", memberRef: "member-reviewer" },
      invocation("none", "none"),
      processorConfig,
    )
    const stream = await host.capability.service.assign(
      { kind: "admission", admissionId: host.admission.admissionId },
      invocation("stream", "stream"),
      processorConfig,
    )
    expect(none.settlement).toBeNull()
    expect(stream.settlement).toBeNull()
    expect(none.coordinatorWake.coordinatorActorRef)
      .toBe(final.coordinatorWake.coordinatorActorRef)
    expect(stream.coordinatorWake.coordinatorActorRef)
      .toBe(final.coordinatorWake.coordinatorActorRef)
    expect(accepted.count()).toBe(1)

    await Promise.all([
      waitForTerminal(host, none.task.taskSpaceId, none.task.taskId),
      waitForTerminal(host, stream.task.taskSpaceId, stream.task.taskId),
    ])
    expect(accepted.count()).toBe(3)

    const replayed = await host.capability.service.assign(
      { kind: "holon", holonRef: "holon-review" },
      invocation("final", "final"),
      processorConfig,
    )
    expect(replayed.task.replayed).toBe(true)
    expect(replayed.coordinatorWake.replayed).toBe(true)
    expect(replayed.settlement?.replayed).toBe(true)
    expect(accepted.count()).toBe(3)
    host.support.close()
  })

  it("retains one support/coordinator owner per VM scope and rejects replacement", async () => {
    const root = await supportRoot()
    const accepted = acceptedEffects()
    const host = await openHost({ root, accepted: accepted.state })

    expect(mountLocalHolonTaskRuntimeSupport({ vm: host.vm, supportRoot: root }))
      .toBe(host.support)
    expect(() => mountLocalHolonTaskRuntimeSupport({
      vm: host.vm,
      supportRoot: `${root}-conflict`,
    })).toThrow("EIDOLON_HOLON_TASK_SUPPORT_SCOPE_CONFLICT")

    const first = await host.capability.service.assign(
      { kind: "holon", holonRef: "holon-review" },
      invocation("one-coordinator-first", "none"),
      processorConfig,
    )
    const second = await host.capability.service.assign(
      { kind: "member", holonRef: "holon-review", memberRef: "member-reviewer" },
      invocation("one-coordinator-second", "none"),
      processorConfig,
    )
    expect(second.coordinatorWake.coordinatorActorRef)
      .toBe(first.coordinatorWake.coordinatorActorRef)
    host.support.close()
  })

  it("reconstructs one pending subscription in a fresh VM without Workflow state", async () => {
    const root = await supportRoot()
    const accepted = acceptedEffects()
    const first = await openHost({ root, accepted: accepted.state, waitingProbeMs: 1_000 })
    const receipt = await first.capability.service.assign(
      { kind: "holon", holonRef: "holon-review" },
      invocation("fresh-restart", "none"),
      processorConfig,
    )
    expect(accepted.count()).toBe(0)
    first.support.close()

    const reconstructed = await openHost({ root, accepted: accepted.state, waitingProbeMs: 1 })
    expect(await reconstructed.support.recoverPending()).toEqual({
      recovered: 1,
      scheduled: 1,
      terminal: 0,
    })
    await waitForTerminal(reconstructed, receipt.task.taskSpaceId, receipt.task.taskId)
    expect(accepted.count()).toBe(1)
    expect((await reconstructed.support.listSubscriptions())[0]?.recoveryScope)
      .toEqual({ kind: "standalone", scopeRef: reconstructed.admission.admissionId })
    reconstructed.support.close()
  })

  it("replays adapter acceptance after a crash between effect and journal result", async () => {
    const root = await supportRoot()
    const accepted = acceptedEffects()
    const faulted = await openHost({
      root,
      accepted: accepted.state,
      crashAfterEffect: true,
    })
    await expect(faulted.capability.service.assign(
      { kind: "holon", holonRef: "holon-review" },
      invocation("crash-after-effect", "final"),
      processorConfig,
    )).rejects.toThrow("INJECTED_AFTER_EFFECT_CRASH")
    expect(accepted.count()).toBe(1)
    faulted.support.close()

    const recovered = await openHost({ root, accepted: accepted.state, waitingProbeMs: 1 })
    expect((await recovered.support.recoverPending()).recovered).toBe(1)
    const [subscription] = await recovered.support.listSubscriptions()
    await recovered.support.wakeSubscription(subscription!)
    await waitForTerminal(recovered, subscription!.taskSpaceId, subscription!.taskId)
    expect(accepted.count()).toBe(1)
    recovered.support.close()
  })
})
