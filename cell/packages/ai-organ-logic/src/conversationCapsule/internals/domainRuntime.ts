import path from "node:path";
import { createHash } from "node:crypto";

import type { ChatMessage } from "@shared/composer";

import {
  CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
  type ActorHistoryGenerationData,
  type ActorProviderContextFact,
  type ActorProviderContextFactNamespace,
  type ActorPromptBasisRefData,
  type ActorPromptGenerationData,
  type ActorPromptHeadData,
  type ActorPromptTransformData,
  type ConversationActorRawState,
  type ConversationCommittedMessageData,
  type ConversationDomainEvent,
  type ConversationProviderContextTransitionGeneration,
  type ConversationSessionRawState,
  type LocalConversationContextAssetData,
  type LocalConversationMessageDeliveryFact,
  type LocalConversationProviderContextFactCandidate,
  type LocalConversationProviderProjectionFact,
  type LocalConversationToolResultDeliveryFact,
  type ProviderContextAuthorityHeads,
  type ProviderContextTransitionCommand,
  type ResponsesReplayCheckpoint,
} from "@cell/ai-organ-contract";
import type { ConversationPersistenceRepository } from "@cell/ai-organ-contract/persistence/conversation/ConversationPersistence";
import {
  createActorProviderContextFact,
  measureActorProviderContextFactRetention,
} from "../../conversation/ActorProviderContextFact";
import {
  assertExactProviderContextHistoryPrefix,
  assertProviderContextClosedValue,
  createProviderContextCompactionProof,
  createProviderEpochReceiptV2,
  createProviderRequestAdmissionReceipt,
  digestLegacyProviderEpochReceipt,
  digestProviderContextClosedValue,
  digestProviderContextHistoryFrontier,
} from "../../conversation/ProviderContextEpochV2";
import {
  committedHistoryRefsToMessages,
  loadConversationActorRawState,
  loadConversationSessionRawState,
  materializeConversationRuntimePrompt,
  materializeConversationVisibleHistory,
  materializeConversationVisibleMessages,
  toCommittedConversationMessage,
} from "@cell/ai-support";
import { reduceTranscriptToMessages } from "@cell/ai-core-logic/runtime/TranscriptRecords";
import type { TranscriptRecord } from "@cell/symbiont-logic/stream/StreamTranscript";
import type { AiAgentVm } from "@cell/ai-core-logic";

import type {
  ConversationDomainEventStream,
  ConversationDomainPersistHooks,
  ConversationDomainRuntime,
  ConversationHistoryDomainEvent,
  ConversationHistoryRuntimeState,
  ConversationMessageAssemblyRuntimeState,
  ConversationPromptDomainEvent,
  ConversationPromptRuntimeState,
  ConversationSessionDomainEvent,
} from "../../conversation/ConversationDomainRuntime";
import {
  MAX_CONVERSATION_DOMAIN_EVENTS_PER_STREAM,
  MAX_MESSAGE_ASSEMBLY_REDUCED_MESSAGES,
  MAX_MESSAGE_ASSEMBLY_TRANSCRIPT_RECORDS,
} from "./constants";
import {
  actorRuntimeKey,
  appendBounded,
  appendCommittedMessageToGeneration,
  applyCommittedMessageAppendToDomains,
  createEmptySessionState,
  deriveConversationActorRawState,
  findSharedMessageSuffixPrefix,
  retainTail,
  toHistoryRuntimeState,
  toPromptRuntimeState,
  upsertHistoryGeneration,
  upsertPromptGeneration,
} from "./derivations";

/**
 * Vm-coupled implementation of the conversation domain runtime. The exported
 * types live on the compatibility facade at
 * src/conversation/ConversationDomainRuntime.ts (type-only back-imports stay
 * acyclic); pure reduction/projection cores live in ./derivations.
 */

type ValueSignal<T> = {
  get: () => T;
  set: (next: T) => void;
  subscribe: (listener: (value: T) => void) => { unsubscribe: () => void };
};

type DomainListener<TEvent> = (event: TEvent) => void;

function createValueSignal<T>(initial: T): ValueSignal<T> {
  let current = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    get: () => current,
    set: (next) => {
      current = next;
      for (const listener of [...listeners]) listener(current);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return {
        unsubscribe: () => listeners.delete(listener),
      };
    },
  };
}

function trimMutableTail<T>(items: T[], maxItems: number): void {
  const extra = items.length - maxItems;
  if (extra > 0) items.splice(0, extra);
}

export function createConversationDomainRuntime(): ConversationDomainRuntime {
  return {
    historyEvents: [],
    promptEvents: [],
    sessionEvents: [],
    actorRawStateSignal: createValueSignal<Record<string, ConversationActorRawState>>({}),
    historyStateSignal: createValueSignal<Record<string, ConversationHistoryRuntimeState>>({}),
    promptStateSignal: createValueSignal<Record<string, ConversationPromptRuntimeState>>({}),
    sessionStateSignal: createValueSignal<Record<string, ConversationSessionRawState>>({}),
    messageAssemblySignal: createValueSignal<Record<string, ConversationMessageAssemblyRuntimeState>>({}),
    historyListeners: new Set(),
    promptListeners: new Set(),
    sessionListeners: new Set(),
    persistHooks: {},
  };
}

export function ensureVmConversationDomainRuntime(vm: AiAgentVm): ConversationDomainRuntime {
  const current = vm.runtimeContext.conversationDomainRuntime as ConversationDomainRuntime | null;
  if (current) {
    bindVmActorsConversationProjection(vm);
    return current;
  }
  const created = createConversationDomainRuntime();
  vm.runtimeContext.conversationDomainRuntime = created;
  bindVmActorsConversationProjection(vm);
  return created;
}

/**
 * Bind every vm actor's read-only `messages` view to the History-domain
 * projection (P7 mirror elimination). Idempotent and cheap; swept on every
 * ensure call so late-spawned actors (delegates, members) get bound as soon
 * as any conversation-domain code path runs.
 */
export function bindActorConversationProjectionToVm(
  vm: AiAgentVm,
  actor: { key: string; bindConversationProjection?: (provider: () => readonly ChatMessage[]) => void },
): void {
  actor.bindConversationProjection?.(() =>
    getConversationVisibleMessagesFromVm({ vm, actorKey: actor.key }),
  );
}

function bindVmActorsConversationProjection(vm: AiAgentVm): void {
  for (const actor of Object.values(vm.actors ?? {})) {
    bindActorConversationProjectionToVm(vm, actor as { key: string; bindConversationProjection?: (provider: () => readonly ChatMessage[]) => void });
  }
}

export function getVmConversationDomainRuntime(vm: AiAgentVm): ConversationDomainRuntime | null {
  return (vm.runtimeContext.conversationDomainRuntime as ConversationDomainRuntime | null) ?? null;
}

export function getConversationSessionRawStateFromVm(params: {
  vm: AiAgentVm;
  sessionId?: string;
}): ConversationSessionRawState | null {
  const runtime = getVmConversationDomainRuntime(params.vm);
  if (!runtime) return null;
  const sessionId = params.sessionId ?? resolveSessionIdFromVm(params.vm);
  return runtime.sessionStateSignal.get()[sessionId] ?? null;
}

export function getConversationActorRawStateFromVm(params: {
  vm: AiAgentVm;
  actorKey: string;
  sessionId?: string;
}): ConversationActorRawState | null {
  const runtime = getVmConversationDomainRuntime(params.vm);
  if (!runtime) return null;
  const sessionId = params.sessionId ?? resolveSessionIdFromVm(params.vm);
  return runtime.actorRawStateSignal.get()[actorRuntimeKey(sessionId, params.actorKey)] ?? null;
}

export function subscribeConversationHistory(
  runtime: ConversationDomainRuntime,
  listener: DomainListener<ConversationHistoryDomainEvent>,
): { unsubscribe: () => void } {
  runtime.historyListeners.add(listener);
  return {
    unsubscribe: () => runtime.historyListeners.delete(listener),
  };
}

export function subscribeConversationPrompt(
  runtime: ConversationDomainRuntime,
  listener: DomainListener<ConversationPromptDomainEvent>,
): { unsubscribe: () => void } {
  runtime.promptListeners.add(listener);
  return {
    unsubscribe: () => runtime.promptListeners.delete(listener),
  };
}

export function subscribeConversationSession(
  runtime: ConversationDomainRuntime,
  listener: DomainListener<ConversationSessionDomainEvent>,
): { unsubscribe: () => void } {
  runtime.sessionListeners.add(listener);
  return {
    unsubscribe: () => runtime.sessionListeners.delete(listener),
  };
}

export function teeConversationHistoryStream(
  runtime: ConversationDomainRuntime,
): ConversationDomainEventStream<ConversationHistoryDomainEvent> {
  return createDomainEventStream(runtime.historyListeners);
}

export function teeConversationPromptStream(
  runtime: ConversationDomainRuntime,
): ConversationDomainEventStream<ConversationPromptDomainEvent> {
  return createDomainEventStream(runtime.promptListeners);
}

export function teeConversationSessionStream(
  runtime: ConversationDomainRuntime,
): ConversationDomainEventStream<ConversationSessionDomainEvent> {
  return createDomainEventStream(runtime.sessionListeners);
}

export function setConversationDomainPersistHooks(
  runtime: ConversationDomainRuntime,
  hooks: ConversationDomainPersistHooks,
): void {
  runtime.persistHooks = { ...hooks };
}

export function injectConversationSessionRawState(
  runtime: ConversationDomainRuntime,
  rawState: ConversationSessionRawState,
): void {
  const current = runtime.sessionStateSignal.get()[rawState.sessionId];
  const actorBindings = current
    ? Object.fromEntries([...new Set([
        ...Object.keys(current.actorBindings),
        ...Object.keys(rawState.actorBindings),
      ])].map((actorKey) => {
        const prior = current.actorBindings[actorKey];
        const incoming = rawState.actorBindings[actorKey];
        return [actorKey, {
          ...(prior ?? {}),
          ...(incoming ?? {}),
          providerEpochReceipt: incoming?.providerContextLegacyMigrationMarker
            && incoming.providerEpochReceiptV2
            ? undefined
            : incoming?.providerEpochReceipt ?? prior?.providerEpochReceipt,
          providerEpochReceiptV2: incoming?.providerEpochReceiptV2 ?? prior?.providerEpochReceiptV2,
          providerRequestAdmissions: incoming?.providerRequestAdmissions ?? prior?.providerRequestAdmissions,
          providerContextFactHead: incoming && Object.prototype.hasOwnProperty.call(incoming, "providerContextFactHead")
            ? incoming.providerContextFactHead
            : prior?.providerContextFactHead,
        }];
      }))
    : rawState.actorBindings;
  for (const binding of Object.values(actorBindings)) {
    if (binding.providerEpochReceipt && binding.providerEpochReceiptV2) {
      throw new Error("provider_context_dual_authority_forbidden");
    }
  }
  const merged = current
    ? {
        ...rawState,
        actorBindings,
        sessionIndex: {
          ...rawState.sessionIndex,
          session: { ...rawState.sessionIndex.session, actorBindings },
        },
      }
    : rawState;
  runtime.sessionStateSignal.set({
    ...runtime.sessionStateSignal.get(),
    [rawState.sessionId]: merged,
  });
}

export function injectConversationActorRawState(
  runtime: ConversationDomainRuntime,
  rawState: ConversationActorRawState,
): void {
  const key = actorRuntimeKey(rawState.session.sessionId, rawState.actorKey);
  runtime.actorRawStateSignal.set({
    ...runtime.actorRawStateSignal.get(),
    [key]: rawState,
  });
  runtime.historyStateSignal.set({
    ...runtime.historyStateSignal.get(),
    [key]: toHistoryRuntimeState(rawState),
  });
  runtime.promptStateSignal.set({
    ...runtime.promptStateSignal.get(),
    [key]: toPromptRuntimeState(rawState),
  });
  injectConversationSessionRawState(runtime, rawState.session);
}

export async function synchronizeConversationDomainActorFromPersistence(params: {
  runtime: ConversationDomainRuntime;
  sessionDir: string;
  actorKey: string;
  repository: ConversationPersistenceRepository;
}): Promise<void> {
  const sessionRawState = await loadConversationSessionRawState({
    sessionDir: params.sessionDir,
    repository: params.repository,
  });
  injectConversationSessionRawState(params.runtime, sessionRawState);

  const actorRawState = await loadConversationActorRawState({
    sessionDir: params.sessionDir,
    actorKey: params.actorKey,
    repository: params.repository,
  });
  if (actorRawState) {
    injectConversationActorRawState(params.runtime, actorRawState);
  }
}

export async function synchronizeConversationDomainSessionFromPersistence(params: {
  runtime: ConversationDomainRuntime;
  sessionDir: string;
  actorKey?: string;
  repository: ConversationPersistenceRepository;
}): Promise<void> {
  const sessionRawState = await loadConversationSessionRawState({
    sessionDir: params.sessionDir,
    repository: params.repository,
  });
  injectConversationSessionRawState(params.runtime, sessionRawState);
  const actorKey =
    params.actorKey
    ?? sessionRawState.activeActorKey
    ?? Object.keys(sessionRawState.actorBindings)[0]
    ?? null;
  if (!actorKey) return;
  await synchronizeConversationDomainActorFromPersistence({
    runtime: params.runtime,
    sessionDir: params.sessionDir,
    actorKey,
    repository: params.repository,
  });
}

function resolveSessionIdFromVm(vm: AiAgentVm): string {
  const metadata = (vm.outerCtx?.metadata ?? {}) as Record<string, unknown>;
  const explicit = typeof metadata.sessionId === "string" ? metadata.sessionId.trim() : "";
  if (explicit) return explicit;
  const sessionDir = typeof metadata.sessionDir === "string" ? metadata.sessionDir.trim() : "";
  if (sessionDir) return path.basename(sessionDir);
  return "__unsessioned__";
}

function createDomainEventStream<TEvent>(
  listeners: Set<DomainListener<TEvent>>,
): ConversationDomainEventStream<TEvent> {
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return {
        unsubscribe: () => listeners.delete(listener),
      };
    },
  };
}

function notifyListeners<TEvent>(
  listeners: Set<DomainListener<TEvent>>,
  event: TEvent,
): void {
  for (const listener of [...listeners]) {
    listener(event);
  }
}

