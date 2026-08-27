import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import {
  appendLiveHistoryMessageToConversationDomainRuntime,
  appendActorProviderContextFactToConversationDomainRuntime,
  commitDeliveredProviderProjectionFactsToConversationDomainRuntime,
  commitProviderContextTransition,
  emitConversationDomainEvent,
  ensureVmConversationDomainRuntime,
  getConversationActorRawStateFromVm,
  materializeConversationRuntimeMessagesFromVm,
} from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime"
import {
  activateActorProviderEpoch,
  acceptActorProviderContextRevision,
  reconcileActorProviderEpochProjection,
  validateActorProviderContextEpoch,
} from "@cell/ai-organ-logic/conversation/ProviderEpoch"
import { createProviderEpochReceiptV2 } from "@cell/ai-organ-logic/conversation/ProviderContextEpochV2"
import {
  digestProviderContextClosedValue,
  digestProviderContextHistoryFrontier,
} from "@cell/ai-organ-logic/conversation/ProviderContextEpochV2"
import {
  digestConversationProviderContextTransitionGeneration,
  LocalFileConversationPersistenceRepository,
  type LocalProviderContextTransitionFaultPoint,
} from "@cell/ai-support"
import { createInMemoryConversationPersistenceAdapter } from "@cell/ai-organ-logic/conversationCapsule/coreLogic"

function fixture() {
  const actor = createActor({
    key: "epoch-actor",
    id: "epoch-actor-id",
    modelConfig: {
      model: "deepseek-chat",
      provider: "deepseek",
      adapter: "deepseek",
      options: { compatibilityProfile: "deepseek-official-chat@1" },
    },
    toolPolicy: {
      allowedToolsMode: "exact",
      allowedTools: [],
      providerToolSurface: { mode: "exact", toolNames: [] },
    },
  })
  const vm = createVM({
    controlActorKey: actor.key,
    actors: { [actor.key]: actor },
    outerCtx: { metadata: { sessionId: "epoch-transition-session" } },
  })
  appendLiveHistoryMessageToConversationDomainRuntime({
    vm,
    actorKey: actor.key,
    actorId: actor.id,
    message: { role: "user", content: "BASE" },
  })
  activateActorProviderEpoch({
    vm,
    actor,
    sessionId: "epoch-transition-session",
    targetProviderId: "deepseek",
    targetProfileId: "deepseek-official-chat@1",
    reason: "initial_projection",
    occurredAt: "2026-08-25T15:00:00.000Z",
  })
  return { actor, vm }
}

function publishAppendChildAfterAdmission(replaceAdmittedPrefix = true) {
  const { actor, vm } = fixture()
  const runtime = ensureVmConversationDomainRuntime(vm)
  const raw = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
  appendLiveHistoryMessageToConversationDomainRuntime({
    vm,
    actorKey: actor.key,
    actorId: actor.id,
    message: { role: "assistant", content: "LEGIT" },
    occurredAt: "2026-08-25T15:00:10.000Z",
  })
  commitDeliveredProviderProjectionFactsToConversationDomainRuntime({
    runtime,
    sessionId: raw.session.sessionId,
    actorKey: actor.key,
    actorId: actor.id,
    finalRequestDigest: digestProviderContextClosedValue({ request: "admission-1" }),
    sourceRecords: [],
    occurredAt: "2026-08-25T15:00:11.000Z",
  })
  const admitted = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
    .activeHistoryGeneration!
  expect(admitted.messages.map((entry) => entry.message.content)).toEqual(["BASE", "LEGIT"])

  const occurredAt = "2026-08-25T15:00:12.000Z"
  const childGenerationId = `${admitted.generationId}__${replaceAdmittedPrefix ? "forged" : "legal"}-append-child`
  const child = structuredClone(admitted)
  child.generationId = childGenerationId
  child.parentGenerationId = admitted.generationId
  child.predecessorGenerationIds = [admitted.generationId]
  child.createdReason = "append"
  if (replaceAdmittedPrefix) child.messages[0]!.message.content = "FORGED"
  child.messages.push({
    ...structuredClone(child.messages[1]!),
    recordId: `${childGenerationId}::2`,
    committedAt: Date.parse(occurredAt),
    message: { ...structuredClone(child.messages[1]!.message), content: "NEXT" },
  })
  child.messageCount = child.messages.length
  child.createdAt = occurredAt
  child.updatedAt = occurredAt
  emitConversationDomainEvent(runtime, {
    type: "actor_history_generation_created",
    sessionId: raw.session.sessionId,
    actorKey: actor.key,
    generationId: childGenerationId,
    generation: child,
    occurredAt,
  })
  emitConversationDomainEvent(runtime, {
    type: "actor_history_head_moved",
    sessionId: raw.session.sessionId,
    actorKey: actor.key,
    activeGenerationId: childGenerationId,
    head: {
      version: child.version,
      sessionId: raw.session.sessionId,
      actorKey: actor.key,
      actorId: actor.id,
      activeGenerationId: childGenerationId,
      visibleGenerationIds: [admitted.generationId, childGenerationId],
      updatedAt: occurredAt,
    },
    occurredAt,
  })
  expect(getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
    .activeHistoryGeneration?.messages.map((entry) => entry.message.content))
    .toEqual([replaceAdmittedPrefix ? "FORGED" : "BASE", "LEGIT", "NEXT"])
  return { actor, vm, runtime, sessionId: raw.session.sessionId }
}

