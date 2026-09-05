import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { canonicalOwnDataDigest } from "task-manager-contract"
import {
  HolonTaskPumpJournalError,
  type HolonTaskPumpJournalCollection,
  type HolonTaskPumpJournalStorePort,
} from "@cell/ai-organ-contract/organization/HolonTaskPumpJournal"
import {
  createHolonTaskPumpDispatchIntent,
  createHolonTaskPumpJournal,
} from "../../src/organization/HolonTaskPumpJournal"

/** An independent byte-only effect implementation: no filesystem or support imports. */
function memoryStore() {
  const records = new Map<string, Uint8Array>()
  const calls: string[] = []
  const tails = new Map<string, Promise<void>>()
  const key = (collection: HolonTaskPumpJournalCollection, identity: string) => `${collection}/${identity}`
  const storageKey = (id: string) => createHash("sha256").update(id.slice(id.indexOf("/") + 1), "utf8").digest("hex")
  const store: HolonTaskPumpJournalStorePort = {
    async read(collection, identity) {
      calls.push(`read:${collection}`)
      const bytes = records.get(key(collection, identity))
      if (!bytes) throw Object.assign(new Error("Missing immutable fact"), { code: "ENOENT" })
      return bytes.slice()
    },
    async list(collection) {
      calls.push(`list:${collection}`)
      return [...records.entries()].filter(([id]) => id.startsWith(`${collection}/`))
        .sort(([left], [right]) => storageKey(left) < storageKey(right) ? -1 : storageKey(left) > storageKey(right) ? 1 : 0)
        .map(([, bytes]) => bytes.slice())
    },
    async writeImmutable(collection, identity, bytes) {
      calls.push(`write:${collection}`)
      const id = key(collection, identity)
      const previous = records.get(id)
      if (previous && (previous.length !== bytes.length || previous.some((value, index) => value !== bytes[index]))) {
        throw new HolonTaskPumpJournalError("EIDOLON_HOLON_PUMP_JOURNAL_CONFLICT", "Immutable fact conflicts.")
      }
      records.set(id, bytes.slice())
    },
    async withExclusive(identity, operation) {
      const previous = tails.get(identity) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((resolve) => { release = resolve })
      tails.set(identity, current)
      await previous
      calls.push("lock")
      try {
        return await operation()
      } finally {
        calls.push("unlock")
        release()
        if (tails.get(identity) === current) tails.delete(identity)
      }
    },
  }
  return { store, records, calls }
}

function intent() {
  return createHolonTaskPumpDispatchIntent({
    deploymentId: "deployment-review", taskSpaceId: "space-review", taskId: "task-review",
    claimId: "claim-review-1", attempt: 1, leaseEpoch: 1, invocationRef: "invoke-review-1",
    input: { requirements: ["R1"] }, preparedAt: "2026-01-01T00:00:01.000Z",
  })
}

const now = () => Date.parse("2026-01-01T00:00:02.000Z")
const subscriptionInput = {
  admissionId: "admission-review", deploymentId: "deployment-review",
  bindingRef: "resource://eidolon.fixture.binding.ai", holonRef: "holon-review",
  snapshotReceiptId: "snapshot-receipt-review", taskSpaceId: "space-review", taskId: "task-review",
  origin: { kind: "service", serviceRef: "resource://eidolon.fixture.service", requestRef: "request-review" },
  recoveryScope: { kind: "standalone", scopeRef: "standalone-review" },
  processorConfig: { leaseDurationMs: 30_000, maxSteps: 16 },
  input: { requirements: ["R1"] }, createdAt: "2026-01-01T00:00:00.000Z",
} as const

