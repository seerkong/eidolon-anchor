import path from "node:path";
import { createHash } from "node:crypto";

import { normalizeInputContent, type ChatMessage, type InputContent, type ToolCall } from "@shared/composer";

import {
  CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
  type ActorCommittedMessageRef,
  type ActorProviderContextFact,
  type ConversationActorRawState,
  type ActorHistoryGenerationData,
  type ActorPromptGenerationData,
  type ConversationArtifactRef,
  type ConversationCommittedMessageData,
  type LocalConversationContextAssetData,
  type ConversationPersistenceRepository,
  type ConversationSessionRawState,
  type ConversationTranscriptSourceRecord,
} from "@cell/ai-organ-contract";
import {
  messagesToTranscriptRecords,
  reduceTranscriptToMessages,
} from "@cell/ai-core-logic/runtime/TranscriptRecords";
import type { TranscriptRecord } from "@cell/symbiont-logic/stream/StreamTranscript";
import { getLocalHistoryGenerationPath } from "./LocalConversationPaths";

function canonicalProviderContextJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalProviderContextJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort((left, right) => left < right ? -1 : left > right ? 1 : 0).map((key) => (
    `${JSON.stringify(key)}:${canonicalProviderContextJson(record[key])}`
  )).join(",")}}`;
}

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
    ...(typeof message.messageId === "string" && message.messageId
      ? { messageId: message.messageId }
      : {}),
    role: message.role,
    name: message.name,
    content: typeof message.content === "string" ? message.content : normalizeInputContent(message.content),
    reasoningContent: message.reasoning_content,
    ...(typeof message.startAt === "number" ? { startAt: message.startAt } : {}),
    ...(typeof message.endAt === "number" ? { endAt: message.endAt } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(message.resultMetadata ? { resultMetadata: { ...message.resultMetadata } } : {}),
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
  const role = (message.role as ChatMessage["role"]) ?? "assistant";
  const content: InputContent = typeof message.content === "string"
    ? message.content
    : normalizeInputContent(message.content);

  // Deterministic content_parts reconstruction for assistant messages: the
  // committed codec stores reasoning/content as plain fields, while adapter
  // consumers (anthropic family) read structured parts. Rebuilt here so the
  // read-only conversation projection carries the same enriched shape the
  // executor used to attach in-place.
  const contentParts: Array<Record<string, unknown>> = [];
  if (role === "assistant") {
    if (typeof message.reasoningContent === "string" && message.reasoningContent) {
      contentParts.push({ type: "reasoning", text: message.reasoningContent });
    }
    if (typeof content === "string" && content) {
      contentParts.push({ type: "text", text: content });
    }
  }

  return {
    ...(typeof message.messageId === "string" && message.messageId
      ? { messageId: message.messageId }
      : {}),
    role,
    name: message.name,
    content,
    reasoning_content: message.reasoningContent,
    ...(contentParts.length > 0 ? { content_parts: contentParts } : {}),
    ...(typeof message.startAt === "number" ? { startAt: message.startAt } : {}),
    ...(typeof message.endAt === "number" ? { endAt: message.endAt } : {}),
    ...(toolCallId ? { toolCallId, tool_call_id: toolCallId } : {}),
    ...(message.resultMetadata ? { resultMetadata: { ...message.resultMetadata } } : {}),
    toolCalls,
    rawToolCalls: toolCalls,
    rawToolCallsStr: toolCalls ? JSON.stringify(toolCalls) : undefined,
  };
}

function fromCommittedHistoryRef(message: ActorCommittedMessageRef): ChatMessage {
  const restored = fromCommittedConversationMessage(message.message);
  const identified = restored.messageId
    ? restored
    : { ...restored, messageId: message.recordId };
  if (identified.role !== "tool" || normalizeToolCallId(identified)) {
    return identified;
  }
  const toolCallId = extractToolCallIdFromSourceRecords(message.sourceRecords);
  return toolCallId ? { ...identified, toolCallId, tool_call_id: toolCallId } : identified;
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
  const canUseCommitted = messages.every((message) => message?.message && (
    typeof message.message.content === "string" || Array.isArray(message.message.content)
  ));
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
  }));
}

export function buildVisibleGenerationOrder(params: {
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

function insertDynamicOverlaysAtConversationBoundary(
  rawState: ConversationActorRawState,
  messages: ChatMessage[],
  overlays: ChatMessage[],
): ChatMessage[] {
  if (overlays.length === 0) return messages;
  const stableSystemPrompts = new Set(readPromptGenerationSystemPrompts(rawState));
  let boundary = 0;
  while (
    boundary < messages.length
    && String(messages[boundary]?.role ?? "") === "system"
    && stableSystemPrompts.has(String(messages[boundary]?.content ?? "").trim())
  ) {
    boundary += 1;
  }
  const next = [...messages];
  next.splice(boundary, 0, ...overlays);
  return next;
}

function isLateStatusOverlayPayload(payload: Record<string, unknown>): boolean {
  return payload.insertPlacement === "late_status" || payload.overlayKind === "work_context";
}

function canonicalContextFactJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalContextFactJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort((left, right) => left < right ? -1 : left > right ? 1 : 0).map((key) => (
    `${JSON.stringify(key)}:${canonicalContextFactJson(record[key])}`
  )).join(",")}}`;
}

