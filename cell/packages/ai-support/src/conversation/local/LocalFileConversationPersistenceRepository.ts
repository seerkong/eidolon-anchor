import fs from "node:fs";
import readline from "node:readline";

import type {
  ActorHistoryGenerationData,
  ActorPromptGenerationData,
  ConversationArtifactRefsSnapshot,
  ConversationHistoryIndexSnapshot,
  ConversationPersistenceRepository,
  ConversationPersistenceRepositoryFactory,
  ConversationPromptIndexSnapshot,
  ConversationSessionIndexSnapshot,
} from "@cell/ai-organ-contract";
import { CONVERSATION_PERSISTENCE_SCHEMA_VERSION } from "@cell/ai-organ-contract";
import {
  appendXnlRecord,
  readXnlRecords,
  type XnlAppendDataRecordBody,
  type XnlDataRecordBodyItem,
  type XnlRecordBodyItem,
} from "@cell/ai-file-store-logic";
import {
  getLocalConversationPaths,
} from "./LocalConversationPaths";
import { readJsonBestEffort, writeJsonAtomically } from "./LocalConversationJson";

const HISTORY_GENERATION_RECORD_TAG = "history-generation";
const HISTORY_GENERATION_BODY_TAG = "generation";
const HISTORY_MESSAGE_RECORD_TAG = "HistoryMessage";
const PROMPT_GENERATION_RECORD_TAG = "PromptGeneration";
const LEGACY_PROMPT_GENERATION_RECORD_TAG = "prompt-generation";
const LEGACY_PROMPT_GENERATION_BODY_TAG = "generation";

type XnlConversationRecord = Awaited<ReturnType<typeof readXnlRecords>>[number];
type PromptBasisRef = NonNullable<ActorPromptGenerationData["basis"]["basisRefs"]>[number];

function isXnlDataRecordBodyItemWithTag(tag: string): (item: XnlRecordBodyItem) => item is XnlDataRecordBodyItem {
  return (item): item is XnlDataRecordBodyItem => item.kind === "data" && item.tag === tag;
}

const QUOTED_XNL_FIELD = /([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"/g;
const conversationXnlWriteQueues = new Map<string, Promise<unknown>>();

function zeroIso(): string {
  return new Date(0).toISOString();
}

function createDefaultHistoryIndex(sessionId: string): ConversationHistoryIndexSnapshot {
  return {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    heads: {},
    lineages: {},
    generations: {},
    updatedAt: zeroIso(),
  };
}

function createDefaultPromptIndex(sessionId: string): ConversationPromptIndexSnapshot {
  return {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    heads: {},
    generations: {},
    updatedAt: zeroIso(),
  };
}

function createDefaultSessionIndex(sessionId: string): ConversationSessionIndexSnapshot {
  return {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    session: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      activeActorKey: null,
      actorBindings: {},
      contextAssetRegistry: null,
      contextAssets: [],
      activeSelection: null,
      createdAt: zeroIso(),
      updatedAt: zeroIso(),
    },
    lineage: null,
    updatedAt: zeroIso(),
  };
}

function createDefaultArtifactRefs(sessionId: string): ConversationArtifactRefsSnapshot {
  return {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    refs: [],
    updatedAt: zeroIso(),
  };
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

function readQuotedXnlFields(line: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of line.matchAll(QUOTED_XNL_FIELD)) {
    fields[match[1]] = match[2];
  }
  return fields;
}

async function scanExistingHistoryRecordIds(params: {
  filePath: string;
  generationId: string;
}): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!fs.existsSync(params.filePath)) return ids;
  const lines = readline.createInterface({
    input: fs.createReadStream(params.filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (!line.startsWith(`<${HISTORY_MESSAGE_RECORD_TAG} `)) continue;
      const fields = readQuotedXnlFields(line);
      if (fields.generationId !== params.generationId || !fields.id) continue;
      ids.add(fields.id);
    }
  } finally {
    lines.close();
  }
  return ids;
}

