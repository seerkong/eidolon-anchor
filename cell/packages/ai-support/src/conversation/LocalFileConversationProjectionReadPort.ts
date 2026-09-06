/**
 * LocalFileConversationProjectionReadPort — the single-source-backed
 * implementation of the read-only `ConversationProjectionReadPort` contract
 * (track isolate-runtime-projection-surfaces, P1, behavior-delta requirement
 * `conversation-projection-read-port`).
 *
 * SINGLE SOURCE, NO LOADER DUPLICATION
 * ------------------------------------
 * This impl delegates to the SAME single-source loaders the persistence
 * backplane recovery read port (`RuntimeRecoveryReadPort.loadConversationSource`
 * in @cell/ai-organ-logic) reads through:
 *
 *   - conversation facts → `loadConversationSessionRawState` /
 *     `loadConversationActorRawState` / `loadConversationHistoryMessages`
 *     (all in `./local/LocalConversationRuntime`), backed by the
 *     `LocalFileConversationPersistenceRepository` (the conversation files —
 *     the single recovery source).
 *   - pending questions → the `LocalFileRuntimeSnapshotRepository`'s
 *     `readQuestionnaires()` (the single `runtime_state/questionnaires.xnl`
 *     source), NOT a second raw `readFile` of the file.
 *
 * It does NOT copy the byte-I/O / parse logic and it does NOT introduce a second
 * source. There is exactly one repository construction, OWNED HERE so callers
 * (surfaces) no longer build their own — that is the whole point of the seam:
 * the single-source policy lives in the port, not in the surface.
 *
 * MISSING-SOURCE SEMANTICS
 * ------------------------
 * A declared-but-unloadable source is surfaced with the established loader
 * semantics: `loadHistoryProjection` and `loadActorProjection` return the
 * loader's empty/`null` result when the surface previously did `.catch(() =>
 * ...)` on a missing source, keeping P2 behavior-equivalent; the single-source
 * discipline (no mixing) lives in the underlying loaders. The pending-questions
 * read returns an empty projection when the questionnaires file is absent,
 * matching the surface's prior `.catch(() => "")` on the raw read.
 */
import type {
  ConversationActorProjection,
  ConversationHistoryProjection,
  ConversationHistoryPageProjection,
  ConversationHistoryPageQuery,
  ConversationHistorySummaryProjection,
  ConversationProjectionReadPort,
  ConversationProjectionTarget,
  ConversationSessionProjection,
  ConversationSessionProjectionTarget,
  PendingQuestionsProjection,
} from "@cell/ai-core-contract/runtime/ConversationProjectionReadPort";
import { projectInputContentText, type InputContentPart } from "@shared/composer";
import path from "node:path";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { projectVisibleHistoryIdentities } from "@cell/ai-persistence-logic/ConversationProjection";
import { resolveConversationHistoryLineage } from "@cell/ai-persistence-logic/ConversationHistoryLineage";
import { createLocalHistoryRecordIndex } from "./LocalHistoryRecordIndex";
import {
  buildVisibleGenerationOrder,
  loadConversationActorRawState,
  loadConversationHistoryMessages,
  loadConversationSessionRawState,
  resolvePromptTargetHistoryGenerationId,
} from "./local/LocalConversationRuntime";
import { getLocalConversationPaths } from "./local/LocalConversationPaths";
import {
  historyMessageXnlRecordToChatMessage,
  historyGenerationXnlRecordToData,
  LocalFileConversationPersistenceRepositoryFactory,
  promptGenerationXnlRecordToData,
} from "./local/LocalFileConversationPersistenceRepository";
import { LocalFileRuntimeSnapshotRepositoryFactory } from "../runtime/LocalFileRuntimeSnapshotRepository";
import { readXnlEdgeRecords, readXnlRecordPage, type XnlStreamRecord } from "@cell/ai-file-store-logic";

const HISTORY_MESSAGE_RECORD_TAG = "HistoryMessage";
const HISTORY_GENERATION_RECORD_TAG = "history-generation";
const PROMPT_GENERATION_RECORD_TAGS = ["PromptGeneration", "prompt-generation"] as const;
const DEFAULT_HISTORY_PAGE_SIZE = 40;
const MAX_HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGE_TOTAL_OBSERVED_BYTES = 8 * 1024 * 1024;