function makeRuntimeScopedId(prefix: string): string {
  return `${prefix}__${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Work-context ("late status") overlays are per-build status banners: the
 * control plane re-materializes exactly one against the CURRENT work context
 * on every prompt build. Inheriting them across prompt generations is what
 * produced the D2 overlay accumulation (and stale plan-mode overlays), so a
 * new generation inherits only structural transforms (compaction summaries,
 * context assets, prelude overlays) and never late-status ones.
 */
function isLateStatusOverlayTransform(transform: ActorPromptTransformData): boolean {
  if (transform.kind !== "overlay") return false;
  const payload = (transform.payload ?? {}) as Record<string, unknown>;
  return payload.insertPlacement === "late_status" || payload.overlayKind === "work_context";
}

function inheritStructuralPromptTransforms(
  transforms: ActorPromptTransformData[] | undefined,
): ActorPromptTransformData[] {
  return (transforms ?? []).filter((transform) => !isLateStatusOverlayTransform(transform));
}

function refreshConversationActorRawStateFromDomainState(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  actorId?: string;
}): void {
  const key = actorRuntimeKey(params.sessionId, params.actorKey);
  const next = deriveConversationActorRawState({
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    currentActorRaw: params.runtime.actorRawStateSignal.get()[key] ?? null,
    historyState: params.runtime.historyStateSignal.get()[key] ?? null,
    promptState: params.runtime.promptStateSignal.get()[key] ?? null,
    sessionState: params.runtime.sessionStateSignal.get()[params.sessionId] ?? null,
  });
  params.runtime.actorRawStateSignal.set({
    ...params.runtime.actorRawStateSignal.get(),
    [key]: next,
  });
}

function historyMutationInvalidatesProviderContext(event: ConversationDomainEvent): boolean {
  return event.type === "actor_history_head_moved"
    || event.type === "actor_history_compaction_applied"
    || event.type === "actor_history_generation_forked"
    || event.type === "actor_history_generation_rolled_back"
    || event.type === "actor_history_reset"
    || event.type === "local_conversation_session_forked";
}

function advanceProviderContextEpochForHistoryMutation(
  runtime: ConversationDomainRuntime,
  event: ConversationDomainEvent,
): void {
  if (!historyMutationInvalidatesProviderContext(event)) return;

  const currentSession = runtime.sessionStateSignal.get()[event.sessionId]
    ?? createEmptySessionState(event.sessionId);
  const replayActorKeys = (currentSession.contextAssets ?? []).flatMap((asset) => (
    asset.replayCheckpoint && asset.source.kind === "note" && asset.source.ownerId
      ? [asset.source.ownerId]
      : []
  ));
  const actorKeys = ("actorKey" in event && typeof event.actorKey === "string"
    ? [event.actorKey]
    : [...new Set([...Object.keys(currentSession.actorBindings), ...replayActorKeys])])
    // v2 authority is immutable. A non-append history mutation must be
    // admitted by commitProviderContextTransition; legacy implicit epoch
    // invalidation remains only for v1 snapshots/import compatibility.
    .filter((actorKey) => !currentSession.actorBindings[actorKey]?.providerEpochReceiptV2);
  if (actorKeys.length === 0) return;

  const affectedActorKeys = new Set(actorKeys);
  const affectedAssetIds = new Set(actorKeys.map(responsesReplayCheckpointAssetId));
  const nextBindings = { ...currentSession.actorBindings };
  const nextAssets = (currentSession.contextAssets ?? []).filter((asset) => {
    if (!asset.replayCheckpoint) return true;
    const ownerId = asset.source.kind === "note" ? asset.source.ownerId ?? "" : "";
    return !affectedAssetIds.has(asset.assetId) && !affectedActorKeys.has(ownerId);
  });
  const remainingAssetIds = new Set(nextAssets.map((asset) => asset.assetId));

  for (const actorKey of actorKeys) {
    const existing = nextBindings[actorKey] ?? {
      actorKey,
      actorId: runtime.historyStateSignal.get()[actorRuntimeKey(event.sessionId, actorKey)]?.actorId ?? "",
      boundAt: event.occurredAt,
    };
    const checkpoint = (currentSession.contextAssets ?? []).find((asset) => (
      asset.assetId === responsesReplayCheckpointAssetId(actorKey)
    ))?.replayCheckpoint;
    const currentEpoch = Math.max(existing.contextEpoch ?? 0, checkpoint?.baselineEpoch ?? 0);
    nextBindings[actorKey] = { ...existing, contextEpoch: currentEpoch + 1 };
    nextBindings[actorKey] = {
      ...nextBindings[actorKey],
      providerContextFactHead: null,
    };
  }

  const nextRegistry = currentSession.contextAssetRegistry
    ? {
        ...currentSession.contextAssetRegistry,
        assetIds: currentSession.contextAssetRegistry.assetIds.filter((assetId) => remainingAssetIds.has(assetId)),
        updatedAt: event.occurredAt,
      }
    : null;
  const nextSession = {
    ...currentSession,
    actorBindings: nextBindings,
    contextAssetRegistry: nextRegistry,
    contextAssets: nextAssets,
    sessionIndex: {
      ...currentSession.sessionIndex,
      updatedAt: event.occurredAt,
      session: {
        ...currentSession.sessionIndex.session,
        actorBindings: nextBindings,
        contextAssetRegistry: nextRegistry,
        contextAssets: nextAssets,
        updatedAt: event.occurredAt,
      },
    },
  };
  runtime.sessionStateSignal.set({
    ...runtime.sessionStateSignal.get(),
    [event.sessionId]: nextSession,
  });
  for (const actorKey of actorKeys) {
    refreshConversationActorRawStateFromDomainState({
      runtime,
      sessionId: event.sessionId,
      actorKey,
      actorId: nextBindings[actorKey]?.actorId,
    });
  }
  const firstActorKey = actorKeys[0]!;
  runtime.persistHooks.session?.({
    type: "local_conversation_session_actor_bound",
    sessionId: event.sessionId,
    actorKey: firstActorKey,
    actorId: nextBindings[firstActorKey]!.actorId,
    binding: nextBindings[firstActorKey],
    occurredAt: event.occurredAt,
  });
}

export function synchronizeProviderContextEpochToConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  contextEpoch: number;
  occurredAt?: string;
}): void {
  if (!Number.isSafeInteger(params.contextEpoch) || params.contextEpoch < 0) return;
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const currentSession = params.runtime.sessionStateSignal.get()[params.sessionId]
    ?? createEmptySessionState(params.sessionId);
  const existing = currentSession.actorBindings[params.actorKey] ?? {
    actorKey: params.actorKey,
    actorId: "",
    boundAt: occurredAt,
  };
  if (existing.contextEpoch !== undefined && existing.contextEpoch >= params.contextEpoch) return;

  const nextBinding = { ...existing, contextEpoch: params.contextEpoch };
  const nextBindings = { ...currentSession.actorBindings, [params.actorKey]: nextBinding };
  const nextSession = {
    ...currentSession,
    actorBindings: nextBindings,
    sessionIndex: {
      ...currentSession.sessionIndex,
      updatedAt: occurredAt,
      session: {
        ...currentSession.sessionIndex.session,
        actorBindings: nextBindings,
        updatedAt: occurredAt,
      },
    },
  };
  params.runtime.sessionStateSignal.set({
    ...params.runtime.sessionStateSignal.get(),
    [params.sessionId]: nextSession,
  });
  refreshConversationActorRawStateFromDomainState({
    runtime: params.runtime,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: nextBinding.actorId,
  });
  params.runtime.persistHooks.session?.({
    type: "local_conversation_session_actor_bound",
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: nextBinding.actorId,
    binding: nextBinding,
    occurredAt,
  });
}

export function activateProviderEpochReceiptV2InConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  receipt: import("@cell/ai-organ-contract").ProviderEpochReceiptV2;
}): import("@cell/ai-organ-contract").ProviderEpochReceiptV2 {
  const receipt = params.receipt;
  const currentSession = params.runtime.sessionStateSignal.get()[receipt.sessionId]
    ?? createEmptySessionState(receipt.sessionId);
  const existing = currentSession.actorBindings[receipt.actorKey] ?? {
    actorKey: receipt.actorKey,
    actorId: receipt.actorId,
    boundAt: receipt.createdAt,
  };
  const current = existing.providerEpochReceiptV2;
  if (existing.providerEpochReceipt) {
    throw new Error("provider_context_legacy_import_required");
  }
  if (current?.receiptDigest === receipt.receiptDigest) return current;
  if (current) {
    throw new Error("provider_epoch_v2_transition_processor_required");
  } else if (receipt.previousReceiptDigest !== null) {
    throw new Error("provider_epoch_v2_predecessor_missing");
  }
  const occurredAt = receipt.createdAt;
  const nextBinding = {
    ...existing,
    actorId: receipt.actorId,
    contextEpoch: Math.max(existing.contextEpoch ?? 0, receipt.epoch),
    providerEpochReceiptV2: receipt,
    providerRequestAdmissions: Object.freeze([]),
  };
  const nextBindings = { ...currentSession.actorBindings, [receipt.actorKey]: nextBinding };
  const nextSession = {
    ...currentSession,
    actorBindings: nextBindings,
    sessionIndex: {
      ...currentSession.sessionIndex,
      updatedAt: occurredAt,
      session: {
        ...currentSession.sessionIndex.session,
        actorBindings: nextBindings,
        updatedAt: occurredAt,
      },
    },
  };
  params.runtime.sessionStateSignal.set({
    ...params.runtime.sessionStateSignal.get(),
    [receipt.sessionId]: nextSession,
  });
  refreshConversationActorRawStateFromDomainState({
    runtime: params.runtime,
    sessionId: receipt.sessionId,
    actorKey: receipt.actorKey,
    actorId: receipt.actorId,
  });
  params.runtime.persistHooks.session?.({
    type: "local_conversation_session_actor_bound",
    sessionId: receipt.sessionId,
    actorKey: receipt.actorKey,
    actorId: receipt.actorId,
    binding: nextBinding,
    occurredAt,
  });
  return receipt;
}

function exactProviderContextHeads(
  left: ProviderContextAuthorityHeads,
  right: ProviderContextAuthorityHeads,
): boolean {
  return left.historyHeadGenerationId === right.historyHeadGenerationId
    && left.promptHeadGenerationId === right.promptHeadGenerationId
    && left.factHeadDigest === right.factHeadDigest;
}

function providerContextAuthorityHeads(
  runtime: ConversationDomainRuntime,
  sessionId: string,
  actorKey: string,
): ProviderContextAuthorityHeads {
  const key = actorRuntimeKey(sessionId, actorKey);
  const session = runtime.sessionStateSignal.get()[sessionId];
  const binding = session?.actorBindings[actorKey];
  return Object.freeze({
    historyHeadGenerationId: runtime.historyStateSignal.get()[key]?.activeGenerationId
      ?? binding?.historyHeadGenerationId
      ?? "__empty_history__",
    promptHeadGenerationId: runtime.promptStateSignal.get()[key]?.activePromptGenerationId
      ?? binding?.promptHeadGenerationId
      ?? "__empty_prompt__",
    factHeadDigest: binding?.providerContextFactHead?.factDigest ?? null,
  });
}

function actorRawStateFromTransitionGeneration(params: {
  current: ConversationActorRawState | null;
  generation: ConversationProviderContextTransitionGeneration;
  sessionId: string;
  actorKey: string;
  actorId: string;
}): ConversationActorRawState {
  const { generation } = params;
  const binding = generation.sessionIndex.session.actorBindings[params.actorKey];
  const historyHead = generation.historyIndex.heads[params.actorKey];
  const promptHead = generation.promptIndex.heads[params.actorKey];
  const promptHeadGenerationId = promptHead?.activePromptGenerationId ?? "__empty_prompt__";
  if (!binding || binding.actorId !== params.actorId || !historyHead
    || binding.promptHeadGenerationId !== promptHeadGenerationId) {
    throw new Error("provider_context_transition_generation_binding_missing");
  }
  const knownHistory = new Map([
    ...(params.current?.visibleHistoryGenerations ?? []).map((entry) => [entry.generationId, entry] as const),
    ...generation.historyGenerations.map((entry) => [entry.generationId, entry] as const),
  ]);
  const visibleGenerationIds = historyHead.visibleGenerationIds;
  const visibleHistoryGenerations = visibleGenerationIds.map((generationId) => {
    const entry = knownHistory.get(generationId);
    if (!entry) throw new Error("provider_context_transition_generation_history_missing");
    return entry;
  });
  const promptGeneration = promptHeadGenerationId === "__empty_prompt__"
    ? null
    : generation.promptGenerations.find(
      (entry) => entry.promptGenerationId === promptHeadGenerationId,
    ) ?? (params.current?.promptGeneration?.promptGenerationId === promptHeadGenerationId
      ? params.current.promptGeneration
      : null);
  if (promptHeadGenerationId !== "__empty_prompt__" && !promptGeneration) {
    throw new Error("provider_context_transition_generation_prompt_missing");
  }
  const session = {
    sessionId: generation.sessionIndex.sessionId,
    activeActorKey: generation.sessionIndex.session.activeActorKey ?? null,
    actorBindings: generation.sessionIndex.session.actorBindings,
    contextAssetRegistry: generation.sessionIndex.session.contextAssetRegistry ?? null,
    contextAssets: generation.sessionIndex.session.contextAssets ?? [],
    activeSelection: generation.sessionIndex.session.activeSelection ?? null,
    lineage: generation.sessionIndex.lineage ?? null,
    historyIndex: generation.historyIndex,
    promptIndex: generation.promptIndex,
    sessionIndex: generation.sessionIndex,
  };
  return {
    session,
    actorKey: params.actorKey,
    actorId: params.actorId,
    historyHeadGenerationId: historyHead.activeGenerationId,
    promptHeadGenerationId,
    visibleGenerationIds: [...visibleGenerationIds],
    visibleHistoryGenerations,
    activeHistoryGeneration: historyHead.activeGenerationId
      ? knownHistory.get(historyHead.activeGenerationId) ?? null
      : null,
    promptGeneration,
    contextAssetIds: session.contextAssetRegistry?.assetIds ?? [],
  };
}

function assertTransitionDigest(value: unknown, field: string): asserts value is `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`provider_context_transition_invalid:${field}`);
  }
}

