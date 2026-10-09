import { open, stat } from "node:fs/promises";
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
  role?: string;
  name?: string;
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

const RECORD_START_MARKERS = ["\n<HistoryMessage ", "\n<history-generation "].map(value => Buffer.from(value));
const HEADER_READ_LIMIT = 64 * 1024;

function readHeaderAttribute(header: string, name: string): string | undefined {
  const key = `${name}=`;
  const at = header.indexOf(key);
  if (at < 0) return undefined;
  let index = at + key.length;
  const quote = header[index];
  if (quote === "\"" || quote === "'") {
    const end = header.indexOf(quote, index + 1);
    return end < 0 ? undefined : header.slice(index + 1, end);
  }
  if (quote === "[") {
    const end = header.indexOf("]", index);
    return end < 0 ? undefined : header.slice(index, end + 1);
  }
  const end = header.slice(index).search(/[\s>]/);
  const raw = end < 0 ? header.slice(index) : header.slice(index, index + end);
  return raw === "undefined" || raw === "null" || raw.length === 0 ? undefined : raw;
}

/** The next line-start record, or the file end. Does not retain the skipped body. */
async function findNextRecordStart(filePath: string, startOffset: number, fileSize: number): Promise<number> {
  const handle = await open(filePath, "r");
  try {
    let offset = startOffset;
    let carry = Buffer.alloc(0);
    while (offset < fileSize) {
      const length = Math.min(1024 * 1024, fileSize - offset);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, offset);
      if (bytesRead === 0) break;
      const data = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      const base = offset - carry.length;
      let found = -1;
      for (const marker of RECORD_START_MARKERS) {
        let from = 0;
        while (from < data.length) {
          const pos = data.indexOf(marker, from);
          if (pos < 0) break;
          const absolute = base + pos + 1;
          if (absolute > startOffset) found = found < 0 ? absolute : Math.min(found, absolute);
          from = pos + 1;
        }
      }
      if (found >= 0) return found;
      carry = data.subarray(Math.max(0, data.length - RECORD_START_MARKERS[0]!.length));
      offset += bytesRead;
    }
    return fileSize;
  } finally {
    await handle.close();
  }
}

async function readOpeningHeader(filePath: string, startOffset: number, endOffset: number): Promise<string> {
  const length = Math.min(HEADER_READ_LIMIT, Math.max(0, endOffset - startOffset));
  if (length === 0) return "";
  const handle = await open(filePath, "r");
  try {
    const bytes = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(bytes, 0, length, startOffset);
    const text = bytes.subarray(0, bytesRead).toString("utf8");
    const close = text.indexOf(">");
    return close < 0 ? text : text.slice(0, close + 1);
  } finally {
    await handle.close();
  }
}
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
    const rememberGeneration = (sessionId?: string, actorId?: string, actorKey?: string,
      generationId?: string, predecessors?: string) => {
      if (!sessionId || !actorId || !actorKey || !generationId || predecessors == null) return;
      let predecessorGenerationIds: unknown;
      try { predecessorGenerationIds = JSON.parse(predecessors); } catch { return; }
      if (!Array.isArray(predecessorGenerationIds) || predecessorGenerationIds.some(id => typeof id !== "string")) {
        throw new LocalHistoryIndexError("lineage_metadata_conflict");
      }
      if (predecessorGenerationIds.length > MAX_ENTRIES) throw new LocalHistoryIndexError("metadata_limit_exceeded");
      const candidate: ConversationHistoryLineageEnvelope = {
        sessionId: boundedIdentity(sessionId), actorId: boundedIdentity(actorId),
        actorKey: boundedIdentity(actorKey), generationId: boundedIdentity(generationId),
        predecessorGenerationIds: predecessorGenerationIds.map(boundedIdentity),
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
    };
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
          ...(typeof metadata.role === "string" ? { role: boundedIdentity(metadata.role) } : {}),
          ...(typeof metadata.name === "string" ? { name: boundedIdentity(metadata.name) } : {}),
          startOffset: entry.startOffset,
          endOffset: entry.endOffset,
          physicalRevision: entries.length,
        }));
        slot.entryCount += 1;
      }
      if (page.oversizedRecord) {
        // A single body larger than the scan batch must not hide the rest of
        // the history. Index the opening tag and resume after the record.
        const resumeFrom = page.records.at(-1)?.endOffset ?? afterOffset;
        const next = await findNextRecordStart(filePath, resumeFrom, identity.sourceBytes);
        if (next > resumeFrom) {
          const header = await readOpeningHeader(filePath, resumeFrom, next);
          rememberGeneration(readHeaderAttribute(header, "sessionId"), readHeaderAttribute(header, "actorId"),
            readHeaderAttribute(header, "actorKey"), readHeaderAttribute(header, "generationId"),
            readHeaderAttribute(header, "predecessorGenerationIds"));
          if (header.includes("<HistoryMessage")) {
            const recordId = boundedIdentity(readHeaderAttribute(header, "id") ?? `oversized:${resumeFrom}`);
            const messageId = readHeaderAttribute(header, "messageId");
            const sequence = Number(readHeaderAttribute(header, "sequence"));
            const role = readHeaderAttribute(header, "role");
            const name = readHeaderAttribute(header, "name");
            entries.push(Object.freeze({
              actorKey: boundedIdentity(readHeaderAttribute(header, "actorKey") ?? ""),
              createdReason: boundedIdentity(readHeaderAttribute(header, "createdReason") ?? ""),
              generationId: boundedIdentity(readHeaderAttribute(header, "generationId") ?? ""),
              recordId,
              messageId: messageId ? boundedIdentity(messageId) : recordId,
              hasMessageId: Boolean(messageId),
              ...(Number.isSafeInteger(sequence) && sequence >= 0 ? { sequence } : {}),
              ...(role ? { role: boundedIdentity(role) } : {}),
              ...(name ? { name: boundedIdentity(name) } : {}),
              startOffset: resumeFrom,
              endOffset: next,
              physicalRevision: entries.length,
            }));
            slot.entryCount += 1;
          }
          afterOffset = next;
          if (afterOffset < identity.sourceBytes) continue;
        }
        break;
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