describe("provider context epoch transition", () => {
  it("keeps legacy v1 and late-status mutation writers off production surfaces", () => {
    const sourceRoot = path.resolve(import.meta.dir, "../../../src")
    const facades = [
      "conversation/ConversationDomainRuntime.ts",
      "conversationCapsule/coreLogic.ts",
      "index.ts",
    ].map((relative) => fs.readFileSync(path.join(sourceRoot, relative), "utf8"))
    for (const source of facades) {
      expect(source).not.toMatch(/\bactivateProviderEpochInConversationDomainRuntime\b/)
      expect(source).not.toMatch(/\brestoreProviderEpochReceiptInConversationDomainRuntime\b/)
      expect(source).not.toMatch(/\bupdateProviderEpochProjectionInConversationDomainRuntime\b/)
      expect(source).not.toMatch(/\brecordPromptOverlayToConversationDomainRuntime\b/)
    }
    const internal = fs.readFileSync(
      path.join(sourceRoot, "conversationCapsule/internals/domainRuntime.ts"),
      "utf8",
    )
    expect(internal).not.toMatch(/\b(?:activateProviderEpochInConversationDomainRuntime|restoreProviderEpochReceiptInConversationDomainRuntime|updateProviderEpochProjectionInConversationDomainRuntime|recordPromptOverlayToConversationDomainRuntime)\b/)
  })

  it("rejects a same-generation rewrite of already admitted append bytes", () => {
    const { actor, vm } = fixture()
    const runtime = ensureVmConversationDomainRuntime(vm)
    const raw = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: { role: "assistant", content: "LEGIT_APPEND" },
      occurredAt: "2026-08-25T15:00:10.000Z",
    })
    commitDeliveredProviderProjectionFactsToConversationDomainRuntime({
      runtime,
      sessionId: raw.session.sessionId,
      actorKey: actor.key,
      actorId: actor.id,
      finalRequestDigest: digestProviderContextClosedValue({ request: "admitted" }),
      sourceRecords: [],
      occurredAt: "2026-08-25T15:00:11.000Z",
    })
    expect(validateActorProviderContextEpoch({ vm, actor })).toBeTruthy()

    const [historyKey, historyState] = Object.entries(runtime.historyStateSignal.get()).find(([, state]) => (
      state.sessionId === raw.session.sessionId && state.actorKey === actor.key
    ))!
    const active = historyState.generations.find((entry) => entry.generationId === historyState.activeGenerationId)!
    const forged = structuredClone(active)
    forged.messages[1]!.message.content = "FORGED"
    runtime.historyStateSignal.set({
      ...runtime.historyStateSignal.get(),
      [historyKey]: {
        ...historyState,
        generations: historyState.generations.map((entry) => entry.generationId === forged.generationId ? forged : entry),
      },
    })
    expect(() => validateActorProviderContextEpoch({ vm, actor }))
      .toThrow("provider_context_admission_history_frontier_mismatch")
  })

  it("rejects an append child that replaces the latest admitted byte prefix before transport", () => {
    const { actor, vm } = publishAppendChildAfterAdmission()
    expect(() => validateActorProviderContextEpoch({ vm, actor }))
      .toThrow("provider_context_admission_history_frontier_mismatch")
    expect(getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
      .session.actorBindings[actor.key]?.providerRequestAdmissions).toHaveLength(1)
  })

  it("rejects a second admission when an append child replaces its parent's admitted byte prefix", () => {
    const { actor, vm, runtime, sessionId } = publishAppendChildAfterAdmission()
    expect(() => commitDeliveredProviderProjectionFactsToConversationDomainRuntime({
      runtime,
      sessionId,
      actorKey: actor.key,
      actorId: actor.id,
      finalRequestDigest: digestProviderContextClosedValue({ request: "admission-2" }),
      sourceRecords: [],
      occurredAt: "2026-08-25T15:00:13.000Z",
    })).toThrow("provider_context_admission_history_frontier_mismatch")
    expect(getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
      .session.actorBindings[actor.key]?.providerRequestAdmissions).toHaveLength(1)
  })

  it("admits a distinct append child that preserves the exact parent admission prefix", () => {
    const { actor, vm, runtime, sessionId } = publishAppendChildAfterAdmission(false)
    expect(validateActorProviderContextEpoch({ vm, actor })).toBeTruthy()
    expect(() => commitDeliveredProviderProjectionFactsToConversationDomainRuntime({
      runtime,
      sessionId,
      actorKey: actor.key,
      actorId: actor.id,
      finalRequestDigest: digestProviderContextClosedValue({ request: "admission-2-legal" }),
      sourceRecords: [],
      occurredAt: "2026-08-25T15:00:13.000Z",
    })).not.toThrow()
    expect(validateActorProviderContextEpoch({ vm, actor })).toBeTruthy()
  })

  it("rejects forged current history content and forged staged transition identity", () => {
    const { actor, vm } = fixture()
    const runtime = ensureVmConversationDomainRuntime(vm)
    const raw = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
    const [historyKey, historyState] = Object.entries(runtime.historyStateSignal.get()).find(([, state]) => (
      state.sessionId === raw.session.sessionId && state.actorKey === actor.key
    ))!
    const active = historyState.generations.find((entry) => entry.generationId === historyState.activeGenerationId)!
    const forged = structuredClone(active)
    forged.messages[0]!.message.content = "forged same-id rewrite"
    runtime.historyStateSignal.set({
      ...runtime.historyStateSignal.get(),
      [historyKey]: {
        ...historyState,
        generations: historyState.generations.map((entry) => entry.generationId === forged.generationId ? forged : entry),
      },
    })
    expect(() => validateActorProviderContextEpoch({ vm, actor }))
      .toThrow("provider_context_history_frontier_mismatch")

    const clean = fixture()
    const cleanRuntime = ensureVmConversationDomainRuntime(clean.vm)
    const cleanRaw = getConversationActorRawStateFromVm({ vm: clean.vm, actorKey: clean.actor.key })!
    const binding = cleanRaw.session.actorBindings[clean.actor.key]!
    const current = binding.providerEpochReceiptV2!
    const heads = {
      historyHeadGenerationId: cleanRaw.historyHeadGenerationId ?? "__empty_history__",
      promptHeadGenerationId: cleanRaw.promptHeadGenerationId ?? "__empty_prompt__",
      factHeadDigest: null,
    }
    const next = createProviderEpochReceiptV2({
      ...current,
      epoch: current.epoch + 1,
      previousReceiptDigest: current.receiptDigest,
      targetProviderId: "deepseek-compatible",
      targetModelId: "deepseek-compatible-chat",
      targetProfileId: "deepseek-compatible-chat@1",
      reason: "provider_model_profile_switch",
      createdAt: "2026-08-25T15:00:30.000Z",
    })
    const stagedSession = structuredClone(cleanRaw.session.sessionIndex)
    stagedSession.session.actorBindings[clean.actor.key]!.providerEpochReceiptV2 = next
    const generation = {
      schemaVersion: "conversation.provider-context-transition-generation/v1" as const,
      transitionId: `sha256:${"f".repeat(64)}`,
      expectedEpochReceiptDigest: current.receiptDigest,
      nextEpochReceiptDigest: next.receiptDigest,
      historyIndex: structuredClone(cleanRaw.session.historyIndex),
      promptIndex: structuredClone(cleanRaw.session.promptIndex),
      sessionIndex: stagedSession,
      artifactRefs: { version: 1, sessionId: cleanRaw.session.sessionId, refs: [], updatedAt: next.createdAt },
      historyGenerations: cleanRaw.activeHistoryGeneration
        ? [JSON.parse(JSON.stringify(cleanRaw.activeHistoryGeneration))]
        : [],
      promptGenerations: cleanRaw.promptGeneration
        ? [JSON.parse(JSON.stringify(cleanRaw.promptGeneration))]
        : [],
      createdAt: next.createdAt,
    }
    expect(() => commitProviderContextTransition(cleanRuntime, {
      schemaVersion: "provider.context-transition-command/v1",
      sessionId: cleanRaw.session.sessionId,
      actorKey: clean.actor.key,
      actorId: clean.actor.id,
      expectedConversationRevision: 0,
      expectedEpochReceiptDigest: current.receiptDigest,
      expectedLatestAdmissionDigest: null,
      priorHeads: heads,
      nextHeads: heads,
      reason: "provider_model_profile_switch",
      nextReceipt: next,
      nextFactHead: null,
      retainedFactDigests: [],
      appendedFactDigests: [],
      deliveryConfirmationDigests: [],
      compactionProof: null,
      generation,
      occurredAt: next.createdAt,
    }, {})).toThrow("provider_context_transition_generation_identity_conflict")
  })

  it("merges stale per-actor transition snapshots without overwriting a sibling", async () => {
    const run = async (repository: any) => {
      const sessionId = "two-actor-cas"
      const receipt = (actorKey: string, actorId: string, epoch: number, previousReceiptDigest: `sha256:${string}` | null) => createProviderEpochReceiptV2({
        sessionId,
        actorKey,
        actorId,
        epoch,
        previousReceiptDigest,
        targetProviderId: "deepseek",
        targetModelId: "deepseek-chat",
        targetProfileId: "deepseek-official-chat@1",
        baselineHeads: { historyHeadGenerationId: "__empty_history__", promptHeadGenerationId: "__empty_prompt__", factHeadDigest: null },
        sourceHistoryMessageCount: 0,
        sourceFrontierDigest: digestProviderContextClosedValue([]),
        pendingDeliveryDigest: digestProviderContextClosedValue([]),
        handoffDigest: digestProviderContextClosedValue([]),
        frozenResourceDigest: digestProviderContextClosedValue({}),
        providerSurfaceDigest: digestProviderContextClosedValue({}),
        retentionPolicy: { maxRevisionsPerNamespace: 32, maxCanonicalFactBytesPerEpoch: 65_536 },
        reason: epoch === 1 ? "initial_projection" : "provider_model_profile_switch",
        compactionProofDigest: null,
        createdAt: `2026-08-25T15:3${epoch}:00.000Z`,
      })
      const a1 = receipt("actor-a", "actor-a-id", 1, null)
      const b1 = receipt("actor-b", "actor-b-id", 1, null)
      const base = await repository.loadSessionIndex()
      base.session.sessionId = sessionId
      base.session.actorBindings = {
        "actor-a": { actorKey: "actor-a", actorId: "actor-a-id", providerEpochReceiptV2: a1 },
        "actor-b": { actorKey: "actor-b", actorId: "actor-b-id", providerEpochReceiptV2: b1 },
      }
      await repository.writeSessionIndex(base)
      const emptyHistory = await repository.loadHistoryIndex()
      const emptyPrompt = await repository.loadPromptIndex()
      const emptyArtifacts = await repository.loadArtifactRefs()
      const makeTransition = (actorKey: "actor-a" | "actor-b", previous: typeof a1, next: typeof a1) => {
        const staged = structuredClone(base)
        staged.session.activeActorKey = actorKey
        staged.session.actorBindings[actorKey]!.providerEpochReceiptV2 = next
        const facts = {
          schemaVersion: "conversation.provider-context-transition-generation/v1" as const,
          expectedEpochReceiptDigest: previous.receiptDigest,
          nextEpochReceiptDigest: next.receiptDigest,
          historyIndex: structuredClone(emptyHistory),
          promptIndex: structuredClone(emptyPrompt),
          sessionIndex: staged,
          artifactRefs: structuredClone(emptyArtifacts),
          historyGenerations: [],
          promptGenerations: [],
          createdAt: next.createdAt,
        }
        return { transitionId: digestConversationProviderContextTransitionGeneration(facts), ...facts }
      }
      const a2 = receipt("actor-a", "actor-a-id", 2, a1.receiptDigest)
      const b2 = receipt("actor-b", "actor-b-id", 2, b1.receiptDigest)
      await Promise.all([
        repository.commitProviderContextTransitionGeneration(makeTransition("actor-a", a1, a2)),
        repository.commitProviderContextTransitionGeneration(makeTransition("actor-b", b1, b2)),
      ])
      const actual = await repository.loadSessionIndex()
      expect(actual.session.actorBindings["actor-a"]?.providerEpochReceiptV2?.receiptDigest).toBe(a2.receiptDigest)
      expect(actual.session.actorBindings["actor-b"]?.providerEpochReceiptV2?.receiptDigest).toBe(b2.receiptDigest)
    }

    const memory = createInMemoryConversationPersistenceAdapter().createRepository("two-actor-cas")
    await run(memory)
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-context-two-actor-"))
    try {
      await run(new LocalFileConversationPersistenceRepository(sessionDir))
      const fresh = new LocalFileConversationPersistenceRepository(sessionDir)
      const recovered = await fresh.loadSessionIndex()
      expect(recovered.session.actorBindings["actor-a"]?.providerEpochReceiptV2?.epoch).toBe(2)
      expect(recovered.session.actorBindings["actor-b"]?.providerEpochReceiptV2?.epoch).toBe(2)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })
  it("keeps append-only reconcile v2-only and ignores caller-owned message candidates", () => {
    const { actor, vm } = fixture()
    const before = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
    const beforeV2 = before.session.actorBindings[actor.key]!.providerEpochReceiptV2!
    const extended = [
      ...materializeConversationRuntimeMessagesFromVm({ vm, actorKey: actor.key }),
      { role: "assistant", content: "append-only" },
    ]

    expect(reconcileActorProviderEpochProjection({
      vm,
      actor,
      messages: extended,
      pendingToolCallIds: [],
    })).toBe(beforeV2)
    expect(validateActorProviderContextEpoch({ vm, actor })).toBe(beforeV2)
    expect(getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
      .session.actorBindings[actor.key]!.providerEpochReceiptV2).toBe(beforeV2)
    expect(reconcileActorProviderEpochProjection({
      vm,
      actor,
      messages: [{ role: "user", content: "rewritten epoch root" }],
      pendingToolCallIds: [],
    })).toBe(beforeV2)
  })

  it("commits exactly one reason-bound n+1 receipt and rejects a stale predecessor", () => {
    const { actor, vm } = fixture()
    const runtime = ensureVmConversationDomainRuntime(vm)
    const raw = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
    const binding = raw.session.actorBindings[actor.key]!
    const current = binding.providerEpochReceiptV2!
    const heads = {
      historyHeadGenerationId: raw.historyHeadGenerationId ?? "__empty_history__",
      promptHeadGenerationId: raw.promptHeadGenerationId ?? "__empty_prompt__",
      factHeadDigest: binding.providerContextFactHead?.factDigest ?? null,
    }
    const nextReceipt = createProviderEpochReceiptV2({
      ...current,
      epoch: current.epoch + 1,
      previousReceiptDigest: current.receiptDigest,
      targetProviderId: "deepseek-compatible",
      targetModelId: "deepseek-compatible-chat",
      targetProfileId: "deepseek-compatible-chat@1",
      baselineHeads: heads,
      reason: "provider_model_profile_switch",
      compactionProofDigest: null,
      createdAt: "2026-08-25T15:01:00.000Z",
    })
    const command = {
      schemaVersion: "provider.context-transition-command/v1" as const,
      sessionId: raw.session.sessionId,
      actorKey: actor.key,
      actorId: actor.id,
      expectedConversationRevision: binding.providerContextFactHead?.conversationRevision ?? 0,
      expectedEpochReceiptDigest: current.receiptDigest,
      expectedLatestAdmissionDigest: binding.providerRequestAdmissions?.at(-1)?.admissionDigest ?? null,
      priorHeads: heads,
      nextHeads: heads,
      reason: "provider_model_profile_switch" as const,
      nextReceipt,
      nextFactHead: binding.providerContextFactHead ?? null,
      retainedFactDigests: [],
      appendedFactDigests: [],
      deliveryConfirmationDigests: [],
      compactionProof: null,
      generation: null,
      occurredAt: nextReceipt.createdAt,
    }

    expect(commitProviderContextTransition(runtime, command, {})).toEqual(nextReceipt)
    expect(commitProviderContextTransition(runtime, command, {})).toEqual(nextReceipt)
    expect(getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
      .session.actorBindings[actor.key]).toMatchObject({
        providerEpochReceiptV2: nextReceipt,
        providerRequestAdmissions: [],
      })
    expect(() => commitProviderContextTransition(runtime, {
      ...command,
      nextReceipt: createProviderEpochReceiptV2({
        ...nextReceipt,
        epoch: nextReceipt.epoch + 1,
        previousReceiptDigest: nextReceipt.receiptDigest,
        targetProviderId: "other",
        createdAt: "2026-08-25T15:02:00.000Z",
      }),
    }, {})).toThrow(/predecessor|expected/i)
  })

  it("admits frozen resource and provider surface revisions through explicit reasoned boundaries", () => {
    const { actor, vm } = fixture()
    const resource = acceptActorProviderContextRevision({
      vm,
      actor,
      kind: "frozen_resource",
      digest: `sha256:${"5".repeat(64)}`,
      occurredAt: "2026-08-25T15:03:00.000Z",
    })
    expect(resource).toMatchObject({
      reason: "frozen_resource_revision_accepted",
      frozenResourceDigest: `sha256:${"5".repeat(64)}`,
    })
    const surface = acceptActorProviderContextRevision({
      vm,
      actor,
      kind: "provider_surface",
      digest: `sha256:${"6".repeat(64)}`,
      occurredAt: "2026-08-25T15:04:00.000Z",
    })
    expect(surface).toMatchObject({
      epoch: resource.epoch + 1,
      previousReceiptDigest: resource.receiptDigest,
      reason: "provider_surface_revision_accepted",
      providerSurfaceDigest: `sha256:${"6".repeat(64)}`,
    })
  })

  it("rejects an over-byte-limit fact batch before mutating the Conversation authority", () => {
    const { actor, vm } = fixture()
    const runtime = ensureVmConversationDomainRuntime(vm)
    const before = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
    const first = appendActorProviderContextFactToConversationDomainRuntime({
      runtime,
      sessionId: before.session.sessionId,
      actorKey: actor.key,
      actorId: actor.id,
      namespace: "provider-projection",
      payload: { content: "x".repeat(63_000) },
      occurredAt: "2026-08-25T15:05:00.000Z",
    })
    const afterFirst = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
    expect(afterFirst.session.actorBindings[actor.key]?.providerContextFactHead?.factDigest)
      .toBe(first.factDigest)
    expect(() => appendActorProviderContextFactToConversationDomainRuntime({
      runtime,
      sessionId: before.session.sessionId,
      actorKey: actor.key,
      actorId: actor.id,
      namespace: "provider-projection",
      payload: { content: "y".repeat(2_000) },
      occurredAt: "2026-08-25T15:05:01.000Z",
    })).toThrow("provider_context_retention_compaction_required")
    const afterRejected = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
    expect(afterRejected.session.actorBindings[actor.key]?.providerContextFactHead?.factDigest)
      .toBe(first.factDigest)
    expect((afterRejected.session.contextAssets ?? []).filter((asset) => asset.providerContextFact)).toHaveLength(1)
  })

  it("recovers each durable transition fault to the exact old or new authority", async () => {
    const faultPoints: LocalProviderContextTransitionFaultPoint[] = [
      "after-stage-create",
      "after-stage-write",
      "after-stage-fsync",
      "after-stage-publish",
      "before-head-cas",
      "after-head-cas",
    ]
    for (const faultPoint of faultPoints) {
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-context-transition-"))
      try {
        const { actor, vm } = fixture()
        const raw = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
        const current = raw.session.actorBindings[actor.key]!.providerEpochReceiptV2!
        const next = createProviderEpochReceiptV2({
          ...current,
          epoch: current.epoch + 1,
          previousReceiptDigest: current.receiptDigest,
          targetProviderId: "deepseek-compatible",
          targetModelId: "deepseek-compatible-chat",
          targetProfileId: "deepseek-compatible-chat@1",
          reason: "provider_model_profile_switch",
          createdAt: "2026-08-25T15:10:00.000Z",
        })
        const initial = new LocalFileConversationPersistenceRepository(sessionDir)
        const historyIndex = await initial.loadHistoryIndex()
        const promptIndex = await initial.loadPromptIndex()
        const sessionIndex = await initial.loadSessionIndex()
        const artifactRefs = await initial.loadArtifactRefs()
        sessionIndex.session.sessionId = raw.session.sessionId
        sessionIndex.session.activeActorKey = actor.key
        sessionIndex.session.actorBindings = {
          [actor.key]: {
            actorKey: actor.key,
            actorId: actor.id,
            boundAt: current.createdAt,
            providerEpochReceiptV2: current,
            providerRequestAdmissions: [],
          },
        }
        await initial.writeSessionIndex(sessionIndex)
        const nextSessionIndex = structuredClone(sessionIndex)
        nextSessionIndex.session.actorBindings[actor.key]!.providerEpochReceiptV2 = next
        const transitionFacts = {
          schemaVersion: "conversation.provider-context-transition-generation/v1" as const,
          expectedEpochReceiptDigest: current.receiptDigest,
          nextEpochReceiptDigest: next.receiptDigest,
          historyIndex,
          promptIndex,
          sessionIndex: nextSessionIndex,
          artifactRefs,
          historyGenerations: [],
          promptGenerations: [],
          createdAt: next.createdAt,
        }
        const transition = {
          transitionId: digestConversationProviderContextTransitionGeneration(transitionFacts),
          ...transitionFacts,
        }
        let injected = false
        const interrupted = new LocalFileConversationPersistenceRepository(sessionDir, {
          providerContextTransitionFault(point) {
            if (!injected && point === faultPoint) {
              injected = true
              throw new Error(`fault:${point}`)
            }
          },
        })
        await expect(interrupted.commitProviderContextTransitionGeneration(transition))
          .rejects.toThrow(`fault:${faultPoint}`)

        const recovered = new LocalFileConversationPersistenceRepository(sessionDir)
        const afterRecovery = await recovered.loadSessionIndex()
        const recoveredDigest = afterRecovery.session.actorBindings[actor.key]
          ?.providerEpochReceiptV2?.receiptDigest
        expect([current.receiptDigest, next.receiptDigest]).toContain(recoveredDigest)
        if (recoveredDigest === current.receiptDigest) {
          await recovered.commitProviderContextTransitionGeneration(transition)
        }
        expect((await recovered.loadSessionIndex()).session.actorBindings[actor.key]
          ?.providerEpochReceiptV2?.receiptDigest).toBe(next.receiptDigest)
      } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true })
      }
    }
  })

  it("fresh-recovers exact resource and rewind receipts from the one filesystem authority", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-context-boundaries-"))
    try {
      const { actor, vm } = fixture()
      const repository = new LocalFileConversationPersistenceRepository(sessionDir)
      const before = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
      const initial = before.session.actorBindings[actor.key]!.providerEpochReceiptV2!
      const initialSessionIndex = structuredClone(before.session.sessionIndex)
      await repository.writeHistoryIndex(before.session.historyIndex)
      if (before.activeHistoryGeneration) await repository.writeHistoryGeneration(before.activeHistoryGeneration)
      await repository.writePromptIndex(before.session.promptIndex)
      if (before.promptGeneration) await repository.writePromptGeneration(before.promptGeneration)
      await repository.writeSessionIndex(initialSessionIndex)

      const resource = acceptActorProviderContextRevision({
        vm,
        actor,
        kind: "frozen_resource",
        digest: `sha256:${"7".repeat(64)}`,
        occurredAt: "2026-08-25T15:20:00.000Z",
      })
      const afterResource = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
      const resourceSessionIndex = structuredClone(afterResource.session.sessionIndex)
      const resourceFacts = {
        schemaVersion: "conversation.provider-context-transition-generation/v1" as const,
        expectedEpochReceiptDigest: initial.receiptDigest,
        nextEpochReceiptDigest: resource.receiptDigest,
        historyIndex: afterResource.session.historyIndex,
        promptIndex: afterResource.session.promptIndex,
        sessionIndex: resourceSessionIndex,
        artifactRefs: await repository.loadArtifactRefs(),
        historyGenerations: [],
        promptGenerations: [],
        createdAt: resource.createdAt,
      }
      await repository.commitProviderContextTransitionGeneration({
        transitionId: digestConversationProviderContextTransitionGeneration(resourceFacts),
        ...resourceFacts,
      })
      expect((await new LocalFileConversationPersistenceRepository(sessionDir).loadSessionIndex())
        .session.actorBindings[actor.key]?.providerEpochReceiptV2).toEqual(resource)

      const current = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
      const active = current.activeHistoryGeneration!
      const occurredAt = "2026-08-25T15:21:00.000Z"
      const rewindGenerationId = `${active.generationId}__rewind_1`
      const rewindGeneration = JSON.parse(JSON.stringify({
        ...structuredClone(active),
        generationId: rewindGenerationId,
        parentGenerationId: active.generationId,
        predecessorGenerationIds: [active.generationId],
        createdReason: "rollback" as const,
        sealed: true,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })) as typeof active
      const historyIndex = structuredClone(current.session.historyIndex)
      historyIndex.updatedAt = occurredAt
      historyIndex.generations[rewindGenerationId] = {
        generationId: rewindGenerationId,
        actorKey: actor.key,
        actorId: actor.id,
        sealed: true,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      }
      historyIndex.heads[actor.key] = {
        ...historyIndex.heads[actor.key]!,
        activeGenerationId: rewindGenerationId,
        visibleGenerationIds: [rewindGenerationId],
        updatedAt: occurredAt,
      }
      historyIndex.lineages[rewindGenerationId] = {
        version: historyIndex.version,
        sessionId: current.session.sessionId,
        actorKey: actor.key,
        actorId: actor.id,
        generationId: rewindGenerationId,
        parentGenerationId: active.generationId,
        rolledBackFromGenerationId: active.generationId,
        predecessorGenerationIds: [active.generationId],
        successorGenerationIds: [],
        forkGenerationIds: [],
        branchLabel: "rewind",
        updatedAt: occurredAt,
      }
      const rewindPromptGenerationId = `${rewindGenerationId}__prompt`
      const rewindPromptGeneration = {
        version: current.session.promptIndex.version,
        promptGenerationId: rewindPromptGenerationId,
        sessionId: current.session.sessionId,
        actorKey: actor.key,
        actorId: actor.id,
        basedOnPromptGenerationId: current.promptHeadGenerationId ?? null,
        basis: {
          version: current.session.promptIndex.version,
          basisHistoryGenerationIds: [rewindGenerationId],
          basisMessageRecordIds: rewindGeneration.messages.map((message) => message.recordId),
        },
        transforms: [],
        createdReason: "restore" as const,
        materializedContext: null,
        sealed: true,
        createdAt: occurredAt,
        sealedAt: occurredAt,
        updatedAt: occurredAt,
      }
      const nextHeads = {
        historyHeadGenerationId: rewindGenerationId,
        promptHeadGenerationId: rewindPromptGenerationId,
        factHeadDigest: null,
      }
      const promptIndex = structuredClone(current.session.promptIndex)
      promptIndex.heads[actor.key] = {
        version: promptIndex.version,
        sessionId: current.session.sessionId,
        actorKey: actor.key,
        actorId: actor.id,
        activePromptGenerationId: nextHeads.promptHeadGenerationId,
        updatedAt: occurredAt,
      }
      promptIndex.generations[rewindPromptGenerationId] = {
        promptGenerationId: rewindPromptGenerationId,
        actorKey: actor.key,
        actorId: actor.id,
        sealed: true,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      }
      promptIndex.updatedAt = occurredAt
      const rewindReceipt = createProviderEpochReceiptV2({
        ...resource,
        epoch: resource.epoch + 1,
        previousReceiptDigest: resource.receiptDigest,
        baselineHeads: nextHeads,
        sourceHistoryMessageCount: rewindGeneration.messages.length,
        sourceFrontierDigest: digestProviderContextHistoryFrontier(rewindGeneration.messages),
        handoffDigest: digestProviderContextClosedValue({ historyGenerationId: rewindGenerationId }),
        reason: "history_rewind_or_fork",
        compactionProofDigest: null,
        createdAt: occurredAt,
      })
      const sessionIndex = structuredClone(current.session.sessionIndex)
      sessionIndex.updatedAt = occurredAt
      sessionIndex.session.contextAssets = (sessionIndex.session.contextAssets ?? [])
        .filter((asset) => asset.providerContextFact?.actorKey !== actor.key)
      sessionIndex.session.contextAssetRegistry = {
        version: sessionIndex.version,
        assetIds: (sessionIndex.session.contextAssets ?? []).map((asset) => asset.assetId),
        updatedAt: occurredAt,
      }
      sessionIndex.session.actorBindings[actor.key] = {
        ...sessionIndex.session.actorBindings[actor.key]!,
        historyHeadGenerationId: rewindGenerationId,
        promptHeadGenerationId: nextHeads.promptHeadGenerationId,
        contextEpoch: rewindReceipt.epoch,
        providerEpochReceiptV2: rewindReceipt,
        providerRequestAdmissions: [],
        providerContextFactHead: null,
      }
      const rewindFacts = {
        schemaVersion: "conversation.provider-context-transition-generation/v1" as const,
        expectedEpochReceiptDigest: resource.receiptDigest,
        nextEpochReceiptDigest: rewindReceipt.receiptDigest,
        historyIndex,
        promptIndex,
        sessionIndex,
        artifactRefs: await repository.loadArtifactRefs(),
        historyGenerations: [rewindGeneration],
        promptGenerations: [rewindPromptGeneration],
        createdAt: occurredAt,
      }
      const generation = {
        transitionId: digestConversationProviderContextTransitionGeneration(rewindFacts),
        ...rewindFacts,
      }
      await repository.commitProviderContextTransitionGeneration(generation)
      const currentBinding = current.session.actorBindings[actor.key]!
      commitProviderContextTransition(ensureVmConversationDomainRuntime(vm), {
        schemaVersion: "provider.context-transition-command/v1",
        sessionId: current.session.sessionId,
        actorKey: actor.key,
        actorId: actor.id,
        expectedConversationRevision: currentBinding.providerContextFactHead?.conversationRevision ?? 0,
        expectedEpochReceiptDigest: resource.receiptDigest,
        expectedLatestAdmissionDigest: currentBinding.providerRequestAdmissions?.at(-1)?.admissionDigest ?? null,
        priorHeads: {
          historyHeadGenerationId: current.historyHeadGenerationId ?? "__empty_history__",
          promptHeadGenerationId: current.promptHeadGenerationId ?? "__empty_prompt__",
          factHeadDigest: currentBinding.providerContextFactHead?.factDigest ?? null,
        },
        nextHeads,
        reason: "history_rewind_or_fork",
        nextReceipt: rewindReceipt,
        nextFactHead: null,
        retainedFactDigests: [],
        appendedFactDigests: [],
        deliveryConfirmationDigests: [],
        compactionProof: null,
        generation,
        occurredAt,
      }, {})
      const fresh = new LocalFileConversationPersistenceRepository(sessionDir)
      expect((await fresh.loadSessionIndex()).session.actorBindings[actor.key]
        ?.providerEpochReceiptV2).toEqual(rewindReceipt)
      expect(await fresh.loadHistoryGeneration(rewindGenerationId)).toEqual(rewindGeneration)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })
})