export function commitProviderContextTransition(
  runtime: ConversationDomainRuntime,
  input: ProviderContextTransitionCommand,
  _config: Readonly<Record<string, never>>,
): import("@cell/ai-organ-contract").ProviderEpochReceiptV2 {
  assertProviderContextClosedValue(input, "transitionCommand");
  const expectedCommandKeys = [
    "actorId", "actorKey", "appendedFactDigests", "compactionProof",
    "deliveryConfirmationDigests", "expectedConversationRevision",
    "expectedEpochReceiptDigest", "expectedLatestAdmissionDigest", "generation", "nextFactHead",
    "nextHeads", "nextReceipt", "occurredAt", "priorHeads", "reason",
    "retainedFactDigests", "schemaVersion", "sessionId",
  ];
  const actualCommandKeys = Object.keys(input).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (actualCommandKeys.length !== expectedCommandKeys.length
    || actualCommandKeys.some((key, index) => key !== expectedCommandKeys[index])) {
    throw new Error("provider_context_transition_invalid:fields");
  }
  if (input.schemaVersion !== "provider.context-transition-command/v1") {
    throw new Error("provider_context_transition_invalid:schemaVersion");
  }
  const session = runtime.sessionStateSignal.get()[input.sessionId];
  const binding = session?.actorBindings[input.actorKey];
  const current = binding?.providerEpochReceiptV2;
  const legacy = binding?.providerEpochReceipt;
  if (current && legacy) {
    throw new Error("provider_context_dual_authority_forbidden");
  }
  const mappedLegacyReason = legacy?.reason === "initial_projection"
    ? "initial_projection"
    : legacy?.reason === "model_control"
      ? "provider_model_profile_switch"
      : legacy?.reason === "recovery_rebuild"
        ? "legacy_context_import"
        : null;
  const legacyImport = !current && Boolean(legacy) && input.reason === mappedLegacyReason;
  if (!session || !binding || (!current && !legacyImport) || binding.actorId !== input.actorId) {
    throw new Error("provider_context_transition_predecessor_missing");
  }
  if (current?.receiptDigest === input.nextReceipt.receiptDigest) return current;
  const currentReceiptDigest = current?.receiptDigest
    ?? (legacy ? digestLegacyProviderEpochReceipt(legacy) : null);
  const currentEpoch = current?.epoch ?? legacy?.epoch ?? -1;
  if (!currentReceiptDigest) throw new Error("provider_context_transition_predecessor_missing");
  assertTransitionDigest(input.expectedEpochReceiptDigest, "expectedEpochReceiptDigest");
  if (input.expectedLatestAdmissionDigest !== null) {
    assertTransitionDigest(input.expectedLatestAdmissionDigest, "expectedLatestAdmissionDigest");
  }
  const latestAdmission = binding.providerRequestAdmissions?.at(-1) ?? null;
  const conversationRevision = binding.providerContextFactHead?.conversationRevision ?? 0;
  if (currentReceiptDigest !== input.expectedEpochReceiptDigest
    || (latestAdmission?.admissionDigest ?? null) !== input.expectedLatestAdmissionDigest
    || conversationRevision !== input.expectedConversationRevision) {
    throw new Error("provider_context_transition_expected_predecessor_conflict");
  }
  const currentHeads = providerContextAuthorityHeads(runtime, input.sessionId, input.actorKey);
  const currentMatchesExpectedBoundary = input.reason === "history_rewind_or_fork" || input.reason === "history_compaction"
    ? exactProviderContextHeads(currentHeads, input.priorHeads)
      || (currentHeads.historyHeadGenerationId === input.nextHeads.historyHeadGenerationId
        && currentHeads.promptHeadGenerationId === input.nextHeads.promptHeadGenerationId)
    : exactProviderContextHeads(currentHeads, input.priorHeads);
  if (!currentMatchesExpectedBoundary) {
    throw new Error("provider_context_transition_prior_heads_conflict");
  }
  const { receiptDigest, ...receiptFacts } = input.nextReceipt;
  const exactReceipt = createProviderEpochReceiptV2(receiptFacts);
  if (exactReceipt.receiptDigest !== receiptDigest
    || exactReceipt.sessionId !== input.sessionId
    || exactReceipt.actorKey !== input.actorKey
    || exactReceipt.actorId !== input.actorId
    || exactReceipt.epoch !== currentEpoch + 1
    || exactReceipt.previousReceiptDigest !== currentReceiptDigest
    || exactReceipt.reason !== input.reason
    || !exactProviderContextHeads(exactReceipt.baselineHeads, input.nextHeads)
    || exactReceipt.createdAt !== input.occurredAt) {
    throw new Error("provider_context_transition_successor_receipt_conflict");
  }
  if (input.nextHeads.factHeadDigest !== (input.nextFactHead?.factDigest ?? null)) {
    throw new Error("provider_context_transition_fact_head_conflict");
  }
  if (input.nextFactHead && (
    input.nextFactHead.sessionId !== input.sessionId
    || input.nextFactHead.actorKey !== input.actorKey
    || input.nextFactHead.actorId !== input.actorId
    || input.nextFactHead.epoch !== exactReceipt.epoch
  )) {
    throw new Error("provider_context_transition_fact_head_identity_conflict");
  }
  const allFactDigests = [...input.retainedFactDigests, ...input.appendedFactDigests];
  for (const [index, digest] of allFactDigests.entries()) assertTransitionDigest(digest, `factDigests[${index}]`);
  for (const [index, digest] of input.deliveryConfirmationDigests.entries()) {
    assertTransitionDigest(digest, `deliveryConfirmationDigests[${index}]`);
  }
  const priorFacts = new Map((session.contextAssets ?? []).flatMap((asset) => (
    asset.providerContextFact ? [[asset.providerContextFact.factDigest, asset.providerContextFact] as const] : []
  )));
  const stagedFacts = new Map((input.generation?.sessionIndex.session.contextAssets ?? []).flatMap((asset) => (
    asset.providerContextFact ? [[asset.providerContextFact.factDigest, asset.providerContextFact] as const] : []
  )));
  const knownFacts = new Map([...priorFacts, ...stagedFacts]);
  for (const digest of allFactDigests) {
    if (!knownFacts.has(digest)) throw new Error("provider_context_transition_fact_missing");
  }
  if (input.compactionProof === null) {
    if (input.reason === "history_compaction" || exactReceipt.compactionProofDigest !== null) {
      throw new Error("provider_context_transition_compaction_proof_missing");
    }
  } else {
    const { schemaVersion: _schemaVersion, proofDigest, ...proofFacts } = input.compactionProof;
    const exactProof = createProviderContextCompactionProof(proofFacts);
    if (exactProof.proofDigest !== proofDigest
      || input.reason !== "history_compaction"
      || exactReceipt.compactionProofDigest !== proofDigest
      || !current
      || exactProof.sourceEpoch !== current.epoch
      || exactProof.successorEpoch !== exactReceipt.epoch) {
      throw new Error("provider_context_transition_compaction_proof_conflict");
    }
    for (const retained of exactProof.retained) {
      const source = priorFacts.get(retained.sourceFactDigest);
      const successor = stagedFacts.get(retained.successorFactDigest);
      const delivery = source?.sourceDeliveryProofs[0];
      const admission = binding.providerRequestAdmissions?.find(
        (candidate) => candidate.admissionDigest === retained.requestAdmissionDigest,
      );
      const admittedRange = admission?.admittedFactRange ?? null;
      const admittedOffset = source && admittedRange ? source.sequence - admittedRange.firstSequence : -1;
      const exactFirstDelivery = delivery?.kind === "first-delivery-pair"
        && admission
        && admission.factAppendIntentDigest === retained.requestAdmissionIntentDigest
        && admittedRange
        && admittedOffset >= 0
        && admittedOffset < admittedRange.count
        && admittedRange.factDigests[admittedOffset] === source?.factDigest
        && admittedRange.lastSequence === admittedRange.firstSequence + admittedRange.count - 1
        && admission.currentHeads.factHeadDigest === admittedRange.factDigests.at(-1);
      const exactCompactedDelivery = delivery?.kind === "compacted-delivery-proof"
        && delivery.proofDigest === current.compactionProofDigest
        && delivery.sourceFactDigest === source?.previousFactDigest
        && delivery.requestAdmissionDigest === retained.requestAdmissionDigest;
      const successorProof = successor?.sourceDeliveryProofs[0];
      if (!source || !successor || !delivery
        || source.namespace !== retained.namespace
        || source.namespaceRevision !== retained.namespaceRevision
        || source.payloadDigest !== retained.payloadDigest
        || delivery.callRecordDigest !== retained.callRecordDigest
        || delivery.resultRecordDigest !== retained.resultRecordDigest
        || delivery.requestAdmissionIntentDigest !== retained.requestAdmissionIntentDigest
        || (!exactFirstDelivery && !exactCompactedDelivery)
        || successor.namespace !== source.namespace
        || successor.namespaceRevision !== source.namespaceRevision
        || successor.payloadDigest !== source.payloadDigest
        || successor.previousFactDigest !== source.factDigest
        || successor.epoch !== exactReceipt.epoch
        || successor.sourceDeliveryProofs.length !== 1
        || successorProof?.kind !== "compacted-delivery-proof"
        || successorProof.proofDigest !== exactProof.proofDigest
        || successorProof.sourceFactDigest !== source.factDigest
        || successorProof.callRecordDigest !== retained.callRecordDigest
        || successorProof.resultRecordDigest !== retained.resultRecordDigest
        || successorProof.requestAdmissionIntentDigest !== retained.requestAdmissionIntentDigest
        || successorProof.requestAdmissionDigest !== retained.requestAdmissionDigest) {
        throw new Error("provider_context_transition_compaction_retained_fact_conflict");
      }
    }
  }
  const providerChanged = current
    ? current.targetProviderId !== exactReceipt.targetProviderId
      || current.targetModelId !== exactReceipt.targetModelId
      || current.targetProfileId !== exactReceipt.targetProfileId
    : legacy
      ? legacy.targetProviderId !== exactReceipt.targetProviderId
        || legacy.targetProfileId !== exactReceipt.targetProfileId
      : false;
  const authorityChanged = !exactProviderContextHeads(input.priorHeads, input.nextHeads);
  const historyChanged = input.priorHeads.historyHeadGenerationId !== input.nextHeads.historyHeadGenerationId
    || input.priorHeads.promptHeadGenerationId !== input.nextHeads.promptHeadGenerationId;
  const resourceChanged = current ? current.frozenResourceDigest !== exactReceipt.frozenResourceDigest : false;
  const surfaceChanged = current ? current.providerSurfaceDigest !== exactReceipt.providerSurfaceDigest : false;
  if ((input.reason === "provider_model_profile_switch" && !providerChanged && !legacyImport)
    || (input.reason === "history_compaction" && !authorityChanged)
    || (input.reason === "history_rewind_or_fork" && !authorityChanged)
    || (input.reason === "frozen_resource_revision_accepted" && !resourceChanged)
    || (input.reason === "provider_surface_revision_accepted" && !surfaceChanged)
    || (input.reason === "initial_projection" && !legacyImport)
    || (input.reason === "legacy_context_import" && !legacyImport)) {
    throw new Error("provider_context_transition_reason_facts_mismatch");
  }
  if (historyChanged && input.generation === null) {
    throw new Error("provider_context_transition_generation_presence_conflict");
  }
  if (input.generation) {
    const generation = input.generation;
    const { transitionId, ...generationFacts } = generation;
    if (transitionId !== digestProviderContextClosedValue(generationFacts)) {
      throw new Error("provider_context_transition_generation_identity_conflict");
    }
    if (generation.schemaVersion !== "conversation.provider-context-transition-generation/v1"
      || generation.expectedEpochReceiptDigest !== currentReceiptDigest
      || generation.nextEpochReceiptDigest !== exactReceipt.receiptDigest
      || generation.sessionIndex.sessionId !== input.sessionId
      || generation.historyIndex.sessionId !== input.sessionId
      || generation.promptIndex.sessionId !== input.sessionId) {
      throw new Error("provider_context_transition_generation_conflict");
    }
    if (historyChanged && (
      generation.historyIndex.heads[input.actorKey]?.activeGenerationId !== input.nextHeads.historyHeadGenerationId
      || (generation.promptIndex.heads[input.actorKey]?.activePromptGenerationId ?? "__empty_prompt__")
        !== input.nextHeads.promptHeadGenerationId
    )) {
      throw new Error("provider_context_transition_generation_conflict");
    }
    const stagedBinding = generation.sessionIndex.session.actorBindings[input.actorKey];
    if (stagedBinding?.providerEpochReceiptV2?.receiptDigest !== exactReceipt.receiptDigest
      || (stagedBinding.providerContextFactHead?.factDigest ?? null) !== input.nextHeads.factHeadDigest
      || (stagedBinding.providerRequestAdmissions?.length ?? 0) !== 0) {
      throw new Error("provider_context_transition_generation_session_conflict");
    }
    if (stagedBinding.providerEpochReceipt !== undefined) {
      throw new Error("provider_context_dual_authority_forbidden");
    }
    const stagedHistoryId = input.nextHeads.historyHeadGenerationId;
    const currentHistory = runtime.historyStateSignal.get()[actorRuntimeKey(input.sessionId, input.actorKey)]
      ?.generations.find((candidate) => candidate.generationId === stagedHistoryId) ?? null;
    const stagedHistory = generation.historyGenerations.find(
      (candidate) => candidate.generationId === stagedHistoryId,
    ) ?? currentHistory;
    if (stagedHistoryId !== "__empty_history__" && (!stagedHistory
      || stagedHistory.sessionId !== input.sessionId
      || stagedHistory.actorKey !== input.actorKey
      || stagedHistory.actorId !== input.actorId
      || stagedHistory.messageCount !== stagedHistory.messages.length)) {
      throw new Error("provider_context_transition_history_generation_conflict");
    }
    const stagedMessages = stagedHistory?.messages ?? [];
    if (exactReceipt.sourceHistoryMessageCount > stagedMessages.length
      || digestProviderContextHistoryFrontier(
        stagedMessages.slice(0, exactReceipt.sourceHistoryMessageCount),
      ) !== exactReceipt.sourceFrontierDigest) {
      throw new Error("provider_context_transition_source_frontier_conflict");
    }
    if (legacyImport && (
      stagedBinding.providerEpochReceipt !== undefined
      || stagedBinding.providerContextLegacyMigrationMarker?.targetReceiptDigest !== exactReceipt.receiptDigest
      || stagedBinding.providerContextLegacyMigrationMarker?.sourceReceiptDigest !== currentReceiptDigest
    )) {
      throw new Error("provider_context_transition_legacy_marker_conflict");
    }
    const rawState = actorRawStateFromTransitionGeneration({
      current: runtime.actorRawStateSignal.get()[actorRuntimeKey(input.sessionId, input.actorKey)] ?? null,
      generation,
      sessionId: input.sessionId,
      actorKey: input.actorKey,
      actorId: input.actorId,
    });
    injectConversationActorRawState(runtime, rawState);
  }
  emitConversationDomainEvent(runtime, {
    type: "local_conversation_provider_context_epoch_transition_committed",
    sessionId: input.sessionId,
    actorKey: input.actorKey,
    actorId: input.actorId,
    command: input,
    receipt: exactReceipt,
    occurredAt: input.occurredAt,
  });
  return exactReceipt;
}