async function scanExistingPromptGenerationIds(filePath: string): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!fs.existsSync(filePath)) return ids;
  const lines = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (!line.startsWith(`<${PROMPT_GENERATION_RECORD_TAG} `)) continue;
      const fields = readQuotedXnlFields(line);
      if (fields.id) ids.add(fields.id);
    }
  } finally {
    lines.close();
  }
  return ids;
}

async function queueConversationXnlWrite<T>(
  queueKey: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = conversationXnlWriteQueues.get(queueKey) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(action);
  conversationXnlWriteQueues.set(queueKey, next);
  try {
    return await next;
  } finally {
    if (conversationXnlWriteQueues.get(queueKey) === next) {
      conversationXnlWriteQueues.delete(queueKey);
    }
  }
}

function xnlRecordToHistoryGeneration(record: XnlConversationRecord): ActorHistoryGenerationData | null {
  const bodyItem = record.body.find((item) => item.kind === "data" && item.tag === HISTORY_GENERATION_BODY_TAG)
    ?? record.body.find((item) => item.kind === "data");
  if (!bodyItem || bodyItem.kind !== "data" || !bodyItem.attributes) return null;
  return bodyItem.attributes as ActorHistoryGenerationData;
}

function historyMessageRecordToCommittedMessage(
  record: XnlConversationRecord,
): ActorHistoryGenerationData["messages"][number] | null {
  const legacyMessage = record.attributes.message;
  const message = historyMessageRecordToMessage(record)
    ?? (legacyMessage && typeof legacyMessage === "object" && !Array.isArray(legacyMessage)
      ? legacyMessage as ActorHistoryGenerationData["messages"][number]["message"]
      : null);
  if (!message) return null;
  return {
    recordId: String(record.metadata.id ?? ""),
    actorKey: String(record.metadata.actorKey ?? ""),
    actorId: String(record.metadata.actorId ?? ""),
    committedAt: Number(record.metadata.committedAt ?? 0),
    message: message as ActorHistoryGenerationData["messages"][number]["message"],
    sourceRecords: Array.isArray(record.attributes.sourceRecords)
      ? record.attributes.sourceRecords as ActorHistoryGenerationData["messages"][number]["sourceRecords"]
      : undefined,
  };
}

function historyMessageRecordToMessage(
  record: XnlConversationRecord,
): ActorHistoryGenerationData["messages"][number]["message"] | null {
  const orderedBlocks = [...record.body]
    .filter((block) => block.kind === "text" || block.kind === "data")
    .sort((left, right) => Number(left.metadata?.index ?? 0) - Number(right.metadata?.index ?? 0));
  if (orderedBlocks.length === 0) return null;

  const role = String(record.metadata.role ?? "");
  if (!role) return null;
  const message: ActorHistoryGenerationData["messages"][number]["message"] = {
    role,
    content: "",
  };
  if (typeof record.metadata.name === "string") message.name = record.metadata.name;
  if (typeof record.metadata.startAt === "number") message.startAt = record.metadata.startAt;
  if (typeof record.metadata.endAt === "number") message.endAt = record.metadata.endAt;

  const contentParts: string[] = [];
  for (const block of orderedBlocks) {
    if (block.kind === "text" && block.tag === "Think") {
      message.reasoningContent = block.text;
      continue;
    }
    if (block.kind === "text" && block.tag === "Content") {
      contentParts.push(block.text);
      continue;
    }
    if (block.kind === "data" && block.tag === "ToolCall") {
      const toolCallId = String(block.metadata?.toolCallId ?? "");
      const name = String(block.metadata?.name ?? "");
      if (!toolCallId || !name) continue;
      message.toolCalls ??= [];
      message.toolCalls.push({
        id: toolCallId,
        name,
        input: block.attributes?.input && typeof block.attributes.input === "object" && !Array.isArray(block.attributes.input)
          ? block.attributes.input as Record<string, unknown>
          : {},
      });
      continue;
    }
    if (block.kind === "data" && block.tag === "ToolResult") {
      const toolCallId = String(block.metadata?.toolCallId ?? "");
      if (toolCallId) {
        message.toolCallId = toolCallId;
        const toolCallIdFields = String(block.metadata?.toolCallIdFields ?? "camel");
        if (toolCallIdFields === "snake" || toolCallIdFields === "both") message.tool_call_id = toolCallId;
      }
      const output = block.attributes?.output;
      if (output && typeof output === "object" && !Array.isArray(output)) {
        const text = (output as Record<string, unknown>).text;
        message.content = typeof text === "string" ? text : "";
      } else if (typeof output === "string") {
        message.content = output;
      }
    }
  }
  if (contentParts.length > 0) message.content = contentParts.join("");
  return message;
}

