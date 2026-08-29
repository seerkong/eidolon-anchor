import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor";
import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime";
import type { LlmActorModelConfig } from "../llm/ModelConfigOps";
import type {
  ProviderContextAuthorityHeads,
  ProviderEpochProfileId,
  ProviderEpochReceiptV2,
  ProviderRequestAdmissionReceipt,
} from "@cell/ai-organ-contract";
import { resetActorContinuationBaseline } from "../runtime/ContextControlPlane";
import {
  activateProviderEpochReceiptV2InConversationDomainRuntime,
  commitProviderContextTransition,
  ensureVmConversationDomainRuntime,
  getConversationActorRawStateFromVm,
  materializeConversationRuntimeMessagesFromVm,
} from "./ConversationDomainRuntime";
import {
  assertExactProviderContextHistoryPrefix,
  createProviderEpochReceiptV2,
  createProviderRequestAdmissionReceipt,
  digestProviderContextClosedValue,
  digestProviderContextHistoryFrontier,
} from "./ProviderContextEpochV2";
import { computeProviderEpochConversationProjectionDigests } from "./ProviderEpochProjection";
import { codeUnitCompare } from "../llm/tool-schema/CanonicalSchemaFacts";

function stableDigest(value: unknown): `sha256:${string}` {
  const persisted = JSON.stringify(value);
  if (persisted === undefined) {
    throw new Error("provider_context_digest_value_not_persistable");
  }
  return digestProviderContextClosedValue(JSON.parse(persisted));
}

function v2TransitionReason(
  reason: "initial_projection" | "model_control" | "recovery_rebuild",
): "initial_projection" | "provider_model_profile_switch" | "recovery_rebuild" {
  return reason === "model_control" ? "provider_model_profile_switch" : reason;
}

