import { expect, test } from "bun:test";
import type { ConversationHistoryIndexSnapshot } from "@cell/ai-organ-contract";
import { resolveConversationHistoryLineage, type ConversationHistoryLineageEnvelope } from "../src/ConversationHistoryLineage";

function fixture() {
  const envelope = (generationId: string, predecessorGenerationIds: string[]): ConversationHistoryLineageEnvelope => ({
    generationId, predecessorGenerationIds, sessionId: "session", actorKey: "main", actorId: "actor",
  });
  const historyGenerations = [envelope("head", ["middle"]), envelope("root", []), envelope("middle", ["root"])];
  const historyIndex: ConversationHistoryIndexSnapshot = {
    version: 1, sessionId: "session", updatedAt: "0", lineages: {}, generations: {},
    heads: { main: { version: 1, sessionId: "session", actorKey: "main", actorId: "actor",
      activeGenerationId: "head", visibleGenerationIds: ["head", "root", "middle"], updatedAt: "0" } },
  };
  return { historyIndex, historyGenerations, actorKey: "main", activeGenerationId: "head" };
}

test("envelope lineage proves predecessor order when index lineage is absent and head appears first", () => {
  const input = fixture();
  const before = JSON.stringify(input);
  expect(resolveConversationHistoryLineage(input)).toEqual({ status: "ok", generationIds: ["root", "middle", "head"] });
  expect(JSON.stringify(input)).toBe(before);
});

test("parent provenance alone does not make rolled-back history visible", () => {
  const input = fixture();
  input.historyIndex.heads.main!.visibleGenerationIds = ["head"];
  input.historyGenerations = [{ ...input.historyGenerations[0]!, predecessorGenerationIds: [], parentGenerationId: "missing-old-tail" } as ConversationHistoryLineageEnvelope];
  expect(resolveConversationHistoryLineage(input)).toEqual({ status: "ok", generationIds: ["head"] });
});

test("missing predecessor and cyclic lineage fail closed", () => {
  const input = fixture();
  input.historyGenerations = input.historyGenerations.filter(g => g.generationId !== "middle");
  expect(resolveConversationHistoryLineage(input)).toEqual({ status: "rejected", reason: "missing_generation", generationId: "middle" });
  const cycle = fixture();
  cycle.historyGenerations[1]!.predecessorGenerationIds = ["head"];
  expect(resolveConversationHistoryLineage(cycle)).toEqual({ status: "rejected", reason: "lineage_cycle", generationId: "head" });
});

test("cross-session, actor key, and actor identity envelopes fail closed", () => {
  for (const field of ["sessionId", "actorKey", "actorId"] as const) {
    const input = fixture();
    input.historyGenerations[2]![field] = "other";
    expect(resolveConversationHistoryLineage(input)).toEqual({ status: "rejected", reason: "identity_mismatch", generationId: "middle" });
  }
});

test("present index lineage must agree with envelope identity and predecessor sequence", () => {
  const input = fixture();
  input.historyIndex.lineages.head = { ...input.historyGenerations[0]!, version: 1, successorGenerationIds: [], forkGenerationIds: [], updatedAt: "0" };
  expect(resolveConversationHistoryLineage(input).status).toBe("ok");
  input.historyIndex.lineages.head.predecessorGenerationIds = ["root"];
  expect(resolveConversationHistoryLineage(input)).toEqual({ status: "rejected", reason: "lineage_conflict", generationId: "head" });
  input.historyIndex.lineages.head.predecessorGenerationIds = ["middle"];
  input.historyIndex.lineages.head.actorId = "other";
  expect(resolveConversationHistoryLineage(input)).toEqual({ status: "rejected", reason: "identity_mismatch", generationId: "head" });
});

test("duplicate generation identities and changed active head fail closed", () => {
  const input = fixture();
  input.historyGenerations.push({ ...input.historyGenerations[0]! });
  expect(resolveConversationHistoryLineage(input)).toEqual({ status: "rejected", reason: "duplicate_generation", generationId: "head" });
  const changed = fixture();
  changed.historyIndex.heads.main!.activeGenerationId = "middle";
  expect(resolveConversationHistoryLineage(changed)).toEqual({ status: "rejected", reason: "head_mismatch", generationId: "head" });
});

test("shared ancestry is visited once and long explicit chains do not exhaust the call stack", () => {
  const input = fixture();
  input.historyGenerations[0]!.predecessorGenerationIds = ["middle", "root"];
  expect(resolveConversationHistoryLineage(input)).toEqual({ status: "ok", generationIds: ["root", "middle", "head"] });
  const count = 12_000;
  const chain = fixture();
  chain.historyGenerations = Array.from({ length: count }, (_, index) => ({
    generationId: String(index), sessionId: "session", actorKey: "main", actorId: "actor",
    predecessorGenerationIds: index === 0 ? [] : [String(index - 1)],
  }));
  chain.activeGenerationId = String(count - 1);
  chain.historyIndex.heads.main!.activeGenerationId = chain.activeGenerationId;
  chain.historyIndex.heads.main!.visibleGenerationIds = [chain.activeGenerationId];
  const result = resolveConversationHistoryLineage(chain);
  expect(result.status).toBe("ok");
  if (result.status === "ok") expect(result.generationIds).toEqual(Array.from({ length: count }, (_, index) => String(index)));
});