function historyMessageRecordsToGeneration(
  generationId: string,
  records: Awaited<ReturnType<typeof readXnlRecords>>,
): ActorHistoryGenerationData | null {
  const messageRecords = records
    .filter((record) => record.tag === HISTORY_MESSAGE_RECORD_TAG && record.metadata.generationId === generationId)
    .sort((left, right) => Number(left.metadata.sequence ?? 0) - Number(right.metadata.sequence ?? 0));
  if (messageRecords.length === 0) return null;
  const dedupedByRecordId = new Map<string, XnlConversationRecord>();
  for (const record of messageRecords) {
    const recordId = String(record.metadata.id ?? "");
    if (!recordId) continue;
    dedupedByRecordId.set(recordId, record);
  }
  const dedupedRecords = [...dedupedByRecordId.values()]
    .sort((left, right) => {
      const leftCommitted = Number(left.metadata.committedAt ?? left.metadata.sequence ?? 0);
      const rightCommitted = Number(right.metadata.committedAt ?? right.metadata.sequence ?? 0);
      if (leftCommitted !== rightCommitted) return leftCommitted - rightCommitted;
      return String(left.metadata.id ?? "").localeCompare(String(right.metadata.id ?? ""));
    });
  if (dedupedRecords.length === 0) return null;
  const generation = dedupedRecords[0].attributes.generation as Partial<ActorHistoryGenerationData> | undefined;
  const firstMetadata = dedupedRecords[0].metadata;
  const messages = dedupedRecords
    .map((record) => historyMessageRecordToCommittedMessage(record))
    .filter((message): message is ActorHistoryGenerationData["messages"][number] => Boolean(message));
  const parentGenerationId = generation?.parentGenerationId
    ?? (typeof firstMetadata.parentGenerationId === "string" ? firstMetadata.parentGenerationId : null);
  return {
    version: Number(generation?.version ?? CONVERSATION_PERSISTENCE_SCHEMA_VERSION),
    generationId,
    sessionId: String(generation?.sessionId ?? messageRecords[0].metadata.sessionId ?? ""),
    actorKey: String(generation?.actorKey ?? messageRecords[0].metadata.actorKey ?? ""),
    actorId: String(generation?.actorId ?? messageRecords[0].metadata.actorId ?? ""),
    parentGenerationId,
    predecessorGenerationIds: Array.isArray(firstMetadata.predecessorGenerationIds)
      ? firstMetadata.predecessorGenerationIds as string[]
      : Array.isArray(generation?.predecessorGenerationIds)
      ? generation.predecessorGenerationIds as string[]
      : [],
    createdReason: (generation?.createdReason ?? firstMetadata.createdReason ?? "append") as ActorHistoryGenerationData["createdReason"],
    sealed: Boolean(generation?.sealed ?? firstMetadata.sealed ?? false),
    messageCount: messages.length,
    messages,
    createdAt: String(generation?.createdAt ?? firstMetadata.generationCreatedAt ?? zeroIso()),
    updatedAt: String(generation?.updatedAt ?? firstMetadata.generationUpdatedAt ?? zeroIso()),
  };
}

function xnlRecordToLegacyPromptGeneration(record: XnlConversationRecord): ActorPromptGenerationData | null {
  const bodyItem = record.body.find((item) => item.kind === "data" && item.tag === LEGACY_PROMPT_GENERATION_BODY_TAG)
    ?? record.body.find((item) => item.kind === "data");
  if (!bodyItem || bodyItem.kind !== "data" || !bodyItem.attributes) return null;
  return bodyItem.attributes as ActorPromptGenerationData;
}

