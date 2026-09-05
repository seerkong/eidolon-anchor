import { afterEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { canonicalOwnDataDigest } from "task-manager-contract"

import {
  createHolonTaskPumpJournal,
  type HolonTaskPumpJournalFaultObserver,
  createHolonTaskPumpDispatchIntent,
} from "../../src/organization/HolonTaskPumpJournal"

import { FileHolonTaskPumpJournalStore } from "@cell/ai-support/organization/FileHolonTaskPumpJournalStore"

function fileJournal(options: Readonly<{
  supportRoot: string
  lockTimeoutMs?: number
  now?: () => number
  faults?: HolonTaskPumpJournalFaultObserver
}>) {
  const now = options.now ?? Date.now
  return createHolonTaskPumpJournal({
    store: new FileHolonTaskPumpJournalStore({ now }, {
      supportRoot: options.supportRoot,
      lockTimeoutMs: options.lockTimeoutMs,
    }),
    now,
    faults: options.faults,
  })
}

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
    const first = fileJournal({ supportRoot })
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

    const reconstructed = fileJournal({ supportRoot })
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

    const [projected] = await fileJournal({ supportRoot })
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
    const first = fileJournal({ supportRoot })
    const second = fileJournal({ supportRoot })
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

    const reconstructed = fileJournal({ supportRoot })
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
    const faulted = fileJournal({
      supportRoot,
      faults: { afterEffect: () => { throw new Error("INJECTED_EFFECT_RESULT_CRASH") } },
    })
    await expect(faulted.dispatch(intent(), effect)).rejects.toThrow(/INJECTED_EFFECT_RESULT_CRASH/)
    expect(acceptedEffects).toBe(1)

    const recovered = await fileJournal({ supportRoot }).dispatch(intent(), effect)
    expect(recovered.receipt.output).toEqual({ summary: "durably-accepted" })
    expect(acceptedEffects).toBe(1)
  })

  it("rejects a re-signed intent whose closed input changed", async () => {
    const supportRoot = await root()
    const journal = fileJournal({ supportRoot })
    const authentic = intent()
    await expect(journal.dispatch({
      ...authentic,
      input: { requirements: ["forged"] },
    }, async () => ({ summary: "must-not-run" }))).rejects.toMatchObject({
      code: "EIDOLON_HOLON_PUMP_JOURNAL_TAMPERED",
    })
  })
})

describe("FileHolonTaskPumpJournalStore physical boundary", () => {
  const filename = (identity: string) => createHash("sha256").update(identity, "utf8").digest("hex")

  it("retains original hashed filenames, byte conflict errors, modes and listing order", async () => {
    const supportRoot = await root()
    const store = new FileHolonTaskPumpJournalStore({ now: Date.now }, { supportRoot })
    const identities = ["../opaque-id", "é", "identity-A"]
    for (const identity of identities) {
      await store.writeImmutable("subscriptions", identity, new TextEncoder().encode(identity))
    }
    const directory = path.join(supportRoot, "holon-task-pump", "subscriptions")
    const expected = identities.map((identity) => ({ name: `${filename(identity)}.json`, identity }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    expect((await readdir(directory)).sort()).toEqual(expected.map((entry) => entry.name))
    expect((await store.list("subscriptions")).map((bytes) => new TextDecoder().decode(bytes)))
      .toEqual(expected.map((entry) => entry.identity))
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(path.join(directory, expected[0]!.name))).mode & 0o777).toBe(0o600)
    const identity = identities[0]!
    const original = await store.read("subscriptions", identity)
    await store.writeImmutable("subscriptions", identity, original)
    await expect(store.writeImmutable("subscriptions", identity, new TextEncoder().encode("different")))
      .rejects.toMatchObject({
        code: "EIDOLON_HOLON_PUMP_JOURNAL_CONFLICT",
        message: `EIDOLON_HOLON_PUMP_JOURNAL_CONFLICT: Immutable fact '${filename(identity)}.json' conflicts.`,
      })
    expect(await store.read("subscriptions", identity)).toEqual(original)
    expect((await readdir(directory)).some((name) => name.endsWith(".candidate"))).toBe(false)
    await expect(store.read("results", "missing")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("recovers an aged lock with no live PID and releases it after a failed operation", async () => {
    const supportRoot = await root()
    const locks = path.join(supportRoot, "holon-task-pump", "locks")
    await mkdir(locks, { recursive: true })
    const lockFile = path.join(locks, `${filename("identity")}.lock`)
    await writeFile(lockFile, JSON.stringify({ token: "abandoned", pid: "missing" }))
    const now = () => Date.now() + 60_000
    const store = new FileHolonTaskPumpJournalStore({ now }, { supportRoot, lockTimeoutMs: 100 })
    const failure = new Error("FAILED_OPERATION")
    await expect(store.withExclusive("identity", async () => { throw failure })).rejects.toBe(failure)
    expect(await readdir(locks)).toEqual([])
    expect(await store.withExclusive("identity", async () => "recovered")).toBe("recovered")
  })

  it("times out against a live owner even when the lock is aged", async () => {
    const supportRoot = await root()
    const locks = path.join(supportRoot, "holon-task-pump", "locks")
    await mkdir(locks, { recursive: true })
    const lockFile = path.join(locks, `${filename("identity")}.lock`)
    const owner = JSON.stringify({ token: "live", pid: process.pid })
    await writeFile(lockFile, owner)
    let time = Date.now() + 60_000
    const store = new FileHolonTaskPumpJournalStore({ now: () => time++ }, { supportRoot, lockTimeoutMs: 1 })
    await expect(store.withExclusive("identity", async () => "must not run")).rejects.toMatchObject({
      code: "EIDOLON_HOLON_PUMP_JOURNAL_LOCK_TIMEOUT",
      message: "EIDOLON_HOLON_PUMP_JOURNAL_LOCK_TIMEOUT: Dispatch result lock did not become available.",
    })
    expect(await readFile(lockFile, "utf8")).toBe(owner)
  })

  it("rejects changed lock ownership without deleting the replacement", async () => {
    const supportRoot = await root()
    const store = new FileHolonTaskPumpJournalStore({ now: Date.now }, { supportRoot })
    const lockFile = path.join(supportRoot, "holon-task-pump", "locks", `${filename("identity")}.lock`)
    const replacement = JSON.stringify({ token: "replacement", pid: process.pid })
    await expect(store.withExclusive("identity", async () => {
      await writeFile(lockFile, replacement)
    })).rejects.toMatchObject({
      code: "EIDOLON_HOLON_PUMP_JOURNAL_LOCK_CONFLICT",
      message: "EIDOLON_HOLON_PUMP_JOURNAL_LOCK_CONFLICT: Dispatch lock ownership changed.",
    })
    expect(await readFile(lockFile, "utf8")).toBe(replacement)
  })

  it("prepares the result directory before publishing an intent", async () => {
    const supportRoot = await root()
    await mkdir(path.join(supportRoot, "holon-task-pump"), { recursive: true })
    await writeFile(path.join(supportRoot, "holon-task-pump", "results"), "not a directory")
    const journal = fileJournal({ supportRoot })
    await expect(journal.dispatch(intent(), async () => "must not run")).rejects.toMatchObject({ code: "EEXIST" })
    expect(await readdir(path.join(supportRoot, "holon-task-pump", "intents"))).toEqual([])
  })
})