async function findBoundedXnlRecord(input: {
  filePath: string;
  tags: readonly string[];
  matches: (record: XnlStreamRecord) => boolean;
  maxObservedBytes: number;
}): Promise<{ record: XnlStreamRecord | null; observedBytes: number; sourceBytes: number }> {
  let beforeOffset: number | undefined;
  let observedBytes = 0;
  let sourceBytes = 0;
  while (observedBytes < input.maxObservedBytes) {
    const page = await readXnlRecordPage({
      filePath: input.filePath,
      tags: input.tags,
      beforeOffset,
      limit: 64,
      maxObservedBytes: input.maxObservedBytes - observedBytes,
    });
    observedBytes += page.observedBytes;
    sourceBytes = page.fileSize;
    if (page.oversizedRecord) throw new Error("conversation_history_page_authority_exceeds_budget");
    const record = [...page.records].reverse().find((entry) => input.matches(entry.record))?.record ?? null;
    if (record) return { record, observedBytes, sourceBytes };
    if (!page.hasPreviousPage || page.previousOffset == null || page.previousOffset === beforeOffset) {
      return { record: null, observedBytes, sourceBytes };
    }
    beforeOffset = page.previousOffset;
  }
  throw new Error("conversation_history_page_authority_exceeds_budget");
}

type LocalHistoryPageCursor = {
  v: 2;
  snapshotId: string;
  position: number;
};

function encodeHistoryPageCursor(cursor: LocalHistoryPageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeHistoryPageCursor(value: string | null | undefined): LocalHistoryPageCursor | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<LocalHistoryPageCursor>;
    if (decoded.v !== 2 || typeof decoded.snapshotId !== "string"
      || !Number.isSafeInteger(decoded.position) || Number(decoded.position) < 0) return null;
    return decoded as LocalHistoryPageCursor;
  } catch {
    return null;
  }
}

function historySnapshotId(input: {
  sessionId: string;
  actorKey: string;
  historyIndexUpdatedAt: string;
  sessionIndexUpdatedAt: string;
  activeGenerationId: string | null;
  visibleGenerationIds: readonly string[];
  promptGenerationId: string | null;
}): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex")}`;
}

function historyRecordPreviewText(record: XnlStreamRecord): string {
  const blocks = [...record.body]
    .filter((block) => block.kind === "text" || block.kind === "data")
    .sort((left, right) => Number(left.metadata?.index ?? 0) - Number(right.metadata?.index ?? 0));
  const content: string[] = [];
  let reasoning = "";
  for (const block of blocks) {
    if (block.kind === "text" && block.tag === "Content") content.push(block.text);
    if (block.kind === "data" && block.tag === "Content" && typeof block.attributes?.text === "string") {
      content.push(block.attributes.text);
    }
    if (block.kind === "data" && block.tag === "StructuredContent" && Array.isArray(block.attributes?.parts)) {
      content.push(projectInputContentText(block.attributes.parts as InputContentPart[]));
    }
    if (block.kind === "data" && block.tag === "ToolResult") {
      const output = block.attributes?.output;
      if (typeof output === "string") content.push(output);
      if (output && typeof output === "object" && !Array.isArray(output)) {
        const text = (output as Record<string, unknown>).text;
        if (typeof text === "string") content.push(text);
      }
    }
    if (block.kind === "text" && block.tag === "Think") reasoning += block.text;
    if (block.kind === "data" && block.tag === "Think" && typeof block.attributes?.text === "string") {
      reasoning += block.attributes.text;
    }
  }
  return content.join("").trim() || reasoning.trim();
}