function xnlRecordToPromptGeneration(record: XnlConversationRecord): ActorPromptGenerationData | null {
  if (record.tag === LEGACY_PROMPT_GENERATION_RECORD_TAG) return xnlRecordToLegacyPromptGeneration(record);
  if (record.tag !== PROMPT_GENERATION_RECORD_TAG) return null;

  const basisNode = record.body.find((item) => item.kind === "data" && item.tag === "Basis");
  if (!basisNode || basisNode.kind !== "data") return null;
  const basisRefs = record.body
    .filter(isXnlDataRecordBodyItemWithTag("BasisRef"))
    .sort((left, right) => Number(left.metadata?.index ?? 0) - Number(right.metadata?.index ?? 0))
    .map((item) => ({
      refKind: String(item.metadata?.kind ?? "unknown") as PromptBasisRef["refKind"],
      refId: String(item.metadata?.refId ?? ""),
      metadata: item.attributes?.metadata as Record<string, unknown> | undefined,
    }));
  const transforms = record.body
    .filter(isXnlDataRecordBodyItemWithTag("Transform"))
    .sort((left, right) => Number(left.metadata?.index ?? 0) - Number(right.metadata?.index ?? 0))
    .map((item) => ({
      transformId: String(item.metadata?.id ?? ""),
      kind: String(item.metadata?.kind ?? "overlay") as ActorPromptGenerationData["transforms"][number]["kind"],
      payload: (item.attributes?.payload ?? {}) as Record<string, unknown>,
      appliedAt: String(item.metadata?.appliedAt ?? zeroIso()),
    }));
  const materializedContextNode = record.body.find((item) => item.kind === "text" && item.tag === "MaterializedContext");
  const materializedContext = materializedContextNode?.kind === "text"
    ? materializedContextNode.metadata?.blockText === true
      ? materializedContextNode.text.replace(/\n$/, "")
      : materializedContextNode.text
    : null;
  const basis: ActorPromptGenerationData["basis"] = {
    version: Number(basisNode.metadata?.version ?? CONVERSATION_PERSISTENCE_SCHEMA_VERSION),
    basisHistoryGenerationIds: Array.isArray(basisNode.attributes?.historyGenerationIds)
      ? basisNode.attributes.historyGenerationIds as string[]
      : [],
    basisMessageRecordIds: Array.isArray(basisNode.attributes?.messageRecordIds)
      ? basisNode.attributes.messageRecordIds as string[]
      : [],
  };
  if (basisRefs.length > 0) basis.basisRefs = basisRefs;

  const generation: ActorPromptGenerationData = {
    version: Number(record.metadata.version ?? CONVERSATION_PERSISTENCE_SCHEMA_VERSION),
    promptGenerationId: String(record.metadata.id ?? ""),
    sessionId: String(record.metadata.sessionId ?? ""),
    actorKey: String(record.metadata.actorKey ?? ""),
    actorId: String(record.metadata.actorId ?? ""),
    basis,
    transforms,
    materializedContext,
    sealed: Boolean(record.metadata.sealed ?? false),
    createdAt: String(record.metadata.createdAt ?? zeroIso()),
    updatedAt: String(record.metadata.updatedAt ?? zeroIso()),
  };
  if ("basedOnPromptGenerationId" in record.metadata) {
    generation.basedOnPromptGenerationId = record.metadata.basedOnPromptGenerationId as string | null;
  }
  if ("reason" in record.metadata) {
    generation.createdReason = record.metadata.reason as ActorPromptGenerationData["createdReason"];
  }
  if ("sealedAt" in record.metadata) {
    generation.sealedAt = record.metadata.sealedAt as string | null;
  }
  if ("metadata" in record.attributes) {
    generation.metadata = record.attributes.metadata as Record<string, unknown>;
  }
  return generation;
}