function providerContextFactWireText(fact: ActorProviderContextFact): string {
  return `eidolon-context-fact/v1\n${canonicalContextFactJson({
    namespace: fact.namespace,
    revision: fact.namespaceRevision,
    payload: fact.payload,
  })}`;
}

function currentActorProviderContextFacts(rawState: ConversationActorRawState): ActorProviderContextFact[] {
  const head = rawState.session.actorBindings[rawState.actorKey]?.providerContextFactHead;
  if (!head) return [];
  const facts = (rawState.session.contextAssets ?? [])
    .map((asset) => asset.providerContextFact)
    .filter((fact): fact is ActorProviderContextFact => Boolean(
      fact && fact.actorKey === rawState.actorKey && fact.epoch === head.epoch,
    ))
    .sort((left, right) => left.sequence - right.sequence);
  let previous: ActorProviderContextFact | null = null;
  for (const fact of facts) {
    if (fact.sequence !== (previous?.sequence ?? 0) + 1
      || fact.previousSequenceFactDigest !== (previous?.factDigest ?? null)) {
      throw new Error("provider context fact chain is not contiguous");
    }
    previous = fact;
  }
  if (previous?.factDigest !== head.factDigest || previous.sequence !== head.sequence) {
    throw new Error("provider context fact head does not match the immutable chain");
  }
  return facts;
}

function isProviderVisibleContextFact(fact: ActorProviderContextFact): boolean {
  // `work-context` is execution-control authority owned by the Actor. Older
  // sessions may still contain this namespace in their immutable fact chain,
  // but it must never be projected as model-visible user content.
  return fact.namespace !== "work-context";
}

function insertProviderContextFactsAtHistoryAnchors(params: {
  generation: ActorHistoryGenerationData | null | undefined;
  messages: ChatMessage[];
  facts: ActorProviderContextFact[];
}): ChatMessage[] {
  if (params.facts.length === 0) return params.messages;
  const generationId = params.generation?.generationId ?? "__empty_history__";
  const byCount = new Map<number, ActorProviderContextFact[]>();
  for (const fact of params.facts) {
    const exactEmptyAnchor = fact.anchor.historyGenerationId === "__empty_history__"
      && fact.anchor.messageCount === 0;
    if ((!exactEmptyAnchor && fact.anchor.historyGenerationId !== generationId) || fact.anchor.messageCount > params.messages.length) {
      throw new Error(
        `provider context fact history anchor is unavailable:${fact.anchor.historyGenerationId}:${fact.anchor.messageCount}:${generationId}:${params.messages.length}`,
      );
    }
    const prefix = params.generation?.messages.slice(0, fact.anchor.messageCount) ?? [];
    // Provider-context frontiers are canonical closed JSON, not JavaScript
    // insertion-order JSON. Persistence codecs are free to reconstruct the
    // same record with a different property order, and that must not mutate
    // the immutable history authority.
    const persistedPrefix = JSON.parse(JSON.stringify(prefix));
    const frontierDigest = `sha256:${createHash("sha256").update(canonicalProviderContextJson(persistedPrefix), "utf8").digest("hex")}`;
    if (frontierDigest !== fact.anchor.frontierDigest) {
      throw new Error("provider context fact history frontier mismatch");
    }
    const list = byCount.get(fact.anchor.messageCount) ?? [];
    list.push(fact);
    byCount.set(fact.anchor.messageCount, list);
  }
  const next: ChatMessage[] = [];
  const appendFacts = (messageCount: number) => {
    for (const fact of byCount.get(messageCount) ?? []) {
      next.push({ role: "user", content: providerContextFactWireText(fact) } as ChatMessage);
    }
  };
  appendFacts(0);
  params.messages.forEach((message, index) => {
    next.push(message);
    appendFacts(index + 1);
  });
  return next;
}

