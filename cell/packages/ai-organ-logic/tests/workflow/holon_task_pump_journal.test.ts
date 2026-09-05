import { afterEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { canonicalOwnDataDigest } from "task-manager-contract"

import {
  FileHolonTaskPumpJournal,
  createHolonTaskPumpDispatchIntent,
} from "../../src/organization/HolonTaskPumpJournal"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-pump-journal-"))
  roots.push(value)
  return value
}

function intent() {
  return createHolonTaskPumpDispatchIntent({
    deploymentId: "deployment-review",
    taskSpaceId: "space-review",
    taskId: "task-review",
    claimId: "claim-review-1",
    attempt: 1,
    leaseEpoch: 1,
    invocationRef: "invoke-review-1",
    input: { requirements: ["R1"] },
    preparedAt: "2026-01-01T00:00:01.000Z",
  })
}

describe("FileHolonTaskPumpJournal", () => {
  it("persists neutral v2 subscriptions for fresh reconstruction and exact scope queries", async () => {
    const supportRoot = await root()
    const first = new FileHolonTaskPumpJournal({ supportRoot })
    const subscriptionInput = {
      admissionId: "admission-review",
      deploymentId: "deployment-review",
      bindingRef: "resource://eidolon.fixture.binding.ai",
      holonRef: "holon-review",
      snapshotReceiptId: "snapshot-receipt-review",
      taskSpaceId: "space-review",
      taskId: "task-review",
      origin: {
        kind: "workflow",
        workflowKind: "AICtrlWorkflow",
        workflowRef: "resource://eidolon.fixture.workflow.review",
        runId: "run-review",
        nodeId: "delegate-review",
        invocationId: "invocation-review",
      },
      recoveryScope: {
        kind: "workflow",
        workflowInstanceId: "instance-review",
        runId: "run-review",
        nodeId: "delegate-review",
      },
      processorConfig: { leaseDurationMs: 30_000, maxSteps: 16 },
      input: { requirements: ["R1"] },
      createdAt: "2026-01-01T00:00:00.000Z",
    } as const
    const subscribed = await first.subscribe(subscriptionInput)
    const replayedAtLaterObservation = await first.subscribe({
      ...subscriptionInput,
      createdAt: "2026-01-01T00:00:02.000Z",
    })

    const reconstructed = new FileHolonTaskPumpJournal({ supportRoot })
    expect(subscribed.schemaVersion).toBe("eidolon.holon-task-pump/v2")
    expect(replayedAtLaterObservation).toEqual(subscribed)
    expect(await reconstructed.listSubscriptions()).toEqual([subscribed])
    expect(await reconstructed.listSubscriptions("run-review")).toEqual([subscribed])
    expect(await reconstructed.listSubscriptions("another-run")).toEqual([])
    await expect(first.subscribe({
      ...subscriptionInput,
      input: { requirements: ["changed"] },
      createdAt: "2026-01-01T00:00:03.000Z",
    })).rejects.toMatchObject({ code: "EIDOLON_HOLON_PUMP_JOURNAL_CONFLICT" })
  })

  it("verifies exact legacy v1 Workflow bytes and projects them without rewriting the fact", async () => {
    const supportRoot = await root()
    const input = Object.freeze({ requirements: ["R1"] })
    const identity = Object.freeze({
      deploymentId: "deployment-review",
      snapshotReceiptId: "snapshot-receipt-review",
      taskSpaceId: "space-review",
      taskId: "task-review",
      runId: "run-review",
      nodeId: "delegate-review",
    })
    const legacy = Object.freeze({
      schemaVersion: "eidolon.holon-task-pump/v1" as const,
      subscriptionId: canonicalOwnDataDigest(identity),
      ...identity,
      bindingRef: "resource://eidolon.fixture.binding.ai",
      holonRef: "holon-review",
      workflowInstanceId: "instance-review",
      input,
      inputDigest: canonicalOwnDataDigest(input),
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    const bytes = Buffer.from(JSON.stringify(legacy))
    const directory = path.join(supportRoot, "holon-task-pump", "subscriptions")
    await mkdir(directory, { recursive: true })
    const target = path.join(
      directory,
      `${createHash("sha256").update(legacy.subscriptionId).digest("hex")}.json`,
    )
    await writeFile(target, bytes)

    const [projected] = await new FileHolonTaskPumpJournal({ supportRoot })
      .listSubscriptions("run-review")
    expect(projected).toMatchObject({
      schemaVersion: "eidolon.holon-task-pump/v2",
      subscriptionId: legacy.subscriptionId,
      recoveryScope: {
        kind: "workflow",
        workflowInstanceId: "instance-review",
        runId: "run-review",
        nodeId: "delegate-review",
      },
      processorConfig: { leaseDurationMs: 30_000, maxSteps: 1_024 },
      origin: { kind: "service" },
    })
    expect(await readFile(target)).toEqual(bytes)
  })

  it("serializes concurrent dispatch and replays one durable accepted result", async () => {
    const supportRoot = await root()
    const first = new FileHolonTaskPumpJournal({ supportRoot })
    const second = new FileHolonTaskPumpJournal({ supportRoot })
    let effects = 0
    const effect = async () => {
      effects += 1
      await new Promise((resolve) => setTimeout(resolve, 25))
      return { summary: "approved" } as const
    }

    const [left, right] = await Promise.all([
      first.dispatch(intent(), effect),
      second.dispatch(intent(), effect),
    ])
    expect(intent().schemaVersion).toBe("eidolon.holon-task-pump/v1")
    expect(effects).toBe(1)
    expect(left.receipt).toEqual(right.receipt)
    expect([left.replayed, right.replayed].sort()).toEqual([false, true])

    const reconstructed = new FileHolonTaskPumpJournal({ supportRoot })
    const replayed = await reconstructed.dispatch(intent(), async () => {
      throw new Error("durable result must suppress a repeated effect")
    })
    expect(replayed.replayed).toBe(true)
    expect(replayed.receipt.output).toEqual({ summary: "approved" })
  })

  it("replays the adapter idempotency key after a crash between effect acceptance and result persistence", async () => {
    const supportRoot = await root()
    let acceptedEffects = 0
    const accepted = new Map<string, { readonly summary: string }>()
    const effect = async (idempotencyKey: string) => {
      const existing = accepted.get(idempotencyKey)
      if (existing) return existing
      acceptedEffects += 1
      const output = Object.freeze({ summary: "durably-accepted" })
      accepted.set(idempotencyKey, output)
      return output
    }
    const faulted = new FileHolonTaskPumpJournal({
      supportRoot,
      faults: { afterEffect: () => { throw new Error("INJECTED_EFFECT_RESULT_CRASH") } },
    })
    await expect(faulted.dispatch(intent(), effect)).rejects.toThrow(/INJECTED_EFFECT_RESULT_CRASH/)
    expect(acceptedEffects).toBe(1)

    const recovered = await new FileHolonTaskPumpJournal({ supportRoot }).dispatch(intent(), effect)
    expect(recovered.receipt.output).toEqual({ summary: "durably-accepted" })
    expect(acceptedEffects).toBe(1)
  })

  it("rejects a re-signed intent whose closed input changed", async () => {
    const supportRoot = await root()
    const journal = new FileHolonTaskPumpJournal({ supportRoot })
    const authentic = intent()
    await expect(journal.dispatch({
      ...authentic,
      input: { requirements: ["forged"] },
    }, async () => ({ summary: "must-not-run" }))).rejects.toMatchObject({
      code: "EIDOLON_HOLON_PUMP_JOURNAL_TAMPERED",
    })
  })
})