function createHistoryMessageBlocks(
  entry: ActorHistoryGenerationData["messages"][number],
): XnlAppendDataRecordBody {
  const blocks: XnlAppendDataRecordBody = [];
  const nextIndex = () => blocks.length;
  if (entry.message.reasoningContent) {
    blocks.push({
      kind: "text",
      tag: "Think",
      metadata: {
        id: `${entry.recordId}.b${nextIndex()}`,
        index: nextIndex(),
      },
      text: entry.message.reasoningContent,
    });
  }
  if (entry.message.content && entry.message.role !== "tool") {
    blocks.push({
      kind: "text",
      tag: "Content",
      metadata: {
        id: `${entry.recordId}.b${nextIndex()}`,
        index: nextIndex(),
      },
      text: entry.message.content,
    });
  }
  for (const toolCall of entry.message.toolCalls ?? []) {
    blocks.push({
      kind: "data",
      tag: "ToolCall",
      metadata: {
        id: `${entry.recordId}.b${nextIndex()}`,
        index: nextIndex(),
        toolCallId: toolCall.id,
        name: toolCall.name,
      },
      attributes: {
        input: toolCall.input,
      },
    });
  }
  const toolCallId = entry.message.toolCallId ?? entry.message.tool_call_id;
  if (entry.message.role === "tool" || toolCallId) {
    const toolCallIdFields = entry.message.toolCallId && entry.message.tool_call_id
      ? "both"
      : entry.message.tool_call_id ? "snake" : "camel";
    blocks.push({
      kind: "data",
      tag: "ToolResult",
      metadata: {
        id: `${entry.recordId}.b${nextIndex()}`,
        index: nextIndex(),
        toolCallId,
        toolCallIdFields,
      },
      attributes: {
        output: {
          kind: "text",
          text: entry.message.content,
        },
      },
    });
  }
  return blocks;
}

function createPromptGenerationBody(
  generation: ActorPromptGenerationData,
): XnlAppendDataRecordBody {
  const body: XnlAppendDataRecordBody = [
    {
      kind: "data",
      tag: "Basis",
      metadata: {
        version: generation.basis.version,
      },
      attributes: {
        historyGenerationIds: generation.basis.basisHistoryGenerationIds,
        messageRecordIds: generation.basis.basisMessageRecordIds,
      },
    },
  ];
  for (const [index, basisRef] of (generation.basis.basisRefs ?? []).entries()) {
    body.push({
      kind: "data",
      tag: "BasisRef",
      metadata: {
        index,
        kind: basisRef.refKind,
        refId: basisRef.refId,
      },
      attributes: basisRef.metadata ? { metadata: basisRef.metadata } : undefined,
    });
  }
  for (const [index, transform] of generation.transforms.entries()) {
    body.push({
      kind: "data",
      tag: "Transform",
      metadata: {
        id: transform.transformId,
        index,
        kind: transform.kind,
        appliedAt: transform.appliedAt,
      },
      attributes: {
        payload: transform.payload,
      },
    });
  }
  if (generation.materializedContext !== null && generation.materializedContext !== undefined) {
    const usesBlockText = generation.materializedContext.includes("\n");
    body.push({
      kind: "text",
      tag: "MaterializedContext",
      metadata: omitUndefined({
        id: `${generation.promptGenerationId}.ctx`,
        blockText: usesBlockText ? true : undefined,
      }),
      text: usesBlockText ? `\n${generation.materializedContext}\n` : generation.materializedContext,
    });
  }
  return body;
}

function promptGenerationMetadata(generation: ActorPromptGenerationData): Record<string, unknown> {
  return omitUndefined({
    version: generation.version,
    id: generation.promptGenerationId,
    sessionId: generation.sessionId,
    actorKey: generation.actorKey,
    actorId: generation.actorId,
    basedOnPromptGenerationId: generation.basedOnPromptGenerationId,
    reason: generation.createdReason,
    sealed: generation.sealed,
    createdAt: generation.createdAt,
    sealedAt: generation.sealedAt,
    updatedAt: generation.updatedAt,
  });
}

function promptGenerationAttributes(generation: ActorPromptGenerationData): Record<string, unknown> {
  return omitUndefined({
    authority: {
      kind: "audit",
      recoverable: true,
      cache: false,
    },
    metadata: generation.metadata,
  });
}