function assistantToolCallIds(message: ChatMessage): Set<string> {
  const ids = new Set<string>();
  for (const call of message.toolCalls ?? []) {
    if (call.id) ids.add(call.id);
  }
  for (const call of message.rawToolCalls ?? []) {
    if (call.id) ids.add(call.id);
  }
  for (const call of message.tool_calls ?? []) {
    if (call.id) ids.add(call.id);
  }
  if (typeof message.rawToolCallsStr === "string") {
    try {
      const calls = JSON.parse(message.rawToolCallsStr) as Array<{ id?: unknown }>;
      if (Array.isArray(calls)) {
        for (const call of calls) {
          if (typeof call?.id === "string" && call.id) ids.add(call.id);
        }
      }
    } catch {
      // Keep an unparseable compatibility field unchanged.
    }
  }
  return ids;
}

function filterAssistantToolCalls(message: ChatMessage, elidedIds: ReadonlySet<string>): ChatMessage | null {
  if (message.role !== "assistant") return message;
  const toolCalls = message.toolCalls?.filter((call) => !elidedIds.has(call.id));
  const rawToolCalls = message.rawToolCalls?.filter((call) => !elidedIds.has(call.id));
  const openAiToolCalls = message.tool_calls?.filter((call) => !elidedIds.has(call.id));
  let rawToolCallsStr = message.rawToolCallsStr;
  if (typeof rawToolCallsStr === "string") {
    try {
      const parsed = JSON.parse(rawToolCallsStr) as Array<{ id?: unknown }>;
      if (Array.isArray(parsed)) {
        rawToolCallsStr = JSON.stringify(parsed.filter((call) => (
          typeof call?.id !== "string" || !elidedIds.has(call.id)
        )));
      }
    } catch {
      // Keep an unparseable compatibility field unchanged.
    }
  }
  if (message.rawToolCalls) rawToolCallsStr = JSON.stringify(rawToolCalls);
  const originalContentParts = (message as ChatMessage & { content_parts?: unknown[] }).content_parts;
  const contentParts = originalContentParts?.filter((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return true;
    const record = part as Record<string, unknown>;
    const partType = record.type;
    const toolCallId = record.id ?? record.toolCallId ?? record.tool_call_id;
    const isToolCallPart = partType === "tool_use" || partType === "tool_call" || partType === "function_call";
    return !isToolCallPart || typeof toolCallId !== "string" || !elidedIds.has(toolCallId);
  });
  const next = {
    ...message,
    ...(message.toolCalls ? { toolCalls } : {}),
    ...(message.rawToolCalls ? {
      rawToolCalls,
    } : {}),
    ...(typeof rawToolCallsStr === "string" ? { rawToolCallsStr } : {}),
    ...(message.tool_calls ? { tool_calls: openAiToolCalls } : {}),
    ...(originalContentParts ? { content_parts: contentParts } : {}),
  } as ChatMessage & { content_parts?: unknown[] };
  const hasCalls = assistantToolCallIds(next).size > 0;
  const hasContent = String(next.content ?? "").trim().length > 0
    || String(next.reasoning_content ?? "").trim().length > 0
    || (Array.isArray(contentParts) && contentParts.length > 0);
  return hasCalls || hasContent ? next : null;
}

export function elideDeliveredToolCallPairsFromProviderView(
  messages: ChatMessage[],
  deliveredSourceToolCallIds: ReadonlySet<string>,
): ChatMessage[] {
  if (deliveredSourceToolCallIds.size === 0) return messages;

  const assistantIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const id of assistantToolCallIds(message)) assistantIds.add(id);
    } else if (message.role === "tool") {
      const id = normalizeToolCallId(message);
      if (id) resultIds.add(id);
    }
  }
  const pairedIds = new Set(
    [...deliveredSourceToolCallIds].filter((id) => assistantIds.has(id) && resultIds.has(id)),
  );
  if (pairedIds.size === 0) return messages;

  const next: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool" && pairedIds.has(normalizeToolCallId(message) ?? "")) continue;
    const filtered = filterAssistantToolCalls(message, pairedIds);
    if (filtered) next.push(filtered);
  }
  return next;
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