export function appendConversationDomainEvent(
  runtime: ConversationDomainRuntime,
  event: ConversationDomainEvent,
): void {
  advanceProviderContextEpochForHistoryMutation(runtime, event);
  const keyActor =
    "actorKey" in event && typeof event.actorKey === "string"
      ? actorRuntimeKey(event.sessionId, event.actorKey)
      : null;

  if (event.type.startsWith("actor_history_")) {
    runtime.historyEvents.push(event);
    trimMutableTail(runtime.historyEvents, MAX_CONVERSATION_DOMAIN_EVENTS_PER_STREAM);
    if (!keyActor) return;
    const current = runtime.historyStateSignal.get()[keyActor];
    if (event.type === "actor_history_generation_created") {
      const nextGeneration: ActorHistoryGenerationData = event.generation ?? {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        generationId: event.generationId,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: current?.actorId ?? "",
        parentGenerationId: null,
        predecessorGenerationIds: [],
        createdReason: "append",
        sealed: false,
        messageCount: 0,
        messages: [],
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
      };
      runtime.historyStateSignal.set({
        ...runtime.historyStateSignal.get(),
        [keyActor]: {
          sessionId: event.sessionId,
          actorKey: event.actorKey,
          actorId: current?.actorId ?? "",
          generations: upsertHistoryGeneration(current?.generations ?? [], nextGeneration),
          activeGenerationId: current?.activeGenerationId ?? event.generationId,
          lastCompaction: current?.lastCompaction ?? null,
          resetReason: current?.resetReason ?? null,
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: nextGeneration.actorId,
      });
      return;
    }
    if (event.type === "actor_history_generation_sealed" && current) {
      const sealedGeneration = event.generation
        ? {
            ...event.generation,
            sealed: true,
            updatedAt: event.occurredAt,
          }
        : null;
      runtime.historyStateSignal.set({
        ...runtime.historyStateSignal.get(),
        [keyActor]: {
          ...current,
          generations: sealedGeneration
            ? upsertHistoryGeneration(current.generations, sealedGeneration)
            : current.generations.map((generation) =>
                generation.generationId === event.generationId
                  ? {
                      ...generation,
                      sealed: true,
                      updatedAt: event.occurredAt,
                    }
                  : generation,
              ),
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
      });
      return;
    }
    if (event.type === "actor_history_head_moved") {
      const activeGenerationId = event.head?.activeGenerationId ?? event.activeGenerationId;
      runtime.historyStateSignal.set({
        ...runtime.historyStateSignal.get(),
        [keyActor]: {
          sessionId: event.sessionId,
          actorKey: event.actorKey,
          actorId: event.head?.actorId ?? current?.actorId ?? "",
          generations: current?.generations ?? [],
          activeGenerationId,
          lastCompaction: current?.lastCompaction ?? null,
          resetReason: current?.resetReason ?? null,
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: event.head?.actorId,
      });
      return;
    }
    if (event.type === "actor_history_reset") {
      runtime.historyStateSignal.set({
        ...runtime.historyStateSignal.get(),
        [keyActor]: {
          sessionId: event.sessionId,
          actorKey: event.actorKey,
          actorId: event.actorId ?? current?.actorId ?? "",
          generations: [],
          activeGenerationId: null,
          lastCompaction: null,
          resetReason: event.reason,
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: event.actorId,
      });
      return;
    }
    if (event.type === "actor_history_compaction_applied" && current) {
      const nextActiveGenerationId =
        event.head?.activeGenerationId
        ?? event.generation?.generationId
        ?? current.activeGenerationId
        ?? event.targetGenerationId;
      runtime.historyStateSignal.set({
        ...runtime.historyStateSignal.get(),
        [keyActor]: {
          ...current,
          generations: event.generation
            ? upsertHistoryGeneration(current.generations, event.generation)
            : current.generations,
          activeGenerationId: nextActiveGenerationId,
          lastCompaction: {
            sourceGenerationIds: [...event.sourceGenerationIds],
            targetGenerationId: event.targetGenerationId,
            summaryText: event.summaryText ?? null,
            artifactId: event.artifactId ?? null,
            appliedAt: event.occurredAt,
          },
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: event.actorId,
      });
      return;
    }
    if (event.type === "actor_history_appended" && current?.activeGenerationId && event.message) {
      const activeGenerationId =
        event.head?.activeGenerationId
        ?? event.generation?.generationId
        ?? current.activeGenerationId;
      const generation =
        event.generation
        ?? current.generations.find((item) => item.generationId === activeGenerationId)
        ?? {
          version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
          generationId: activeGenerationId,
          sessionId: current.sessionId,
          actorKey: current.actorKey,
          actorId: current.actorId,
          parentGenerationId: null,
          predecessorGenerationIds: [],
          createdReason: "append",
          sealed: false,
          messageCount: 0,
          messages: [],
          createdAt: event.occurredAt,
          updatedAt: event.occurredAt,
        };
      if (generation.messages.some((message) => message.recordId === event.messageRecordId)) {
        return;
      }
      const nextGeneration = appendCommittedMessageToGeneration({
        generation,
        message: event.message as ConversationCommittedMessageData,
        actorKey: current.actorKey,
        actorId: current.actorId,
      });
      runtime.historyStateSignal.set({
        ...runtime.historyStateSignal.get(),
        [keyActor]: {
          ...current,
          generations: upsertHistoryGeneration(current.generations, nextGeneration),
          activeGenerationId,
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
      });
    }
    return;
  }

  if (event.type.startsWith("actor_prompt_")) {
    runtime.promptEvents.push(event);
    trimMutableTail(runtime.promptEvents, MAX_CONVERSATION_DOMAIN_EVENTS_PER_STREAM);
    if (!keyActor) return;
    const current = runtime.promptStateSignal.get()[keyActor] ?? {
      sessionId: event.sessionId,
      actorKey: "actorKey" in event ? event.actorKey : "",
      actorId: "",
      generations: [],
      activePromptGenerationId: null,
      resetReason: null,
      updatedAt: event.occurredAt,
    };
    if (event.type === "actor_prompt_generation_created") {
      const nextGeneration: ActorPromptGenerationData = event.generation ?? {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        promptGenerationId: event.promptGenerationId,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: current.actorId,
        basedOnPromptGenerationId: current.activePromptGenerationId ?? null,
        basis: {
          version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
          basisHistoryGenerationIds: [],
          basisMessageRecordIds: [],
          basisRefs: [],
        },
        transforms: [],
        createdReason: "unknown",
        materializedContext: null,
        sealed: false,
        createdAt: event.occurredAt,
        sealedAt: null,
        updatedAt: event.occurredAt,
        metadata: {},
      };
      runtime.promptStateSignal.set({
        ...runtime.promptStateSignal.get(),
        [keyActor]: {
          ...current,
          generations: upsertPromptGeneration(current.generations, nextGeneration),
          activePromptGenerationId: current.activePromptGenerationId ?? event.promptGenerationId,
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: nextGeneration.actorId,
      });
      return;
    }
    if (event.type === "actor_prompt_basis_selected") {
      runtime.promptStateSignal.set({
        ...runtime.promptStateSignal.get(),
        [keyActor]: {
          ...current,
          generations: current.generations.map((generation) =>
            generation.promptGenerationId === event.promptGenerationId
              ? {
                  ...generation,
                  basis: {
                    ...generation.basis,
                    basisHistoryGenerationIds: [...event.basisHistoryGenerationIds],
                    basisMessageRecordIds: [...(event.basisMessageRecordIds ?? [])],
                    basisRefs: [...(event.basisRefs ?? [])],
                  },
                  updatedAt: event.occurredAt,
                }
              : generation,
          ),
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
      });
      return;
    }
    if (event.type === "actor_prompt_transform_applied") {
      runtime.promptStateSignal.set({
        ...runtime.promptStateSignal.get(),
        [keyActor]: {
          ...current,
          generations: current.generations.map((generation) =>
            generation.promptGenerationId === event.promptGenerationId
                ? {
                  ...generation,
                  transforms: [
                    ...generation.transforms.filter((transform) => transform.transformId !== event.transformId),
                    (
                      event.transform
                      ?? {
                          transformId: event.transformId,
                          kind: event.transformKind,
                          payload: event.payload ?? {},
                          appliedAt: event.occurredAt,
                        }
                    ) as ActorPromptTransformData,
                  ],
                  updatedAt: event.occurredAt,
                }
              : generation,
          ),
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
      });
      return;
    }
    if (event.type === "actor_prompt_generation_sealed") {
      runtime.promptStateSignal.set({
        ...runtime.promptStateSignal.get(),
        [keyActor]: {
          ...current,
          generations: current.generations.map((generation) =>
            generation.promptGenerationId === event.promptGenerationId
              ? {
                  ...generation,
                  sealed: true,
                  sealedAt: event.occurredAt,
                  updatedAt: event.occurredAt,
                }
              : generation,
          ),
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
      });
      return;
    }
    if (event.type === "actor_prompt_head_moved") {
      const activePromptGenerationId = event.head?.activePromptGenerationId ?? event.activePromptGenerationId;
      runtime.promptStateSignal.set({
        ...runtime.promptStateSignal.get(),
        [keyActor]: {
          ...current,
          actorId: event.head?.actorId ?? current.actorId,
          activePromptGenerationId,
          updatedAt: event.occurredAt,
        },
      });
      const session = runtime.sessionStateSignal.get()[event.sessionId] ?? createEmptySessionState(event.sessionId);
      const binding = session.actorBindings[event.actorKey];
      const promptHead = event.head ?? {
        version: session.promptIndex.version,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: current.actorId,
        activePromptGenerationId,
        updatedAt: event.occurredAt,
      };
      const actorBindings = binding
        ? {
            ...session.actorBindings,
            [event.actorKey]: {
              ...binding,
              promptHeadGenerationId: activePromptGenerationId,
            },
          }
        : session.actorBindings;
      const promptIndex = {
        ...session.promptIndex,
        heads: {
          ...session.promptIndex.heads,
          [event.actorKey]: promptHead,
        },
        updatedAt: event.occurredAt,
      };
      const sessionIndex = {
        ...session.sessionIndex,
        session: {
          ...session.sessionIndex.session,
          actorBindings,
          updatedAt: event.occurredAt,
        },
        updatedAt: event.occurredAt,
      };
      runtime.sessionStateSignal.set({
        ...runtime.sessionStateSignal.get(),
        [event.sessionId]: {
          ...session,
          actorBindings,
          promptIndex,
          sessionIndex,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: event.head?.actorId,
      });
      return;
    }
    if (event.type === "actor_prompt_reset") {
      runtime.promptStateSignal.set({
        ...runtime.promptStateSignal.get(),
        [keyActor]: {
          sessionId: event.sessionId,
          actorKey: event.actorKey,
          actorId: event.actorId ?? current.actorId,
          generations: [],
          activePromptGenerationId: null,
          resetReason: event.reason,
          updatedAt: event.occurredAt,
        },
      });
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey: event.actorKey,
        actorId: event.actorId,
      });
      return;
    }
    return;
  }

  runtime.sessionEvents.push(event);
  trimMutableTail(runtime.sessionEvents, MAX_CONVERSATION_DOMAIN_EVENTS_PER_STREAM);
  const currentSession = runtime.sessionStateSignal.get()[event.sessionId] ?? createEmptySessionState(event.sessionId);
  if (event.type === "local_conversation_session_created") {
    const admittedActorBindings = event.session
      ? Object.fromEntries([...new Set([
          ...Object.keys(currentSession.actorBindings),
          ...Object.keys(event.session.actorBindings),
        ])].map((actorKey) => [
          actorKey,
          {
            ...(currentSession.actorBindings[actorKey] ?? {}),
            ...(event.session!.actorBindings[actorKey] ?? {}),
            providerEpochReceiptV2:
              event.session!.actorBindings[actorKey]?.providerEpochReceiptV2
              ?? currentSession.actorBindings[actorKey]?.providerEpochReceiptV2,
            providerRequestAdmissions:
              event.session!.actorBindings[actorKey]?.providerRequestAdmissions
              ?? currentSession.actorBindings[actorKey]?.providerRequestAdmissions,
            providerContextFactHead: event.session!.actorBindings[actorKey]
              && Object.prototype.hasOwnProperty.call(event.session!.actorBindings[actorKey], "providerContextFactHead")
              ? event.session!.actorBindings[actorKey]?.providerContextFactHead
              : currentSession.actorBindings[actorKey]?.providerContextFactHead,
          },
        ]))
      : currentSession.actorBindings;
    const nextSession = event.session
      ? {
          ...currentSession,
          activeActorKey: event.session.activeActorKey ?? null,
          actorBindings: admittedActorBindings,
          contextAssetRegistry: event.session.contextAssetRegistry ?? null,
          contextAssets: event.session.contextAssets ?? [],
          activeSelection: event.session.activeSelection ?? null,
          sessionIndex: {
            ...currentSession.sessionIndex,
            updatedAt: event.occurredAt,
            session: { ...event.session, actorBindings: admittedActorBindings },
          },
        }
      : {
          ...currentSession,
          sessionIndex: {
            ...currentSession.sessionIndex,
            updatedAt: event.occurredAt,
            session: {
              ...currentSession.sessionIndex.session,
              createdAt: event.occurredAt,
              updatedAt: event.occurredAt,
            },
          },
        };
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: nextSession,
    });
    return;
  }
  if (event.type === "local_conversation_session_forked") {
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        lineage: event.lineage ?? currentSession.lineage,
        sessionIndex: {
          ...currentSession.sessionIndex,
          lineage: event.lineage ?? currentSession.sessionIndex.lineage,
          updatedAt: event.occurredAt,
        },
      },
    });
    return;
  }
  if (event.type === "local_conversation_session_closed") {
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        activeActorKey: event.session?.activeActorKey ?? currentSession.activeActorKey,
        actorBindings: event.session?.actorBindings ?? currentSession.actorBindings,
        contextAssetRegistry: event.session?.contextAssetRegistry ?? currentSession.contextAssetRegistry,
        contextAssets: event.session?.contextAssets ?? currentSession.contextAssets,
        activeSelection: event.session?.activeSelection ?? currentSession.activeSelection,
        sessionIndex: {
          ...currentSession.sessionIndex,
          updatedAt: event.occurredAt,
          session: {
            ...(event.session ?? currentSession.sessionIndex.session),
            updatedAt: event.occurredAt,
          },
        },
      },
    });
    return;
  }
  if (event.type === "local_conversation_session_head_selected") {
    const nextSelection = event.selection ?? {
      sessionId: event.sessionId,
      activeActorKey: event.activeActorKey,
      historyHeadGenerationId: currentSession.activeSelection?.historyHeadGenerationId ?? null,
      promptHeadGenerationId: currentSession.activeSelection?.promptHeadGenerationId ?? null,
      selectedAt: event.occurredAt,
      metadata: currentSession.activeSelection?.metadata,
    };
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        activeActorKey: event.session?.activeActorKey ?? event.activeActorKey,
        actorBindings: event.session?.actorBindings ?? currentSession.actorBindings,
        contextAssetRegistry: event.session?.contextAssetRegistry ?? currentSession.contextAssetRegistry,
        contextAssets: event.session?.contextAssets ?? currentSession.contextAssets,
        activeSelection: nextSelection,
        sessionIndex: {
          ...currentSession.sessionIndex,
          updatedAt: event.occurredAt,
          session: {
            ...(event.session ?? currentSession.sessionIndex.session),
            activeActorKey: event.session?.activeActorKey ?? event.activeActorKey,
            activeSelection: nextSelection,
            updatedAt: event.occurredAt,
          },
        },
      },
    });
    refreshConversationActorRawStateFromDomainState({
      runtime,
      sessionId: event.sessionId,
      actorKey: event.activeActorKey,
    });
    return;
  }
  if (event.type === "local_conversation_session_actor_bound") {
    const currentBinding = currentSession.actorBindings[event.actorKey];
    const projectedBinding = event.binding ?? {
      actorKey: event.actorKey,
      actorId: event.actorId,
      actorName: event.actorName ?? null,
      actorKind: event.actorKind ?? null,
      boundAt: event.occurredAt,
      historyHeadGenerationId: event.historyHeadGenerationId ?? null,
      promptHeadGenerationId: event.promptHeadGenerationId ?? null,
      metadata: currentSession.actorBindings[event.actorKey]?.metadata,
    };
    const nextBinding = {
      ...currentBinding,
      ...projectedBinding,
      providerEpochReceiptV2:
        projectedBinding.providerEpochReceiptV2 ?? currentBinding?.providerEpochReceiptV2,
      providerRequestAdmissions:
        projectedBinding.providerRequestAdmissions ?? currentBinding?.providerRequestAdmissions,
      providerContextFactHead: Object.prototype.hasOwnProperty.call(projectedBinding, "providerContextFactHead")
        ? projectedBinding.providerContextFactHead
        : currentBinding?.providerContextFactHead,
    };
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        actorBindings: {
          ...currentSession.actorBindings,
          [event.actorKey]: nextBinding,
        },
        sessionIndex: {
          ...currentSession.sessionIndex,
          updatedAt: event.occurredAt,
          session: {
            ...currentSession.sessionIndex.session,
            actorBindings: {
              ...currentSession.sessionIndex.session.actorBindings,
              [event.actorKey]: nextBinding,
            },
            updatedAt: event.occurredAt,
          },
        },
      },
    });
    refreshConversationActorRawStateFromDomainState({
      runtime,
      sessionId: event.sessionId,
      actorKey: event.actorKey,
      actorId: nextBinding.actorId,
    });
    return;
  }
  if (event.type === "local_conversation_session_lineage_updated") {
    const nextLineage = event.lineage ?? {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId: event.sessionId,
      parentSessionId: event.parentSessionId ?? null,
      forkedFromGenerationId: event.forkedFromGenerationId ?? null,
      rolledBackFromSessionId: event.rolledBackFromSessionId ?? null,
      predecessorSessionIds: currentSession.lineage?.predecessorSessionIds ?? [],
      forkSessionIds: currentSession.lineage?.forkSessionIds ?? [],
      updatedAt: event.occurredAt,
    };
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        lineage: nextLineage,
        sessionIndex: {
          ...currentSession.sessionIndex,
          lineage: nextLineage,
          updatedAt: event.occurredAt,
        },
      },
    });
    return;
  }
  if (event.type === "local_conversation_session_active_selection_updated") {
    const nextSelection = event.selection ?? {
      sessionId: event.sessionId,
      activeActorKey: event.activeActorKey,
      historyHeadGenerationId: event.historyHeadGenerationId ?? null,
      promptHeadGenerationId: event.promptHeadGenerationId ?? null,
      selectedAt: event.occurredAt,
      metadata: currentSession.activeSelection?.metadata,
    };
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        activeActorKey: event.activeActorKey,
        activeSelection: nextSelection,
        sessionIndex: {
          ...currentSession.sessionIndex,
          updatedAt: event.occurredAt,
          session: {
            ...currentSession.sessionIndex.session,
            activeActorKey: event.activeActorKey,
            activeSelection: nextSelection,
            updatedAt: event.occurredAt,
          },
        },
      },
    });
    refreshConversationActorRawStateFromDomainState({
      runtime,
      sessionId: event.sessionId,
      actorKey: event.activeActorKey,
    });
    return;
  }
  if (event.type === "local_conversation_context_asset_registered") {
    const nextAssets = [
      ...(currentSession.contextAssets ?? []).filter((asset) => asset.assetId !== event.assetId),
      ...(event.asset ? [event.asset] : []),
    ];
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        contextAssetRegistry: {
          version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
          assetIds: [...new Set([...(currentSession.contextAssetRegistry?.assetIds ?? []), event.assetId])],
          updatedAt: event.occurredAt,
        },
        contextAssets: nextAssets,
        sessionIndex: {
          ...currentSession.sessionIndex,
          updatedAt: event.occurredAt,
          session: {
            ...currentSession.sessionIndex.session,
            contextAssetRegistry: {
              version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
              assetIds: [...new Set([...(currentSession.contextAssetRegistry?.assetIds ?? []), event.assetId])],
              updatedAt: event.occurredAt,
            },
            contextAssets: nextAssets,
            updatedAt: event.occurredAt,
          },
        },
      },
    });
    const actorKeys = Object.keys(currentSession.actorBindings);
    for (const actorKey of actorKeys) {
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey,
      });
    }
    return;
  }
  if (event.type === "local_conversation_provider_context_fact_appended") {
    const nextAssets = [
      ...(currentSession.contextAssets ?? []).filter((asset) => asset.assetId !== event.assetId),
      event.asset,
    ];
    const nextBinding = {
      ...(currentSession.actorBindings[event.actorKey] ?? {
        actorKey: event.actorKey,
        actorId: event.head.actorId,
        boundAt: event.occurredAt,
      }),
      providerContextFactHead: event.head,
    };
    const nextRegistry = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      assetIds: [...new Set([...(currentSession.contextAssetRegistry?.assetIds ?? []), event.assetId])],
      updatedAt: event.occurredAt,
    };
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        actorBindings: { ...currentSession.actorBindings, [event.actorKey]: nextBinding },
        contextAssetRegistry: nextRegistry,
        contextAssets: nextAssets,
        sessionIndex: {
          ...currentSession.sessionIndex,
          updatedAt: event.occurredAt,
          session: {
            ...currentSession.sessionIndex.session,
            actorBindings: {
              ...currentSession.sessionIndex.session.actorBindings,
              [event.actorKey]: nextBinding,
            },
            contextAssetRegistry: nextRegistry,
            contextAssets: nextAssets,
            updatedAt: event.occurredAt,
          },
        },
      },
    });
    refreshConversationActorRawStateFromDomainState({
      runtime,
      sessionId: event.sessionId,
      actorKey: event.actorKey,
      actorId: event.head.actorId,
    });
    return;
  }
  if (event.type === "local_conversation_provider_context_delivery_committed") {
    const replacements = new Map(
      [...event.candidateAssets, ...event.factAssets].map((asset) => [asset.assetId, asset]),
    );
    const nextAssets = [
      ...(currentSession.contextAssets ?? []).filter((asset) => !replacements.has(asset.assetId)),
      ...replacements.values(),
    ];
    const currentBinding = currentSession.actorBindings[event.actorKey] ?? {
      actorKey: event.actorKey,
      actorId: event.head.actorId,
      boundAt: event.occurredAt,
    };
    const nextBinding = {
      ...currentBinding,
      providerContextFactHead: event.head,
      providerRequestAdmissions: [
        ...(currentBinding.providerRequestAdmissions ?? []),
        event.admission,
      ],
    };
    const nextRegistry = {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      assetIds: [...new Set([
        ...(currentSession.contextAssetRegistry?.assetIds ?? []),
        ...replacements.keys(),
      ])],
      updatedAt: event.occurredAt,
    };
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        actorBindings: { ...currentSession.actorBindings, [event.actorKey]: nextBinding },
        contextAssetRegistry: nextRegistry,
        contextAssets: nextAssets,
        sessionIndex: {
          ...currentSession.sessionIndex,
          updatedAt: event.occurredAt,
          session: {
            ...currentSession.sessionIndex.session,
            actorBindings: {
              ...currentSession.sessionIndex.session.actorBindings,
              [event.actorKey]: nextBinding,
            },
            contextAssetRegistry: nextRegistry,
            contextAssets: nextAssets,
            updatedAt: event.occurredAt,
          },
        },
      },
    });
    refreshConversationActorRawStateFromDomainState({
      runtime,
      sessionId: event.sessionId,
      actorKey: event.actorKey,
      actorId: event.head.actorId,
    });
    return;
  }
  if (event.type === "local_conversation_provider_request_admitted") {
    const currentBinding = currentSession.actorBindings[event.actorKey] ?? {
      actorKey: event.actorKey,
      actorId: event.actorId,
      boundAt: event.occurredAt,
    };
    const nextBinding = {
      ...currentBinding,
      providerRequestAdmissions: [
        ...(currentBinding.providerRequestAdmissions ?? []),
        event.admission,
      ],
    };
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        actorBindings: { ...currentSession.actorBindings, [event.actorKey]: nextBinding },
        sessionIndex: {
          ...currentSession.sessionIndex,
          updatedAt: event.occurredAt,
          session: {
            ...currentSession.sessionIndex.session,
            actorBindings: {
              ...currentSession.sessionIndex.session.actorBindings,
              [event.actorKey]: nextBinding,
            },
            updatedAt: event.occurredAt,
          },
        },
      },
    });
    refreshConversationActorRawStateFromDomainState({
      runtime,
      sessionId: event.sessionId,
      actorKey: event.actorKey,
      actorId: event.actorId,
    });
    return;
  }
  if (event.type === "local_conversation_provider_context_epoch_transition_committed") {
    const currentBinding = currentSession.actorBindings[event.actorKey] ?? {
      actorKey: event.actorKey,
      actorId: event.actorId,
      boundAt: event.occurredAt,
    };
    const stagedBinding = event.command.generation?.sessionIndex.session.actorBindings[event.actorKey];
    const nextBinding = {
      ...currentBinding,
      actorId: event.actorId,
      contextEpoch: event.receipt.epoch,
      historyHeadGenerationId: event.command.nextHeads.historyHeadGenerationId,
      promptHeadGenerationId: event.command.nextHeads.promptHeadGenerationId,
      providerContextFactHead: event.command.nextFactHead,
      providerEpochReceiptV2: event.receipt,
      providerRequestAdmissions: Object.freeze([]),
      ...(stagedBinding?.providerContextLegacyMigrationMarker
        ? {
            providerEpochReceipt: undefined,
            providerContextLegacyMigrationMarker: stagedBinding?.providerContextLegacyMigrationMarker,
          }
        : {}),
    };
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        actorBindings: { ...currentSession.actorBindings, [event.actorKey]: nextBinding },
        sessionIndex: {
          ...currentSession.sessionIndex,
          updatedAt: event.occurredAt,
          session: {
            ...currentSession.sessionIndex.session,
            actorBindings: {
              ...currentSession.sessionIndex.session.actorBindings,
              [event.actorKey]: nextBinding,
            },
            updatedAt: event.occurredAt,
          },
        },
      },
    });
    refreshConversationActorRawStateFromDomainState({
      runtime,
      sessionId: event.sessionId,
      actorKey: event.actorKey,
      actorId: event.actorId,
    });
    return;
  }
  if (event.type === "local_conversation_context_asset_removed") {
    const nextAssetIds = (currentSession.contextAssetRegistry?.assetIds ?? []).filter((assetId) => assetId !== event.assetId);
    const nextAssets = (currentSession.contextAssets ?? []).filter((asset) => asset.assetId !== event.assetId);
    runtime.sessionStateSignal.set({
      ...runtime.sessionStateSignal.get(),
      [event.sessionId]: {
        ...currentSession,
        activeActorKey: event.session?.activeActorKey ?? currentSession.activeActorKey,
        actorBindings: event.session?.actorBindings ?? currentSession.actorBindings,
        contextAssetRegistry: event.session?.contextAssetRegistry ?? (currentSession.contextAssetRegistry
          ? {
              ...currentSession.contextAssetRegistry,
              assetIds: nextAssetIds,
              updatedAt: event.occurredAt,
            }
          : null),
        contextAssets: event.session?.contextAssets ?? nextAssets,
        sessionIndex: {
          ...currentSession.sessionIndex,
          updatedAt: event.occurredAt,
          session: {
            ...(event.session ?? currentSession.sessionIndex.session),
            contextAssetRegistry: event.session?.contextAssetRegistry ?? (currentSession.contextAssetRegistry
              ? {
                  ...currentSession.contextAssetRegistry,
                  assetIds: nextAssetIds,
                  updatedAt: event.occurredAt,
                }
              : null),
            contextAssets: event.session?.contextAssets ?? nextAssets,
            updatedAt: event.occurredAt,
          },
        },
      },
    });
    const actorKeys = Object.keys(currentSession.actorBindings);
    for (const actorKey of actorKeys) {
      refreshConversationActorRawStateFromDomainState({
        runtime,
        sessionId: event.sessionId,
        actorKey,
      });
    }
  }
}

