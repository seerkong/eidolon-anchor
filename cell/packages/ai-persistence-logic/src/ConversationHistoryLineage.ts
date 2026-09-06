import type { ActorHistoryGenerationData, ConversationHistoryIndexSnapshot } from "@cell/ai-organ-contract";

/** Metadata authority only: message bodies and storage are deliberately absent. */
export type ConversationHistoryLineageEnvelope = Pick<ActorHistoryGenerationData,
  "generationId" | "sessionId" | "actorKey" | "actorId" | "predecessorGenerationIds">;

export type ConversationHistoryLineageRejectionReason =
  | "head_mismatch"
  | "missing_generation"
  | "duplicate_generation"
  | "identity_mismatch"
  | "lineage_conflict"
  | "lineage_cycle";

export type ConversationHistoryLineageResult =
  | Readonly<{ status: "ok"; generationIds: string[] }>
  | Readonly<{ status: "rejected"; reason: ConversationHistoryLineageRejectionReason; generationId: string }>;

/**
 * Resolve visible ancestry from durable generation envelopes, checking any
 * redundant index lineage rather than requiring old indexes to contain it.
 * parentGenerationId is provenance, not visibility (notably after rollback).
 */
export function resolveConversationHistoryLineage(input: {
  historyIndex: ConversationHistoryIndexSnapshot;
  actorKey: string;
  activeGenerationId: string;
  historyGenerations: readonly ConversationHistoryLineageEnvelope[];
}): ConversationHistoryLineageResult {
  const reject = (reason: ConversationHistoryLineageRejectionReason, generationId: string): ConversationHistoryLineageResult => ({
    status: "rejected", reason, generationId,
  });
  const head = input.historyIndex.heads[input.actorKey];
  if (!head || (head.activeGenerationId && head.activeGenerationId !== input.activeGenerationId)) {
    return reject("head_mismatch", input.activeGenerationId);
  }
  const sameIdentity = (value: { sessionId: string; actorKey: string; actorId: string }) => (
    value.sessionId === input.historyIndex.sessionId
    && value.actorKey === input.actorKey
    && value.actorId === head.actorId
  );
  if (!sameIdentity(head)) return reject("identity_mismatch", input.activeGenerationId);
  const generations = new Map<string, ConversationHistoryLineageEnvelope>();
  for (const generation of input.historyGenerations) {
    if (generations.has(generation.generationId)) return reject("duplicate_generation", generation.generationId);
    generations.set(generation.generationId, generation);
  }

  const generationIds: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  // Iterative DFS also supports very long conversations without call-stack growth.
  const roots = [...new Set([input.activeGenerationId, ...head.visibleGenerationIds])];
  for (const root of roots) {
    const stack = [{ id: root, exiting: false }];
    while (stack.length > 0) {
      const { id, exiting } = stack.pop()!;
      if (exiting) {
        visiting.delete(id);
        visited.add(id);
        generationIds.push(id);
        continue;
      }
      if (visited.has(id)) continue;
      if (visiting.has(id)) return reject("lineage_cycle", id);
      const generation = generations.get(id);
      if (!generation) return reject("missing_generation", id);
      if (!sameIdentity(generation)) return reject("identity_mismatch", id);
      const lineage = input.historyIndex.lineages[id];
      if (lineage) {
        if (lineage.generationId !== id || !sameIdentity(lineage)) return reject("identity_mismatch", id);
        if (lineage.predecessorGenerationIds.length !== generation.predecessorGenerationIds.length
          || lineage.predecessorGenerationIds.some((predecessor, index) => predecessor !== generation.predecessorGenerationIds[index])) {
          return reject("lineage_conflict", id);
        }
      }
      visiting.add(id);
      stack.push({ id, exiting: true });
      for (let index = generation.predecessorGenerationIds.length - 1; index >= 0; index--) {
        stack.push({ id: generation.predecessorGenerationIds[index]!, exiting: false });
      }
    }
  }
  return { status: "ok", generationIds };
}