export function resolveProviderEpochProfileId(
  modelConfig: Readonly<LlmActorModelConfig>,
  runtimeChatCompatibilityProfileId?: ProviderEpochProfileId,
): ProviderEpochProfileId {
  const adapter = String(modelConfig.adapter ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (adapter === "codex" || adapter === "openai-responses") return "openai-responses@1";
  if (adapter === "openai") return "openai-chat@1";
  if (adapter === "anthropic") return "anthropic-chat@1";
  if (adapter === "claude") return "claude-code@1";
  if (adapter === "deepseek") {
    const configured = modelConfig.options?.compatibilityProfile
      ?? modelConfig.options?.compatibility_profile;
    if (configured === "deepseek-compatible-chat@1" || configured === "deepseek-official-chat@1") {
      return configured;
    }
    if (runtimeChatCompatibilityProfileId === "deepseek-compatible-chat@1"
      || runtimeChatCompatibilityProfileId === "deepseek-official-chat@1") {
      return runtimeChatCompatibilityProfileId;
    }
    throw new Error("provider_chat_compatibility_profile_required");
  }
  throw new Error("unsupported_provider_epoch_profile");
}

export function activateActorProviderEpoch(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  sessionId: string;
  targetProviderId: string;
  targetProfileId: ProviderEpochProfileId;
  reason: "initial_projection" | "model_control" | "recovery_rebuild";
  occurredAt?: string;
}) {
  const raw = getConversationActorRawStateFromVm({
    vm: params.vm,
    actorKey: params.actor.key,
  });
  const sessionId = raw?.session.sessionId ?? params.sessionId;
  const messages = materializeConversationRuntimeMessagesFromVm({
    vm: params.vm,
    actorKey: params.actor.key,
  });
  const pairedAssistantToolCallIds = new Set(messages.flatMap((message: any) => (
    message?.role === "assistant"
      ? (Array.isArray(message.tool_calls)
          ? message.tool_calls
          : Array.isArray(message.toolCalls)
            ? message.toolCalls
            : [])
        .map((call: any) => String(call?.id ?? "").trim())
        .filter(Boolean)
      : []
  )));
  const pendingToolCallIds = (raw?.session.contextAssets ?? []).flatMap((asset) =>
    asset.toolResultDeliveryFact?.actorKey === params.actor.key
      ? asset.toolResultDeliveryFact.deliveries
        .filter((delivery) => delivery.deliveryState === "pending")
        .map((delivery) => delivery.toolCallId)
      : [])
    .filter(Boolean)
    // A recovered orphan result is not a provider-continuation pair. Keeping
    // it pending would mint false pair authority and block the recovered Actor
    // before transport; the handoff projection neutralizes it instead.
    .filter((toolCallId) => pairedAssistantToolCallIds.has(toolCallId))
    .sort(codeUnitCompare);
  const binding = raw?.session.actorBindings[params.actor.key];
  if (binding?.providerEpochReceipt) {
    throw new Error("provider_context_legacy_import_required");
  }
  const currentV2 = binding?.providerEpochReceiptV2;
  const targetModelId = String(params.actor.modelConfig.model ?? "__unspecified_model__");
  if (currentV2
    && currentV2.targetProviderId === params.targetProviderId
    && currentV2.targetModelId === targetModelId
    && currentV2.targetProfileId === params.targetProfileId) {
    return Object.freeze({ changed: false, receipt: currentV2 });
  }
  const createdAt = params.occurredAt ?? new Date().toISOString();
  const { handoffDigest } = computeProviderEpochConversationProjectionDigests({
    messages,
    targetProviderId: params.targetProviderId,
    targetProfileId: params.targetProfileId,
    createdAt,
    pendingToolCallIds,
  });
  const sourceFrontierDigest = digestProviderContextHistoryFrontier(
    raw?.activeHistoryGeneration?.messages ?? [],
  );
  const heads = {
    historyHeadGenerationId: raw?.historyHeadGenerationId ?? "__empty_history__",
    promptHeadGenerationId: raw?.promptHeadGenerationId ?? "__empty_prompt__",
    factHeadDigest: binding?.providerContextFactHead?.factDigest ?? null,
  };
  const successorHeads = currentV2
    ? { ...heads, factHeadDigest: null }
    : heads;
  const receiptV2 = createProviderEpochReceiptV2({
      sessionId,
      actorKey: params.actor.key,
      actorId: params.actor.id,
      epoch: currentV2
        ? currentV2.epoch + 1
        : Math.max(binding?.contextEpoch ?? 0, 0) + 1,
      previousReceiptDigest: currentV2?.receiptDigest ?? null,
      targetProviderId: params.targetProviderId,
      targetModelId,
      targetProfileId: params.targetProfileId,
      baselineHeads: successorHeads,
      sourceHistoryMessageCount: raw?.activeHistoryGeneration?.messages.length ?? 0,
      sourceFrontierDigest,
      pendingDeliveryDigest: stableDigest(pendingToolCallIds),
      handoffDigest,
      // A provider/model/profile transition owns only that identity change.
      // Resource and surface revisions are separate reasoned boundaries at the
      // shared pre-transport fence, so never smuggle their new digests into the
      // provider-switch receipt.
      frozenResourceDigest: currentV2?.frozenResourceDigest
        ?? stableDigest(params.actor.durableMaterials ?? {}),
      providerSurfaceDigest: currentV2?.providerSurfaceDigest
        ?? stableDigest(params.actor.toolPolicy.providerToolSurface ?? {
          mode: params.actor.toolPolicy.allowedToolsMode,
          toolNames: params.actor.toolPolicy.allowedTools,
        }),
      retentionPolicy: {
        maxRevisionsPerNamespace: 32,
        maxCanonicalFactBytesPerEpoch: 65_536,
      },
      reason: currentV2
        ? "provider_model_profile_switch"
        : v2TransitionReason(params.reason),
      compactionProofDigest: null,
      createdAt,
    });
  if (currentV2) {
      commitProviderContextTransition(ensureVmConversationDomainRuntime(params.vm), {
        schemaVersion: "provider.context-transition-command/v1",
        sessionId,
        actorKey: params.actor.key,
        actorId: params.actor.id,
        expectedConversationRevision: binding?.providerContextFactHead?.conversationRevision ?? 0,
        expectedEpochReceiptDigest: currentV2.receiptDigest,
        expectedLatestAdmissionDigest: binding?.providerRequestAdmissions?.at(-1)?.admissionDigest ?? null,
        priorHeads: heads,
        nextHeads: successorHeads,
        reason: "provider_model_profile_switch",
        nextReceipt: receiptV2,
        nextFactHead: null,
        retainedFactDigests: [],
        appendedFactDigests: [],
        deliveryConfirmationDigests: [],
        compactionProof: null,
        generation: null,
        occurredAt: createdAt,
      }, {});
  } else {
    activateProviderEpochReceiptV2InConversationDomainRuntime({
      runtime: ensureVmConversationDomainRuntime(params.vm),
      receipt: receiptV2,
    });
  }
  resetActorContinuationBaseline({
    actor: params.actor,
    reason: `provider_epoch:${params.targetProfileId}`,
    occurredAt: receiptV2.createdAt,
  });
  return Object.freeze({ changed: true, receipt: receiptV2 });
}