function historySummaryProjectionFromRecords(input: {
  initialRecords: ReadonlyArray<XnlStreamRecord>;
  latestRecords: ReadonlyArray<XnlStreamRecord>;
  actorKey: string;
  visibleGenerationIds: readonly string[];
  observedBytes: number;
  sourceBytes: number;
}): ConversationHistorySummaryProjection {
  const generationOrder = new Map(input.visibleGenerationIds.map((generationId, index) => [generationId, index]));
  const initialRecords = input.initialRecords.filter((record) => (
    record.tag === HISTORY_MESSAGE_RECORD_TAG
    && String(record.metadata.actorKey ?? "") === input.actorKey
  ));
  const dedupedLatest = new Map<string, XnlStreamRecord>();
  for (const record of input.latestRecords) {
    const generationId = String(record.metadata.generationId ?? "");
    if (record.tag !== HISTORY_MESSAGE_RECORD_TAG
      || String(record.metadata.actorKey ?? "") !== input.actorKey
      || !generationOrder.has(generationId)) continue;
    dedupedLatest.set(String(record.metadata.id ?? `${generationId}:${record.metadata.sequence ?? ""}`), record);
  }
  const latestRecords = [...dedupedLatest.values()].sort((left, right) => {
    const generationDifference = Number(generationOrder.get(String(left.metadata.generationId)) ?? 0)
      - Number(generationOrder.get(String(right.metadata.generationId)) ?? 0);
    if (generationDifference !== 0) return generationDifference;
    return Number(left.metadata.sequence ?? 0) - Number(right.metadata.sequence ?? 0);
  });
  const firstUser = initialRecords.find((record) => (
    record.metadata.role === "user" && Boolean(historyRecordPreviewText(record))
  ));
  const firstDisplayable = firstUser ?? initialRecords.find((record) => Boolean(historyRecordPreviewText(record)));
  const latestDisplayable = [...latestRecords].reverse().find((record) => Boolean(historyRecordPreviewText(record)));
  const initialUserMessage = firstDisplayable ? historyRecordPreviewText(firstDisplayable) : undefined;
  const latestMessage = latestDisplayable ? historyRecordPreviewText(latestDisplayable) : undefined;
  return {
    source: initialUserMessage || latestMessage ? "conversation" : "empty",
    initialUserMessage,
    latestMessage,
    observedBytes: input.observedBytes,
    sourceBytes: input.sourceBytes,
  };
}

async function resolveRootConversationSessionDir(sessionDir: string): Promise<string> {
  let current = sessionDir;
  const visited = new Set<string>();
  for (let depth = 0; depth < 32 && !visited.has(current); depth += 1) {
    visited.add(current);
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(current);
    const index = await repository.loadSessionIndex();
    const parentSessionId = index.lineage?.parentSessionId;
    if (!parentSessionId) return current;
    current = path.join(path.dirname(current), parentSessionId);
  }
  return current;
}

/**
 * A `ConversationProjectionReadPort` backed by the local-file single source.
 *
 * The repository is constructed INTERNALLY per read (the same cheap
 * `createRepository(sessionDir)` the surface used to call itself), so the
 * surface no longer constructs one and there is no second source path.
 */
export function createLocalFileConversationProjectionReadPort(options: { signal?: AbortSignal } = {}): ConversationProjectionReadPort & Required<
  Pick<ConversationProjectionReadPort, "loadHistoryPageProjection" | "loadHistoryPageIndexProjection">