export class LocalFileConversationPersistenceRepository implements ConversationPersistenceRepository {
  readonly sessionDir: string;
  private readonly knownHistoryRecordIdsByGeneration = new Map<string, Set<string>>();
  private knownPromptGenerationIds: Set<string> | null = null;

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir;
  }

  async loadHistoryIndex(): Promise<ConversationHistoryIndexSnapshot> {
    const paths = getLocalConversationPaths(this.sessionDir);
    return await readJsonBestEffort(paths.historyIndexPath, createDefaultHistoryIndex(this.sessionDir));
  }

  async writeHistoryIndex(index: ConversationHistoryIndexSnapshot): Promise<void> {
    const paths = getLocalConversationPaths(this.sessionDir);
    await writeJsonAtomically(paths.historyIndexPath, index);
  }

  async loadHistoryGeneration(generationId: string): Promise<ActorHistoryGenerationData | null> {
    const paths = getLocalConversationPaths(this.sessionDir);
    const records = await readXnlRecords({
      filePath: paths.historyXnlPath,
    });
    const messageGeneration = historyMessageRecordsToGeneration(generationId, records);
    if (messageGeneration) {
      this.knownHistoryRecordIdsByGeneration.set(
        generationId,
        new Set(messageGeneration.messages.map((message) => message.recordId)),
      );
    }
    if (messageGeneration) return messageGeneration;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index].tag !== HISTORY_GENERATION_RECORD_TAG) continue;
      const generation = xnlRecordToHistoryGeneration(records[index]);
      if (generation?.generationId === generationId) return generation;
    }
    return null;
  }

  async writeHistoryGeneration(generation: ActorHistoryGenerationData): Promise<void> {
    const paths = getLocalConversationPaths(this.sessionDir);
    await queueConversationXnlWrite(`${paths.historyXnlPath}:${generation.generationId}`, async () => {
      const knownRecordIds = await scanExistingHistoryRecordIds({
        filePath: paths.historyXnlPath,
        generationId: generation.generationId,
      });
      this.knownHistoryRecordIdsByGeneration.set(generation.generationId, knownRecordIds);
      for (const [sequence, entry] of generation.messages.entries()) {
        if (knownRecordIds.has(entry.recordId)) continue;
        const blocks = createHistoryMessageBlocks(entry);
        await appendXnlRecord({
          filePath: paths.historyXnlPath,
          tag: HISTORY_MESSAGE_RECORD_TAG,
          metadata: {
            version: generation.version,
            id: entry.recordId,
            sessionId: generation.sessionId,
            actorKey: entry.actorKey,
            actorId: entry.actorId,
            role: entry.message.role,
            name: entry.message.name,
            startAt: entry.message.startAt,
            endAt: entry.message.endAt,
            committedAt: entry.committedAt,
            sequence,
            generationId: generation.generationId,
            parentGenerationId: generation.parentGenerationId ?? null,
            predecessorGenerationIds: generation.predecessorGenerationIds,
            createdReason: generation.createdReason,
            sealed: generation.sealed,
            messageCount: generation.messageCount,
            generationCreatedAt: generation.createdAt,
            generationUpdatedAt: generation.updatedAt,
            blockCount: blocks?.length ?? 0,
          },
          // Legacy transcript-shaped `sourceRecords` duplicate the same text already
          // stored in the block children, so they are intentionally not persisted.
          // The reader keeps accepting `sourceRecords` attributes from legacy records.
          body: blocks,
        });
        knownRecordIds.add(entry.recordId);
      }
    });
  }

  async listHistoryGenerationIds(): Promise<string[]> {
    const paths = getLocalConversationPaths(this.sessionDir);
    const generationIds = new Set<string>();
    const records = await readXnlRecords({
      filePath: paths.historyXnlPath,
    });
    for (const record of records) {
      if (record.tag === HISTORY_MESSAGE_RECORD_TAG && typeof record.metadata.generationId === "string") {
        generationIds.add(record.metadata.generationId);
        continue;
      }
      if (record.tag === HISTORY_GENERATION_RECORD_TAG) {
        const generation = xnlRecordToHistoryGeneration(record);
        if (generation?.generationId) generationIds.add(generation.generationId);
      }
    }
    return [...generationIds].sort((a, b) => a.localeCompare(b));
  }

  async loadPromptIndex(): Promise<ConversationPromptIndexSnapshot> {
    const paths = getLocalConversationPaths(this.sessionDir);
    return await readJsonBestEffort(paths.promptIndexPath, createDefaultPromptIndex(this.sessionDir));
  }

  async writePromptIndex(index: ConversationPromptIndexSnapshot): Promise<void> {
    const paths = getLocalConversationPaths(this.sessionDir);
    await writeJsonAtomically(paths.promptIndexPath, index);
  }

  async loadPromptGeneration(promptGenerationId: string): Promise<ActorPromptGenerationData | null> {
    const paths = getLocalConversationPaths(this.sessionDir);
    const records = [
      ...await readXnlRecords({
        filePath: paths.promptsXnlPath,
        tag: PROMPT_GENERATION_RECORD_TAG,
      }),
      ...await readXnlRecords({
        filePath: paths.promptsXnlPath,
        tag: LEGACY_PROMPT_GENERATION_RECORD_TAG,
      }),
    ];
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const generation = xnlRecordToPromptGeneration(records[index]);
      if (generation?.promptGenerationId === promptGenerationId) return generation;
    }
    return null;
  }

  async writePromptGeneration(generation: ActorPromptGenerationData): Promise<void> {
    const paths = getLocalConversationPaths(this.sessionDir);
    await queueConversationXnlWrite(paths.promptsXnlPath, async () => {
      this.knownPromptGenerationIds = await scanExistingPromptGenerationIds(paths.promptsXnlPath);
      if (this.knownPromptGenerationIds.has(generation.promptGenerationId)) return;
      await appendXnlRecord({
        filePath: paths.promptsXnlPath,
        tag: PROMPT_GENERATION_RECORD_TAG,
        metadata: promptGenerationMetadata(generation),
        attributes: promptGenerationAttributes(generation),
        body: createPromptGenerationBody(generation),
      });
      this.knownPromptGenerationIds.add(generation.promptGenerationId);
    });
  }

  async listPromptGenerationIds(): Promise<string[]> {
    const paths = getLocalConversationPaths(this.sessionDir);
    const generationIds = new Set<string>();
    const records = [
      ...await readXnlRecords({
        filePath: paths.promptsXnlPath,
        tag: PROMPT_GENERATION_RECORD_TAG,
      }),
      ...await readXnlRecords({
        filePath: paths.promptsXnlPath,
        tag: LEGACY_PROMPT_GENERATION_RECORD_TAG,
      }),
    ];
    for (const record of records) {
      const generation = xnlRecordToPromptGeneration(record);
      if (generation?.promptGenerationId) generationIds.add(generation.promptGenerationId);
    }
    return [...generationIds].sort((a, b) => a.localeCompare(b));
  }

  async loadSessionIndex(): Promise<ConversationSessionIndexSnapshot> {
    const paths = getLocalConversationPaths(this.sessionDir);
    return await readJsonBestEffort(paths.sessionIndexPath, createDefaultSessionIndex(this.sessionDir));
  }

  async writeSessionIndex(index: ConversationSessionIndexSnapshot): Promise<void> {
    const paths = getLocalConversationPaths(this.sessionDir);
    await writeJsonAtomically(paths.sessionIndexPath, index);
  }

  async loadArtifactRefs(): Promise<ConversationArtifactRefsSnapshot> {
    const paths = getLocalConversationPaths(this.sessionDir);
    return await readJsonBestEffort(paths.artifactRefsPath, createDefaultArtifactRefs(this.sessionDir));
  }

  async writeArtifactRefs(snapshot: ConversationArtifactRefsSnapshot): Promise<void> {
    const paths = getLocalConversationPaths(this.sessionDir);
    await writeJsonAtomically(paths.artifactRefsPath, snapshot);
  }
}

export const LocalFileConversationPersistenceRepositoryFactory: ConversationPersistenceRepositoryFactory = {
  createRepository(sessionDir: string) {
    return new LocalFileConversationPersistenceRepository(sessionDir);
  },
};