export function acceptActorProviderContextRevision(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  kind: "frozen_resource" | "provider_surface";
  digest: `sha256:${string}`;
  occurredAt?: string;
}): ProviderEpochReceiptV2 {
  const raw = getConversationActorRawStateFromVm({ vm: params.vm, actorKey: params.actor.key });
  const binding = raw?.session.actorBindings[params.actor.key];
  const current = binding?.providerEpochReceiptV2;
  if (!raw || !binding || !current) throw new Error("provider_context_revision_predecessor_missing");
  if (!/^sha256:[0-9a-f]{64}$/.test(params.digest)) {
    throw new Error("provider_context_revision_digest_invalid");
  }
  const reason = params.kind === "frozen_resource"
    ? "frozen_resource_revision_accepted" as const
    : "provider_surface_revision_accepted" as const;
  const occurredAt = params.occurredAt ?? new Date().toISOString();
  const heads = currentAuthorityHeads({ vm: params.vm, actor: params.actor });
  const successorHeads = { ...heads, factHeadDigest: null };
  const nextReceipt = createProviderEpochReceiptV2({
    ...current,
    epoch: current.epoch + 1,
    previousReceiptDigest: current.receiptDigest,
    baselineHeads: successorHeads,
    sourceHistoryMessageCount: raw.activeHistoryGeneration?.messages.length ?? 0,
    sourceFrontierDigest: digestProviderContextHistoryFrontier(
      raw.activeHistoryGeneration?.messages ?? [],
    ),
    frozenResourceDigest: params.kind === "frozen_resource" ? params.digest : current.frozenResourceDigest,
    providerSurfaceDigest: params.kind === "provider_surface" ? params.digest : current.providerSurfaceDigest,
    reason,
    compactionProofDigest: null,
    createdAt: occurredAt,
  });
  return commitProviderContextTransition(ensureVmConversationDomainRuntime(params.vm), {
    schemaVersion: "provider.context-transition-command/v1",
    sessionId: current.sessionId,
    actorKey: params.actor.key,
    actorId: params.actor.id,
    expectedConversationRevision: binding.providerContextFactHead?.conversationRevision ?? 0,
    expectedEpochReceiptDigest: current.receiptDigest,
    expectedLatestAdmissionDigest: binding.providerRequestAdmissions?.at(-1)?.admissionDigest ?? null,
    priorHeads: heads,
    nextHeads: successorHeads,
    reason,
    nextReceipt,
    nextFactHead: null,
    retainedFactDigests: [],
    appendedFactDigests: [],
    deliveryConfirmationDigests: [],
    compactionProof: null,
    generation: null,
    occurredAt,
  }, {});
}

function exactV2Receipt(receipt: ProviderEpochReceiptV2): ProviderEpochReceiptV2 {
  const { receiptDigest, ...facts } = receipt;
  const normalized = createProviderEpochReceiptV2(facts);
  if (normalized.receiptDigest !== receiptDigest) {
    throw new Error("provider_context_epoch_receipt_digest_mismatch");
  }
  return receipt;
}

function exactAdmission(receipt: ProviderRequestAdmissionReceipt): ProviderRequestAdmissionReceipt {
  const { admissionDigest, ...facts } = receipt;
  const normalized = createProviderRequestAdmissionReceipt(facts);
  if (normalized.admissionDigest !== admissionDigest) {
    throw new Error("provider_context_admission_digest_mismatch");
  }
  return receipt;
}

