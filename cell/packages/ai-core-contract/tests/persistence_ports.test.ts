import { describe, expect, it } from "bun:test"

import {
  createNoopPersistenceWritePort,
  isPersistenceWritePort,
  type PersistenceReadPort,
  type PersistenceWritePort,
} from "../src"

/**
 * P1 (track refactor-persistent-session-backplane) — port-contract slice.
 *
 * Covers the concretely-testable parts of behavior-delta requirements
 * `one-way-persistence-ports` (port shape: write-behind / fire-and-forget;
 * read port single-source method surface) and `storage-not-live-gate`
 * (storage-off → no-op write port). The runtime non-blocking + explicit
 * injection behavior is deferred to P3; single-source recovery + 005 replay
 * to P4. Here we only assert the contract shapes are real.
 */

describe("PersistenceWritePort: write-behind / fire-and-forget shape", () => {
  it("its enqueue methods do not return a Promise the caller must await for durability", () => {
    // A conforming write port surface: each enqueue method returns void (or a
    // detached handle), NEVER a Promise the hot path must await for durable
    // completion. We assert this structurally via the reference no-op port.
    const port = createNoopPersistenceWritePort()

    const snapshotResult = port.writeSnapshot({
      sessionDir: "/tmp/session-a",
      sessionId: "session-a",
      reason: "safepoint",
    })
    const evidenceResult = port.appendEffectEvidence({
      sessionDir: "/tmp/session-a",
      event: { kind: "tool_call", phase: "started", effectId: "e1" },
    })
    const compactionResult = port.persistCompaction({
      sessionDir: "/tmp/session-a",
      sessionId: "session-a",
      actorKey: "actor-1",
      actorId: "actor-1",
      reason: "auto",
    })

    // Enqueue must not be a thenable the turn awaits for durability.
    expect(typeof (snapshotResult as { then?: unknown })?.then).not.toBe("function")
    expect(typeof (evidenceResult as { then?: unknown })?.then).not.toBe("function")
    expect(typeof (compactionResult as { then?: unknown })?.then).not.toBe("function")
  })

  it("the no-op (storage-off) port satisfies the PersistenceWritePort interface", () => {
    const port: PersistenceWritePort = createNoopPersistenceWritePort()
    expect(isPersistenceWritePort(port)).toBe(true)
    expect(typeof port.writeSnapshot).toBe("function")
    expect(typeof port.appendEffectEvidence).toBe("function")
    expect(typeof port.persistCompaction).toBe("function")
  })

  it("the no-op port is a true no-op: enqueuing never throws and persists nothing observable", () => {
    const port = createNoopPersistenceWritePort()
    // storage-off path: each call is a silent no-op (storage-not-live-gate).
    expect(() => {
      port.writeSnapshot({ sessionDir: "", sessionId: "s", reason: "safepoint" })
      port.appendEffectEvidence({
        sessionDir: "",
        event: { kind: "bash", phase: "completed", effectId: "e2" },
      })
      port.persistCompaction({
        sessionDir: "",
        sessionId: "s",
        actorKey: "a",
        actorId: "a",
        reason: "manual",
      })
    }).not.toThrow()
  })

  it("a plain object missing a write method is not a PersistenceWritePort", () => {
    const notAPort = {
      writeSnapshot: () => undefined,
      appendEffectEvidence: () => undefined,
      // persistCompaction missing
    }
    expect(isPersistenceWritePort(notAPort)).toBe(false)
  })
})

describe("PersistenceReadPort: single-source recovery method surface", () => {
  it("declares recovery read methods (recoverSession / loadConversationSource)", () => {
    // Structural type-level assertion: a conforming implementation must expose
    // both recovery read methods. We exercise it via a minimal stub so the
    // contract members are referenced (single-source semantics enforced in P4).
    const stub: PersistenceReadPort = {
      recoverSession: async () => null,
      loadConversationSource: async () => null,
    }
    expect(typeof stub.recoverSession).toBe("function")
    expect(typeof stub.loadConversationSource).toBe("function")
  })

  it("recoverSession returns a Promise (recovery is an explicit async read, off the hot path)", () => {
    const stub: PersistenceReadPort = {
      recoverSession: async () => null,
      loadConversationSource: async () => null,
    }
    const result = stub.recoverSession({ sessionDir: "/tmp/s", sessionId: "s" })
    expect(typeof (result as Promise<unknown>).then).toBe("function")
  })
})
