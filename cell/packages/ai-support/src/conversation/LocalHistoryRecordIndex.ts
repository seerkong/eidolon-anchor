import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { readXnlRecordPage } from "@cell/ai-file-store-logic";
import type { ConversationHistoryLineageEnvelope } from "@cell/ai-persistence-logic/ConversationHistoryLineage";
import { historyGenerationXnlRecordToData } from "./local/LocalFileConversationPersistenceRepository";

export type LocalHistoryRecordIndexEntry = Readonly<{
  actorKey: string;
  generationId: string;
  recordId: string;
  messageId: string;
  hasMessageId: boolean;
  createdReason: string;
  sequence?: number;
  startOffset: number;
  endOffset: number;
  physicalRevision: number;
}>;

export type PreparedLocalHistoryRecordIndex = Readonly<{
  entries: readonly LocalHistoryRecordIndexEntry[];
  generations: readonly ConversationHistoryLineageEnvelope[];
  sourceSignature: string;
  sourceBytes: number;
  observedBytes: number;
  cacheHit: boolean;
}>;

const MAX_SOURCES = 2;
const MAX_ENTRIES = 100_000;
const SCAN_BATCH_BYTES = 8 * 1024 * 1024;
const MAX_IDENTITY_LENGTH = 4096;

export type LocalHistoryIndexErrorCode =
  | "source_changed"
  | "preparation_invalidated"
  | "record_exceeds_budget"
  | "metadata_limit_exceeded"
  | "scan_did_not_advance"
  | "identity_too_large"
  | "lineage_metadata_conflict";

export class LocalHistoryIndexError extends Error {
  constructor(readonly code: LocalHistoryIndexErrorCode) {
    super(`conversation_history_index_${code}`);
    this.name = "LocalHistoryIndexError";
  }
}

function boundedIdentity(value: unknown): string {
  const identity = String(value ?? "");
  if (identity.length > MAX_IDENTITY_LENGTH) throw new LocalHistoryIndexError("identity_too_large");
  return identity;
}

async function sourceIdentity(filePath: string) {
  const source = await stat(filePath);
  return {
    sourceBytes: source.size,
    sourceSignature: [source.dev, source.ino, source.size, source.mtimeMs, source.ctimeMs].join(":"),
  };
}

/** Disposable read-only derivative of XNL. Preparation I/O is reported separately
 * from page hydration; neither parsed bodies nor an on-disk index are retained. */
