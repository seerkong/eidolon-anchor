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
  v: 1;
  snapshotId: string;
  beforeOffset: number;
};

function encodeHistoryPageCursor(cursor: LocalHistoryPageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeHistoryPageCursor(value: string | null | undefined): LocalHistoryPageCursor | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<LocalHistoryPageCursor>;
    if (decoded.v !== 1 || typeof decoded.snapshotId !== "string"
      || !Number.isSafeInteger(decoded.beforeOffset) || Number(decoded.beforeOffset) < 0) return null;
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
export function createLocalFileConversationProjectionReadPort(): ConversationProjectionReadPort & Required<
  Pick<ConversationProjectionReadPort, "loadHistoryPageProjection">
> {
  return {
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
      let observedBytes = 0;
      let sourceBytes = 0;
      const boundedLookup = async (input: Parameters<typeof findBoundedXnlRecord>[0]) => {
        const remaining = MAX_HISTORY_PAGE_TOTAL_OBSERVED_BYTES - observedBytes;
        if (remaining <= 0) throw new Error("conversation_history_page_authority_exceeds_budget");
        const result = await findBoundedXnlRecord({ ...input, maxObservedBytes: remaining });
        observedBytes += result.observedBytes;
        sourceBytes = Math.max(sourceBytes, result.sourceBytes);
        return result.record;
      };
      const promptRecord = promptGenerationId
        ? await boundedLookup({
            filePath: paths.promptsXnlPath,
            tags: PROMPT_GENERATION_RECORD_TAGS,
            matches: (record) => {
              const generation = promptGenerationXnlRecordToData(record);
              return generation?.promptGenerationId === promptGenerationId;
            },
            maxObservedBytes: 0,
          })
        : null;
      const promptGeneration = promptRecord ? promptGenerationXnlRecordToData(promptRecord) : null;
      const promptTargetHistoryGenerationId = promptGeneration
        ? resolvePromptTargetHistoryGenerationId({
            promptGeneration,
            historyIndex,
            actorKey: target.actorKey,
          })
        : null;
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
      const targetHistoryRecord = promptTargetHistoryGenerationId
        ? await boundedLookup({
            filePath: paths.historyXnlPath,
            tags: [HISTORY_MESSAGE_RECORD_TAG, HISTORY_GENERATION_RECORD_TAG],
            matches: (record) => historyGenerationIdentity(record)?.generationId === promptTargetHistoryGenerationId,
            maxObservedBytes: 0,
          })
        : null;
      const declaredHistoryRecord = promptTargetHistoryGenerationId
        && declaredHistoryGenerationId
        && declaredHistoryGenerationId !== promptTargetHistoryGenerationId
        ? await boundedLookup({
            filePath: paths.historyXnlPath,
            tags: [HISTORY_MESSAGE_RECORD_TAG, HISTORY_GENERATION_RECORD_TAG],
            matches: (record) => historyGenerationIdentity(record)?.generationId === declaredHistoryGenerationId,
            maxObservedBytes: 0,
          })
        : promptTargetHistoryGenerationId ? targetHistoryRecord : null;
      const declaredReason = declaredHistoryRecord
        ? historyGenerationIdentity(declaredHistoryRecord)?.createdReason
        : null;
      const activeGenerationId = promptGeneration
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
      const decodedCursor = decodeHistoryPageCursor(query.before);
      const emptyPage = (status: "ok" | "stale_cursor", sourceBytes = 0): ConversationHistoryPageProjection => ({
        status,
        source: "empty",
        messages: [],
        pageInfo: {
          snapshotId,
          startCursor: null,
          hasPreviousPage: false,
        },
        historyGenerationId: activeGenerationId,
        promptGenerationId,
        observedBytes,
        sourceBytes,
      });
      if (query.before && (!decodedCursor || decodedCursor.snapshotId !== snapshotId)) {
        return emptyPage("stale_cursor");
      }
      if (!activeGenerationId || visibleGenerationIds.length === 0) return emptyPage("ok");
      if (observedBytes >= MAX_HISTORY_PAGE_TOTAL_OBSERVED_BYTES) {
        throw new Error("conversation_history_page_budget_exhausted_before_messages");
      }

      const filePath = paths.historyXnlPath;
      const visible = new Set(visibleGenerationIds);
      const limit = Math.min(MAX_HISTORY_PAGE_SIZE, Math.max(1, Math.floor(query.limit ?? DEFAULT_HISTORY_PAGE_SIZE)));
      let beforeOffset = decodedCursor?.beforeOffset;
      let hasPreviousPage = false;
      let continuationOffset = beforeOffset ?? null;
      const selected: Array<{ message: NonNullable<ReturnType<typeof historyMessageXnlRecordToChatMessage>>; startOffset: number }> = [];
      const identities = new Set<string>();

      while (selected.length < limit && observedBytes < MAX_HISTORY_PAGE_TOTAL_OBSERVED_BYTES) {
        const recordPage = await readXnlRecordPage({
          filePath,
          tags: HISTORY_MESSAGE_RECORD_TAG,
          beforeOffset,
          limit: Math.max(limit * 2, 64),
          maxObservedBytes: MAX_HISTORY_PAGE_TOTAL_OBSERVED_BYTES - observedBytes,
        });
        observedBytes += recordPage.observedBytes;
        sourceBytes = Math.max(sourceBytes, recordPage.fileSize);
        if (recordPage.oversizedRecord) {
          throw new Error("conversation_history_record_exceeds_page_budget");
        }
        hasPreviousPage = recordPage.hasPreviousPage;
        if (!recordPage.exists || recordPage.records.length === 0) break;

        for (let index = recordPage.records.length - 1; index >= 0 && selected.length < limit; index -= 1) {
          const entry = recordPage.records[index];
          const generationId = String(entry.record.metadata.generationId ?? "");
          const recordId = String(entry.record.metadata.id ?? "");
          if (String(entry.record.metadata.actorKey ?? "") !== target.actorKey || !visible.has(generationId)) continue;
          const identity = `${generationId}:${recordId}`;
          if (identities.has(identity)) continue;
          const decoded = historyMessageXnlRecordToChatMessage(entry.record);
          if (!decoded) continue;
          identities.add(identity);
          selected.push({
            message: decoded.messageId ? decoded : { ...decoded, messageId: recordId || `history:${identity}` },
            startOffset: entry.startOffset,
          });
        }

        const oldestSelectedOffset = selected.at(-1)?.startOffset;
        if (oldestSelectedOffset !== undefined && recordPage.records.some((entry) => {
          if (entry.startOffset >= oldestSelectedOffset) return false;
          const generationId = String(entry.record.metadata.generationId ?? "");
          return String(entry.record.metadata.actorKey ?? "") === target.actorKey && visible.has(generationId);
        })) {
          hasPreviousPage = true;
        }

        const nextOffset = recordPage.previousOffset;
        continuationOffset = nextOffset;
        if (nextOffset == null || nextOffset <= 0 || nextOffset === beforeOffset) {
          hasPreviousPage = false;
          break;
        }
        beforeOffset = nextOffset;
        if (!recordPage.hasPreviousPage) break;
      }

      const chronological = selected.reverse();
      const oldestOffset = chronological[0]?.startOffset ?? continuationOffset ?? beforeOffset ?? 0;
      const mayHaveEarlierVisibleRecords = hasPreviousPage || (chronological.length === limit && oldestOffset > 0);
      const startCursor = mayHaveEarlierVisibleRecords && oldestOffset > 0
        ? encodeHistoryPageCursor({ v: 1, snapshotId, beforeOffset: oldestOffset })
        : null;
      return {
        status: "ok",
        source: chronological.length > 0 ? "conversation" : "empty",
        messages: chronological.map((entry) => entry.message),
        pageInfo: {
          snapshotId,
          startCursor,
          hasPreviousPage: Boolean(startCursor),
        },
        historyGenerationId: activeGenerationId,
        promptGenerationId,
        observedBytes,
        sourceBytes,
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
