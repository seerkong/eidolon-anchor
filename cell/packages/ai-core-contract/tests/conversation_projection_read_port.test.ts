import { describe, expect, it } from "bun:test"

import {
  CONVERSATION_PROJECTION_MUTATION_VERBS,
  CONVERSATION_PROJECTION_READ_PORT_METHODS,
  isConversationProjectionReadPort,
  type ConversationProjectionReadPort,
} from "../src"

/**
 * P1 (track isolate-runtime-projection-surfaces) — contract slice.
 *
 * Covers behavior-delta requirement `conversation-projection-read-port`, case
 * `read-port-is-readonly`: the ConversationProjectionReadPort contract exposes
 * ONLY read views and NO write/mutate/destroy capability. The single-source
 * backing behavior is asserted against the impl in the @cell/ai-support suite;
 * here we assert the contract SHAPE is real and read-only.
 */

function makeStubPort(): ConversationProjectionReadPort {
  return {
    loadHistoryProjection: async () => ({ source: "empty", messages: [] }),
    loadSessionProjection: async () => ({
      sessionId: "s",
      actorBindings: {},
      historyIndex: {} as never,
      promptIndex: {} as never,
      sessionIndex: {} as never,
    }),
    loadActorProjection: async () => null,
    loadPendingQuestionsProjection: async () => ({ rows: [] }),
  }
}

describe("ConversationProjectionReadPort: read-only method surface", () => {
  it("declares exactly the read-view methods (load*Projection)", () => {
    const stub = makeStubPort()
    for (const method of CONVERSATION_PROJECTION_READ_PORT_METHODS) {
      expect(typeof (stub as Record<string, unknown>)[method]).toBe("function")
    }
    expect(isConversationProjectionReadPort(stub)).toBe(true)
  })

  it("every declared method is a read view named load*Projection", () => {
    for (const method of CONVERSATION_PROJECTION_READ_PORT_METHODS) {
      expect(method.startsWith("load")).toBe(true)
      expect(method.endsWith("Projection")).toBe(true)
    }
  })

  it("exposes NO write/mutate/destroy method (read-port-is-readonly)", () => {
    // Structural read-only assertion: none of the declared method names carry a
    // write/mutate/destroy verb. The contract is read-only — there is no way to
    // write, delete, compact, or otherwise reach back onto domain truth.
    for (const method of CONVERSATION_PROJECTION_READ_PORT_METHODS) {
      const lower = method.toLowerCase()
      for (const verb of CONVERSATION_PROJECTION_MUTATION_VERBS) {
        expect(lower.includes(verb)).toBe(false)
      }
    }
  })

  it("a stub with only read methods conforms (no write member required)", () => {
    const stub = makeStubPort()
    expect(isConversationProjectionReadPort(stub)).toBe(true)
    // Adding any write-shaped method is unnecessary for conformance: the guard
    // only ever checks for the read views.
    expect(CONVERSATION_PROJECTION_READ_PORT_METHODS.length).toBe(4)
  })

  it("a value missing a read method is not a ConversationProjectionReadPort", () => {
    const notAPort = {
      loadHistoryProjection: async () => ({ source: "empty", messages: [] }),
      loadSessionProjection: async () => ({}),
      // loadActorProjection + loadPendingQuestionsProjection missing
    }
    expect(isConversationProjectionReadPort(notAPort)).toBe(false)
  })

  it("read methods return Promises (hydration is an explicit async read, off the hot path)", () => {
    const stub = makeStubPort()
    const history = stub.loadHistoryProjection({ sessionDir: "/tmp/s", actorKey: "a" })
    const pending = stub.loadPendingQuestionsProjection({ sessionDir: "/tmp/s" })
    expect(typeof (history as Promise<unknown>).then).toBe("function")
    expect(typeof (pending as Promise<unknown>).then).toBe("function")
  })
})