export function emitConversationDomainEvent(
  runtime: ConversationDomainRuntime,
  event: ConversationDomainEvent,
): void {
  appendConversationDomainEvent(runtime, event);
  if (event.type.startsWith("actor_history_")) {
    const historyEvent = event as ConversationHistoryDomainEvent;
    runtime.persistHooks.history?.(historyEvent);
    notifyListeners(runtime.historyListeners, historyEvent);
    return;
  }
  if (event.type.startsWith("actor_prompt_")) {
    const promptEvent = event as ConversationPromptDomainEvent;
    runtime.persistHooks.prompt?.(promptEvent);
    notifyListeners(runtime.promptListeners, promptEvent);
    return;
  }
  const sessionEvent = event as ConversationSessionDomainEvent;
  runtime.persistHooks.session?.(sessionEvent);
  notifyListeners(runtime.sessionListeners, sessionEvent);
}

export function appendLiveHistoryMessageToConversationDomainRuntime(params: {
  vm: AiAgentVm;
  actorKey: string;
  actorId: string;
  message: ChatMessage;
  occurredAt?: string;
}): string {
  const runtime = ensureVmConversationDomainRuntime(params.vm);
  const sessionId = resolveSessionIdFromVm(params.vm);
  const key = actorRuntimeKey(sessionId, params.actorKey);
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const messageAssemblyStates = runtime.messageAssemblySignal.get();
  const currentAssembly = messageAssemblyStates[key] ?? {
    sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    transcriptRecords: [],
    reducedMessages: [],
    emittedMessageCount: 0,
    updatedAt: new Date(0).toISOString(),
  };
  const nextReducedMessages = appendBounded(
    currentAssembly.reducedMessages,
    params.message,
    MAX_MESSAGE_ASSEMBLY_REDUCED_MESSAGES,
  );
  runtime.messageAssemblySignal.set({
    ...messageAssemblyStates,
    [key]: {
      ...currentAssembly,
      actorId: params.actorId,
      reducedMessages: nextReducedMessages,
      emittedMessageCount: currentAssembly.emittedMessageCount + 1,
      updatedAt: occurredAt,
    },
  });
  const { nextHistoryState, nextSession, nextGeneration } = applyCommittedMessageAppendToDomains({
    historyStates: runtime.historyStateSignal.get(),
    sessionStates: runtime.sessionStateSignal.get(),
    sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    message: params.message,
    occurredAt,
  });
  runtime.historyStateSignal.set({
    ...runtime.historyStateSignal.get(),
    [key]: nextHistoryState,
  });
  runtime.sessionStateSignal.set({
    ...runtime.sessionStateSignal.get(),
    [sessionId]: nextSession,
  });

  const actorRawStates = runtime.actorRawStateSignal.get();
  const currentActorRaw = actorRawStates[key];
  const nextVisibleGenerations = upsertHistoryGeneration(
    currentActorRaw?.visibleHistoryGenerations ?? [],
    nextGeneration,
  );
  runtime.actorRawStateSignal.set({
    ...actorRawStates,
    [key]: {
      session: nextSession,
      actorKey: params.actorKey,
      actorId: params.actorId,
      historyHeadGenerationId: nextGeneration.generationId,
      promptHeadGenerationId:
        currentActorRaw?.promptHeadGenerationId
        ?? nextSession.actorBindings[params.actorKey]?.promptHeadGenerationId
        ?? null,
      visibleGenerationIds: nextVisibleGenerations.map((generation) => generation.generationId),
      visibleHistoryGenerations: nextVisibleGenerations,
      activeHistoryGeneration: nextGeneration,
      promptGeneration: currentActorRaw?.promptGeneration ?? null,
      contextAssetIds:
        currentActorRaw?.contextAssetIds
        ?? nextSession.contextAssetRegistry?.assetIds
        ?? [],
    },
  });

  emitConversationDomainEvent(runtime, {
    type: "actor_history_appended",
    sessionId,
    actorKey: params.actorKey,
    generationId: nextGeneration.generationId,
    messageRecordId: `${nextGeneration.generationId}::${nextGeneration.messages.length - 1}`,
    message: toCommittedConversationMessage(params.message),
    generation: nextGeneration,
    head: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      actorKey: params.actorKey,
      actorId: params.actorId,
      activeGenerationId: nextGeneration.generationId,
      visibleGenerationIds: nextVisibleGenerations.map((generation) => generation.generationId),
      updatedAt: nextGeneration.updatedAt,
    },
    occurredAt: nextGeneration.updatedAt,
  });
  const appended = nextGeneration.messages[nextGeneration.messages.length - 1]!;
  return appended.message.messageId ?? appended.recordId;
}

/**
 * In-place domain transform over the ACTIVE history generation (track
 * refactor-ai-semantic-conversation-spine, task T4.3): apply a pure,
 * positional (1:1) message rewrite — e.g. cheap tool-result compaction — to
 * the committed messages of the active generation and publish the rewritten
 * immutable successor generation through an
 * `actor_history_compaction_applied` domain event. The History domain stays the single
 * provider-context truth: the materialization picks the rewrite up on the
 * next build without any raw-array involvement.
 */