> {
  const recordIndex = createLocalHistoryRecordIndex();
  const promptWitnesses = new Map<string, { exists: boolean; target: string | null }>();
  options.signal?.addEventListener("abort", () => { recordIndex.clear(); promptWitnesses.clear(); }, { once: true });
  return {
    async loadHistoryPageIndexProjection(target) {
      options.signal?.throwIfAborted();
      try {
        const prepared = await recordIndex.prepare(getLocalConversationPaths(target.sessionDir).historyXnlPath);
        return { observedBytes: prepared.observedBytes, sourceBytes: prepared.sourceBytes,
          recordCount: prepared.entries.length, cacheHit: prepared.cacheHit };
      } catch (error: any) {
        if (error?.code === "ENOENT") return { observedBytes: 0, sourceBytes: 0, recordCount: 0, cacheHit: false };
        throw error;
      }
    },
    async loadHistoryProjection(
      target: ConversationProjectionTarget,
    ): Promise<ConversationHistoryProjection> {
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(
        target.sessionDir,
      );
      const loaded = await loadConversationHistoryMessages({
        sessionDir: target.sessionDir,
        actorKey: target.actorKey,
        repository,
      });
      return {
        source: loaded.source,
        messages: loaded.messages,
        historyGenerationId: loaded.historyGenerationId ?? null,
        promptGenerationId: loaded.promptGenerationId ?? null,
      };
    },

    async loadHistoryPageProjection(
      target: ConversationProjectionTarget,
      query: ConversationHistoryPageQuery = {},
    ): Promise<ConversationHistoryPageProjection> {
      options.signal?.throwIfAborted();
      if (query.before != null && query.after != null) {
        throw new Error("conversation_history_page_conflicting_cursors");
      }
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(
        target.sessionDir,
      );
      const [historyIndex, promptIndex, sessionIndex] = await Promise.all([
        repository.loadHistoryIndex(),
        repository.loadPromptIndex(),
        repository.loadSessionIndex(),
      ]);
      const head = historyIndex.heads[target.actorKey];
      const actorBinding = sessionIndex.session.actorBindings[target.actorKey];
      const declaredHistoryGenerationId = actorBinding?.historyHeadGenerationId ?? head?.activeGenerationId ?? null;
      const promptGenerationId = actorBinding?.promptHeadGenerationId
        ?? promptIndex.heads[target.actorKey]?.activePromptGenerationId
        ?? null;
      const paths = getLocalConversationPaths(target.sessionDir);
      const authorityFingerprint = JSON.stringify([historyIndex, promptIndex, sessionIndex]);
      const authorityBytes = Buffer.byteLength(authorityFingerprint);
      let observedBytes = authorityBytes;
      let sourceBytes = 0;
      const boundedLookup = async (input: Parameters<typeof findBoundedXnlRecord>[0]) => {
        const remaining = MAX_HISTORY_PAGE_TOTAL_OBSERVED_BYTES - observedBytes;
        if (remaining <= 0) throw new Error("conversation_history_page_authority_exceeds_budget");
        const result = await findBoundedXnlRecord({ ...input, maxObservedBytes: remaining });
        observedBytes += result.observedBytes;
        sourceBytes = Math.max(sourceBytes, result.sourceBytes);
        return result.record;
      };
      const promptStat = promptGenerationId ? await stat(paths.promptsXnlPath).catch(() => null) : null;
      const promptSignature = promptStat
        ? [promptStat.dev, promptStat.ino, promptStat.size, promptStat.mtimeMs, promptStat.ctimeMs].join(":") : "absent";
      const witnessKey = createHash("sha256").update(JSON.stringify([
        paths.promptsXnlPath, target.actorKey, promptGenerationId, historyIndex, promptSignature,
      ])).digest("hex");
      let witness = promptWitnesses.get(witnessKey);
      if (!witness) {
        const promptRecord = promptGenerationId ? await boundedLookup({
          filePath: paths.promptsXnlPath, tags: PROMPT_GENERATION_RECORD_TAGS,
          matches: record => promptGenerationXnlRecordToData(record)?.promptGenerationId === promptGenerationId,
          maxObservedBytes: 0,
        }) : null;
        const promptGeneration = promptRecord ? promptGenerationXnlRecordToData(promptRecord) : null;
        witness = { exists: Boolean(promptGeneration), target: promptGeneration
          ? resolvePromptTargetHistoryGenerationId({ promptGeneration, historyIndex, actorKey: target.actorKey }) : null };
        options.signal?.throwIfAborted();
        if (promptWitnesses.size >= 2) promptWitnesses.delete(promptWitnesses.keys().next().value!);
        promptWitnesses.set(witnessKey, witness);
      }
      const promptTargetHistoryGenerationId = witness.target;
      const historyGenerationIdentity = (record: XnlStreamRecord) => {
        if (record.tag === HISTORY_MESSAGE_RECORD_TAG) {
          return {
            generationId: String(record.metadata.generationId ?? ""),
            createdReason: String(record.metadata.createdReason ?? ""),
          };
        }
        const generation = historyGenerationXnlRecordToData(record);
        return generation
          ? { generationId: generation.generationId, createdReason: generation.createdReason }
          : null;
      };
      const indexedHistory = await recordIndex.getPrepared(paths.historyXnlPath);
      const resolveHistoryIdentity = async (generationId: string) => {
        const indexed = indexedHistory?.entries.find(entry =>
          entry.actorKey === target.actorKey && entry.generationId === generationId);
        if (indexed) return { generationId, createdReason: indexed.createdReason };
        // Legacy generation envelopes may not contain individual message records.
        const record = await boundedLookup({
          filePath: paths.historyXnlPath,
          tags: [HISTORY_MESSAGE_RECORD_TAG, HISTORY_GENERATION_RECORD_TAG],
          matches: record => historyGenerationIdentity(record)?.generationId === generationId,
          maxObservedBytes: 0,
        });
        return record ? historyGenerationIdentity(record) : null;
      };
      const targetHistoryRecord = promptTargetHistoryGenerationId
        ? await resolveHistoryIdentity(promptTargetHistoryGenerationId) : null;
      const declaredHistoryRecord = promptTargetHistoryGenerationId && declaredHistoryGenerationId
        && declaredHistoryGenerationId !== promptTargetHistoryGenerationId
        ? await resolveHistoryIdentity(declaredHistoryGenerationId) : targetHistoryRecord;
      const declaredReason = declaredHistoryRecord?.createdReason ?? null;
      const activeGenerationId = witness.exists
        && targetHistoryRecord
        && declaredReason !== "compaction"
        ? promptTargetHistoryGenerationId
        : declaredHistoryGenerationId;
      const visibleGenerationIds = activeGenerationId
        ? buildVisibleGenerationOrder({ historyIndex, actorKey: target.actorKey, activeGenerationId })
        : [];
      const snapshotId = historySnapshotId({
        sessionId: sessionIndex.sessionId,
        actorKey: target.actorKey,
        historyIndexUpdatedAt: historyIndex.updatedAt,
        sessionIndexUpdatedAt: sessionIndex.updatedAt,
        activeGenerationId,
        visibleGenerationIds,
        promptGenerationId,
      });
      const emptyPage = (status: "ok" | "stale_cursor", snapshot = snapshotId): ConversationHistoryPageProjection => ({
        status, source: "empty", messages: [], historyGenerationId: activeGenerationId, promptGenerationId,
        pageInfo: { snapshotId: snapshot, startCursor: null, hasPreviousPage: false, endCursor: null, hasNextPage: false },
        observedBytes, sourceBytes,
      });
      if (!activeGenerationId || visibleGenerationIds.length === 0) {
        return emptyPage(query.before != null || query.after != null ? "stale_cursor" : "ok");
      }

      const filePath = paths.historyXnlPath;
      let prepared = await recordIndex.getPrepared(filePath);
      if (!prepared) {
        // Preserve inline preparation for small callers, charging every byte to
        // this page. Large sources require the explicit, measured preparation view.
        const size = (await stat(filePath)).size;
        if (size > (MAX_HISTORY_PAGE_TOTAL_OBSERVED_BYTES - observedBytes) / 2) {
          throw new Error("conversation_history_page_index_prepare_required");
        }
        prepared = await recordIndex.prepare(filePath);
        observedBytes += prepared.observedBytes;
      }
      sourceBytes = Math.max(sourceBytes, prepared.sourceBytes);
      const snapshot = createHash("sha256").update(snapshotId + prepared.sourceSignature + promptSignature).digest("hex");
      const cursor = query.after ?? query.before;
      const decodedCursor = decodeHistoryPageCursor(cursor);
      if (cursor != null && (!decodedCursor || decodedCursor.snapshotId !== snapshot)) {
        return emptyPage("stale_cursor", snapshot);
      }
      const lineageEnvelopes = prepared.generations.filter(generation => generation.actorKey === target.actorKey);
      let orderedGenerationIds = visibleGenerationIds;
      for (const generation of lineageEnvelopes.filter(value => visibleGenerationIds.includes(value.generationId))) {
        const indexed = historyIndex.lineages[generation.generationId];
        if (generation.sessionId !== historyIndex.sessionId || generation.actorId !== (actorBinding?.actorId ?? head?.actorId)
          || (indexed && (indexed.sessionId !== generation.sessionId || indexed.actorKey !== generation.actorKey
            || indexed.actorId !== generation.actorId || indexed.generationId !== generation.generationId))) {
          throw new Error("conversation_history_page_lineage_identity_mismatch");
        }
        if (indexed && JSON.stringify(indexed.predecessorGenerationIds) !== JSON.stringify(generation.predecessorGenerationIds)) {
          throw new Error("conversation_history_page_lineage_lineage_conflict");
        }
      }
      // Modern committed records carry complete envelope authority even when
      // old index.lineages is empty. Legacy empty/envelope-less sources retain
      // their established index-only semantics; contradictory evidence never does.
      const visibleEnvelopeCount = lineageEnvelopes.filter(generation => visibleGenerationIds.includes(generation.generationId)).length;
      if (visibleEnvelopeCount > 0 && !visibleGenerationIds.every(id => lineageEnvelopes.some(generation => generation.generationId === id))) {
        throw new Error("conversation_history_page_lineage_missing_generation");
      }
      if (visibleGenerationIds.every(id => lineageEnvelopes.some(generation => generation.generationId === id))) {
        const effectiveHead = head ? { ...head, activeGenerationId } : {
          actorKey: target.actorKey, actorId: actorBinding?.actorId ?? "",
          sessionId: historyIndex.sessionId, version: 1, updatedAt: historyIndex.updatedAt,
          activeGenerationId, visibleGenerationIds,
        };
        const lineage = resolveConversationHistoryLineage({ historyIndex: {
          // Provider handoff may select a different effective read head; retain
          // declared identity so a mismatch remains a rejection, not a repair.
          ...historyIndex, heads: { ...historyIndex.heads, [target.actorKey]: effectiveHead },
        }, actorKey: target.actorKey, activeGenerationId, historyGenerations: lineageEnvelopes });
        if (lineage.status === "rejected") throw new Error(`conversation_history_page_lineage_${lineage.reason}`);
        orderedGenerationIds = lineage.generationIds;
      }
      const generationOrder = new Map(orderedGenerationIds.map((id, index) => [id, index]));
      // Last physical revision wins within a generation, then canonical sequence
      // orders that generation. Logical identity is scoped to this actor/source.
      const records = new Map<string, typeof prepared.entries[number]>();
      for (const entry of prepared.entries) {
        if (entry.actorKey !== target.actorKey || !generationOrder.has(entry.generationId) || !entry.messageId) continue;
        records.set(JSON.stringify([entry.generationId, entry.recordId]), entry);
      }
      const ordered = [...records.values()].sort((a, b) =>
        generationOrder.get(a.generationId)! - generationOrder.get(b.generationId)!
        || (a.sequence ?? a.physicalRevision) - (b.sequence ?? b.physicalRevision)
        || a.recordId.localeCompare(b.recordId));
      const logical = projectVisibleHistoryIdentities(ordered.map(entry => ({
        id: entry.messageId, namespace: entry.hasMessageId ? "message" as const : "record" as const,
        order: [generationOrder.get(entry.generationId)!, entry.sequence ?? entry.physicalRevision] as const,
        value: entry,
      })));
      if (decodedCursor && decodedCursor.position > logical.length) return emptyPage("stale_cursor", snapshot);
      const limit = Math.min(MAX_HISTORY_PAGE_SIZE, Math.max(1, Math.floor(query.limit ?? DEFAULT_HISTORY_PAGE_SIZE)));
      const forward = query.after != null;
      const boundary = decodedCursor?.position ?? logical.length;
      const start = forward ? boundary : Math.max(0, boundary - limit);
      const end = forward ? Math.min(logical.length, start + limit) : boundary;
      const messages: NonNullable<ReturnType<typeof historyMessageXnlRecordToChatMessage>>[] = [];
      const messageOrder: Record<string, readonly [number, number]> = {};
      for (const row of logical.slice(start, end)) {
        options.signal?.throwIfAborted();
        const length = row.value.endOffset - row.value.startOffset;
        if (length > MAX_HISTORY_PAGE_TOTAL_OBSERVED_BYTES - observedBytes - authorityBytes) {
          throw new Error("conversation_history_record_exceeds_page_budget");
        }
        const page = await readXnlRecordPage({
          filePath, tags: HISTORY_MESSAGE_RECORD_TAG, afterOffset: row.value.startOffset,
          limit: 1, windowBytes: length, maxObservedBytes: length,
        });
        observedBytes += page.observedBytes;
        const entry = page.records[0];
        if (page.oversizedRecord || !entry || entry.startOffset !== row.value.startOffset || entry.endOffset !== row.value.endOffset) {
          return emptyPage("stale_cursor", snapshot);
        }
        const message = historyMessageXnlRecordToChatMessage(entry.record);
        if (!message) throw new Error("conversation_history_index_record_decode_failed");
        messages.push(message);
        messageOrder[row.id] = row.order;
      }
      if (!(await recordIndex.getPrepared(filePath))) return emptyPage("stale_cursor", snapshot);
      const finalAuthority = JSON.stringify(await Promise.all([
        repository.loadHistoryIndex(), repository.loadPromptIndex(), repository.loadSessionIndex(),
      ]));
      observedBytes += Buffer.byteLength(finalAuthority);
      if (observedBytes > MAX_HISTORY_PAGE_TOTAL_OBSERVED_BYTES) throw new Error("conversation_history_page_authority_exceeds_budget");
      if (finalAuthority !== authorityFingerprint) return emptyPage("stale_cursor", snapshot);
      const finalPromptStat = promptGenerationId ? await stat(paths.promptsXnlPath).catch(() => null) : null;
      const finalPromptSignature = finalPromptStat
        ? [finalPromptStat.dev, finalPromptStat.ino, finalPromptStat.size, finalPromptStat.mtimeMs, finalPromptStat.ctimeMs].join(":") : "absent";
      if (finalPromptSignature !== promptSignature) return emptyPage("stale_cursor", snapshot);
      options.signal?.throwIfAborted();
      return {
        status: "ok", source: messages.length ? "conversation" : "empty", messages, messageOrder,
        historyGenerationId: activeGenerationId, promptGenerationId, observedBytes, sourceBytes,
        pageInfo: {
          snapshotId: snapshot,
          startCursor: start > 0 ? encodeHistoryPageCursor({ v: 2, snapshotId: snapshot, position: start }) : null,
          hasPreviousPage: start > 0,
          endCursor: encodeHistoryPageCursor({ v: 2, snapshotId: snapshot, position: end }),
          hasNextPage: end < logical.length,
        },
      };
    },

    async loadHistorySummaryProjection(
      target: ConversationProjectionTarget,
    ): Promise<ConversationHistorySummaryProjection> {
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(
        target.sessionDir,
      );
      const historyIndex = await repository.loadHistoryIndex();
      const head = historyIndex.heads[target.actorKey];
      if (!head) return { source: "empty", observedBytes: 0, sourceBytes: 0 };
      const rootSessionDir = await resolveRootConversationSessionDir(target.sessionDir);
      const [currentEdges, rootEdges] = await Promise.all([
        readXnlEdgeRecords({
          filePath: getLocalConversationPaths(target.sessionDir).historyXnlPath,
          tags: HISTORY_MESSAGE_RECORD_TAG,
        }),
        rootSessionDir === target.sessionDir
          ? Promise.resolve(null)
          : readXnlEdgeRecords({
              filePath: getLocalConversationPaths(rootSessionDir).historyXnlPath,
              tags: HISTORY_MESSAGE_RECORD_TAG,
            }),
      ]);
      const initialEdges = rootEdges ?? currentEdges;
      return historySummaryProjectionFromRecords({
        initialRecords: initialEdges.head,
        latestRecords: currentEdges.tail,
        actorKey: target.actorKey,
        visibleGenerationIds: head.visibleGenerationIds,
        observedBytes: currentEdges.observedBytes + (rootEdges?.observedBytes ?? 0),
        sourceBytes: currentEdges.fileSize + (rootEdges?.fileSize ?? 0),
      });
    },

    async loadSessionProjection(
      target: ConversationSessionProjectionTarget,
    ): Promise<ConversationSessionProjection> {
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(
        target.sessionDir,
      );
      return await loadConversationSessionRawState({
        sessionDir: target.sessionDir,
        repository,
      });
    },

    async loadActorProjection(
      target: ConversationProjectionTarget,
    ): Promise<ConversationActorProjection> {
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(
        target.sessionDir,
      );
      return await loadConversationActorRawState({
        sessionDir: target.sessionDir,
        actorKey: target.actorKey,
        repository,
      });
    },

    async loadPendingQuestionsProjection(
      target: ConversationSessionProjectionTarget,
    ): Promise<PendingQuestionsProjection> {
      // Single source for runtime_state pending questions: the snapshot
      // repository's questionnaires file. `readQuestionnaires()` returns [] when
      // the file is absent — the same empty-on-missing semantics the surface had
      // when it raw-read `questionnaires.xnl` with `.catch(() => "")`.
      const snapshotRepository =
        LocalFileRuntimeSnapshotRepositoryFactory.createRuntimeSnapshotRepository(
          target.sessionDir,
        );
      const rows = await (snapshotRepository as typeof snapshotRepository & {
        readQuestionnaires(): Promise<import("@cell/ai-core-contract/runtime/Questionnaire").QuestionnaireRow[]>
      }).readQuestionnaires();
      return {
        rows: rows.filter((row) => row.status === "pending"),
      };
    },
  };
}
