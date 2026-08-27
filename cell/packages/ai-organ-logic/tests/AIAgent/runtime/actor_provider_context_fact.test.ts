import { describe, expect, it } from "bun:test";

import type { ActorProviderContextFact } from "@cell/ai-organ-contract";
import {
  ActorProviderContextFactError,
  canonicalActorProviderContextFactBytes,
  createActorProviderContextFact,
  createInMemoryActorProviderContextFactRuntime,
  measureActorProviderContextFactRetention,
  readActorProviderContextFacts,
} from "@cell/ai-organ-logic/conversation/ActorProviderContextFact";

function invocation(overrides: Partial<{
  namespace: ActorProviderContextFact["namespace"];
  namespaceRevision: number;
  sequence: number;
  previousFactDigest: `sha256:${string}` | null;
  previousSequenceFactDigest: `sha256:${string}` | null;
  payload: Record<string, unknown>;
}> = {}) {
  return {
    sessionId: "session-1",
    actorKey: "actor-key-1",
    actorId: "actor-id-1",
    epoch: 3,
    namespace: "work-context" as const,
    namespaceRevision: 1,
    sequence: 1,
    previousFactDigest: null,
    previousSequenceFactDigest: null,
    anchor: {
      historyGenerationId: "history-1",
      messageCount: 2,
      frontierDigest: `sha256:${"1".repeat(64)}` as const,
    },
    sourceDeliveryProofs: [],
    payload: { taskPhase: "coding", workMode: "implementation", ownerRevision: 1 },
    observedAt: "2026-08-25T14:00:00.000Z",
    ...overrides,
  };
}

describe("Actor provider context fact authority", () => {
  it("creates deterministic closed facts and rejects structural escape", () => {
    const first = createActorProviderContextFact(invocation());
    const second = createActorProviderContextFact(invocation());
    expect(second).toEqual(first);
    expect(first.factId).toBe(first.factDigest);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.payload)).toBe(true);

    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "workMode", { enumerable: true, get: () => "coding" });
    expect(() => createActorProviderContextFact(invocation({ payload: accessor }))).toThrow(
      ActorProviderContextFactError,
    );

    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[1] = "x";
    expect(() => createActorProviderContextFact(invocation({ payload: { sparse } }))).toThrow(
      ActorProviderContextFactError,
    );
  });

  it("CAS-appends one actor-global chain across interleaved namespaces", () => {
    const runtime = createInMemoryActorProviderContextFactRuntime();
    const first = createActorProviderContextFact(invocation());
    const firstCommit = runtime.append({
      expectedConversationRevision: 0,
      expectedHeadDigest: null,
      fact: first,
    });
    expect(firstCommit.acceptedConversationRevision).toBe(1);

    const second = createActorProviderContextFact(invocation({
      namespace: "provider-projection",
      namespaceRevision: 1,
      sequence: 2,
      previousSequenceFactDigest: first.factDigest,
      payload: { projectionKey: "resource:one", content: "second" },
    }));
    runtime.append({
      expectedConversationRevision: 1,
      expectedHeadDigest: first.factDigest,
      fact: second,
    });

    const third = createActorProviderContextFact(invocation({
      namespaceRevision: 2,
      sequence: 3,
      previousFactDigest: first.factDigest,
      previousSequenceFactDigest: second.factDigest,
      payload: { taskPhase: "testing", workMode: "implementation", ownerRevision: 2 },
    }));
    runtime.append({
      expectedConversationRevision: 2,
      expectedHeadDigest: second.factDigest,
      fact: third,
    });

    expect(readActorProviderContextFacts({
      runtime,
      sessionId: "session-1",
      actorKey: "actor-key-1",
      epoch: 3,
    }).map((fact) => [fact.sequence, fact.namespace])).toEqual([
      [1, "work-context"],
      [2, "provider-projection"],
      [3, "work-context"],
    ]);

    expect(() => runtime.append({
      expectedConversationRevision: 1,
      expectedHeadDigest: first.factDigest,
      fact: third,
    })).toThrow(ActorProviderContextFactError);
  });

  it("measures canonical UTF-8 fact bytes and closes both retention ceilings", () => {
    const first = createActorProviderContextFact(invocation({
      payload: { content: "x".repeat(63_000) },
    }));
    const second = createActorProviderContextFact(invocation({
      namespaceRevision: 2,
      sequence: 2,
      previousFactDigest: first.factDigest,
      previousSequenceFactDigest: first.factDigest,
      payload: { content: "y".repeat(2_000) },
    }));
    expect(canonicalActorProviderContextFactBytes(first).byteLength).toBeGreaterThan(63_000);
    expect(measureActorProviderContextFactRetention({
      facts: [first],
      maxRevisionsPerNamespace: 32,
      maxCanonicalFactBytesPerEpoch: 65_536,
    })).toMatchObject({ atLimit: false, overLimit: false });
    expect(measureActorProviderContextFactRetention({
      facts: [first, second],
      maxRevisionsPerNamespace: 32,
      maxCanonicalFactBytesPerEpoch: 65_536,
    })).toMatchObject({ atLimit: true, overLimit: true });

    const revisionFacts: ActorProviderContextFact[] = [];
    let prior: ActorProviderContextFact | null = null;
    for (let revision = 1; revision <= 33; revision += 1) {
      const fact = createActorProviderContextFact(invocation({
        namespaceRevision: revision,
        sequence: revision,
        previousFactDigest: prior?.factDigest ?? null,
        previousSequenceFactDigest: prior?.factDigest ?? null,
        payload: { revision },
      }));
      revisionFacts.push(fact);
      prior = fact;
    }
    expect(measureActorProviderContextFactRetention({
      facts: revisionFacts.slice(0, 32),
      maxRevisionsPerNamespace: 32,
      maxCanonicalFactBytesPerEpoch: 65_536,
    })).toMatchObject({ atLimit: true, overLimit: false });
    expect(measureActorProviderContextFactRetention({
      facts: revisionFacts,
      maxRevisionsPerNamespace: 32,
      maxCanonicalFactBytesPerEpoch: 65_536,
    })).toMatchObject({ atLimit: true, overLimit: true });
  });
});
