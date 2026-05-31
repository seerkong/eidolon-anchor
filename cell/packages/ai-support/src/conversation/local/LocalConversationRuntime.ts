import path from "node:path";

import type { ChatMessage, ToolCall } from "@shared/composer";

import {
  CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
  type ActorCommittedMessageRef,
  type ConversationActorRawState,
  type ActorHistoryGenerationData,
  type ActorPromptGenerationData,
  type ConversationArtifactRef,
  type ConversationCommittedMessageData,
  type ConversationPersistenceRepository,
  type ConversationSessionRawState,
  type ConversationTranscriptSourceRecord,
} from "@cell/ai-organ-contract";
import {
  messagesToTranscriptRecords,
  reduceTranscriptToMessages,
} from "@cell/ai-core-logic/runtime/ActorTranscript";
import type { TranscriptRecord } from "@cell/symbiont-logic/stream/StreamTranscript";
import { getLocalHistoryGenerationPath } from "./LocalConversationPaths";

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    next.push(trimmed);
  }
  return next;
}

function makeGenerationId(actorKey: string, kind: "active" | "compact" | "prompt"): string {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${actorKey}__${kind}__${suffix}`;
}

function makeRecordId(prefix: string, index: number): string {
  return `${prefix}::${index}`;
}

function toCommittedToolCalls(toolCalls?: ToolCall[]): Array<{ id: string; name: string; input: Record<string, unknown> }> | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
  return toolCalls.map((toolCall) => ({
    id: String(toolCall.id ?? ""),
    name: String(toolCall.name ?? ""),
    input: toolCall.input ?? {},
  }));
}

function normalizeToolCallId(message: Pick<ChatMessage, "toolCallId" | "tool_call_id">): string | undefined {
  const value = message.toolCallId ?? message.tool_call_id;
  return typeof value === "string" && value ? value : undefined;
}

function normalizeCommittedToolCallId(message: Pick<ConversationCommittedMessageData, "toolCallId" | "tool_call_id">): string | undefined {
  const value = message.toolCallId ?? message.tool_call_id;
  return typeof value === "string" && value ? value : undefined;
}

function extractToolCallIdFromSourceRecords(records?: ConversationTranscriptSourceRecord[]): string | undefined {
  if (!Array.isArray(records)) return undefined;
  for (const record of records) {
    if (record?.stream !== "tool_call_result" && record?.stream !== "questionnaire_result") continue;
    try {
      const parsed = JSON.parse(record.payload) as { toolCallId?: unknown; id?: unknown };
      const value = parsed.toolCallId ?? parsed.id;
      if (typeof value === "string" && value) return value;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function toCommittedConversationMessage(message: ChatMessage): ConversationCommittedMessageData {
  const toolCallId = normalizeToolCallId(message);
  return {
    role: message.role,
    name: message.name,
    content: String(message.content ?? ""),
    reasoningContent: message.reasoning_content,
    ...(typeof message.startAt === "number" ? { startAt: message.startAt } : {}),
    ...(typeof message.endAt === "number" ? { endAt: message.endAt } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    toolCalls: toCommittedToolCalls(message.toolCalls ?? message.rawToolCalls),
  };
}

export function fromCommittedConversationMessage(message: ConversationCommittedMessageData): ChatMessage {
  const toolCalls = Array.isArray(message.toolCalls)
    ? message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
      }))
    : undefined;

  const toolCallId = normalizeCommittedToolCallId(message);
  return {
    role: (message.role as ChatMessage["role"]) ?? "assistant",
    name: message.name,
    content: String(message.content ?? ""),
    reasoning_content: message.reasoningContent,
    ...(typeof message.startAt === "number" ? { startAt: message.startAt } : {}),
    ...(typeof message.endAt === "number" ? { endAt: message.endAt } : {}),
    ...(toolCallId ? { toolCallId, tool_call_id: toolCallId } : {}),
    toolCalls,
    rawToolCalls: toolCalls,
    rawToolCallsStr: toolCalls ? JSON.stringify(toolCalls) : undefined,
  };
}

function fromCommittedHistoryRef(message: ActorCommittedMessageRef): ChatMessage {
  const restored = fromCommittedConversationMessage(message.message);
  if (restored.role !== "tool" || normalizeToolCallId(restored)) {
    return restored;
  }
  const toolCallId = extractToolCallIdFromSourceRecords(message.sourceRecords);
  return toolCallId ? { ...restored, toolCallId, tool_call_id: toolCallId } : restored;
}

function legacyRefToTranscriptRecords(message: any): TranscriptRecord[] {
  if (Array.isArray(message?.sourceRecords) && message.sourceRecords.length > 0) {
    return message.sourceRecords.map((record: ConversationTranscriptSourceRecord) => ({
      stream: record.stream,
      payload: record.payload,
    }));
  }
  if (message?.message) {
    return messagesToTranscriptRecords([fromCommittedConversationMessage(message.message)]);
  }
  if (typeof message?.role === "string") {
    return [{
      stream: String(message.role),
      payload: String(message.content ?? ""),
    }];
  }
  return [];
}

export function committedHistoryRefsToTranscriptRecords(messages: ActorCommittedMessageRef[]): TranscriptRecord[] {
  return messages.flatMap((message) => legacyRefToTranscriptRecords(message));
}

export function committedHistoryRefsToMessages(messages: ActorCommittedMessageRef[]): ChatMessage[] {
  const canUseCommitted = messages.every((message) => message?.message && typeof message.message.content === "string");
  if (canUseCommitted) {
    return messages.map((message) => fromCommittedHistoryRef(message));
  }
  return reduceTranscriptToMessages(committedHistoryRefsToTranscriptRecords(messages));
}

export function chatMessagesToCommittedHistoryRefs(params: {
  messages: ChatMessage[];
  actorKey: string;
  actorId: string;
  recordIdPrefix: string;
  transcriptPath?: string | null;
}): ActorCommittedMessageRef[] {
  return params.messages.map((message, index) => ({
    recordId: makeRecordId(params.recordIdPrefix, index),
    actorKey: params.actorKey,
    actorId: params.actorId,
    committedAt:
      typeof message.endAt === "number"
        ? message.endAt
        : typeof message.startAt === "number"
          ? message.startAt
          : index,
    message: toCommittedConversationMessage(message),
    sourceRecords: messagesToTranscriptRecords([message]).map((record) => ({
      stream: record.stream,
      payload: record.payload,
      ...(typeof record.startAt === "number" ? { startAt: record.startAt } : {}),
      ...(typeof record.endAt === "number" ? { endAt: record.endAt } : {}),
    })),
    transcriptPath: params.transcriptPath ?? null,
  }));
}

function buildVisibleGenerationOrder(params: {
  historyIndex: Awaited<ReturnType<ConversationPersistenceRepository["loadHistoryIndex"]>>;
  actorKey: string;
  activeGenerationId: string;
}): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const walk = (generationId: string | null | undefined) => {
    const id = typeof generationId === "string" ? generationId.trim() : "";
    if (!id || seen.has(id)) return;
    seen.add(id);
    const lineage = params.historyIndex.lineages[id];
    for (const predecessorId of lineage?.predecessorGenerationIds ?? []) {
      walk(predecessorId);
    }
    ordered.push(id);
  };

  walk(params.activeGenerationId);
  for (const generationId of params.historyIndex.heads[params.actorKey]?.visibleGenerationIds ?? []) {
    walk(generationId);
  }
  return ordered;
}

function readPromptPayloadText(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    const text = typeof value === "string" ? value.trim() : "";
    if (text) return text;
  }
  return null;
}

function isToolMessage(message: ChatMessage | undefined): boolean {
  return String(message?.role ?? "") === "tool";
}

function findToolCallGroupStart(messages: ChatMessage[], index: number): number {
  let start = Math.max(0, Math.min(index, messages.length - 1));
  if (isToolMessage(messages[start])) {
    while (start > 0 && isToolMessage(messages[start - 1])) start -= 1;
    if (start > 0 && String(messages[start - 1]?.role ?? "") === "assistant") start -= 1;
  }
  return start;
}

function findLateStatusOverlayInsertIndex(messages: ChatMessage[]): number {
  if (messages.length === 0) return 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (String(messages[index]?.role ?? "") === "user") return index;
  }
  return findToolCallGroupStart(messages, messages.length - 1);
}

function insertLateStatusOverlay(messages: ChatMessage[], overlay: ChatMessage): ChatMessage[] {
  const next = [...messages];
  next.splice(findLateStatusOverlayInsertIndex(next), 0, overlay);
  return next;
}

function isLateStatusOverlayPayload(payload: Record<string, unknown>): boolean {
  return payload.insertPlacement === "late_status" || payload.overlayKind === "work_context";
}

function resolveActorKey(params: {
  session: ConversationSessionRawState;
  actorKey?: string;
}): string | null {
  const preferred = typeof params.actorKey === "string" ? params.actorKey.trim() : "";
  if (preferred) return preferred;
  return (
    params.session.activeActorKey
    ?? Object.keys(params.session.actorBindings)[0]
    ?? Object.keys(params.session.historyIndex.heads)[0]
    ?? Object.keys(params.session.promptIndex.heads)[0]
    ?? null
  );
}

function resolvePromptTargetHistoryGenerationId(params: {
  promptGeneration?: ActorPromptGenerationData | null;
  historyIndex: ConversationSessionRawState["historyIndex"];
  actorKey: string;
}): string | null {
  const metadataTarget = typeof params.promptGeneration?.metadata?.targetHistoryGenerationId === "string"
    ? params.promptGeneration.metadata.targetHistoryGenerationId.trim()
    : "";
  if (metadataTarget && params.historyIndex.generations[metadataTarget]) {
    return metadataTarget;
  }
  const transformTarget = params.promptGeneration?.transforms
    .map((transform) => {
      const value = transform.payload?.targetHistoryGenerationId;
      return typeof value === "string" ? value.trim() : "";
    })
    .find((value) => value && params.historyIndex.generations[value]);
  if (transformTarget) {
    return transformTarget;
  }
  const compactCandidates = Object.values(params.historyIndex.generations)
    .filter((generation) => generation.actorKey === params.actorKey && generation.generationId.includes("__compact__"))
    .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")));
  return compactCandidates[0]?.generationId ?? null;
}

export async function loadConversationSessionRawState(params: {
  sessionDir: string;
  repository: ConversationPersistenceRepository;
}): Promise<ConversationSessionRawState> {
  const sessionIndex = await params.repository.loadSessionIndex();
  const historyIndex = await params.repository.loadHistoryIndex();
  const promptIndex = await params.repository.loadPromptIndex();
  return {
    sessionId: path.basename(params.sessionDir),
    activeActorKey: sessionIndex.session.activeActorKey ?? null,
    actorBindings: sessionIndex.session.actorBindings,
    contextAssetRegistry: sessionIndex.session.contextAssetRegistry ?? null,
    contextAssets: sessionIndex.session.contextAssets ?? [],
    activeSelection: sessionIndex.session.activeSelection ?? null,
    lineage: sessionIndex.lineage ?? null,
    historyIndex,
    promptIndex,
    sessionIndex,
  };
}

export async function loadConversationActorRawState(params: {
  sessionDir: string;
  actorKey?: string;
  repository: ConversationPersistenceRepository;
}): Promise<ConversationActorRawState | null> {
  const session = await loadConversationSessionRawState(params);
  const actorKey = resolveActorKey({
    session,
    actorKey: params.actorKey,
  });

  if (!actorKey) {
    return null;
  }

  const actorBinding = session.actorBindings[actorKey];
  const promptHeadGenerationId =
    actorBinding?.promptHeadGenerationId
    ?? session.promptIndex.heads[actorKey]?.activePromptGenerationId
    ?? null;
  const promptGeneration = promptHeadGenerationId
    ? await params.repository.loadPromptGeneration(promptHeadGenerationId)
    : null;
  const declaredHistoryHeadGenerationId =
    actorBinding?.historyHeadGenerationId
    ?? session.historyIndex.heads[actorKey]?.activeGenerationId
    ?? null;
  const promptTargetHistoryGenerationId = resolvePromptTargetHistoryGenerationId({
    promptGeneration,
    historyIndex: session.historyIndex,
    actorKey,
  });
  const declaredHistoryGeneration = declaredHistoryHeadGenerationId
    ? await params.repository.loadHistoryGeneration(declaredHistoryHeadGenerationId)
    : null;
  const promptTargetHistoryGeneration = promptTargetHistoryGenerationId
    ? await params.repository.loadHistoryGeneration(promptTargetHistoryGenerationId)
    : null;
  const historyHeadGenerationId =
    promptGeneration
    && promptTargetHistoryGeneration
    && declaredHistoryGeneration?.createdReason !== "compaction"
      ? promptTargetHistoryGenerationId
      : declaredHistoryHeadGenerationId;

  const visibleGenerationIds = historyHeadGenerationId
    ? buildVisibleGenerationOrder({
        historyIndex: session.historyIndex,
        actorKey,
        activeGenerationId: historyHeadGenerationId,
      })
    : [];
  const visibleHistoryGenerations = (
    await Promise.all(visibleGenerationIds.map((generationId) => params.repository.loadHistoryGeneration(generationId)))
  ).filter((generation): generation is ActorHistoryGenerationData => !!generation);
  const activeHistoryGeneration = historyHeadGenerationId
    ? (visibleHistoryGenerations.find((generation) => generation.generationId === historyHeadGenerationId)
      ?? (historyHeadGenerationId === promptTargetHistoryGenerationId ? promptTargetHistoryGeneration : null)
      ?? (historyHeadGenerationId === declaredHistoryHeadGenerationId ? declaredHistoryGeneration : null)
      ?? await params.repository.loadHistoryGeneration(historyHeadGenerationId))
    : null;

  return {
    session,
    actorKey,
    actorId:
      actorBinding?.actorId
      ?? activeHistoryGeneration?.actorId
      ?? promptGeneration?.actorId
      ?? "",
    historyHeadGenerationId,
    promptHeadGenerationId,
    visibleGenerationIds,
    visibleHistoryGenerations,
    activeHistoryGeneration: activeHistoryGeneration ?? null,
    promptGeneration: promptGeneration ?? null,
    contextAssetIds: session.contextAssetRegistry?.assetIds ?? [],
  };
}

function materializePromptTransformPrelude(params: {
  rawState: ConversationActorRawState;
}): ChatMessage[] {
  const promptGeneration = params.rawState.promptGeneration;
  if (!promptGeneration) return [];

  let preludeEntries: Array<{ message: ChatMessage; assetId?: string | null }> = [];
  let materializedContextConsumed = false;

  for (const transform of promptGeneration.transforms) {
    const payload = transform.payload ?? {};
    switch (transform.kind) {
      case "history_compaction_summary":
      case "micro_compact": {
        const summary =
          readPromptPayloadText(payload, ["summary", "context", "text", "content"])
          ?? (
            !materializedContextConsumed
            ? String(promptGeneration.materializedContext ?? "").trim() || null
            : null
          );
        const ack = readPromptPayloadText(payload, ["acknowledgedSummary", "ack", "assistantAck"]);
        if (summary) {
          preludeEntries.push({ message: { role: "user", content: summary } as ChatMessage });
          materializedContextConsumed = true;
        }
        if (ack) {
          preludeEntries.push({ message: { role: "assistant", content: ack } as ChatMessage });
        }
        break;
      }
      case "overlay": {
        const overlay = readPromptPayloadText(payload, ["content", "text", "overlay", "prompt"]);
        if (overlay && !isLateStatusOverlayPayload(payload)) {
          preludeEntries.push({ message: { role: "system", content: overlay } as ChatMessage });
        }
        break;
      }
      case "context_asset_detach_all": {
        preludeEntries = preludeEntries.filter((entry) => !entry.assetId);
        break;
      }
      case "context_asset_attach":
      case "context_asset_extract_text":
      case "context_asset_select_fragment":
      case "context_asset_bind_summary": {
        const assetText = readPromptPayloadText(payload, [
          "content",
          "text",
          "summary",
          "extractedText",
          "fragmentText",
          "materializedText",
        ]);
        if (assetText) {
          const assetId = readPromptPayloadText(payload, ["assetId", "asset_id", "blockId", "block_id"]);
          preludeEntries = preludeEntries.filter((entry) => !assetId || entry.assetId !== assetId);
          preludeEntries.push({
            message: { role: "system", content: assetText } as ChatMessage,
            assetId,
          });
        }
        break;
      }
    }
  }

  if (!materializedContextConsumed) {
    const fallbackContext = String(promptGeneration.materializedContext ?? "").trim();
    if (fallbackContext) {
      preludeEntries.push({ message: { role: "user", content: fallbackContext } as ChatMessage });
    }
  }

  return preludeEntries.map((entry) => entry.message);
}

function materializePromptTransformLateStatusOverlays(params: {
  rawState: ConversationActorRawState;
}): ChatMessage[] {
  const promptGeneration = params.rawState.promptGeneration;
  if (!promptGeneration) return [];
  const overlays: ChatMessage[] = [];
  for (const transform of promptGeneration.transforms) {
    if (transform.kind !== "overlay") continue;
    const payload = transform.payload ?? {};
    if (!isLateStatusOverlayPayload(payload)) continue;
    const overlay = readPromptPayloadText(payload, ["content", "text", "overlay", "prompt"]);
    if (overlay) overlays.push({ role: "system", content: overlay } as ChatMessage);
  }
  return overlays;
}

export function materializeConversationVisibleHistory(rawState: ConversationActorRawState): ChatMessage[] {
  return rawState.visibleHistoryGenerations.flatMap((generation) => committedHistoryRefsToMessages(generation.messages));
}

export function materializeConversationRuntimePrompt(rawState: ConversationActorRawState): ChatMessage[] {
  const activeTailMessages = rawState.activeHistoryGeneration
    ? committedHistoryRefsToMessages(rawState.activeHistoryGeneration.messages)
    : [];
  let materialized = [
    ...materializePromptTransformPrelude({ rawState }),
    ...activeTailMessages,
  ];
  for (const overlay of materializePromptTransformLateStatusOverlays({ rawState })) {
    materialized = insertLateStatusOverlay(materialized, overlay);
  }
  return materialized;
}

function extractActiveTailMessages(params: {
  compressedMessages: ChatMessage[];
  summary: string;
  acknowledgedSummary?: string | null;
}): ChatMessage[] {
  const messages = [...params.compressedMessages];
  if (messages[0]?.role === "user" && String(messages[0]?.content ?? "").trim() === params.summary.trim()) {
    messages.shift();
  }
  const ack = String(params.acknowledgedSummary ?? "").trim();
  if (
    ack
    && messages[0]?.role === "assistant"
    && String(messages[0]?.content ?? "").trim() === ack
  ) {
    messages.shift();
  }
  return messages;
}

export type LoadedConversationMessages = {
  messages: ChatMessage[];
  source: "conversation" | "empty";
  historyGenerationId?: string | null;
  promptGenerationId?: string | null;
  path?: string;
};

export async function loadConversationHistoryMessages(params: {
  sessionDir: string;
  actorKey: string;
  repository: ConversationPersistenceRepository;
}): Promise<LoadedConversationMessages> {
  const rawState = await loadConversationActorRawState(params);
  if (!rawState?.historyHeadGenerationId) {
    return {
      messages: [],
      source: "empty",
    };
  }
  const messages = materializeConversationVisibleHistory(rawState);
  if (messages.length === 0) {
    return {
      messages: [],
      source: "empty",
      historyGenerationId: rawState.historyHeadGenerationId,
    };
  }
  return {
    messages,
    source: "conversation",
    historyGenerationId: rawState.historyHeadGenerationId,
    promptGenerationId: rawState.promptHeadGenerationId ?? null,
    path: getLocalHistoryGenerationPath(params.sessionDir, rawState.historyHeadGenerationId),
  };
}

export async function loadConversationRuntimeMessages(params: {
  sessionDir: string;
  actorKey: string;
  repository: ConversationPersistenceRepository;
}): Promise<LoadedConversationMessages> {
  const rawState = await loadConversationActorRawState(params);
  if (!rawState?.historyHeadGenerationId) {
    return {
      messages: [],
      source: "empty",
      historyGenerationId: null,
      promptGenerationId: rawState?.promptHeadGenerationId ?? null,
    };
  }
  if (!rawState.activeHistoryGeneration) {
    return {
      messages: [],
      source: "empty",
      historyGenerationId: rawState.historyHeadGenerationId,
      promptGenerationId: rawState.promptHeadGenerationId ?? null,
    };
  }
  const runtimeMessages = materializeConversationRuntimePrompt(rawState);
  return {
    messages: runtimeMessages,
    source: runtimeMessages.length > 0 ? "conversation" : "empty",
    historyGenerationId: rawState.historyHeadGenerationId,
    promptGenerationId: rawState.promptHeadGenerationId ?? null,
    path: getLocalHistoryGenerationPath(params.sessionDir, rawState.historyHeadGenerationId),
  };
}

export async function applyConversationCompaction(params: {
  sessionDir: string;
  actorKey: string;
  actorId: string;
  compressedMessages: ChatMessage[];
  summary: string;
  acknowledgedSummary?: string | null;
  occurredAt?: string;
  metadata?: {
    workContext?: Record<string, unknown>;
    policyContext?: Record<string, unknown>;
    policyDecision?: Record<string, unknown>;
    continuationBaselineBefore?: Record<string, unknown>;
    continuationBaselineAfter?: Record<string, unknown>;
    promptPlan?: Record<string, unknown>;
  };
  repository: ConversationPersistenceRepository;
}): Promise<{
  historyGenerationId: string;
  promptGenerationId: string;
}> {
  const nowIso = params.occurredAt ?? new Date().toISOString();
  const sessionId = path.basename(params.sessionDir);
  const historyIndex = await params.repository.loadHistoryIndex();
  const promptIndex = await params.repository.loadPromptIndex();
  const sessionIndex = await params.repository.loadSessionIndex();
  const artifactRefs = await params.repository.loadArtifactRefs();
  const actorBinding = sessionIndex.session.actorBindings[params.actorKey];
  const previousHistoryGenerationId =
    actorBinding?.historyHeadGenerationId
    ?? historyIndex.heads[params.actorKey]?.activeGenerationId
    ?? null;
  const previousPromptGenerationId =
    actorBinding?.promptHeadGenerationId
    ?? promptIndex.heads[params.actorKey]?.activePromptGenerationId
    ?? null;
  const previousHistoryGeneration = previousHistoryGenerationId
    ? await params.repository.loadHistoryGeneration(previousHistoryGenerationId)
    : null;

  if (previousHistoryGeneration && !previousHistoryGeneration.sealed) {
    await params.repository.writeHistoryGeneration({
      ...previousHistoryGeneration,
      sealed: true,
      updatedAt: nowIso,
    });
  }

  const historyGenerationId = makeGenerationId(params.actorKey, "compact");
  const promptGenerationId = makeGenerationId(params.actorKey, "prompt");
  const activeTailMessages = extractActiveTailMessages({
    compressedMessages: params.compressedMessages,
    summary: params.summary,
    acknowledgedSummary: params.acknowledgedSummary,
  });

  const historyGeneration: ActorHistoryGenerationData = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    generationId: historyGenerationId,
    sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    parentGenerationId: previousHistoryGenerationId,
    predecessorGenerationIds: uniqueStrings([previousHistoryGenerationId]),
    createdReason: "compaction",
    sealed: false,
    messageCount: activeTailMessages.length,
    messages: chatMessagesToCommittedHistoryRefs({
      messages: activeTailMessages,
      actorKey: params.actorKey,
      actorId: params.actorId,
      recordIdPrefix: historyGenerationId,
      transcriptPath: null,
    }),
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const promptGeneration: ActorPromptGenerationData = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    promptGenerationId,
    sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    basedOnPromptGenerationId: previousPromptGenerationId,
    basis: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      basisHistoryGenerationIds: uniqueStrings([previousHistoryGenerationId, historyGenerationId]),
      basisMessageRecordIds: historyGeneration.messages.map((message) => message.recordId),
      basisRefs: uniqueStrings([previousHistoryGenerationId, historyGenerationId]).map((generationId) => ({
        refKind: "history_generation",
        refId: generationId,
      })),
    },
    transforms: [
      {
        transformId: `${promptGenerationId}::summary`,
        kind: "history_compaction_summary",
        payload: {
          summary: params.summary,
          acknowledgedSummary: params.acknowledgedSummary ?? null,
          sourceHistoryGenerationId: previousHistoryGenerationId,
          targetHistoryGenerationId: historyGenerationId,
          ...(params.metadata?.workContext ? { workContext: params.metadata.workContext } : {}),
          ...(params.metadata?.policyContext ? { policyContext: params.metadata.policyContext } : {}),
          ...(params.metadata?.policyDecision ? { policyDecision: params.metadata.policyDecision } : {}),
          ...(params.metadata?.continuationBaselineAfter
            ? { continuationBaselineAfter: params.metadata.continuationBaselineAfter }
            : {}),
        },
        appliedAt: nowIso,
      },
    ],
    createdReason: "request_build",
    materializedContext: params.summary,
    sealed: false,
    createdAt: nowIso,
    sealedAt: null,
    updatedAt: nowIso,
    metadata: {
      sourceHistoryGenerationId: previousHistoryGenerationId,
      targetHistoryGenerationId: historyGenerationId,
      ...(params.metadata?.workContext ? { workContext: params.metadata.workContext } : {}),
      ...(params.metadata?.policyContext ? { policyContext: params.metadata.policyContext } : {}),
      ...(params.metadata?.policyDecision ? { policyDecision: params.metadata.policyDecision } : {}),
      ...(params.metadata?.continuationBaselineBefore
        ? { continuationBaselineBefore: params.metadata.continuationBaselineBefore }
        : {}),
      ...(params.metadata?.continuationBaselineAfter
        ? { continuationBaselineAfter: params.metadata.continuationBaselineAfter }
        : {}),
      ...(params.metadata?.promptPlan ? { promptPlan: params.metadata.promptPlan } : {}),
    },
  };

  await params.repository.writeHistoryGeneration(historyGeneration);
  await params.repository.writePromptGeneration(promptGeneration);

  historyIndex.heads[params.actorKey] = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    activeGenerationId: historyGenerationId,
    visibleGenerationIds: uniqueStrings([
      ...(historyIndex.heads[params.actorKey]?.visibleGenerationIds ?? []),
      previousHistoryGenerationId,
      historyGenerationId,
    ]),
    updatedAt: nowIso,
  };

  historyIndex.lineages[historyGenerationId] = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    generationId: historyGenerationId,
    parentGenerationId: previousHistoryGenerationId,
    rolledBackFromGenerationId: null,
    predecessorGenerationIds: uniqueStrings([previousHistoryGenerationId]),
    successorGenerationIds: [],
    forkGenerationIds: [],
    branchLabel: null,
    updatedAt: nowIso,
  };
  historyIndex.generations[historyGenerationId] = {
    generationId: historyGenerationId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    sealed: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  if (previousHistoryGenerationId) {
    const previousLineage = historyIndex.lineages[previousHistoryGenerationId] ?? {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      actorKey: params.actorKey,
      actorId: params.actorId,
      generationId: previousHistoryGenerationId,
      parentGenerationId: null,
      rolledBackFromGenerationId: null,
      predecessorGenerationIds: [],
      successorGenerationIds: [],
      forkGenerationIds: [],
      branchLabel: null,
      updatedAt: nowIso,
    };
    historyIndex.lineages[previousHistoryGenerationId] = {
      ...previousLineage,
      successorGenerationIds: uniqueStrings([
        ...(previousLineage.successorGenerationIds ?? []),
        historyGenerationId,
      ]),
      updatedAt: nowIso,
    };
    const previousManifest = historyIndex.generations[previousHistoryGenerationId];
    if (previousManifest) {
      historyIndex.generations[previousHistoryGenerationId] = {
        ...previousManifest,
        sealed: true,
        updatedAt: nowIso,
      };
    }
  }
  historyIndex.updatedAt = nowIso;

  promptIndex.heads[params.actorKey] = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    activePromptGenerationId: promptGenerationId,
    updatedAt: nowIso,
  };
  promptIndex.generations[promptGenerationId] = {
    promptGenerationId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    sealed: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  promptIndex.updatedAt = nowIso;

  sessionIndex.session.activeActorKey = params.actorKey;
  sessionIndex.session.actorBindings[params.actorKey] = {
    actorKey: params.actorKey,
    actorId: params.actorId,
    boundAt: nowIso,
    historyHeadGenerationId: historyGenerationId,
    promptHeadGenerationId: promptGenerationId,
  };
  sessionIndex.session.activeSelection = {
    sessionId,
    activeActorKey: params.actorKey,
    historyHeadGenerationId: historyGenerationId,
    promptHeadGenerationId: promptGenerationId,
    selectedAt: nowIso,
  };
  sessionIndex.session.updatedAt = nowIso;
  sessionIndex.updatedAt = nowIso;

  const artifactRef: ConversationArtifactRef = {
    artifactId: `${promptGenerationId}::artifact`,
    ownerDomain: "prompt",
    ownerId: promptGenerationId,
    artifactKind: "compaction_summary",
    filePath: null,
    metadata: {
      sourceHistoryGenerationId: previousHistoryGenerationId,
      targetHistoryGenerationId: historyGenerationId,
      summaryPreview: params.summary.slice(0, 160),
      ...(params.metadata?.workContext ? { workContext: params.metadata.workContext } : {}),
      ...(params.metadata?.policyDecision ? { policyDecision: params.metadata.policyDecision } : {}),
    },
    createdAt: nowIso,
  };
  const diagnosticRef: ConversationArtifactRef = {
    artifactId: `${promptGenerationId}::context-control`,
    ownerDomain: "prompt",
    ownerId: promptGenerationId,
    artifactKind: "diagnostic",
    filePath: null,
    metadata: {
      workContext: params.metadata?.workContext ?? null,
      policyContext: params.metadata?.policyContext ?? null,
      policyDecision: params.metadata?.policyDecision ?? null,
      continuationBaselineBefore: params.metadata?.continuationBaselineBefore ?? null,
      continuationBaselineAfter: params.metadata?.continuationBaselineAfter ?? null,
      promptPlan: params.metadata?.promptPlan ?? null,
    },
    createdAt: nowIso,
  };
  artifactRefs.refs = [
    ...artifactRefs.refs.filter(
      (ref) => ref.artifactId !== artifactRef.artifactId && ref.artifactId !== diagnosticRef.artifactId,
    ),
    artifactRef,
    diagnosticRef,
  ];
  artifactRefs.updatedAt = nowIso;

  await params.repository.writeHistoryIndex(historyIndex);
  await params.repository.writePromptIndex(promptIndex);
  await params.repository.writeSessionIndex(sessionIndex);
  await params.repository.writeArtifactRefs(artifactRefs);

  return {
    historyGenerationId,
    promptGenerationId,
  };
}