function currentAuthorityHeads(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
}): ProviderContextAuthorityHeads {
  const raw = getConversationActorRawStateFromVm({ vm: params.vm, actorKey: params.actor.key });
  const binding = raw?.session.actorBindings[params.actor.key];
  return Object.freeze({
    historyHeadGenerationId: raw?.historyHeadGenerationId ?? "__empty_history__",
    promptHeadGenerationId: raw?.promptHeadGenerationId ?? "__empty_prompt__",
    factHeadDigest: binding?.providerContextFactHead?.factDigest ?? null,
  });
}

function historyDescends(params: {
  vm: AiAgentVm;
  actorKey: string;
  current: string;
  ancestor: string;
}): boolean {
  if (params.current === params.ancestor) return true;
  if (params.ancestor === "__empty_history__") return true;
  const runtime = ensureVmConversationDomainRuntime(params.vm);
  const state = Object.values(runtime.historyStateSignal.get()).find((candidate) => (
    candidate.actorKey === params.actorKey && candidate.activeGenerationId === params.current
  ));
  if (!state) return false;
  const generations = new Map(state.generations.map((generation) => [generation.generationId, generation]));
  const pending = [params.current];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const generationId = pending.pop()!;
    if (generationId === params.ancestor) return true;
    if (visited.has(generationId)) continue;
    visited.add(generationId);
    const generation = generations.get(generationId);
    if (!generation) continue;
    if (generation.generationId !== params.ancestor && generation.createdReason !== "append") {
      continue;
    }
    if (generation.parentGenerationId) pending.push(generation.parentGenerationId);
    pending.push(...generation.predecessorGenerationIds);
  }
  return false;
}

function promptDescends(params: {
  vm: AiAgentVm;
  actorKey: string;
  current: string;
  ancestor: string;
}): boolean {
  if (params.current === params.ancestor) return true;
  if (params.ancestor === "__empty_prompt__") return true;
  const runtime = ensureVmConversationDomainRuntime(params.vm);
  const state = Object.values(runtime.promptStateSignal.get()).find((candidate) => (
    candidate.actorKey === params.actorKey && candidate.activePromptGenerationId === params.current
  ));
  if (!state) return false;
  const generations = new Map(state.generations.map((generation) => [generation.promptGenerationId, generation]));
  let generationId: string | null | undefined = params.current;
  const visited = new Set<string>();
  while (generationId && !visited.has(generationId)) {
    if (generationId === params.ancestor) return true;
    visited.add(generationId);
    generationId = generations.get(generationId)?.basedOnPromptGenerationId;
  }
  return false;
}

function factDescends(params: {
  vm: AiAgentVm;
  actorKey: string;
  current: `sha256:${string}` | null;
  ancestor: `sha256:${string}` | null;
}): boolean {
  if (params.current === params.ancestor) return true;
  if (params.ancestor === null) return true;
  const raw = getConversationActorRawStateFromVm({ vm: params.vm, actorKey: params.actorKey });
  const facts = new Map((raw?.session.contextAssets ?? []).flatMap((asset) => (
    asset.providerContextFact ? [[asset.providerContextFact.factDigest, asset.providerContextFact] as const] : []
  )));
  let digest = params.current;
  const visited = new Set<string>();
  while (digest && !visited.has(digest)) {
    if (digest === params.ancestor) return true;
    visited.add(digest);
    digest = facts.get(digest)?.previousSequenceFactDigest ?? null;
  }
  return false;
}

function historyGenerationForHead(params: {
  vm: AiAgentVm;
  sessionId: string;
  actorKey: string;
  generationId: string;
}) {
  if (params.generationId === "__empty_history__") return null;
  const runtime = ensureVmConversationDomainRuntime(params.vm);
  const state = Object.values(runtime.historyStateSignal.get()).find((candidate) => (
    candidate.sessionId === params.sessionId && candidate.actorKey === params.actorKey
  ));
  return state?.generations.find((generation) => generation.generationId === params.generationId) ?? null;
}