describe("Holon journal with injected memory bytes", () => {
  it("keeps v2 first-observation facts and rejects conflicting facts without physical IO", async () => {
    const { store, records } = memoryStore()
    const journal = createHolonTaskPumpJournal({ store, now })
    const first = await journal.subscribe(subscriptionInput)
    const bytes = records.get(`subscriptions/${first.subscriptionId}`)!.slice()
    expect(first.subscriptionId).toBe(canonicalOwnDataDigest({
      admissionId: subscriptionInput.admissionId, deploymentId: subscriptionInput.deploymentId,
      snapshotReceiptId: subscriptionInput.snapshotReceiptId, taskSpaceId: subscriptionInput.taskSpaceId,
      taskId: subscriptionInput.taskId, recoveryScope: subscriptionInput.recoveryScope,
    }))
    expect(await journal.subscribe({ ...subscriptionInput, createdAt: "2026-01-01T00:00:03.000Z" })).toEqual(first)
    expect(records.get(`subscriptions/${first.subscriptionId}`)).toEqual(bytes)
    expect(await createHolonTaskPumpJournal({ store, now }).listSubscriptions()).toEqual([first])
    expect(await journal.listSubscriptions("unrelated-run")).toEqual([])
    await expect(journal.subscribe({ ...subscriptionInput, input: { requirements: ["changed"] } }))
      .rejects.toMatchObject({ code: "EIDOLON_HOLON_PUMP_JOURNAL_CONFLICT" })
  })

  it("preserves dispatch ordering, exact v1 intent/result bytes, and replay suppression", async () => {
    const { store, records, calls } = memoryStore()
    const journal = createHolonTaskPumpJournal({
      store, now, faults: { afterEffect: () => { calls.push("afterEffect") } },
    })
    const value = intent()
    const dispatched = await journal.dispatch(value, async (idempotencyKey) => {
      calls.push("effect")
      expect(idempotencyKey).toBe(value.invocationRef)
      return { summary: "approved" }
    })
    expect(calls).toEqual([
      "write:intents", "read:intents", "read:results", "lock", "read:results",
      "effect", "afterEffect", "write:results", "read:results", "unlock",
    ])
    expect(new TextDecoder().decode(records.get(`intents/${value.intentId}`))).toBe(JSON.stringify(value))
    const body = {
      schemaVersion: "eidolon.holon-task-pump/v1", intentId: value.intentId,
      invocationRef: value.invocationRef, output: { summary: "approved" },
      outputDigest: canonicalOwnDataDigest({ summary: "approved" }), acceptedAt: "2026-01-01T00:00:02.000Z",
    }
    expect(new TextDecoder().decode(records.get(`results/${value.intentId}`))).toBe(
      JSON.stringify({ ...body, receiptDigest: canonicalOwnDataDigest(body) }),
    )
    expect(dispatched.replayed).toBe(false)
    calls.length = 0
    expect(await createHolonTaskPumpJournal({ store, now }).dispatch(value, async () => {
      throw new Error("replay must suppress effects")
    })).toEqual({ receipt: dispatched.receipt, replayed: true })
    expect(calls).toEqual(["write:intents", "read:intents", "read:results"])
  })

  it("releases after injected failure and recovers with the same effect idempotency key", async () => {
    const { store, calls } = memoryStore()
    const keys: string[] = []
    const effect = async (key: string) => { keys.push(key); return { accepted: true } }
    const failed = createHolonTaskPumpJournal({
      store, now, faults: { afterEffect: () => { throw new Error("INJECTED_EFFECT_RESULT_CRASH") } },
    })
    await expect(failed.dispatch(intent(), effect)).rejects.toThrow("INJECTED_EFFECT_RESULT_CRASH")
    expect(calls.at(-1)).toBe("unlock")
    expect(await failed.readResult(intent().intentId)).toBeUndefined()
    expect((await createHolonTaskPumpJournal({ store, now }).dispatch(intent(), effect)).replayed).toBe(false)
    expect(keys).toEqual([intent().invocationRef, intent().invocationRef])
  })

  it("checks raced results under the injected exclusive boundary", async () => {
    const { store } = memoryStore()
    let effects = 0
    const effect = async () => { effects += 1; return { accepted: true } }
    const results = await Promise.all([
      createHolonTaskPumpJournal({ store, now }).dispatch(intent(), effect),
      createHolonTaskPumpJournal({ store, now }).dispatch(intent(), effect),
    ])
    expect(effects).toBe(1)
    expect(results.map((value) => value.replayed).sort()).toEqual([false, true])
  })

  it("rejects tampered bytes and propagates non-missing storage failures", async () => {
    const { store, records } = memoryStore()
    const journal = createHolonTaskPumpJournal({ store, now })
    const first = await journal.subscribe(subscriptionInput)
    records.set(`subscriptions/${first.subscriptionId}`, new TextEncoder().encode(JSON.stringify({ ...first, inputDigest: "sha256:forged" })))
    await expect(journal.listSubscriptions()).rejects.toMatchObject({ code: "EIDOLON_HOLON_PUMP_JOURNAL_TAMPERED" })
    await journal.dispatch(intent(), async () => ({ accepted: true }))
    const receipt = await journal.readResult(intent().intentId)
    records.set(`results/${intent().intentId}`, new TextEncoder().encode(JSON.stringify({ ...receipt, outputDigest: "sha256:forged" })))
    await expect(journal.readResult(intent().intentId)).rejects.toMatchObject({ code: "EIDOLON_HOLON_PUMP_JOURNAL_TAMPERED" })
    const failure = Object.assign(new Error("read denied"), { code: "EACCES" })
    await expect(createHolonTaskPumpJournal({
      now, store: { ...store, read: async () => { throw failure } },
    }).readResult(intent().intentId)).rejects.toBe(failure)
  })
})
