import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  mountLocalHolonTaskRuntimeSupport,
} from "../../src/organization/HolonTaskRuntimeComposition"
import { invocation, openHost, processorConfig, waitForTerminal } from "./fixtures/holonTaskFileRuntime"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function supportRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-standalone-holon-runtime-"))
  roots.push(root)
  return root
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