function assertReceiptHistoryFrontier(params: {
  vm: AiAgentVm;
  actorKey: string;
  receipt: ProviderEpochReceiptV2;
}): void {
  const generationId = params.receipt.baselineHeads.historyHeadGenerationId;
  const generation = historyGenerationForHead({
    vm: params.vm,
    sessionId: params.receipt.sessionId,
    actorKey: params.actorKey,
    generationId,
  });
  if (generationId !== "__empty_history__" && (!generation
    || generation.actorKey !== params.actorKey
    || generation.messageCount !== generation.messages.length)) {
    throw new Error("provider_context_history_generation_mismatch");
  }
  const messages = generation?.messages ?? [];
  assertExactProviderContextHistoryPrefix({
    messages,
    messageCount: params.receipt.sourceHistoryMessageCount,
    frontierDigest: params.receipt.sourceFrontierDigest,
    mismatchCode: "provider_context_history_frontier_mismatch",
  });
}

function assertHeadsDescend(params: {
  vm: AiAgentVm;
  actorKey: string;
  current: ProviderContextAuthorityHeads;
  ancestor: ProviderContextAuthorityHeads;
  label: string;
}): void {
  if (!historyDescends({
    vm: params.vm,
    actorKey: params.actorKey,
    current: params.current.historyHeadGenerationId,
    ancestor: params.ancestor.historyHeadGenerationId,
  }) || !promptDescends({
    vm: params.vm,
    actorKey: params.actorKey,
    current: params.current.promptHeadGenerationId,
    ancestor: params.ancestor.promptHeadGenerationId,
  }) || !factDescends({
    vm: params.vm,
    actorKey: params.actorKey,
    current: params.current.factHeadDigest,
    ancestor: params.ancestor.factHeadDigest,
  })) {
    throw new Error(`provider_context_epoch_transition_required:${params.label}`);
  }
}