export function rewriteActiveHistoryGenerationMessagesInConversationDomainRuntime(params: {
  vm: AiAgentVm;
  actorKey: string;
  actorId?: string;
  /** Diagnostic tag recorded in the thrown error on a non-positional rewrite. */
  reason: string;
  /** Pure rewrite; return null to signal "no change". Must keep message count. */
  rewrite: (messages: ChatMessage[]) => ChatMessage[] | null;
  occurredAt?: string;
}): { changed: boolean } {
  const runtime = getVmConversationDomainRuntime(params.vm);
  if (!runtime) return { changed: false };
  const sessionId = resolveSessionIdFromVm(params.vm);
  const key = actorRuntimeKey(sessionId, params.actorKey);
  const historyState = runtime.historyStateSignal.get()[key];
  const activeGenerationId = historyState?.activeGenerationId;
  if (!historyState || !activeGenerationId) return { changed: false };
  const generation = historyState.generations.find((item) => item.generationId === activeGenerationId);
  if (!generation || generation.messages.length === 0) return { changed: false };

  const currentMessages = committedHistoryRefsToMessages(generation.messages);
  const rewrittenMessages = params.rewrite(currentMessages);
  if (!rewrittenMessages) return { changed: false };
  if (rewrittenMessages.length !== generation.messages.length) {
    throw new Error(
      `active history generation rewrite must be positional (1:1): produced ${rewrittenMessages.length} `
        + `messages for ${generation.messages.length} committed records (${params.reason})`,
    );
  }

  let changed = false;
  const nextRefs = generation.messages.map((ref, index) => {
    const nextMessage = rewrittenMessages[index]!;
    if (JSON.stringify(nextMessage) === JSON.stringify(currentMessages[index])) {
      return ref;
    }
    changed = true;
    return { ...ref, message: toCommittedConversationMessage(nextMessage) };
  });
  if (!changed) return { changed: false };

  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const generationDigest = createHash("sha256").update(JSON.stringify({
    schemaVersion: "conversation.positional-history-compaction/v1",
    sessionId,
    actorKey: params.actorKey,
    sourceGenerationId: generation.generationId,
    reason: params.reason,
    messages: nextRefs,
  }), "utf8").digest("hex");
  const nextGeneration: ActorHistoryGenerationData = {
    ...generation,
    generationId: `history-compaction-${generationDigest}`,
    parentGenerationId: generation.generationId,
    predecessorGenerationIds: [generation.generationId],
    createdReason: "compaction",
    messages: nextRefs,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  emitConversationDomainEvent(runtime, {
    type: "actor_history_compaction_applied",
    sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    sourceGenerationIds: [generation.generationId],
    targetGenerationId: nextGeneration.generationId,
    summaryText: null,
    artifactId: null,
    generation: nextGeneration,
    occurredAt,
  });
  return { changed: true };
}

export function recordConversationTranscriptEvidenceInRuntime(params: {
  vm: AiAgentVm;
  actorKey: string;
  actorId: string;
  transcriptRecord: TranscriptRecord;
}): void {
  const runtime = ensureVmConversationDomainRuntime(params.vm);
  const sessionId = resolveSessionIdFromVm(params.vm);
  const key = actorRuntimeKey(sessionId, params.actorKey);
  const current = runtime.messageAssemblySignal.get()[key] ?? {
    sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    transcriptRecords: [],
    reducedMessages: [],
    emittedMessageCount: 0,
    updatedAt: new Date(0).toISOString(),
  };
  runtime.messageAssemblySignal.set({
    ...runtime.messageAssemblySignal.get(),
    [key]: {
      ...current,
      actorId: params.actorId,
      transcriptRecords: appendBounded(
        current.transcriptRecords,
        params.transcriptRecord,
        MAX_MESSAGE_ASSEMBLY_TRANSCRIPT_RECORDS,
      ),
      updatedAt: new Date().toISOString(),
    },
  });
}

export function recordPromptRequestToConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  actorId: string;
  reason?: ActorPromptGenerationData["createdReason"];
  materializedContext?: string | null;
  basisHistoryGenerationIds?: string[];
  basisMessageRecordIds?: string[];
  basisRefs?: ActorPromptBasisRefData[];
  /**
   * Stage-1 system prompt snapshot for the provider-context materialization.
   * When omitted, the snapshot of the previous prompt generation is carried
   * forward (structural inheritance, like compaction/asset transforms).
   */
  systemPrompts?: string[];
  metadata?: Record<string, unknown>;
  occurredAt?: string;
}): string {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const promptGenerationId = makeRuntimeScopedId(`${params.actorKey}__prompt`);
  const currentPromptState =
    params.runtime.promptStateSignal.get()[actorRuntimeKey(params.sessionId, params.actorKey)];
  const currentPromptGeneration = currentPromptState?.activePromptGenerationId
    ? (
        currentPromptState.generations.find(
          (generation) => generation.promptGenerationId === currentPromptState.activePromptGenerationId,
        ) ?? null
      )
    : null;
  const inheritedSystemPrompts = (() => {
    const currentMetadata = (currentPromptGeneration?.metadata ?? {}) as Record<string, unknown>;
    const direct = currentMetadata.systemPrompts;
    if (Array.isArray(direct)) return direct.filter((value): value is string => typeof value === "string");
    const fromPlan = (currentMetadata.promptPlan as Record<string, unknown> | undefined)?.systemPrompts;
    if (Array.isArray(fromPlan)) return fromPlan.filter((value): value is string => typeof value === "string");
    return [];
  })();
  const systemPrompts = params.systemPrompts ?? inheritedSystemPrompts;
  const generation: ActorPromptGenerationData = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    promptGenerationId,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    basedOnPromptGenerationId: currentPromptState?.activePromptGenerationId ?? null,
    basis: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      basisHistoryGenerationIds: [
        ...(currentPromptGeneration?.basis.basisHistoryGenerationIds ?? []),
        ...(params.basisHistoryGenerationIds ?? []),
      ],
      basisMessageRecordIds: [
        ...(currentPromptGeneration?.basis.basisMessageRecordIds ?? []),
        ...(params.basisMessageRecordIds ?? []),
      ],
      basisRefs: [
        ...(currentPromptGeneration?.basis.basisRefs ?? []),
        ...(params.basisRefs ?? []),
      ],
    },
    transforms: inheritStructuralPromptTransforms(currentPromptGeneration?.transforms),
    createdReason: params.reason ?? "request_build",
    materializedContext: params.materializedContext ?? currentPromptGeneration?.materializedContext ?? null,
    sealed: false,
    createdAt: occurredAt,
    sealedAt: null,
    updatedAt: occurredAt,
    metadata: {
      ...(params.metadata ?? {}),
      ...(systemPrompts.length ? { systemPrompts } : {}),
    },
  };
  emitConversationDomainEvent(params.runtime, {
    type: "actor_prompt_generation_created",
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    promptGenerationId,
    generation,
    occurredAt,
  });
  emitConversationDomainEvent(params.runtime, {
    type: "actor_prompt_basis_selected",
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    promptGenerationId,
    basisHistoryGenerationIds: generation.basis.basisHistoryGenerationIds,
    basisMessageRecordIds: generation.basis.basisMessageRecordIds,
    basisRefs: generation.basis.basisRefs,
    occurredAt,
  });
  const head: ActorPromptHeadData = {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    activePromptGenerationId: promptGenerationId,
    updatedAt: occurredAt,
  };
  emitConversationDomainEvent(params.runtime, {
    type: "actor_prompt_head_moved",
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    activePromptGenerationId: promptGenerationId,
    head,
    occurredAt,
  });
  return promptGenerationId;
}

export function applyPromptTransformToConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  promptGenerationId?: string | null;
  transformKind: ActorPromptTransformData["kind"];
  payload: Record<string, unknown>;
  occurredAt?: string;
}): string | null {
  if (params.transformKind === "overlay"
    && (params.payload.insertPlacement === "late_status" || params.payload.overlayKind === "work_context")) {
    throw new Error("provider_context_legacy_overlay_writer_removed");
  }
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const promptState =
    params.runtime.promptStateSignal.get()[actorRuntimeKey(params.sessionId, params.actorKey)];
  const promptGenerationId =
    params.promptGenerationId
    ?? promptState?.activePromptGenerationId
    ?? null;
  if (!promptGenerationId) {
    return null;
  }
  const transformId = makeRuntimeScopedId(`${params.actorKey}__${params.transformKind}`);
  emitConversationDomainEvent(params.runtime, {
    type: "actor_prompt_transform_applied",
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    promptGenerationId,
    transformId,
    transformKind: params.transformKind,
    payload: params.payload,
    transform: {
      transformId,
      kind: params.transformKind,
      payload: params.payload,
      appliedAt: occurredAt,
    },
    occurredAt,
  });
  return transformId;
}

export function registerContextBlockToConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  actorId: string;
  title: string;
  content: string;
  source?: LocalConversationContextAssetData["source"];
  occurredAt?: string;
}): string {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const assetId = makeRuntimeScopedId(`${params.actorKey}__asset`);
  const asset: LocalConversationContextAssetData = {
    assetId,
    kind: params.source?.kind === "mcp_resource"
      ? "mcp_resource"
      : params.source?.kind === "upload"
        ? "upload"
        : params.source?.kind === "generated_summary"
          ? "generated_summary"
          : params.source?.kind === "note"
            ? "note"
            : "workspace_file",
    label: params.title,
    source: params.source ?? { kind: "workspace_file", path: params.title || assetId },
    metadata: {},
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  emitConversationDomainEvent(params.runtime, {
    type: "local_conversation_context_asset_registered",
    sessionId: params.sessionId,
    assetId,
    asset,
    occurredAt,
  });
  const promptGenerationId = recordPromptRequestToConversationDomainRuntime({
    runtime: params.runtime,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    reason: "asset_attach",
    basisRefs: [{ refKind: "session_asset", refId: assetId }],
    occurredAt,
  });
  const transformId = `${promptGenerationId}::asset_attach`;
  emitConversationDomainEvent(params.runtime, {
    type: "actor_prompt_transform_applied",
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    promptGenerationId,
    transformId,
    transformKind: "context_asset_attach",
    payload: {
      assetId,
      title: params.title,
      content: params.content,
    },
    transform: {
      transformId,
      kind: "context_asset_attach",
      payload: {
        assetId,
        title: params.title,
        content: params.content,
      },
      appliedAt: occurredAt,
    },
    occurredAt,
  });
  return assetId;
}

export function upsertContextResourceFactToConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  asset: LocalConversationContextAssetData;
  occurredAt?: string;
}): void {
  const occurredAt = params.occurredAt ?? params.asset.updatedAt ?? new Date().toISOString();
  emitConversationDomainEvent(params.runtime, {
    type: "local_conversation_context_asset_registered",
    sessionId: params.sessionId,
    assetId: params.asset.assetId,
    asset: params.asset,
    occurredAt,
  });
}

function toolResultDeliveryAssetId(actorKey: string): string {
  return `tool-result-delivery:${encodeURIComponent(actorKey)}`;
}

function messageDeliveryAssetId(actorKey: string): string {
  return `message-delivery:${encodeURIComponent(actorKey)}`;
}

export function registerPendingMessageDeliveryToConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  messageId: string;
  deliveryId?: string;
  occurredAt?: string;
}): string | null {
  const messageId = params.messageId.trim();
  if (!messageId) return null;
  const deliveryId = params.deliveryId?.trim() || `message-delivery:${messageId}`;
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const assetId = messageDeliveryAssetId(params.actorKey);
  const existing = params.runtime.sessionStateSignal.get()[params.sessionId]
    ?.contextAssets?.find((asset) => asset.assetId === assetId);
  const currentFact = existing?.messageDeliveryFact;
  const deliveries = new Map(
    (currentFact?.deliveries ?? []).map((delivery) => [delivery.deliveryId, delivery]),
  );
  if (deliveries.get(deliveryId)?.deliveryState === "delivered") return deliveryId;
  deliveries.set(deliveryId, {
    deliveryId,
    messageId,
    deliveryState: "pending",
    observedAt: deliveries.get(deliveryId)?.observedAt ?? occurredAt,
    deliveredAt: null,
  });
  const messageDeliveryFact: LocalConversationMessageDeliveryFact = {
    actorKey: params.actorKey,
    deliveries: [...deliveries.values()],
    updatedAt: occurredAt,
  };
  const asset: LocalConversationContextAssetData = {
    assetId,
    kind: "note",
    label: "Conversation message provider delivery",
    source: { kind: "note", ownerId: params.actorKey },
    messageDeliveryFact,
    createdAt: existing?.createdAt ?? occurredAt,
    updatedAt: occurredAt,
  };
  emitConversationDomainEvent(params.runtime, {
    type: "local_conversation_context_asset_registered",
    sessionId: params.sessionId,
    assetId,
    asset,
    occurredAt,
  });
  return deliveryId;
}

export function confirmMessageDeliveriesToConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  deliveryIds: readonly string[];
  occurredAt?: string;
}): void {
  if (params.deliveryIds.length === 0) return;
  const assetId = messageDeliveryAssetId(params.actorKey);
  const existing = params.runtime.sessionStateSignal.get()[params.sessionId]
    ?.contextAssets?.find((asset) => asset.assetId === assetId);
  const fact = existing?.messageDeliveryFact;
  if (!existing || !fact || fact.actorKey !== params.actorKey) return;
  const selected = new Set(params.deliveryIds);
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  let changed = false;
  const deliveries = fact.deliveries.map((delivery) => {
    if (delivery.deliveryState !== "pending" || !selected.has(delivery.deliveryId)) {
      return delivery;
    }
    changed = true;
    return {
      ...delivery,
      deliveryState: "delivered" as const,
      deliveredAt: occurredAt,
    };
  });
  if (!changed) return;
  emitConversationDomainEvent(params.runtime, {
    type: "local_conversation_context_asset_registered",
    sessionId: params.sessionId,
    assetId,
    asset: {
      ...existing,
      messageDeliveryFact: {
        ...fact,
        deliveries,
        updatedAt: occurredAt,
      },
      updatedAt: occurredAt,
    },
    occurredAt,
  });
}

export function registerPendingToolResultDeliveryToConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  toolCallId: string;
  occurredAt?: string;
}): void {
  const toolCallId = params.toolCallId.trim();
  if (!toolCallId) return;
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const assetId = toolResultDeliveryAssetId(params.actorKey);
  const existing = params.runtime.sessionStateSignal.get()[params.sessionId]
    ?.contextAssets?.find((asset) => asset.assetId === assetId);
  const currentFact = existing?.toolResultDeliveryFact;
  const deliveries = new Map(
    (currentFact?.deliveries ?? []).map((delivery) => [delivery.toolCallId, delivery]),
  );
  if (deliveries.get(toolCallId)?.deliveryState === "delivered") return;
  deliveries.set(toolCallId, {
    toolCallId,
    deliveryState: "pending",
    observedAt: deliveries.get(toolCallId)?.observedAt ?? occurredAt,
    deliveredAt: null,
  });
  const toolResultDeliveryFact: LocalConversationToolResultDeliveryFact = {
    actorKey: params.actorKey,
    deliveries: [...deliveries.values()],
    updatedAt: occurredAt,
  };
  const asset: LocalConversationContextAssetData = {
    assetId,
    kind: "note",
    label: "Tool result provider delivery",
    source: { kind: "note", ownerId: params.actorKey },
    toolResultDeliveryFact,
    createdAt: existing?.createdAt ?? occurredAt,
    updatedAt: occurredAt,
  };
  emitConversationDomainEvent(params.runtime, {
    type: "local_conversation_context_asset_registered",
    sessionId: params.sessionId,
    assetId,
    asset,
    occurredAt,
  });
}

export function confirmToolResultDeliveriesToConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  toolCallIds: readonly string[];
  occurredAt?: string;
}): void {
  if (params.toolCallIds.length === 0) return;
  const assetId = toolResultDeliveryAssetId(params.actorKey);
  const existing = params.runtime.sessionStateSignal.get()[params.sessionId]
    ?.contextAssets?.find((asset) => asset.assetId === assetId);
  const fact = existing?.toolResultDeliveryFact;
  if (!existing || !fact || fact.actorKey !== params.actorKey) return;
  const selected = new Set(params.toolCallIds);
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  let changed = false;
  const deliveries = fact.deliveries.map((delivery) => {
    if (delivery.deliveryState !== "pending" || !selected.has(delivery.toolCallId)) {
      return delivery;
    }
    changed = true;
    return {
      ...delivery,
      deliveryState: "delivered" as const,
      deliveredAt: occurredAt,
    };
  });
  if (!changed) return;
  emitConversationDomainEvent(params.runtime, {
    type: "local_conversation_context_asset_registered",
    sessionId: params.sessionId,
    assetId,
    asset: {
      ...existing,
      toolResultDeliveryFact: {
        ...fact,
        deliveries,
        updatedAt: occurredAt,
      },
      updatedAt: occurredAt,
    },
    occurredAt,
  });
}

function providerProjectionAssetId(actorKey: string, projectionKey: string, revision: string): string {
  return `provider-projection:${encodeURIComponent(actorKey)}:${encodeURIComponent(projectionKey)}:${encodeURIComponent(revision)}`;
}

function providerContextCandidateAssetId(
  actorKey: string,
  namespace: string,
  logicalKey: string,
  revision: string,
): string {
  return `provider-context-candidate:${encodeURIComponent(actorKey)}:${encodeURIComponent(namespace)}:${encodeURIComponent(logicalKey)}:${encodeURIComponent(revision)}`;
}

function providerContextFrontierDigest(generation: ActorHistoryGenerationData | null | undefined): `sha256:${string}` {
  return digestProviderContextHistoryFrontier(generation?.messages ?? []);
}

function assertProviderContextFactRetention(
  binding: ConversationSessionRawState["actorBindings"][string] | undefined,
  facts: readonly ActorProviderContextFact[],
): void {
  const policy = binding?.providerEpochReceiptV2?.retentionPolicy;
  if (!policy) return;
  const usage = measureActorProviderContextFactRetention({
    facts,
    maxRevisionsPerNamespace: policy.maxRevisionsPerNamespace,
    maxCanonicalFactBytesPerEpoch: policy.maxCanonicalFactBytesPerEpoch,
  });
  if (usage.overLimit) {
    throw new Error("provider_context_retention_compaction_required");
  }
}

export function appendActorProviderContextFactToConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  actorId: string;
  namespace: ActorProviderContextFactNamespace;
  payload: Record<string, unknown>;
  sourceDeliveryProofs?: ActorProviderContextFact["sourceDeliveryProofs"];
  occurredAt?: string;
}): ActorProviderContextFact {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const session = params.runtime.sessionStateSignal.get()[params.sessionId]
    ?? createEmptySessionState(params.sessionId);
  const binding = session.actorBindings[params.actorKey];
  const epoch = binding?.contextEpoch ?? binding?.providerEpochReceipt?.epoch ?? 0;
  const epochFacts = (session.contextAssets ?? [])
    .map((asset) => asset.providerContextFact)
    .filter((fact): fact is ActorProviderContextFact => Boolean(
      fact && fact.actorKey === params.actorKey && fact.epoch === epoch,
    ))
    .sort((left, right) => left.sequence - right.sequence);
  const priorSequenceFact = epochFacts.at(-1) ?? null;
  const priorNamespaceFact = [...epochFacts].reverse().find((fact) => fact.namespace === params.namespace) ?? null;
  const historyState = params.runtime.historyStateSignal.get()[actorRuntimeKey(params.sessionId, params.actorKey)];
  const activeHistory = historyState?.activeGenerationId
    ? historyState.generations.find((generation) => generation.generationId === historyState.activeGenerationId) ?? null
    : null;
  const candidate = createActorProviderContextFact({
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    epoch,
    namespace: params.namespace,
    namespaceRevision: (priorNamespaceFact?.namespaceRevision ?? 0) + 1,
    sequence: (priorSequenceFact?.sequence ?? 0) + 1,
    previousFactDigest: priorNamespaceFact?.factDigest ?? null,
    previousSequenceFactDigest: priorSequenceFact?.factDigest ?? null,
    anchor: {
      historyGenerationId: activeHistory?.generationId ?? "__empty_history__",
      messageCount: activeHistory?.messages.length ?? 0,
      frontierDigest: providerContextFrontierDigest(activeHistory),
    },
    sourceDeliveryProofs: params.sourceDeliveryProofs ?? [],
    payload: params.payload,
    observedAt: occurredAt,
  });
  if (priorNamespaceFact?.payloadDigest === candidate.payloadDigest) return priorNamespaceFact;
  assertProviderContextFactRetention(binding, [...epochFacts, candidate]);

  const acceptedConversationRevision = (binding?.providerContextFactHead?.conversationRevision ?? 0) + 1;
  const head = Object.freeze({
    schemaVersion: "eidolon.actor-provider-context-fact-head/v1" as const,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    epoch,
    sequence: candidate.sequence,
    factDigest: candidate.factDigest,
    conversationRevision: acceptedConversationRevision,
  });
  const assetId = `provider-context-fact:${candidate.factDigest.slice("sha256:".length)}`;
  const asset: LocalConversationContextAssetData = {
    assetId,
    kind: "note",
    label: `${candidate.namespace}@${candidate.namespaceRevision}`,
    source: { kind: "note", ownerId: params.actorKey },
    providerContextFact: candidate,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  emitConversationDomainEvent(params.runtime, {
    type: "local_conversation_provider_context_fact_appended",
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    assetId,
    asset,
    head,
    occurredAt,
  });
  return candidate;
}

export function commitDeliveredProviderProjectionFactsToConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  actorId: string;
  finalRequestDigest: `sha256:${string}`;
  sourceRecords: readonly Readonly<{
    toolCallId: string;
    callRecordDigest: `sha256:${string}`;
    resultRecordDigest: `sha256:${string}`;
  }>[];
  occurredAt?: string;
}): readonly ActorProviderContextFact[] {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const session = params.runtime.sessionStateSignal.get()[params.sessionId]
    ?? createEmptySessionState(params.sessionId);
  const binding = session.actorBindings[params.actorKey];
  const epochReceipt = binding?.providerEpochReceiptV2;
  if (!binding || !epochReceipt || epochReceipt.actorId !== params.actorId) {
    throw new Error(`provider_context_epoch_v2_required:${params.sessionId}:${params.actorKey}:${Boolean(binding)}:${Boolean(epochReceipt)}:${epochReceipt?.actorId ?? "missing"}:${params.actorId}`);
  }
  const previousAdmission = binding.providerRequestAdmissions?.at(-1) ?? null;
  const selected = new Map(params.sourceRecords.map((record) => [record.toolCallId, record]));
  const candidateAssets: LocalConversationContextAssetData[] = [];
  const candidates: Array<{
    namespace: ActorProviderContextFactNamespace;
    payload: Record<string, unknown>;
    sourceToolCallIds: readonly string[];
    observedAt: string;
    assetId: string;
  }> = [];
  for (const asset of session.contextAssets ?? []) {
    const projection = asset.projectionFact;
    if (!projection || projection.actorKey !== params.actorKey) continue;
    const revisionSources = projection.sourceToolCalls.filter((source) => (
      source.projectionRevision === projection.revision
    ));
    if (revisionSources.length === 0 || revisionSources.some((source) => (
      source.deliveryState === "pending" && !selected.has(source.toolCallId)
    ))) continue;
    const selectedRevisionSources = revisionSources.filter((source) => selected.has(source.toolCallId));
    if (selectedRevisionSources.length === 0) continue;
    const sourceToolCalls = projection.sourceToolCalls.map((source) => (
      source.deliveryState === "pending" && selected.has(source.toolCallId)
        ? { ...source, deliveryState: "delivered" as const, deliveredAt: occurredAt }
        : source
    ));
    candidateAssets.push({
      ...asset,
      projectionFact: { ...projection, sourceToolCalls, observedAt: occurredAt },
      updatedAt: occurredAt,
    });
    candidates.push({
      namespace: "provider-projection",
      payload: {
        logicalKey: projection.projectionKey,
        revision: projection.revision,
        content: projection.content,
      },
      sourceToolCallIds: Object.freeze(selectedRevisionSources.map((source) => source.toolCallId)),
      observedAt: projection.observedAt,
      assetId: asset.assetId,
    });
  }
  for (const asset of session.contextAssets ?? []) {
    const candidate = asset.providerContextFactCandidate;
    if (!candidate || candidate.actorKey !== params.actorKey) continue;
    const revisionSources = candidate.sourceToolCalls.filter((source) => (
      source.projectionRevision === candidate.revision
    ));
    if (revisionSources.length === 0 || revisionSources.some((source) => (
      source.deliveryState === "pending" && !selected.has(source.toolCallId)
    ))) continue;
    const selectedRevisionSources = revisionSources.filter((source) => selected.has(source.toolCallId));
    if (selectedRevisionSources.length === 0) continue;
    const sourceToolCalls = candidate.sourceToolCalls.map((source) => (
      source.deliveryState === "pending" && selected.has(source.toolCallId)
        ? { ...source, deliveryState: "delivered" as const, deliveredAt: occurredAt }
        : source
    ));
    candidateAssets.push({
      ...asset,
      providerContextFactCandidate: { ...candidate, sourceToolCalls, observedAt: occurredAt },
      updatedAt: occurredAt,
    });
    candidates.push({
      namespace: candidate.namespace,
      payload: { ...candidate.payload },
      sourceToolCallIds: Object.freeze(selectedRevisionSources.map((source) => source.toolCallId)),
      observedAt: candidate.observedAt,
      assetId: asset.assetId,
    });
  }
  candidates.sort((left, right) => (
    left.observedAt < right.observedAt ? -1
      : left.observedAt > right.observedAt ? 1
        : left.assetId < right.assetId ? -1
          : left.assetId > right.assetId ? 1
            : 0
  ));

  const currentHead = binding.providerContextFactHead ?? null;
  const actorRuntime = actorRuntimeKey(params.sessionId, params.actorKey);
  const currentHistoryHead = params.runtime.historyStateSignal.get()[actorRuntime]?.activeGenerationId
    ?? binding.historyHeadGenerationId
    ?? "__empty_history__";
  const currentPromptHead = params.runtime.promptStateSignal.get()[actorRuntime]?.activePromptGenerationId
    ?? binding.promptHeadGenerationId
    ?? "__empty_prompt__";
  const currentHistoryGeneration = params.runtime.historyStateSignal.get()[actorRuntime]?.generations.find(
    (generation) => generation.generationId === currentHistoryHead,
  ) ?? null;
  const historyMessagesAtAdmission = currentHistoryGeneration?.messages ?? [];
  const historyMessageCount = historyMessagesAtAdmission.length;
  const historyFrontierDigest = digestProviderContextHistoryFrontier(historyMessagesAtAdmission);
  const predecessorHistoryBoundary = previousAdmission
    ? {
        messageCount: previousAdmission.historyMessageCount,
        frontierDigest: previousAdmission.historyFrontierDigest,
      }
    : {
        messageCount: epochReceipt.sourceHistoryMessageCount,
        frontierDigest: epochReceipt.sourceFrontierDigest,
      };
  // Admission is a Conversation-owner operation and therefore enforces the
  // predecessor byte boundary itself. It must remain fail-closed even if a
  // caller bypasses the normal pre-transport epoch validator.
  assertExactProviderContextHistoryPrefix({
    messages: historyMessagesAtAdmission,
    messageCount: predecessorHistoryBoundary.messageCount,
    frontierDigest: predecessorHistoryBoundary.frontierDigest,
    mismatchCode: "provider_context_admission_history_frontier_mismatch",
  });
  const epochFacts = (session.contextAssets ?? [])
    .map((asset) => asset.providerContextFact)
    .filter((fact): fact is ActorProviderContextFact => Boolean(
      fact && fact.actorKey === params.actorKey && fact.epoch === epochReceipt.epoch,
    ))
    .sort((left, right) => left.sequence - right.sequence);
  const previousAdmittedHeadDigest = previousAdmission?.currentHeads.factHeadDigest
    ?? epochReceipt.baselineHeads.factHeadDigest;
  const previousAdmittedIndex = previousAdmittedHeadDigest === null
    ? -1
    : epochFacts.findIndex((fact) => fact.factDigest === previousAdmittedHeadDigest);
  if (previousAdmittedHeadDigest !== null && previousAdmittedIndex < 0) {
    throw new Error("provider_context_admission_previous_fact_head_missing");
  }
  const preexistingDeliveryFacts = epochFacts.slice(previousAdmittedIndex + 1);
  if ((preexistingDeliveryFacts.at(-1)?.factDigest ?? previousAdmittedHeadDigest)
    !== (currentHead?.factDigest ?? null)) {
    throw new Error("provider_context_admission_current_fact_head_not_contiguous");
  }
  const deliveryConfirmationDigests = Object.freeze(params.sourceRecords.flatMap((record) => [
    record.callRecordDigest,
    record.resultRecordDigest,
  ]));
  const factAppendIntentDigest = digestProviderContextClosedValue({
    schemaVersion: "provider.request-admission-fact-append-intent/v1",
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    epoch: epochReceipt.epoch,
    epochReceiptDigest: epochReceipt.receiptDigest,
    previousAdmissionDigest: previousAdmission?.admissionDigest ?? null,
    previousFactHeadDigest: previousAdmittedHeadDigest,
    preexistingFactDigests: preexistingDeliveryFacts.map((fact) => fact.factDigest),
    candidates: candidates.map((candidate) => ({
      namespace: candidate.namespace,
      payload: candidate.payload,
      sourceToolCallIds: candidate.sourceToolCallIds,
      observedAt: candidate.observedAt,
      assetId: candidate.assetId,
    })),
    finalRequestDigest: params.finalRequestDigest,
    deliveryConfirmationDigests,
    admittedAt: occurredAt,
  });

  if (candidates.length === 0) {
    const admittedFactRange = preexistingDeliveryFacts.length > 0 ? {
      previousHeadDigest: previousAdmittedHeadDigest,
      firstSequence: preexistingDeliveryFacts[0]!.sequence,
      lastSequence: preexistingDeliveryFacts.at(-1)!.sequence,
      count: preexistingDeliveryFacts.length,
      factDigests: preexistingDeliveryFacts.map((fact) => fact.factDigest),
    } : null;
    const admission = createProviderRequestAdmissionReceipt({
      sessionId: params.sessionId,
      actorKey: params.actorKey,
      actorId: params.actorId,
      epoch: epochReceipt.epoch,
      epochReceiptDigest: epochReceipt.receiptDigest,
      previousAdmissionDigest: previousAdmission?.admissionDigest ?? null,
      currentHeads: {
        historyHeadGenerationId: currentHistoryHead,
        promptHeadGenerationId: currentPromptHead,
        factHeadDigest: currentHead?.factDigest ?? null,
      },
      historyMessageCount,
      historyFrontierDigest,
      factAppendIntentDigest,
      admittedFactRange,
      finalRequestDigest: params.finalRequestDigest,
      deliveryConfirmationDigests,
      admittedAt: occurredAt,
    });
    emitConversationDomainEvent(params.runtime, {
      type: "local_conversation_provider_request_admitted",
      sessionId: params.sessionId,
      actorKey: params.actorKey,
      actorId: params.actorId,
      admission,
      occurredAt,
    });
    return Object.freeze([]);
  }

  let priorSequenceFact = epochFacts.at(-1) ?? null;
  const priorNamespaceFacts = new Map<ActorProviderContextFactNamespace, ActorProviderContextFact>();
  for (const fact of epochFacts) priorNamespaceFacts.set(fact.namespace, fact);
  const historyState = params.runtime.historyStateSignal.get()[actorRuntimeKey(params.sessionId, params.actorKey)];
  const activeHistory = historyState?.activeGenerationId
    ? historyState.generations.find((generation) => generation.generationId === historyState.activeGenerationId) ?? null
    : null;
  const factAssets: LocalConversationContextAssetData[] = [];
  const facts: ActorProviderContextFact[] = [];
  for (const candidate of candidates) {
    const priorNamespaceFact = priorNamespaceFacts.get(candidate.namespace) ?? null;
    const fact = createActorProviderContextFact({
      sessionId: params.sessionId,
      actorKey: params.actorKey,
      actorId: params.actorId,
      epoch: epochReceipt.epoch,
      namespace: candidate.namespace,
      namespaceRevision: (priorNamespaceFact?.namespaceRevision ?? 0) + 1,
      sequence: (priorSequenceFact?.sequence ?? 0) + 1,
      previousFactDigest: priorNamespaceFact?.factDigest ?? null,
      previousSequenceFactDigest: priorSequenceFact?.factDigest ?? null,
      anchor: {
        historyGenerationId: activeHistory?.generationId ?? "__empty_history__",
        messageCount: activeHistory?.messages.length ?? 0,
        frontierDigest: providerContextFrontierDigest(activeHistory),
      },
      sourceDeliveryProofs: candidate.sourceToolCallIds.map((toolCallId) => {
        const record = selected.get(toolCallId)!;
        return {
          kind: "first-delivery-pair" as const,
          toolCallId,
          callRecordDigest: record.callRecordDigest,
          resultRecordDigest: record.resultRecordDigest,
          requestAdmissionIntentDigest: factAppendIntentDigest,
        };
      }),
      payload: candidate.payload,
      observedAt: occurredAt,
    });
    const asset: LocalConversationContextAssetData = {
      assetId: `provider-context-fact:${fact.factDigest.slice("sha256:".length)}`,
      kind: "note",
      label: `${fact.namespace}@${fact.namespaceRevision}`,
      source: { kind: "note", ownerId: params.actorKey },
      providerContextFact: fact,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    };
    facts.push(fact);
    factAssets.push(asset);
    priorSequenceFact = fact;
    priorNamespaceFacts.set(candidate.namespace, fact);
  }
  assertProviderContextFactRetention(binding, [...epochFacts, ...facts]);
  const lastFact = facts.at(-1)!;
  const admittedFacts = [...preexistingDeliveryFacts, ...facts];
  const head = Object.freeze({
    schemaVersion: "eidolon.actor-provider-context-fact-head/v1" as const,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    epoch: epochReceipt.epoch,
    sequence: lastFact.sequence,
    factDigest: lastFact.factDigest,
    conversationRevision: (currentHead?.conversationRevision ?? 0) + 1,
  });
  const admission = createProviderRequestAdmissionReceipt({
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    epoch: epochReceipt.epoch,
    epochReceiptDigest: epochReceipt.receiptDigest,
    previousAdmissionDigest: previousAdmission?.admissionDigest ?? null,
    currentHeads: {
      historyHeadGenerationId: currentHistoryHead,
      promptHeadGenerationId: currentPromptHead,
      factHeadDigest: head.factDigest,
    },
    historyMessageCount,
    historyFrontierDigest,
    factAppendIntentDigest,
    admittedFactRange: {
      previousHeadDigest: previousAdmittedHeadDigest,
      firstSequence: admittedFacts[0]!.sequence,
      lastSequence: lastFact.sequence,
      count: admittedFacts.length,
      factDigests: admittedFacts.map((fact) => fact.factDigest),
    },
    finalRequestDigest: params.finalRequestDigest,
    deliveryConfirmationDigests,
    admittedAt: occurredAt,
  });
  emitConversationDomainEvent(params.runtime, {
    type: "local_conversation_provider_context_delivery_committed",
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    factAssets,
    candidateAssets,
    head,
    admission,
    occurredAt,
  });
  return Object.freeze(facts);
}

export function upsertProviderContextFactCandidateToConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  candidate: LocalConversationProviderContextFactCandidate;
  occurredAt?: string;
}): string {
  const occurredAt = params.occurredAt ?? params.candidate.observedAt ?? new Date().toISOString();
  const session = params.runtime.sessionStateSignal.get()[params.sessionId];
  const assetId = providerContextCandidateAssetId(
    params.candidate.actorKey,
    params.candidate.namespace,
    params.candidate.logicalKey,
    params.candidate.revision,
  );
  const existing = session?.contextAssets?.find((asset) => asset.assetId === assetId);
  const sourceToolCalls = new Map<string, LocalConversationProviderProjectionFact["sourceToolCalls"][number]>();
  for (const source of [
    ...(existing?.providerContextFactCandidate?.sourceToolCalls ?? []),
    ...params.candidate.sourceToolCalls,
  ]) {
    const sourceKey = `${source.toolCallId}\u0000${source.projectionRevision}`;
    if (sourceToolCalls.get(sourceKey)?.deliveryState === "delivered") continue;
    sourceToolCalls.set(sourceKey, source);
  }
  const asset: LocalConversationContextAssetData = {
    assetId,
    kind: "note",
    label: `${params.candidate.namespace}:${params.candidate.logicalKey}`,
    source: { kind: "note", ownerId: params.candidate.actorKey },
    providerContextFactCandidate: {
      ...params.candidate,
      sourceToolCalls: [...sourceToolCalls.values()],
      observedAt: occurredAt,
    },
    createdAt: existing?.createdAt ?? occurredAt,
    updatedAt: occurredAt,
  };
  emitConversationDomainEvent(params.runtime, {
    type: "local_conversation_context_asset_registered",
    sessionId: params.sessionId,
    assetId,
    asset,
    occurredAt,
  });
  return assetId;
}

export function upsertProviderProjectionFactToConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  projectionFact: LocalConversationProviderProjectionFact;
  occurredAt?: string;
}): string {
  const occurredAt = params.occurredAt ?? params.projectionFact.observedAt ?? new Date().toISOString();
  const session = params.runtime.sessionStateSignal.get()[params.sessionId];
  const existing = session?.contextAssets?.find((asset) => (
    asset.projectionFact?.actorKey === params.projectionFact.actorKey
    && asset.projectionFact.projectionKey === params.projectionFact.projectionKey
    && asset.projectionFact.revision === params.projectionFact.revision
  ));
  const sourceToolCalls = new Map<string, LocalConversationProviderProjectionFact["sourceToolCalls"][number]>();
  for (const source of [
    ...(existing?.projectionFact?.sourceToolCalls ?? []),
    ...params.projectionFact.sourceToolCalls,
  ]) {
    const sourceKey = `${source.toolCallId}\u0000${source.projectionRevision}`;
    if (sourceToolCalls.get(sourceKey)?.deliveryState === "delivered") continue;
    sourceToolCalls.set(sourceKey, source);
  }
  const assetId = existing?.assetId
    ?? providerProjectionAssetId(
      params.projectionFact.actorKey,
      params.projectionFact.projectionKey,
      params.projectionFact.revision,
    );
  const asset: LocalConversationContextAssetData = {
    assetId,
    kind: "note",
    label: params.projectionFact.projectionKey,
    source: { kind: "note", ownerId: params.projectionFact.actorKey },
    projectionFact: {
      ...params.projectionFact,
      sourceToolCalls: [...sourceToolCalls.values()],
      observedAt: occurredAt,
    },
    createdAt: existing?.createdAt ?? occurredAt,
    updatedAt: occurredAt,
  };
  emitConversationDomainEvent(params.runtime, {
    type: "local_conversation_context_asset_registered",
    sessionId: params.sessionId,
    assetId,
    asset,
    occurredAt,
  });
  return assetId;
}

function responsesReplayCheckpointAssetId(actorKey: string): string {
  return `responses-replay:${encodeURIComponent(actorKey)}`;
}

export function upsertResponsesReplayCheckpointToConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  checkpoint: ResponsesReplayCheckpoint;
  occurredAt?: string;
}): string {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const assetId = responsesReplayCheckpointAssetId(params.actorKey);
  const existing = params.runtime.sessionStateSignal.get()[params.sessionId]
    ?.contextAssets?.find((asset) => asset.assetId === assetId);
  const asset: LocalConversationContextAssetData = {
    assetId,
    kind: "note",
    label: "OpenAI Responses replay checkpoint",
    source: { kind: "note", ownerId: params.actorKey },
    replayCheckpoint: params.checkpoint,
    createdAt: existing?.createdAt ?? occurredAt,
    updatedAt: occurredAt,
  };
  emitConversationDomainEvent(params.runtime, {
    type: "local_conversation_context_asset_registered",
    sessionId: params.sessionId,
    assetId,
    asset,
    occurredAt,
  });
  return assetId;
}

export function clearContextBlocksInConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  actorKey: string;
  actorId: string;
  occurredAt?: string;
}): string {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const promptGenerationId = recordPromptRequestToConversationDomainRuntime({
    runtime: params.runtime,
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    actorId: params.actorId,
    reason: "manual",
    occurredAt,
  });
  const transformId = `${promptGenerationId}::detach_all`;
  emitConversationDomainEvent(params.runtime, {
    type: "actor_prompt_transform_applied",
    sessionId: params.sessionId,
    actorKey: params.actorKey,
    promptGenerationId,
    transformId,
    transformKind: "context_asset_detach_all",
    payload: {},
    transform: {
      transformId,
      kind: "context_asset_detach_all",
      payload: {},
      appliedAt: occurredAt,
    },
    occurredAt,
  });
  return transformId;
}

export function forkConversationSessionInConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  parentSessionId?: string | null;
  forkedFromGenerationId?: string | null;
  occurredAt?: string;
}): void {
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  emitConversationDomainEvent(params.runtime, {
    type: "local_conversation_session_forked",
    sessionId: params.sessionId,
    lineage: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId: params.sessionId,
      parentSessionId: params.parentSessionId ?? null,
      forkedFromGenerationId: params.forkedFromGenerationId ?? null,
      rolledBackFromSessionId: null,
      predecessorSessionIds: params.parentSessionId ? [params.parentSessionId] : [],
      forkSessionIds: [],
      updatedAt: occurredAt,
    },
    occurredAt,
  });
}

export function closeConversationSessionInConversationDomainRuntime(params: {
  runtime: ConversationDomainRuntime;
  sessionId: string;
  reason?: string | null;
  occurredAt?: string;
}): void {
  emitConversationDomainEvent(params.runtime, {
    type: "local_conversation_session_closed",
    sessionId: params.sessionId,
    reason: params.reason ?? null,
    occurredAt: params.occurredAt ?? new Date().toISOString(),
  });
}

export function materializeConversationRuntimeMessagesFromVm(params: {
  vm: AiAgentVm;
  actorKey: string;
}): ChatMessage[] {
  const actorRawState = getConversationActorRawStateFromVm({
    vm: params.vm,
    actorKey: params.actorKey,
  });
  return actorRawState ? materializeConversationRuntimePrompt(actorRawState) : [];
}

export function materializeConversationHistoryMessagesFromVm(params: {
  vm: AiAgentVm;
  actorKey: string;
}): ChatMessage[] {
  const actorRawState = getConversationActorRawStateFromVm({
    vm: params.vm,
    actorKey: params.actorKey,
  });
  return actorRawState ? materializeConversationVisibleHistory(actorRawState) : [];
}

const EMPTY_VISIBLE_MESSAGES: readonly ChatMessage[] = Object.freeze([]);

/**
 * Cache keyed by raw-state object identity: every domain write derives a NEW
 * ConversationActorRawState (refreshConversationActorRawStateFromDomainState),
 * so the projection invalidates naturally on writes and keeps a stable array
 * reference between writes (consumers holding the reference do not churn).
 */
const visibleMessagesProjectionCache = new WeakMap<object, readonly ChatMessage[]>();

/**
 * Read-only conversation view of an actor (spec case
 * single-in-memory-truth/mirror-eliminated): prompt-transform prelude plus
 * History-domain active tail, frozen. This is the single projection behind
 * the `actor.messages` facade getter; it is NOT a provider assembly input —
 * provider context comes from materializeConversationRuntimeMessagesFromVm.
 */
export function getConversationVisibleMessagesFromVm(params: {
  vm: AiAgentVm;
  actorKey: string;
}): readonly ChatMessage[] {
  const actorRawState = getConversationActorRawStateFromVm({
    vm: params.vm,
    actorKey: params.actorKey,
  });
  if (!actorRawState) return EMPTY_VISIBLE_MESSAGES;
  const cached = visibleMessagesProjectionCache.get(actorRawState);
  if (cached) return cached;
  const projected = Object.freeze(materializeConversationVisibleMessages(actorRawState));
  visibleMessagesProjectionCache.set(actorRawState, projected);
  return projected;
}

export function updateConversationDomainFromTranscriptRecordBatch(params: {
  vm: AiAgentVm;
  actorKey: string;
  actorId: string;
  transcriptRecord: TranscriptRecord;
}): void {
  // Compatibility/bootstrap helper only. Live ingress should append committed
  // messages via appendLiveHistoryMessageToConversationDomainRuntime(...).
  recordConversationTranscriptEvidenceInRuntime(params);
  const runtime = ensureVmConversationDomainRuntime(params.vm);
  const sessionId = resolveSessionIdFromVm(params.vm);
  const key = actorRuntimeKey(sessionId, params.actorKey);
  const current = runtime.messageAssemblySignal.get()[key];
  if (!current) return;
  const reducedMessages = reduceTranscriptToMessages(current.transcriptRecords);
  const previousReducedMessages = current.reducedMessages;
  const sharedCount = findSharedMessageSuffixPrefix(previousReducedMessages, reducedMessages);
  const newMessages = reducedMessages.slice(sharedCount);
  const nextReducedMessages = retainTail([...previousReducedMessages, ...newMessages], MAX_MESSAGE_ASSEMBLY_REDUCED_MESSAGES);
  runtime.messageAssemblySignal.set({
    ...runtime.messageAssemblySignal.get(),
    [key]: {
      ...current,
      reducedMessages: nextReducedMessages,
      emittedMessageCount: current.emittedMessageCount + newMessages.length,
      updatedAt: new Date().toISOString(),
    },
  });
  for (const message of newMessages) {
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm: params.vm,
      actorKey: params.actorKey,
      actorId: params.actorId,
      message,
    });
  }
}