export function createLocalHistoryRecordIndex() {
  type Slot = {
    signature: string;
    entryCount: number;
    preparation: Promise<PreparedLocalHistoryRecordIndex>;
    prepared?: PreparedLocalHistoryRecordIndex;
  };
  const sources = new Map<string, Slot>();
  let epoch = 0;

  async function scan(filePath: string, slot: Slot, identity: Awaited<ReturnType<typeof sourceIdentity>>) {
    const entries: LocalHistoryRecordIndexEntry[] = [];
    const generations = new Map<string, ConversationHistoryLineageEnvelope>();
    let afterOffset = 0;
    let observedBytes = 0;
    do {
      if (sources.get(filePath) !== slot) throw new LocalHistoryIndexError("preparation_invalidated");
      const page = await readXnlRecordPage({
        filePath, tags: ["HistoryMessage", "history-generation"], afterOffset, limit: 64,
        maxObservedBytes: SCAN_BATCH_BYTES,
      });
      observedBytes += page.observedBytes;
      if (sources.get(filePath) !== slot) throw new LocalHistoryIndexError("preparation_invalidated");
      if (!page.exists || page.fileSize !== identity.sourceBytes) {
        throw new LocalHistoryIndexError("source_changed");
      }
      if (page.oversizedRecord) throw new LocalHistoryIndexError("record_exceeds_budget");
      for (const entry of page.records) {
        if ([...sources.values()].reduce((count, source) => count + source.entryCount, 0) >= MAX_ENTRIES) {
          throw new LocalHistoryIndexError("metadata_limit_exceeded");
        }
        const metadata = entry.record.metadata;
        const envelope = entry.record.tag === "history-generation"
          ? historyGenerationXnlRecordToData(entry.record)
          : { ...(entry.record.attributes.generation as Record<string, unknown> | undefined), ...metadata };
        if (envelope?.predecessorGenerationIds != null && !Array.isArray(envelope.predecessorGenerationIds)) {
          throw new LocalHistoryIndexError("lineage_metadata_conflict");
        }
        if (envelope && typeof envelope.sessionId === "string" && typeof envelope.actorId === "string"
          && typeof envelope.actorKey === "string" && typeof envelope.generationId === "string"
          && Array.isArray(envelope.predecessorGenerationIds)) {
          if (envelope.predecessorGenerationIds.some(id => typeof id !== "string")) {
            throw new LocalHistoryIndexError("lineage_metadata_conflict");
          }
          if (envelope.predecessorGenerationIds.length > MAX_ENTRIES) {
            throw new LocalHistoryIndexError("metadata_limit_exceeded");
          }
          const candidate: ConversationHistoryLineageEnvelope = {
            sessionId: boundedIdentity(envelope.sessionId), actorId: boundedIdentity(envelope.actorId),
            actorKey: boundedIdentity(envelope.actorKey), generationId: boundedIdentity(envelope.generationId),
            predecessorGenerationIds: envelope.predecessorGenerationIds.map(boundedIdentity),
          };
          const key = JSON.stringify([candidate.actorKey, candidate.generationId]);
          const existing = generations.get(key);
          if (existing && JSON.stringify(existing) !== JSON.stringify(candidate)) {
            throw new LocalHistoryIndexError("lineage_metadata_conflict");
          }
          if (!existing) {
            const added = candidate.predecessorGenerationIds.length + 1;
            if ([...sources.values()].reduce((count, source) => count + source.entryCount, 0) + added > MAX_ENTRIES) {
              throw new LocalHistoryIndexError("metadata_limit_exceeded");
            }
            slot.entryCount += added;
            Object.freeze(candidate.predecessorGenerationIds);
            generations.set(key, Object.freeze(candidate));
          }
        }
        if (entry.record.tag !== "HistoryMessage") continue;
        if ([...sources.values()].reduce((count, source) => count + source.entryCount, 0) >= MAX_ENTRIES) {
          throw new LocalHistoryIndexError("metadata_limit_exceeded");
        }
        const recordId = boundedIdentity(metadata.id);
        const hasMessageId = typeof metadata.messageId === "string" && metadata.messageId.length > 0;
        const sequence = metadata.sequence;
        entries.push(Object.freeze({
          actorKey: boundedIdentity(metadata.actorKey),
          createdReason: boundedIdentity(metadata.createdReason),
          generationId: boundedIdentity(metadata.generationId),
          recordId,
          messageId: hasMessageId ? boundedIdentity(metadata.messageId) : recordId,
          hasMessageId,
          ...(typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0 ? { sequence } : {}),
          startOffset: entry.startOffset,
          endOffset: entry.endOffset,
          physicalRevision: entries.length,
        }));
        slot.entryCount += 1;
      }
      // Yield even on the final batch so clear/eviction can invalidate completion.
      await setImmediate();
      if (sources.get(filePath) !== slot) throw new LocalHistoryIndexError("preparation_invalidated");
      if (!page.hasNextPage) break;
      if (page.nextOffset == null || page.nextOffset <= afterOffset) {
        throw new LocalHistoryIndexError("scan_did_not_advance");
      }
      afterOffset = page.nextOffset;
    } while (true);
    const finalIdentity = await sourceIdentity(filePath).catch((error) => {
      if (error?.code === "ENOENT") throw new LocalHistoryIndexError("source_changed");
      throw error;
    });
    if (finalIdentity.sourceSignature !== identity.sourceSignature) {
      throw new LocalHistoryIndexError("source_changed");
    }
    if (sources.get(filePath) !== slot) throw new LocalHistoryIndexError("preparation_invalidated");
    return Object.freeze({ ...identity, entries: Object.freeze(entries),
      generations: Object.freeze([...generations.values()]), observedBytes, cacheHit: false });
  }

  return {
    async getPrepared(inputPath: string): Promise<PreparedLocalHistoryRecordIndex | null> {
      const filePath = resolve(inputPath);
      const slot = sources.get(filePath);
      if (!slot?.prepared) return null;
      const identity = await sourceIdentity(filePath).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (sources.get(filePath) !== slot) return null;
      if (!identity || identity.sourceSignature !== slot.signature) {
        sources.delete(filePath);
        return null;
      }
      sources.delete(filePath);
      sources.set(filePath, slot);
      return { ...slot.prepared, observedBytes: 0, cacheHit: true };
    },
    async prepare(inputPath: string): Promise<PreparedLocalHistoryRecordIndex> {
      const filePath = resolve(inputPath);
      const requestedEpoch = epoch;
      const identity = await sourceIdentity(filePath);
      if (requestedEpoch !== epoch) throw new LocalHistoryIndexError("preparation_invalidated");
      const existing = sources.get(filePath);
      if (existing?.signature === identity.sourceSignature) {
        sources.delete(filePath);
        sources.set(filePath, existing);
        const prepared = await existing.preparation;
        return { ...prepared, observedBytes: 0, cacheHit: true };
      }
      sources.delete(filePath);
      while (sources.size >= MAX_SOURCES) sources.delete(sources.keys().next().value!);
      const slot: Slot = { signature: identity.sourceSignature, entryCount: 0, preparation: undefined! };
      sources.set(filePath, slot);
      slot.preparation = scan(filePath, slot, identity).then((prepared) => {
        if (sources.get(filePath) === slot) slot.prepared = prepared;
        return prepared;
      }).catch((error) => {
        if (sources.get(filePath) === slot) sources.delete(filePath);
        throw error;
      });
      return slot.preparation;
    },
    clear() {
      epoch += 1;
      sources.clear();
    },
  };
}