export function validateActorProviderContextEpoch(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
}): ProviderEpochReceiptV2 | null {
  const raw = getConversationActorRawStateFromVm({ vm: params.vm, actorKey: params.actor.key });
  const binding = raw?.session.actorBindings[params.actor.key];
  if (binding?.providerEpochReceipt && binding.providerEpochReceiptV2) {
    throw new Error("provider_context_dual_authority_forbidden");
  }
  const receipt = binding?.providerEpochReceiptV2;
  if (!receipt) return null;
  exactV2Receipt(receipt);
  assertReceiptHistoryFrontier({ vm: params.vm, actorKey: params.actor.key, receipt });
  if (receipt.sessionId !== raw?.session.sessionId
    || receipt.actorKey !== params.actor.key
    || receipt.actorId !== params.actor.id) {
    throw new Error("provider_context_epoch_identity_mismatch");
  }
  const admissions = binding?.providerRequestAdmissions ?? [];
  const epochFacts = new Map((raw?.session.contextAssets ?? []).flatMap((asset) => (
    asset.providerContextFact?.actorKey === params.actor.key
      && asset.providerContextFact.epoch === receipt.epoch
      ? [[asset.providerContextFact.factDigest, asset.providerContextFact] as const]
      : []
  )));
  let previousAdmissionDigest: `sha256:${string}` | null = null;
  let previousAdmittedHeadDigest: `sha256:${string}` | null = receipt.baselineHeads.factHeadDigest;
  let previousHistoryMessageCount = receipt.sourceHistoryMessageCount;
  let previousHistoryFrontierDigest = receipt.sourceFrontierDigest;
  for (const admission of admissions) {
    exactAdmission(admission);
    if (admission.sessionId !== receipt.sessionId
      || admission.actorKey !== receipt.actorKey
      || admission.actorId !== receipt.actorId
      || admission.epoch !== receipt.epoch
      || admission.epochReceiptDigest !== receipt.receiptDigest
      || admission.previousAdmissionDigest !== previousAdmissionDigest) {
      throw new Error("provider_context_admission_chain_mismatch");
    }
    const admittedHistory = historyGenerationForHead({
      vm: params.vm,
      sessionId: receipt.sessionId,
      actorKey: params.actor.key,
      generationId: admission.currentHeads.historyHeadGenerationId,
    });
    if (admission.currentHeads.historyHeadGenerationId !== "__empty_history__" && (!admittedHistory
      || admittedHistory.actorKey !== params.actor.key
      || admittedHistory.messageCount !== admittedHistory.messages.length)) {
      throw new Error("provider_context_admission_history_generation_mismatch");
    }
    const admittedMessages = admittedHistory?.messages ?? [];
    assertExactProviderContextHistoryPrefix({
      messages: admittedMessages,
      messageCount: admission.historyMessageCount,
      frontierDigest: admission.historyFrontierDigest,
      mismatchCode: "provider_context_admission_history_frontier_mismatch",
    });
    // An admission is an extension of the previous admitted boundary (or the
    // immutable epoch baseline for admission 1), not merely a descendant id.
    // Restrict the comparison to this admission's own declared frontier so a
    // later suffix cannot conceal a shortened or replaced predecessor prefix.
    assertExactProviderContextHistoryPrefix({
      messages: admittedMessages.slice(0, admission.historyMessageCount),
      messageCount: previousHistoryMessageCount,
      frontierDigest: previousHistoryFrontierDigest,
      mismatchCode: "provider_context_admission_history_frontier_mismatch",
    });
    const range = admission.admittedFactRange;
    if (range) {
      if (range.previousHeadDigest !== previousAdmittedHeadDigest
        || range.count !== range.factDigests.length
        || range.count <= 0
        || range.lastSequence !== range.firstSequence + range.count - 1
        || range.factDigests.at(-1) !== admission.currentHeads.factHeadDigest) {
        throw new Error("provider_context_admission_fact_range_mismatch");
      }
      let predecessor = range.previousHeadDigest;
      for (const [index, digest] of range.factDigests.entries()) {
        const fact = epochFacts.get(digest);
        if (!fact
          || fact.sequence !== range.firstSequence + index
          || fact.previousSequenceFactDigest !== predecessor
          || (fact.sourceDeliveryProofs.length > 0 && !fact.sourceDeliveryProofs.some((proof) => (
            proof.kind === "first-delivery-pair"
            && proof.requestAdmissionIntentDigest === admission.factAppendIntentDigest
          )))) {
          throw new Error("provider_context_admission_fact_range_mismatch");
        }
        predecessor = fact.factDigest;
      }
    } else if (admission.currentHeads.factHeadDigest !== previousAdmittedHeadDigest) {
      throw new Error("provider_context_admission_fact_range_mismatch");
    }
    previousAdmittedHeadDigest = admission.currentHeads.factHeadDigest;
    previousHistoryMessageCount = admission.historyMessageCount;
    previousHistoryFrontierDigest = admission.historyFrontierDigest;
    previousAdmissionDigest = admission.admissionDigest;
  }
  const current = currentAuthorityHeads(params);
  assertHeadsDescend({
    vm: params.vm,
    actorKey: params.actor.key,
    current,
    ancestor: receipt.baselineHeads,
    label: "baseline_diverged",
  });
  const latest = admissions.at(-1);
  if (latest) {
    assertHeadsDescend({
      vm: params.vm,
      actorKey: params.actor.key,
      current,
      ancestor: latest.currentHeads,
      label: "latest_admission_diverged",
    });
    const currentHistory = historyGenerationForHead({
      vm: params.vm,
      sessionId: receipt.sessionId,
      actorKey: params.actor.key,
      generationId: current.historyHeadGenerationId,
    });
    const currentMessages = currentHistory?.messages ?? [];
    // Always recompute the latest admitted prefix against the current active
    // generation. A distinct append child receives no trust from its parent id
    // or createdReason; it must carry the exact already-admitted bytes.
    assertExactProviderContextHistoryPrefix({
      messages: currentMessages,
      messageCount: latest.historyMessageCount,
      frontierDigest: latest.historyFrontierDigest,
      mismatchCode: "provider_context_admission_history_frontier_mismatch",
    });
  } else {
    const currentHistory = historyGenerationForHead({
      vm: params.vm,
      sessionId: receipt.sessionId,
      actorKey: params.actor.key,
      generationId: current.historyHeadGenerationId,
    });
    assertExactProviderContextHistoryPrefix({
      messages: currentHistory?.messages ?? [],
      messageCount: receipt.sourceHistoryMessageCount,
      frontierDigest: receipt.sourceFrontierDigest,
      mismatchCode: "provider_context_history_frontier_mismatch",
    });
  }
  return receipt;
}

export function reconcileActorProviderEpochProjection(params: {
  vm: AiAgentVm;
  actor: AiAgentActor;
  messages: readonly any[];
  pendingToolCallIds: readonly string[];
}): ProviderEpochReceiptV2 | null {
  return validateActorProviderContextEpoch({ vm: params.vm, actor: params.actor });
}