export function resolvePromptTargetHistoryGenerationId(params: {
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

/**
 * Conversation-visible messages: the prompt-transform prelude (compaction
 * summary/ack, context-asset entries) plus the active history tail — WITHOUT
 * the Stage-1 system prompts and without late-status overlays, which belong
 * to the provider materialization only. This is the read-only view semantics
 * of `actor.messages` after the mirror elimination (spec case
 * single-in-memory-truth/mirror-eliminated).
 */
export function materializeConversationVisibleMessages(rawState: ConversationActorRawState): ChatMessage[] {
  const activeTailMessages = rawState.activeHistoryGeneration
    ? committedHistoryRefsToMessages(rawState.activeHistoryGeneration.messages)
    : [];
  return [
    ...materializePromptTransformPrelude({ rawState }),
    ...activeTailMessages,
  ];
}

function readPromptGenerationSystemPrompts(rawState: ConversationActorRawState): string[] {
  const metadata = (rawState.promptGeneration?.metadata ?? {}) as Record<string, unknown>;
  const direct = metadata.systemPrompts;
  const fromPlan = (metadata.promptPlan as Record<string, unknown> | undefined)?.systemPrompts;
  const source = Array.isArray(direct) ? direct : Array.isArray(fromPlan) ? fromPlan : [];
  const prompts: string[] = [];
  const seen = new Set<string>();
  for (const value of source) {
    const prompt = typeof value === "string" ? value.trim() : "";
    if (!prompt || seen.has(prompt)) continue;
    seen.add(prompt);
    prompts.push(prompt);
  }
  return prompts;
}

/**
 * Stage 1 of the provider-context materialization: root the actor system
 * prompts recorded on the active prompt generation (Session/Context-domain
 * input, snapshotted at prompt-request time) ahead of everything else. The
 * verbatim semantics mirror the legacy materializeActorSystemPrompts: only
 * prompts not already present as system messages are prepended, in order.
 */
function materializeSystemPromptStage(
  rawState: ConversationActorRawState,
  messages: ChatMessage[],
): ChatMessage[] {
  const prompts = readPromptGenerationSystemPrompts(rawState);
  if (prompts.length === 0) return messages;
  const existing = new Set(
    messages
      .filter((message) => String(message?.role ?? "") === "system")
      .map((message) => String(message?.content ?? "").trim())
      .filter(Boolean),
  );
  const missing = prompts.filter((prompt) => !existing.has(prompt));
  if (missing.length === 0) return messages;
  return [
    ...missing.map((prompt) => ({ role: "system", content: prompt } as ChatMessage)),
    ...messages,
  ];
}

export function materializeConversationRuntimePrompt(rawState: ConversationActorRawState): ChatMessage[] {
  const providerContextFacts = currentActorProviderContextFacts(rawState)
    .filter(isProviderVisibleContextFact);
  const activeTailMessages = rawState.activeHistoryGeneration
    ? committedHistoryRefsToMessages(rawState.activeHistoryGeneration.messages)
    : [];
  const chronological = insertProviderContextFactsAtHistoryAnchors({
    generation: rawState.activeHistoryGeneration,
    messages: activeTailMessages,
    facts: providerContextFacts,
  });
  const materialized = materializeSystemPromptStage(rawState, [
    ...materializePromptTransformPrelude({ rawState }),
    ...chronological,
  ]);
  return insertDynamicOverlaysAtConversationBoundary(
    rawState,
    materialized,
    [
      ...materializePromptTransformLateStatusOverlays({ rawState }),
    ],
  );
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
  deferCommit?: boolean;
}): Promise<{
  historyGenerationId: string;
  promptGenerationId: string;
  historyIndex: import("@cell/ai-organ-contract").ConversationHistoryIndexSnapshot;
  promptIndex: import("@cell/ai-organ-contract").ConversationPromptIndexSnapshot;
  sessionIndex: import("@cell/ai-organ-contract").ConversationSessionIndexSnapshot;
  artifactRefs: import("@cell/ai-organ-contract").ConversationArtifactRefsSnapshot;
  historyGenerations: readonly ActorHistoryGenerationData[];
  promptGenerations: readonly ActorPromptGenerationData[];
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

  const sealedPreviousHistoryGeneration = previousHistoryGeneration && !previousHistoryGeneration.sealed
    ? {
        ...previousHistoryGeneration,
        sealed: true,
        updatedAt: nowIso,
      }
    : null;
  if (sealedPreviousHistoryGeneration && !params.deferCommit) {
    await params.repository.writeHistoryGeneration({
      ...sealedPreviousHistoryGeneration,
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

  if (!params.deferCommit) {
    await params.repository.writeHistoryGeneration(historyGeneration);
    await params.repository.writePromptGeneration(promptGeneration);
  }

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

  if (!params.deferCommit) {
    await params.repository.writeHistoryIndex(historyIndex);
    await params.repository.writePromptIndex(promptIndex);
    await params.repository.writeSessionIndex(sessionIndex);
    await params.repository.writeArtifactRefs(artifactRefs);
  }

  return {
    historyGenerationId,
    promptGenerationId,
    historyIndex,
    promptIndex,
    sessionIndex,
    artifactRefs,
    historyGenerations: [
      ...(sealedPreviousHistoryGeneration ? [sealedPreviousHistoryGeneration] : []),
      historyGeneration,
    ],
    promptGenerations: [promptGeneration],
  };
}
