import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createActorDurableMaterial, normalizeActorDurableMaterialIndex } from "@cell/ai-core-logic/runtime/ActorDurableMaterial"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import {
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFileRuntimeDerivedIndexesStore,
  LocalFileRuntimeSnapshotRepositoryFactory,
  freezeAiWorkflowResourcePackage,
  installBundledSystemSkills,
} from "@cell/ai-support"
import { applyFileStoreAiRuntimeSessionUpgrade } from "@cell/ai-runtime-control-composer"
import type { ProviderRequestObservationData } from "@cell/ai-organ-contract/llm/ProviderRuntime"
import type { ProviderCacheCostObservation } from "@cell/ai-organ-contract/llm/ProviderCacheCostObservation"

import { invokeAddressedChildExecutionActor } from "../../agent/DelegateActor"
import { buildBuiltinToolDefs } from "../../composer/AIAgent/ToolFuncBuiltin"
import { composeToolRegistry } from "../../composer/AIAgent/ToolFuncComposer"
import {
  emitConversationDomainEvent,
  ensureVmConversationDomainRuntime,
  getConversationActorRawStateFromVm,
  recordPromptRequestToConversationDomainRuntime,
  rewriteActiveHistoryGenerationMessagesInConversationDomainRuntime,
  synchronizeConversationDomainActorFromPersistence,
} from "../../conversation/ConversationDomainRuntime"
import { acceptActorProviderContextRevision, activateActorProviderEpoch } from "../../conversation/ProviderEpoch"
import { digestProviderContextClosedValue, digestProviderContextHistoryFrontier } from "../../conversation/ProviderContextEpochV2"
import { computeProviderEpochReceiptIntegrityDigest } from "../../conversation/ProviderEpochProjection"
import { ProviderRuntimeLlmAdapter } from "../ProviderRuntimeAdapter"
import { createAiAgentOrchestratorDriverWithCooperative } from "../../OrchestratorDriver"
import {
  configureRuntimePersistenceSupport,
  recoverAiAgentRuntime,
  saveAiAgentRuntimeSnapshot,
} from "../../persistence/RuntimeSnapshots"
import { getVmToolCallDomain } from "../../runtime/ToolCallDomainRuntime"
import { forceCompressActorHistory } from "../../exec/AiAgentExecutor"
import { EidolonWorkflowEffectProvider } from "../../workflow/effects/EidolonWorkflowEffectProvider"
import { WorkflowFactStore } from "../../workflow/runtime/WorkflowFactStore"
import { spawnWorkflowLifecycleExecutionActor } from "../../workflow/runtime/WorkflowLifecycleActorCapsule"
import { readWorkflowLifecycleFacet } from "../../workflow/runtime/WorkflowLifecycleFacet"
import {
  WORKFLOW_SURFACE_EXPERIMENT_STAGES,
  WORKFLOW_SURFACE_STRATEGY_REGISTRY,
  createClosedWorkflowSurfaceExperimentInput,
  digestClosedWorkflowSurfaceValue,
} from "../../workflow/runtime/WorkflowProviderSurfaceStrategy"
import {
  createLocalWorkflowSurfaceExperimentRuntime,
  readVerifiedWorkflowSurfaceProductJourney,
  runClosedWorkflowSurfaceExperiment,
  selectWorkflowSurfaceStrategy,
  type VerifiedWorkflowSurfaceProductJourney,
} from "../../workflow/runtime/WorkflowProviderSurfaceExperimentRuntime"
import { WORKFLOW_LIFECYCLE_TOOL_PROFILE } from "../../workflow/tools"
import { createProviderCacheCostObservation } from "../ProviderCacheCostObservation"
import { estimateFinalWireProviderCacheCostTokens } from "../ProviderCacheCostEstimates"

type OrdinaryProductScenarioOptions = Readonly<{
  scenarioId: string
  tools: "none" | "all" | "clock"
  retry503?: boolean
  parallelToolCalls?: boolean
  turns?: number
  retainedMessages?: number
  sessionId?: string
  freshRecovery?: boolean
  initialDurableMaterials?: Readonly<Record<string, unknown>>
  epochTransition?: "provider_model_profile_switch" | "frozen_resource_revision_accepted" | "provider_surface_revision_accepted" | "history_compaction" | "history_rewind_or_fork" | "legacy_context_import"
}>

type OrdinaryProductScenarioRun = Readonly<{
  vm: ReturnType<typeof createVM>
  actorKey: string
  actorId: string
  sessionDir: string
  cleanupDir: string
  observations: readonly ProviderRequestObservationData[]
  cacheObservations: readonly ProviderCacheCostObservation[]
  sourceRecords: ReadonlyMap<string, ProviderCacheProductSourceRecord>
  recovery: Readonly<{
    distinctVm: boolean
    exactActor: boolean
    exactEpoch: boolean
    exactAdmissions: boolean
    continuationObserved: boolean
    recoveredEpochReason: string
    recoveredEpochReceiptDigest: string
    recoveredFrozenResourceDigest: string
    distinctRuntimeProofDigest: `sha256:${string}`
  }> | null
  deliveryConfirmationCounts: readonly number[]
  wireMessageCounts: readonly number[]
  isolation: Readonly<{
    sequence: readonly Readonly<{ globalOrdinal: number; actorClass: "ordinary" | "workflow_lifecycle" | "workflow_ctrl_node" | "workflow_data_node"; sessionId: string; actorId: string }>[]
    lifecycle: WorkflowLifecycleProductRun
    ctrl: WorkflowNodeProductRun
    data: WorkflowNodeProductRun
  }> | null
}>

type ProviderCacheProductSourceKind =
  | "scenario"
  | "actor"
  | "session"
  | "strategy_proof"
  | "frozen_resource"
  | "request_admission"
  | "final_wire"
  | "provider_epoch"
  | "tool_effect"
  | "transport_attempt"
  | "final_success_usage"

type ProviderCacheProductSourceRecord = Readonly<{
  schemaVersion: "eidolon.provider-cache-product-source/v1"
  kind: ProviderCacheProductSourceKind
  sourceId: string
  identity: Readonly<{
    sessionId: string
    actorKey: string
    actorId: string
    providerCallId: string | null
    callOrdinal: number | null
    attemptOrdinal: number | null
  }>
  facts: unknown
}>

type WorkflowNodeProductRun = Readonly<{
  kind: "ai_ctrl" | "ai_data"
  sessionDir: string
  sessionId: string
  actorId: string
  actorKey: string
  cacheObservation: ProviderCacheCostObservation
  requestObservation: ProviderRequestObservationData
  epochReason: string
  admissionDigest: string
  admission: any
  epoch: any
  globalOrdinal: number | null
}>

type WorkflowLifecycleProductRun = Readonly<{
  actorClass: "workflow_lifecycle"
  sessionDir: string
  sessionId: string
  actorId: string
  actorKey: string
  epochReason: string
  frozenResourceDigest: string
  requestObservation: ProviderRequestObservationData
  cacheObservation: ProviderCacheCostObservation
  admission: any
  epoch: any
  globalOrdinal: number | null
}>

type IsolationActorClass = "ordinary" | "workflow_lifecycle" | "workflow_ctrl_node" | "workflow_data_node"
type IsolationExecutionContext = {
  nextOrdinal: number
  ordinalsByProviderCallId: Map<string, number>
  sequence: Array<Readonly<{ globalOrdinal: number; actorClass: IsolationActorClass; sessionId: string; actorId: string }>>
}

let activeIsolationExecution: IsolationExecutionContext | null = null
const OBSERVATION_GLOBAL_ORDINALS = new WeakMap<object, number>()

function appendProductTransportObservation(
  target: ProviderRequestObservationData[],
  entry: ProviderRequestObservationData,
  actorClass: IsolationActorClass,
  sessionId: string,
): void {
  target.push(entry)
  const context = activeIsolationExecution
  if (!context) return
  let ordinal = context.ordinalsByProviderCallId.get(entry.providerCallId)
  if (ordinal === undefined) {
    ordinal = context.nextOrdinal
    context.nextOrdinal += 1
    context.ordinalsByProviderCallId.set(entry.providerCallId, ordinal)
    context.sequence.push(Object.freeze({
      globalOrdinal: ordinal,
      actorClass,
      sessionId,
      actorId: String(entry.actorId),
    }))
  }
  OBSERVATION_GLOBAL_ORDINALS.set(entry as object, ordinal)
}

function readProviderCacheProductTransportGlobalOrdinal(
  observation: ProviderRequestObservationData,
): number | null {
  return OBSERVATION_GLOBAL_ORDINALS.get(observation as object) ?? null
}

function sha(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`
}

function digestProviderCacheProductClosedValue(value: unknown): `sha256:${string}` {
  return sha(JSON.stringify(value))
}

const PRODUCT_RESOURCE_V2_MATERIAL = createActorDurableMaterial(
  "provider-cache-product-resource-v2",
  "application/vnd.eidolon.provider-cache-product+json",
)
const PRODUCT_RESOURCE_V2_MATERIALS = Object.freeze({
  [PRODUCT_RESOURCE_V2_MATERIAL.digest]: PRODUCT_RESOURCE_V2_MATERIAL,
})

function sse(content = "done"): Response {
  return new Response([
    `data: ${JSON.stringify({
      choices: [{ delta: { content }, finish_reason: null }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 4,
        total_tokens: 104,
        prompt_cache_hit_tokens: 75,
        prompt_cache_miss_tokens: 25,
      },
    })}`,
    "data: [DONE]",
    "",
  ].join("\n\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

function sourceRecord(input: {
  kind: ProviderCacheProductSourceKind
  sourceId: string
  sessionId: string
  actorKey: string
  actorId: string
  providerCallId?: string
  callOrdinal?: number
  attemptOrdinal?: number
  facts: unknown
}): ProviderCacheProductSourceRecord {
  return Object.freeze({
    schemaVersion: "eidolon.provider-cache-product-source/v1" as const,
    kind: input.kind,
    sourceId: input.sourceId,
    identity: Object.freeze({
      sessionId: input.sessionId,
      actorKey: input.actorKey,
      actorId: input.actorId,
      providerCallId: input.providerCallId ?? null,
      callOrdinal: input.callOrdinal ?? null,
      attemptOrdinal: input.attemptOrdinal ?? null,
    }),
    facts: structuredClone(input.facts),
  })
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* final-success usage is emitted while draining */ }
}

async function runOrdinaryProductScenario(
  options: OrdinaryProductScenarioOptions,
): Promise<OrdinaryProductScenarioRun> {
  const sessionId = options.sessionId ?? `session-${options.scenarioId.replace(/[^a-z0-9]+/gi, "-")}`
  const cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-provider-cache-product-"))
  // The file backend derives its session identity from the directory basename.
  // Keep that physical authority aligned with the runtime session owner.
  const sessionDir = path.join(cleanupDir, sessionId)
  fs.mkdirSync(sessionDir, { recursive: true })
  const requestObservations: ProviderRequestObservationData[] = []
  const cacheObservations: ProviderCacheCostObservation[] = []
  const fetchBodies: string[] = []
  let fetchOrdinal = 0
  const originalFetch = globalThis.fetch
  const ownsIsolationExecution = options.scenarioId === "isolation.four-actors-two-sessions/v1"
  if (ownsIsolationExecution) {
    if (activeIsolationExecution) throw new Error("provider cache isolation orchestrator is already active")
    activeIsolationExecution = { nextOrdinal: 1, ordinalsByProviderCallId: new Map(), sequence: [] }
  }
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    fetchOrdinal += 1
    fetchBodies.push(String(init?.body ?? ""))
    if (options.retry503 && fetchOrdinal === 1) return new Response("temporary", { status: 503 })
    if (options.epochTransition === "history_compaction" && fetchOrdinal === 2) {
      return sse("<state_snapshot><overall_goal>cache matrix</overall_goal></state_snapshot>")
    }
    return sse()
  }) as typeof fetch
  try {
    configureRuntimePersistenceSupport({
      snapshotRepositoryFactory: LocalFileRuntimeSnapshotRepositoryFactory,
      derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore,
      conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
    })
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "product-deepseek-compatible",
      selectedModel: "deepseek-chat",
      adapterName: "deepseek",
      options: {
        apiKey: "fixture-only-not-reported",
        baseURL: "https://provider-cache-product.invalid/v1",
        compatibility_profile: "deepseek-compatible-chat@1",
      },
      runtime: {
        sessionId,
        requestObservationPort: {
          append: (entry) => appendProductTransportObservation(requestObservations, entry, "ordinary", sessionId),
          appendOutcome: () => {},
        },
      },
    })
    const originalCreateStream = adapter.createStream.bind(adapter)
    adapter.createStream = async (generateOptions) => {
      const result = await originalCreateStream({
        ...generateOptions,
        ...(generateOptions.providerCacheCostObservation ? {
          providerCacheCostObservation: {
            ...generateOptions.providerCacheCostObservation,
            priceWeights: { cacheHitWeight: 0.1, cacheMissWeight: 1 },
          },
        } : {}),
      })
      return {
        ...result,
        providerOutput: result.providerOutput?.then((output: any) => {
          const observation = output?.provider_cache_cost_observation as ProviderCacheCostObservation | undefined
          // Compression is a real auxiliary provider call but intentionally
          // has no admitted product-turn cache observation. The canonical
          // addressed calls below are still required one-for-one.
          if (observation) cacheObservations.push(observation)
          return output
        }),
      }
    }
    // Ordinary Actors receive the ordinary registry: builtin tools plus the
    // two public Workflow gateways. Lifecycle-internal definitions are bound
    // only by the lifecycle capsule's registry/profile authority.
    const toolRegistry = composeToolRegistry()
    const allSchemas = ToolFuncRegistry.list(toolRegistry).map((definition) => definition.schema)
    const clockName = "get_goal"
    const selectedTools = options.tools === "none" ? [] : options.tools === "clock" ? [clockName] : "*"
    if (options.retainedMessages !== undefined
      && (!Number.isSafeInteger(options.retainedMessages) || options.retainedMessages < 3)) {
      throw new Error("retainedMessages must be a safe integer greater than two")
    }
    const longContextSeed = options.retainedMessages === undefined ? undefined : Array.from(
      { length: options.retainedMessages - 2 },
      (_, index) => index === 0
        ? { role: "system" as const, content: "Frozen long-context product root." }
        : {
          role: index % 2 === 0 ? "assistant" as const : "user" as const,
          content: options.epochTransition === "history_compaction"
            ? `retained-${index}-${"x".repeat(256)}`
            : `retained-${index}`,
        },
    )
    const parent = createActor({
      key: "main",
      id: `parent-${sha(options.scenarioId).slice(-12)}`,
      agentName: "main",
      llmClient: adapter,
      modelConfig: { model: "deepseek-chat", provider: "product-deepseek-compatible", adapter: "deepseek", options: { compatibilityProfile: "deepseek-compatible-chat@1" } },
      callbacks: {
        buildToolset: () => allSchemas,
        processStream: async (_vm, actor, stream) => {
          await drain(stream as AsyncIterable<unknown>)
          const toolDomain = getVmToolCallDomain(_vm)
          const completed = toolDomain?.getAllRecords().filter((record) => record.actorKey === actor.key && record.status === "completed").length ?? 0
          if (options.tools === "clock" && completed === 0) {
            return {
              role: "assistant" as const,
              reasoning_content: "fixture reasoning output",
              tool_calls: Array.from({ length: options.parallelToolCalls ? 2 : 1 }, (_, index) => ({
                id: `product-tool-${index + 1}`,
                type: "function",
                function: { name: clockName, arguments: "{}" },
              })),
            }
          }
          return { role: "assistant" as const, content: "done" }
        },
      },
    })
    let vm = createVM({
      controlActorKey: parent.key,
      actors: { [parent.key]: parent },
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({
          code: {
            name: "code",
            description: "ordinary product cache E2E actor",
            tools: selectedTools,
            prompt: ["Run the ordinary product journey."],
            ...(longContextSeed ? { seedMessages: longContextSeed } : {}),
            ...(selectedTools === "*" ? {} : { requireExactTools: true }),
          },
        }),
      },
      outerCtx: {
        metadata: { sessionId, sessionDir },
        conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
      },
    })
    const turns = options.turns ?? 2
    let reference: Awaited<ReturnType<typeof invokeAddressedChildExecutionActor>>["reference"] | undefined
    const epochReceipts: any[] = []
    const journeyAdmissions: any[] = []
    const journeyObservations: ProviderRequestObservationData[] = []
    let isolationChildren: OrdinaryProductScenarioRun["isolation"] = null
    let admissionCursor = 0
    for (let turn = 0; turn < turns; turn += 1) {
      const observationCursor = requestObservations.length
      const execution = await invokeAddressedChildExecutionActor(vm, parent, {
        description: "ordinary product cache E2E",
        prompt: `product turn ${turn + 1}`,
        agentType: "code",
        resolvedConfig: AgentRegistry.get(vm.registries.agentRegistry, "code")!,
        sessionId,
        ...(!reference && options.initialDurableMaterials
          ? { durableMaterials: options.initialDurableMaterials }
          : {}),
        ...(reference ? { target: reference } : {}),
      })
      reference = execution.reference
      const currentActor = vm.actors[reference.actorKey]!
      const currentEpoch = getConversationActorRawStateFromVm({ vm, actorKey: currentActor.key })
        ?.session.actorBindings[currentActor.key]?.providerEpochReceiptV2
      const currentAdmissions = getConversationActorRawStateFromVm({ vm, actorKey: currentActor.key })
        ?.session.actorBindings[currentActor.key]?.providerRequestAdmissions ?? []
      if (!currentEpoch) throw new Error("ordinary product turn lacks canonical epoch receipt")
      const newAdmissions = currentAdmissions.slice(admissionCursor)
      if (newAdmissions.length === 0) throw new Error("ordinary product turn lacks canonical request admission")
      journeyAdmissions.push(...newAdmissions)
      epochReceipts.push(...newAdmissions.map(() => currentEpoch))
      journeyObservations.push(...requestObservations.slice(observationCursor))
      admissionCursor = currentAdmissions.length
      if (turn === 0 && options.epochTransition) {
        if (options.epochTransition === "history_compaction") {
          // Drive the production compaction policy with a genuinely oversized
          // canonical history while leaving enough budget for its real
          // state-snapshot prompt. A tiny artificial limit only exercises the
          // prompt-overhead rejection branch and never commits a transition.
          currentActor.modelConfig.inputLimit = 8_192
          const compacted = await forceCompressActorHistory({ vm, actor: currentActor, trigger: "provider-cache-product-matrix" })
          if (!compacted.ok || !compacted.compacted) throw new Error(`product compaction did not commit: ${JSON.stringify(compacted)}`)
        } else if (options.epochTransition === "history_rewind_or_fork") {
          const rewritten = rewriteActiveHistoryGenerationMessagesInConversationDomainRuntime({
            vm,
            actorKey: currentActor.key,
            actorId: currentActor.id,
            reason: "provider-cache-product-rewind",
            rewrite: (messages) => messages.map((message, index) => index === 0
              ? { ...message, content: `${String(message.content ?? "")} [rewound]` }
              : message),
          })
          if (!rewritten.changed) throw new Error("product rewind did not move canonical history authority")
        } else if (options.epochTransition === "legacy_context_import") {
          // Reproduce the exact on-disk v1 authority accepted by the product's
          // backward-compatible importer, then enter a fresh Conversation
          // runtime through its canonical file read port. The v1 receipt is
          // migration input only; G5 proof is issued solely from the resulting
          // production v2 admission/epoch owners.
          const runtime = ensureVmConversationDomainRuntime(vm)
          const occurredAt = new Date().toISOString()
          const promptGenerationId = recordPromptRequestToConversationDomainRuntime({
            runtime,
            sessionId,
            actorKey: currentActor.key,
            actorId: currentActor.id,
            reason: "overlay",
            occurredAt,
          })
          const overlayPayload = Object.freeze({
            content: "legacy cache product work context",
            overlayKind: "work_context",
            insertPlacement: "late_status",
            promptPlanVersion: 1,
          })
          emitConversationDomainEvent(runtime, {
            type: "actor_prompt_transform_applied",
            sessionId,
            actorKey: currentActor.key,
            promptGenerationId,
            transformId: `${promptGenerationId}::legacy-product-overlay`,
            transformKind: "overlay",
            payload: overlayPayload,
            transform: {
              transformId: `${promptGenerationId}::legacy-product-overlay`,
              kind: "overlay",
              payload: overlayPayload,
              appliedAt: occurredAt,
            },
            occurredAt,
          })
          const legacyRaw = getConversationActorRawStateFromVm({ vm, actorKey: currentActor.key })!
          const legacyOverlayCount = legacyRaw.promptGeneration?.transforms.filter((transform) => (
            transform.kind === "overlay"
            && transform.payload?.overlayKind === "work_context"
            && transform.payload?.insertPlacement === "late_status"
          )).length ?? 0
          if (legacyOverlayCount !== 1) {
            throw new Error(`legacy product input lacks one exact late-status overlay (${legacyOverlayCount})`)
          }
          const legacyReceiptFacts = Object.freeze({
            schemaVersion: "provider.epoch-receipt/v1" as const,
            sessionId,
            actorKey: currentActor.key,
            actorId: currentActor.id,
            epoch: currentEpoch.epoch,
            targetProviderId: currentEpoch.targetProviderId,
            targetProfileId: currentEpoch.targetProfileId,
            sourceMessageCount: legacyRaw.activeHistoryGeneration?.messages.length ?? 0,
            pendingToolCallIds: Object.freeze([]),
            sourceFrontierDigest: digestProviderContextHistoryFrontier(legacyRaw.activeHistoryGeneration?.messages ?? []),
            handoffDigest: sha("legacy-cache-product-handoff"),
            reason: "recovery_rebuild" as const,
            createdAt: occurredAt,
          })
          const legacyReceipt = Object.freeze({
            ...legacyReceiptFacts,
            integrityDigest: computeProviderEpochReceiptIntegrityDigest(legacyReceiptFacts),
          })
          const { providerEpochReceiptV2: _retiredV2, ...bindingWithoutV2 } = legacyRaw.session.actorBindings[currentActor.key]!
          const legacyBinding = Object.freeze({
            ...bindingWithoutV2,
            contextEpoch: legacyReceipt.epoch,
            promptHeadGenerationId: legacyRaw.promptGeneration?.promptGenerationId ?? bindingWithoutV2.promptHeadGenerationId,
            providerEpochReceipt: legacyReceipt,
            providerRequestAdmissions: Object.freeze([]),
            providerContextFactHead: null,
          })
          const legacySessionIndex = structuredClone(legacyRaw.session.sessionIndex)
          legacySessionIndex.session.actorBindings[currentActor.key] = legacyBinding
          const legacyPromptIndex = structuredClone(legacyRaw.session.promptIndex)
          if (legacyRaw.promptGeneration) {
            legacyPromptIndex.heads[currentActor.key] = {
              version: legacyPromptIndex.version,
              sessionId,
              actorKey: currentActor.key,
              actorId: currentActor.id,
              activePromptGenerationId: legacyRaw.promptGeneration.promptGenerationId,
              updatedAt: legacyRaw.promptGeneration.updatedAt,
            }
          }
          const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
          await repository.writeHistoryIndex(legacyRaw.session.historyIndex)
          if (legacyRaw.activeHistoryGeneration) await repository.writeHistoryGeneration(legacyRaw.activeHistoryGeneration)
          await repository.writePromptIndex(legacyPromptIndex)
          if (legacyRaw.promptGeneration) await repository.writePromptGeneration(legacyRaw.promptGeneration)
          await repository.writeSessionIndex(legacySessionIndex)
          const freshVm = createVM({
            controlActorKey: parent.key,
            actors: { [parent.key]: parent, [currentActor.key]: currentActor },
            registries: vm.registries,
            outerCtx: vm.outerCtx,
          })
          await synchronizeConversationDomainActorFromPersistence({
            runtime: ensureVmConversationDomainRuntime(freshVm),
            sessionDir,
            actorKey: currentActor.key,
            repository,
          })
          const importedInput = getConversationActorRawStateFromVm({ vm: freshVm, actorKey: currentActor.key })!
          const importedBinding = importedInput.session.actorBindings[currentActor.key]
          const importedOverlayCount = importedInput.promptGeneration?.transforms.filter((transform) => (
            transform.kind === "overlay"
            && transform.payload?.overlayKind === "work_context"
            && transform.payload?.insertPlacement === "late_status"
          )).length ?? 0
          if (!importedBinding?.providerEpochReceipt
            || importedBinding.providerEpochReceiptV2
            || importedOverlayCount !== 1
            || importedBinding.providerContextFactHead
            || (importedBinding.providerRequestAdmissions?.length ?? 0) !== 0) {
            throw new Error(`legacy product file authority was not admitted exactly: ${JSON.stringify({
              hasV1: Boolean(importedBinding?.providerEpochReceipt),
              hasV2: Boolean(importedBinding?.providerEpochReceiptV2),
              overlays: importedOverlayCount,
              factHead: Boolean(importedBinding?.providerContextFactHead),
              admissions: importedBinding?.providerRequestAdmissions?.length ?? 0,
            })}`)
          }
          vm = freshVm
          journeyAdmissions.length = 0
          journeyObservations.length = 0
          epochReceipts.length = 0
          cacheObservations.length = 0
        } else if (options.epochTransition === "provider_model_profile_switch") {
          currentActor.modelConfig.provider = "product-deepseek-compatible-switched"
          activateActorProviderEpoch({
            vm,
            actor: currentActor,
            sessionId,
            targetProviderId: "product-deepseek-compatible-switched",
            targetProfileId: "deepseek-compatible-chat@1",
            reason: "model_control",
          })
        } else {
          const isResource = options.epochTransition === "frozen_resource_revision_accepted"
          if (isResource) {
            ;(currentActor as any).durableMaterials = normalizeActorDurableMaterialIndex(PRODUCT_RESOURCE_V2_MATERIALS)
          } else {
            ;(currentActor.toolPolicy as any).providerToolSurface = Object.freeze({
              mode: currentActor.toolPolicy.allowedToolsMode,
              toolNames: currentActor.toolPolicy.allowedTools,
              revision: "surface-v2",
            })
          }
          acceptActorProviderContextRevision({
            vm,
            actor: currentActor,
            kind: isResource ? "frozen_resource" : "provider_surface",
            digest: digestProviderContextClosedValue(isResource
              ? currentActor.durableMaterials ?? {}
              : currentActor.toolPolicy.providerToolSurface ?? {
                mode: currentActor.toolPolicy.allowedToolsMode,
                toolNames: currentActor.toolPolicy.allowedTools,
              }),
          })
        }
        // Every explicit epoch transition intentionally starts a new request
        // admission chain. Preserve the predecessor receipts above, then read
        // the successor chain from ordinal zero on the next addressed turn.
        admissionCursor = 0
      }
      if (turn === 0 && ownsIsolationExecution) {
        const isolationSessionB = sessionId.endsWith("-a") ? `${sessionId.slice(0, -2)}-b` : `${sessionId}-b`
        const lifecycle = await runWorkflowLifecycleProductScenario({ sessionId: isolationSessionB })
        const ctrl = await runWorkflowNodeProductScenario("ai_ctrl", { sessionId })
        const data = await runWorkflowNodeProductScenario("ai_data", { sessionId: isolationSessionB })
        isolationChildren = Object.freeze({
          sequence: Object.freeze([]),
          lifecycle,
          ctrl,
          data,
        })
      }
    }
    if (!reference) throw new Error("ordinary product gateway did not create an addressed Actor")
    const wireMessageCounts = requestObservations.map((observation) => {
      const body = JSON.parse(String(observation.requestBody)) as { messages?: readonly unknown[] }
      if (!Array.isArray(body.messages)) throw new Error("product final wire has no message array")
      return body.messages.length
    })
    if (options.retainedMessages !== undefined && options.scenarioId === "context.long-128/v1") {
      if (turns !== 2 || wireMessageCounts.length !== 2
        || wireMessageCounts[0] !== options.retainedMessages
        || wireMessageCounts[1] !== options.retainedMessages + 1) {
        throw new Error(`long-context gateway did not retain ${options.retainedMessages}+1 messages (${wireMessageCounts.join(",")})`)
      }
    }
    let actor = vm.actors[reference.actorKey]
    if (!actor || actor.id !== reference.actorId) throw new Error("addressed Actor owner was not retained")
    let recovery: OrdinaryProductScenarioRun["recovery"] = null
    if (options.freshRecovery) {
      const originalVm = vm
      const originalActor = actor
      const beforeRaw = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
      const preRecoveryBinding = beforeRaw.session.actorBindings[actor.key]!
      const recoveryObservationCursor = requestObservations.length
      const driver = createAiAgentOrchestratorDriverWithCooperative({
        fibers: [{ fiberId: `${parent.key}:${parent.id}`, vm, actor: parent, messages: parent.messages, basePriority: 1 }],
        options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
      })
      const saved = await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })
      if (saved.status !== "saved") throw new Error(`fresh recovery snapshot was not saved (${saved.status})`)
      const upgrade = await applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })
      if (upgrade.status !== "applied" && upgrade.status !== "already_upgraded") {
        throw new Error(`fresh recovery snapshot was not admitted (${upgrade.status})`)
      }
      const recovered = await recoverAiAgentRuntime({
        sessionDir,
        sessionId,
        llmClient: adapter,
        registries: vm.registries,
        outerCtx: {
          metadata: { sessionId, sessionDir },
          conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
        },
        actorCallbacks: {
          buildToolset: () => allSchemas,
          processStream: async (_vm, _actor, stream) => {
            await drain(stream as AsyncIterable<unknown>)
            return { role: "assistant", content: "recovered" }
          },
        },
      })
      if (!recovered) throw new Error("fresh recovery returned no VM")
      vm = recovered.vm
      actor = vm.actors[reference.actorKey]!
      const recoveredParent = vm.actors[vm.controlActorKey]!
      if (!actor || !recoveredParent || vm === originalVm || actor === originalActor) {
        throw new Error("fresh recovery did not create a distinct VM/Actor")
      }
      const recoveredRaw = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
      const beforeBinding = beforeRaw.session.actorBindings[actor.key]!
      const recoveredBinding = recoveredRaw.session.actorBindings[actor.key]!
      recovery = Object.freeze({
        distinctVm: true,
        exactActor: actor.id === originalActor.id,
        exactEpoch: recoveredBinding.providerEpochReceiptV2?.receiptDigest === beforeBinding.providerEpochReceiptV2?.receiptDigest,
        exactAdmissions: digestProviderCacheProductClosedValue(recoveredBinding.providerRequestAdmissions ?? [])
          === digestProviderCacheProductClosedValue(beforeBinding.providerRequestAdmissions ?? []),
        continuationObserved: false,
        recoveredEpochReason: String(recoveredBinding.providerEpochReceiptV2?.reason ?? ""),
        recoveredEpochReceiptDigest: String(recoveredBinding.providerEpochReceiptV2?.receiptDigest ?? ""),
        recoveredFrozenResourceDigest: String(recoveredBinding.providerEpochReceiptV2?.frozenResourceDigest ?? ""),
        distinctRuntimeProofDigest: sha(JSON.stringify({
          sessionId,
          actorKey: actor.key,
          actorId: actor.id,
          epochReceiptDigest: recoveredBinding.providerEpochReceiptV2?.receiptDigest ?? null,
          admissionDigest: recoveredBinding.providerRequestAdmissions?.at(-1)?.admissionDigest ?? null,
          distinctVm: true,
          distinctActorObject: true,
        })),
      })
      await invokeAddressedChildExecutionActor(vm, recoveredParent, {
        description: "fresh recovered ordinary product cache E2E",
        prompt: "recovered product turn",
        agentType: "code",
        resolvedConfig: AgentRegistry.get(vm.registries.agentRegistry, "code")!,
        sessionId,
        target: reference,
      })
      const continuedRaw = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })!
      const continuedBinding = continuedRaw.session.actorBindings[actor.key]!
      const recoveryAdmissions = (continuedBinding.providerRequestAdmissions ?? [])
        .slice(preRecoveryBinding.providerRequestAdmissions?.length ?? 0)
      const recoveryObservations = requestObservations.slice(recoveryObservationCursor)
      if (recoveryAdmissions.length !== 1 || recoveryObservations.length === 0) {
        throw new Error(`fresh recovery continuation lacks canonical call closure admissions=${recoveryAdmissions.length} observations=${recoveryObservations.length}`)
      }
      journeyAdmissions.push(...recoveryAdmissions)
      epochReceipts.push(...recoveryAdmissions.map(() => continuedBinding.providerEpochReceiptV2))
      journeyObservations.push(...recoveryObservations)
      recovery = Object.freeze({ ...recovery, continuationObserved: true })
    }
    const raw = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })
    const binding = raw?.session.actorBindings[actor.key]
    const providerCallCount = journeyAdmissions.length
    const minimumProductCalls = options.epochTransition === "legacy_context_import" ? 1 : turns
    if (!raw || !binding?.providerEpochReceiptV2 || providerCallCount < minimumProductCalls
      || cacheObservations.length < providerCallCount) {
      throw new Error(`product journey lacks exact Conversation epoch/admission authority calls=${providerCallCount} admissions=${binding?.providerRequestAdmissions?.length ?? 0} raw=${Boolean(raw)} epoch=${Boolean(binding?.providerEpochReceiptV2)}`)
    }
    const observationsByCall = new Map<string, ProviderRequestObservationData[]>()
    for (const entry of journeyObservations) {
      const current = observationsByCall.get(entry.providerCallId) ?? []
      current.push(entry)
      observationsByCall.set(entry.providerCallId, current)
    }
    const orderedObservationGroups = [...observationsByCall.values()]
    if (orderedObservationGroups.length !== providerCallCount) {
      throw new Error(`product journey lacks final transport observations admissions=${providerCallCount} observations=${orderedObservationGroups.length}`)
    }
    const records = new Map<string, ProviderCacheProductSourceRecord>()
    const add = (record: ProviderCacheProductSourceRecord) => records.set(`${record.kind}\0${record.sourceId}`, record)
    const terminalTools = getVmToolCallDomain(vm)?.getAllRecords().filter((record) => record.actorKey === actor.key && record.status === "completed") ?? []
    for (let index = 0; index < providerCallCount; index += 1) {
      const callOrdinal = index + 1
      const admission = journeyAdmissions[index]!
      const epoch = epochReceipts[index] ?? binding.providerEpochReceiptV2
      const callObservations = orderedObservationGroups[index]!
        .sort((left, right) => left.providerAttemptOrdinal! - right.providerAttemptOrdinal!)
      const cache = cacheObservations[index]!
      const providerCallId = callObservations[0]!.providerCallId
      const finalWire = JSON.parse(String(callObservations.at(-1)!.requestBody)) as any
      const finalWireToolNames = Object.freeze((finalWire.tools ?? []).map((entry: any) => String(entry.function?.name ?? "")))
      add(sourceRecord({ kind: "request_admission", sourceId: `admission-${callOrdinal}`, sessionId, actorKey: actor.key, actorId: actor.id, providerCallId, callOrdinal, facts: {
        admissionDigest: admission.admissionDigest,
        previousAdmissionDigest: admission.previousAdmissionDigest,
        finalRequestDigest: admission.finalRequestDigest,
        historyFrontierDigest: admission.historyFrontierDigest,
      } }))
      add(sourceRecord({ kind: "final_wire", sourceId: `wire-${callOrdinal}`, sessionId, actorKey: actor.key, actorId: actor.id, providerCallId, callOrdinal, facts: {
        requestDigest: cache.requestDigest,
        cacheUnits: cache.units,
        body: String(callObservations.at(-1)!.requestBody),
        toolNames: finalWireToolNames,
        captureLayer: callObservations.at(-1)!.captureLayer,
      } }))
      add(sourceRecord({ kind: "provider_epoch", sourceId: `epoch-${callOrdinal}`, sessionId, actorKey: actor.key, actorId: actor.id, providerCallId, callOrdinal, facts: {
        receiptDigest: epoch.receiptDigest,
        previousReceiptDigest: epoch.previousReceiptDigest,
        epoch: epoch.epoch,
        reason: epoch.reason,
        predecessorFrontierDigest: epoch.previousReceiptDigest === null ? null : journeyAdmissions[index - 1]?.historyFrontierDigest ?? null,
        sourceFrontierDigest: epoch.previousReceiptDigest === null ? admission.historyFrontierDigest : epoch.sourceFrontierDigest,
      } }))
      callObservations.forEach((observation, attemptIndex) => add(sourceRecord({
        kind: "transport_attempt",
        sourceId: `attempt-${callOrdinal}-${attemptIndex + 1}`,
        sessionId,
        actorKey: actor.key,
        actorId: actor.id,
        providerCallId,
        callOrdinal,
        attemptOrdinal: attemptIndex + 1,
        facts: {
          bodyDigest: sha(String(observation.requestBody)),
          status: attemptIndex === callObservations.length - 1 ? "final_success" : "failed_retryable",
          globalOrdinal: readProviderCacheProductTransportGlobalOrdinal(observation),
        },
      })))
      const usage = cache.tokenBreakdown.usage
      if (!usage || cache.tokenBreakdown.normalizedInputCost === null) throw new Error("final-success usage binding is missing")
      add(sourceRecord({ kind: "final_success_usage", sourceId: `usage-${callOrdinal}`, sessionId, actorKey: actor.key, actorId: actor.id, providerCallId, callOrdinal, facts: {
        usageDigest: digestProviderCacheProductClosedValue(usage),
        status: "final_success",
        cacheHitTokens: usage.cacheHitTokens,
        cacheMissTokens: usage.cacheMissTokens,
        normalizedInputCost: cache.tokenBreakdown.normalizedInputCost,
      } }))
      if (index === 0) {
        for (const record of terminalTools) add(sourceRecord({ kind: "tool_effect", sourceId: record.toolCallId, sessionId, actorKey: actor.key, actorId: actor.id, providerCallId, callOrdinal, facts: {
          effectId: record.toolCallId,
          effectDigest: digestProviderCacheProductClosedValue(record),
          status: "completed",
        } }))
      }
    }
    if (ownsIsolationExecution) {
      const sequence = Object.freeze([...(activeIsolationExecution?.sequence ?? [])])
      if (!isolationChildren || JSON.stringify(sequence.map((row) => row.actorClass)) !== JSON.stringify([
        "ordinary", "workflow_lifecycle", "workflow_ctrl_node", "workflow_data_node", "ordinary",
      ]) || JSON.stringify(sequence.map((row) => row.globalOrdinal)) !== JSON.stringify([1, 2, 3, 4, 5])) {
        throw new Error(`provider cache isolation execution order invalid: ${JSON.stringify(sequence)}`)
      }
      isolationChildren = Object.freeze({ ...isolationChildren, sequence })
    }
    return Object.freeze({
      vm, actorKey: actor.key, actorId: actor.id, sessionDir, cleanupDir,
      observations: Object.freeze(requestObservations), cacheObservations: Object.freeze(cacheObservations),
      sourceRecords: records, recovery,
      deliveryConfirmationCounts: Object.freeze(journeyAdmissions.map((admission: any) => admission.deliveryConfirmationDigests?.length ?? 0)),
      wireMessageCounts: Object.freeze(wireMessageCounts),
      isolation: isolationChildren,
    })
  } finally {
    globalThis.fetch = originalFetch
    if (ownsIsolationExecution) activeIsolationExecution = null
  }
}

async function runWorkflowNodeProductScenario(
  kind: "ai_ctrl" | "ai_data",
  options: Readonly<{ sessionId?: string }> = {},
): Promise<WorkflowNodeProductRun> {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), `eidolon-provider-cache-${kind}-`))
  const sessionId = options.sessionId ?? `session-${kind}`
  const requestObservations: ProviderRequestObservationData[] = []
  const cacheObservations: ProviderCacheCostObservation[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => sse()) as typeof fetch
  try {
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "product-deepseek-compatible",
      selectedModel: "deepseek-chat",
      adapterName: "deepseek",
      options: { apiKey: "fixture-only", baseURL: "https://provider-cache-node.invalid/v1", compatibility_profile: "deepseek-compatible-chat@1" },
      runtime: {
        sessionId,
        requestObservationPort: { append: (entry) => appendProductTransportObservation(requestObservations, entry, kind === "ai_ctrl" ? "workflow_ctrl_node" : "workflow_data_node", sessionId), appendOutcome: () => {} },
      },
    })
    const originalCreateStream = adapter.createStream.bind(adapter)
    adapter.createStream = async (options) => {
      const result = await originalCreateStream({
        ...options,
        ...(options.providerCacheCostObservation ? {
          providerCacheCostObservation: {
            ...options.providerCacheCostObservation,
            priceWeights: { cacheHitWeight: 0.1, cacheMissWeight: 1 },
          },
        } : {}),
      })
      return {
        ...result,
        providerOutput: result.providerOutput?.then((output: any) => {
          const observation = output?.provider_cache_cost_observation
          if (observation) cacheObservations.push(observation)
          return output
        }),
      }
    }
    const toolRegistry = composeToolRegistry({ includeWorkflowLifecycle: true })
    const publicTools = buildBuiltinToolDefs({ includeInternalOnly: false }).map((definition) => definition.schema)
    const publicNames = publicTools.map((schema) => schema.function.name)
    const parent = createActor({
      key: "main",
      id: `parent-${kind}`,
      agentName: "main",
      llmClient: adapter,
      modelConfig: { model: "deepseek-chat", provider: "product-deepseek-compatible", adapter: "deepseek", options: { compatibilityProfile: "deepseek-compatible-chat@1" } },
      callbacks: {
        buildToolset: () => publicTools,
        processStream: async (_vm, _actor, stream) => {
          await drain(stream as AsyncIterable<unknown>)
          return { role: "assistant", content: "node done" }
        },
      },
    })
    const vm = createVM({
      controlActorKey: parent.key,
      actors: { [parent.key]: parent },
      registries: { toolRegistry, agentRegistry: new AgentRegistry() },
      outerCtx: { metadata: { sessionId, sessionDir } },
    })
    const workflowForm = kind === "ai_ctrl" ? "AICtrlWorkflow" : "AIDataWorkflow"
    const run = { workflow: { ref: `resource://product.${workflowForm}`, scheme: "resource" as const }, runId: `${kind}-run`, generation: 0 }
    const executionContract = Object.freeze({
      schemaVersion: "eidolon.agent-execution-contract/v1" as const,
      input: Object.freeze({ schemaVersion: "eidolon.agent-execution-input/v1" as const, payload: Object.freeze({ request: "node product task" }), materials: Object.freeze([]) }),
      messageSchemas: Object.freeze([]),
      effectPolicy: Object.freeze({ toolMode: "declared-only" as const }),
    })
    const agentDefinitionRef = `resource://product.${kind}.Agent` as const
    const prepared = {
      plan: Object.freeze({
        schemaVersion: "eidolon.resource-agent-execution-plan/v1",
        agentDefinitionRef,
        registryRevision: "sha256:registry",
        compositionRevision: "sha256:composition",
        agentContentDigest: "sha256:agent",
        messages: Object.freeze([]),
        toolResourceIds: Object.freeze(publicNames),
        requiresWorkflowTask: true,
        executionContract,
        agentConfig: Object.freeze({
          name: agentDefinitionRef,
          description: "frozen stage-free Workflow node Agent",
          tools: Object.freeze(publicNames),
          prompt: Object.freeze(["Frozen stage-free Workflow node Agent instruction."]),
          requireExactTools: true,
          executionContract,
        }),
      }),
      receipt: Object.freeze({
        schemaVersion: "ai-workflow.run-resource-freeze/v1" as const,
        task: Object.freeze({ workflowKind: workflowForm, workflowRef: run.workflow.ref, nodeId: "agent-node", agentDefinitionRef }),
        bindingResourceIds: Object.freeze([]),
        dependencySnapshot: Object.freeze({}),
        semanticFingerprint: "sha256:semantic" as const,
      }),
    }
    const provider = new EidolonWorkflowEffectProvider(
      { vm, actor: parent } as any,
      {} as any,
      new WorkflowFactStore(sessionDir),
      undefined,
      () => run,
      { workflowForm, resourceRegistry: { prepareWorkflowAgentExecution: async () => prepared } as any },
    )
    await provider.invoke({
      run,
      effectId: `${kind}-effect`,
      operation: "ai.agent",
      nodeId: "agent-node",
      input: { agentDefinitionRef, payload: { request: "node product task" } },
    } as any)
    if (requestObservations.length !== 1 || cacheObservations.length !== 1) throw new Error("node product path did not emit one final request/usage")
    const actorId = requestObservations[0]!.actorId!
    const runtime = (vm as any).runtimeContext?.conversationDomainRuntime
    const sessions = runtime?.sessionStateSignal?.get?.() ?? {}
    let actorKey = ""
    let binding: any
    for (const state of Object.values(sessions) as any[]) {
      for (const [key, candidate] of Object.entries(state.actorBindings ?? {}) as any) {
        if ((candidate as any).actorId === actorId) { actorKey = key; binding = candidate; break }
      }
    }
    if (!actorKey || !binding?.providerEpochReceiptV2 || binding.providerRequestAdmissions?.length !== 1) {
      throw new Error("node product Conversation authority is missing")
    }
    return Object.freeze({
      kind,
      sessionDir,
      sessionId,
      actorId,
      actorKey,
      cacheObservation: cacheObservations[0]!,
      requestObservation: requestObservations[0]!,
      epochReason: binding.providerEpochReceiptV2.reason,
      admissionDigest: binding.providerRequestAdmissions[0].admissionDigest,
      admission: binding.providerRequestAdmissions[0],
      epoch: binding.providerEpochReceiptV2,
      globalOrdinal: readProviderCacheProductTransportGlobalOrdinal(requestObservations[0]!),
    })
  } finally {
    globalThis.fetch = originalFetch
  }
}

async function runWorkflowLifecycleProductScenario(
  options: Readonly<{ sessionId: string }>,
): Promise<WorkflowLifecycleProductRun> {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-provider-cache-lifecycle-"))
  const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-provider-cache-lifecycle-skills-"))
  const originalFetch = globalThis.fetch
  const requestObservations: ProviderRequestObservationData[] = []
  const cacheObservations: ProviderCacheCostObservation[] = []
  globalThis.fetch = (async () => sse()) as typeof fetch
  try {
    await installBundledSystemSkills({ globalRoot })
    const resourcePackage = await freezeAiWorkflowResourcePackage({ globalRoot })
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "product-deepseek-compatible",
      selectedModel: "deepseek-chat",
      adapterName: "deepseek",
      options: {
        apiKey: "fixture-only",
        baseURL: "https://provider-cache-lifecycle.invalid/v1",
        compatibility_profile: "deepseek-compatible-chat@1",
      },
      runtime: {
        sessionId: options.sessionId,
        requestObservationPort: { append: (entry) => appendProductTransportObservation(requestObservations, entry, "workflow_lifecycle", options.sessionId), appendOutcome: () => {} },
      },
    })
    const createStream = adapter.createStream.bind(adapter)
    adapter.createStream = async (options) => {
      const result = await createStream({
        ...options,
        ...(options.providerCacheCostObservation ? {
          providerCacheCostObservation: {
            ...options.providerCacheCostObservation,
            priceWeights: { cacheHitWeight: 0.1, cacheMissWeight: 1 },
          },
        } : {}),
      })
      return {
        ...result,
        providerOutput: result.providerOutput?.then((output: any) => {
          if (output?.provider_cache_cost_observation) cacheObservations.push(output.provider_cache_cost_observation)
          return output
        }),
      }
    }
    const toolRegistry = composeToolRegistry({ includeWorkflowLifecycle: true })
    const schemas = ToolFuncRegistry.list(toolRegistry).map((definition) => definition.schema)
    const parent = createActor({
      key: "main",
      id: `parent-${sha(options.sessionId).slice(-12)}`,
      agentName: "main",
      llmClient: adapter,
      modelConfig: {
        model: "deepseek-chat",
        provider: "product-deepseek-compatible",
        adapter: "deepseek",
        options: { compatibilityProfile: "deepseek-compatible-chat@1" },
      },
      callbacks: {
        buildToolset: () => schemas,
        processStream: async (_vm, _actor, stream) => {
          await drain(stream as AsyncIterable<unknown>)
          return { role: "assistant", content: "lifecycle identity complete" }
        },
      },
    })
    const vm = createVM({
      controlActorKey: parent.key,
      actors: { [parent.key]: parent },
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({
          workflow: {
            name: "workflow",
            description: "workflow lifecycle isolation product Actor",
            tools: "*",
            prompt: ["Follow the frozen Workflow lifecycle authority."],
          },
        }),
      },
      outerCtx: {
        workDir: sessionDir,
        metadata: {
          sessionId: options.sessionId,
          sessionDir,
          aiWorkflow: { roots: { systemRoot: globalRoot } },
        },
        conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
      },
    })
    let lifecycleActor: ReturnType<typeof createActor> | undefined
    await spawnWorkflowLifecycleExecutionActor(vm, parent, {
      description: "workflow lifecycle isolation product journey",
      prompt: "Run the frozen lifecycle identity turn.",
      systemSkillMaterial: resourcePackage.resources["sys-eidolon-anchor-devops/SKILL.md"]!,
      systemSkillPackage: resourcePackage,
      mode: "sync_wait",
      retainActor: true,
      onActorCreated: (actor) => { lifecycleActor = actor },
    })
    if (!lifecycleActor) throw new Error("lifecycle product gateway did not retain its Actor")
    const raw = getConversationActorRawStateFromVm({ vm, actorKey: lifecycleActor.key })
    const epoch = raw?.session.actorBindings[lifecycleActor.key]?.providerEpochReceiptV2
    const admission = raw?.session.actorBindings[lifecycleActor.key]?.providerRequestAdmissions?.[0]
    const facet = readWorkflowLifecycleFacet(lifecycleActor)
    if (!epoch || !admission || !facet || requestObservations.length !== 1 || cacheObservations.length !== 1) {
      throw new Error("lifecycle product Actor lacks request/epoch/facet authority")
    }
    return Object.freeze({
      actorClass: "workflow_lifecycle",
      sessionDir,
      sessionId: options.sessionId,
      actorId: lifecycleActor.id,
      actorKey: lifecycleActor.key,
      epochReason: epoch.reason,
      frozenResourceDigest: facet.systemSkill.materialDigest,
      requestObservation: requestObservations[0]!,
      cacheObservation: cacheObservations[0]!,
      admission,
      epoch,
      globalOrdinal: readProviderCacheProductTransportGlobalOrdinal(requestObservations[0]!),
    })
  } finally {
    globalThis.fetch = originalFetch
    fs.rmSync(globalRoot, { recursive: true, force: true })
  }
}

export const PROVIDER_CACHE_PRODUCT_PRODUCTION_SCENARIOS = Object.freeze([
  "context.long-128/v1",
  "epoch.compaction/v1",
  "epoch.legacy-import-rebuild/v1",
  "epoch.provider-model-profile/v1",
  "epoch.resource-revision/v1",
  "epoch.rewind-fork/v1",
  "epoch.surface-revision/v1",
  "isolation.four-actors-two-sessions/v1",
  "ordinary.code.all-tools/v1",
  "ordinary.no-tool.forward/v1",
  "recovery.fresh-runtime/v1",
  "resource.old-new-actor/v1",
  "tool.reasoning-parallel-pending/v1",
  "transport.retry-503/v1",
  "workflow.ctrl-node.stage-free/v1",
  "workflow.data-node.stage-free/v1",
  "workflow.lifecycle.stable-superset/v1",
  "workflow.complete-authoring-release/v1",
] as const)

type ProviderCacheProductProductionScenarioId = typeof PROVIDER_CACHE_PRODUCT_PRODUCTION_SCENARIOS[number]

export type VerifiedProductChildHandle = Readonly<{
  schemaVersion: "eidolon.provider-cache-product-child-handle/v1"
  handleId: `sha256:${string}`
}>

export type OpenedVerifiedProductChild = Readonly<{
  schemaVersion: "eidolon.provider-cache-product-opened-child/v1"
  scenarioId: ProviderCacheProductProductionScenarioId
  childId: string
  childOrdinal: number
  actorClass: "ordinary" | "workflow_lifecycle" | "workflow_ctrl_node" | "workflow_data_node"
  sessionId: string
  actorKey: string
  actorId: string
  callCount: number
  recoveryBoundary: boolean
  contractFacts: Readonly<{
    lifecycleStages: readonly string[]
    providerRequestsPerStage: number
    terminalCount: number
    recoveryCount: number
  }> | null
  sourceRecords: readonly ProviderCacheProductSourceRecord[]
  sourceClosureDigest: `sha256:${string}`
  receiptDigest: `sha256:${string}`
  seal: `hmac-sha256:${string}`
}>

type ProductChildReadPort = Readonly<{
  read(): readonly ProviderCacheProductSourceRecord[]
}>

type ProductChildOwnerState = Readonly<{
  secret: Buffer
  readPort: ProductChildReadPort
  identity: Readonly<{
    scenarioId: ProviderCacheProductProductionScenarioId
    childId: string
    childOrdinal: number
    actorClass: OpenedVerifiedProductChild["actorClass"]
    sessionId: string
    actorKey: string
    actorId: string
    recoveryBoundary: boolean
    contractFacts: OpenedVerifiedProductChild["contractFacts"]
  }>
  expectedReceiptDigest: `sha256:${string}`
  expectedSeal: `hmac-sha256:${string}`
}>

const PRODUCT_CHILD_OWNER_STATES = new WeakMap<object, ProductChildOwnerState>()

function canonicalProductEvidence(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalProductEvidence).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalProductEvidence(record[key])}`).join(",")}}`
}

function exactClosedProductInput(value: unknown): asserts value is Readonly<{ scenarioId: ProviderCacheProductProductionScenarioId }> {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value as object).length !== 1
    || !Object.prototype.hasOwnProperty.call(value, "scenarioId")
    || !PROVIDER_CACHE_PRODUCT_PRODUCTION_SCENARIOS.includes((value as any).scenarioId)) {
    throw new Error("provider_cache_product_production_scenario_input_not_closed")
  }
}

function cloneProductRecords(records: readonly ProviderCacheProductSourceRecord[]): readonly ProviderCacheProductSourceRecord[] {
  return Object.freeze(structuredClone(records))
}

function issueVerifiedProductChild(input: Readonly<{
  scenarioId: ProviderCacheProductProductionScenarioId
  childId: string
  childOrdinal: number
  actorClass: OpenedVerifiedProductChild["actorClass"]
  sessionId: string
  actorKey: string
  actorId: string
  recoveryBoundary: boolean
  contractFacts?: OpenedVerifiedProductChild["contractFacts"]
  readPort: ProductChildReadPort
}>): VerifiedProductChildHandle {
  const records = cloneProductRecords(input.readPort.read())
  const callCount = new Set(records
    .filter((record) => record.kind === "request_admission")
    .map((record) => record.identity.callOrdinal)).size
  if (callCount < 1) throw new Error(`provider_cache_product_production_child_has_no_call:${input.childId}`)
  const sourceClosureDigest = sha(canonicalProductEvidence(records))
  const body = Object.freeze({
    schemaVersion: "eidolon.provider-cache-product-opened-child/v1" as const,
    scenarioId: input.scenarioId,
    childId: input.childId,
    childOrdinal: input.childOrdinal,
    actorClass: input.actorClass,
    sessionId: input.sessionId,
    actorKey: input.actorKey,
    actorId: input.actorId,
    callCount,
    recoveryBoundary: input.recoveryBoundary,
    contractFacts: input.contractFacts ?? null,
    sourceRecords: records,
    sourceClosureDigest,
  })
  const receiptDigest = sha(canonicalProductEvidence(body))
  const secret = randomBytes(32)
  const seal = `hmac-sha256:${createHmac("sha256", secret).update(receiptDigest).digest("hex")}` as const
  const handle = Object.freeze({
    schemaVersion: "eidolon.provider-cache-product-child-handle/v1" as const,
    handleId: sha(randomBytes(32).toString("hex")),
  })
  PRODUCT_CHILD_OWNER_STATES.set(handle, Object.freeze({
    secret,
    readPort: input.readPort,
    identity: Object.freeze({
      scenarioId: input.scenarioId,
      childId: input.childId,
      childOrdinal: input.childOrdinal,
      actorClass: input.actorClass,
      sessionId: input.sessionId,
      actorKey: input.actorKey,
      actorId: input.actorId,
      recoveryBoundary: input.recoveryBoundary,
      contractFacts: input.contractFacts ?? null,
    }),
    expectedReceiptDigest: receiptDigest,
    expectedSeal: seal,
  }))
  return handle
}

export function openVerifiedProductChild(handle: VerifiedProductChildHandle): OpenedVerifiedProductChild {
  const state = PRODUCT_CHILD_OWNER_STATES.get(handle as object)
  if (!state || !Object.isFrozen(handle)
    || handle.schemaVersion !== "eidolon.provider-cache-product-child-handle/v1") {
    throw new Error("provider_cache_product_child_handle_invalid")
  }
  const records = cloneProductRecords(state.readPort.read())
  const callCount = new Set(records
    .filter((record) => record.kind === "request_admission")
    .map((record) => record.identity.callOrdinal)).size
  const sourceClosureDigest = sha(canonicalProductEvidence(records))
  const body = Object.freeze({
    schemaVersion: "eidolon.provider-cache-product-opened-child/v1" as const,
    ...state.identity,
    callCount,
    sourceRecords: records,
    sourceClosureDigest,
  })
  const receiptDigest = sha(canonicalProductEvidence(body))
  const seal = `hmac-sha256:${createHmac("sha256", state.secret).update(receiptDigest).digest("hex")}` as const
  if (receiptDigest !== state.expectedReceiptDigest
    || seal.length !== state.expectedSeal.length
    || !timingSafeEqual(Buffer.from(seal), Buffer.from(state.expectedSeal))) {
    throw new Error("provider_cache_product_child_owner_readback_mismatch")
  }
  return Object.freeze({ ...body, receiptDigest, seal })
}

function recordsForSingleProductCall(input: Readonly<{
  sessionId: string
  actorKey: string
  actorId: string
  requestObservation: ProviderRequestObservationData
  cacheObservation: ProviderCacheCostObservation
  admission: any
  epoch: any
}>): readonly ProviderCacheProductSourceRecord[] {
  const providerCallId = input.requestObservation.providerCallId
  const usage = input.cacheObservation.tokenBreakdown.usage
  if (!usage || input.cacheObservation.tokenBreakdown.normalizedInputCost === null) {
    throw new Error("provider_cache_product_single_call_usage_missing")
  }
  const finalWire = JSON.parse(String(input.requestObservation.requestBody)) as any
  return Object.freeze([
    sourceRecord({ kind: "request_admission", sourceId: "admission-1", sessionId: input.sessionId, actorKey: input.actorKey, actorId: input.actorId, providerCallId, callOrdinal: 1, facts: {
      admissionDigest: input.admission.admissionDigest,
      previousAdmissionDigest: input.admission.previousAdmissionDigest,
      finalRequestDigest: input.admission.finalRequestDigest,
      historyFrontierDigest: input.admission.historyFrontierDigest,
    } }),
    sourceRecord({ kind: "final_wire", sourceId: "wire-1", sessionId: input.sessionId, actorKey: input.actorKey, actorId: input.actorId, providerCallId, callOrdinal: 1, facts: {
      requestDigest: input.cacheObservation.requestDigest,
      cacheUnits: input.cacheObservation.units,
      body: String(input.requestObservation.requestBody),
      toolNames: Object.freeze((finalWire.tools ?? []).map((entry: any) => String(entry.function?.name ?? ""))),
      captureLayer: input.requestObservation.captureLayer,
    } }),
    sourceRecord({ kind: "provider_epoch", sourceId: "epoch-1", sessionId: input.sessionId, actorKey: input.actorKey, actorId: input.actorId, providerCallId, callOrdinal: 1, facts: {
      receiptDigest: input.epoch.receiptDigest,
      previousReceiptDigest: input.epoch.previousReceiptDigest,
      epoch: input.epoch.epoch,
      reason: input.epoch.reason,
      predecessorFrontierDigest: null,
      sourceFrontierDigest: input.epoch.sourceFrontierDigest,
    } }),
    sourceRecord({ kind: "transport_attempt", sourceId: "attempt-1-1", sessionId: input.sessionId, actorKey: input.actorKey, actorId: input.actorId, providerCallId, callOrdinal: 1, attemptOrdinal: 1, facts: {
      bodyDigest: sha(String(input.requestObservation.requestBody)),
      status: "final_success",
      globalOrdinal: readProviderCacheProductTransportGlobalOrdinal(input.requestObservation),
    } }),
    sourceRecord({ kind: "final_success_usage", sourceId: "usage-1", sessionId: input.sessionId, actorKey: input.actorKey, actorId: input.actorId, providerCallId, callOrdinal: 1, facts: {
      usageDigest: digestProviderCacheProductClosedValue(usage),
      status: "final_success",
      cacheHitTokens: usage.cacheHitTokens,
      cacheMissTokens: usage.cacheMissTokens,
      normalizedInputCost: input.cacheObservation.tokenBreakdown.normalizedInputCost,
    } }),
  ])
}

function fixedOrdinaryOptions(scenarioId: ProviderCacheProductProductionScenarioId): OrdinaryProductScenarioOptions {
  const epochTransition = scenarioId === "epoch.provider-model-profile/v1" ? "provider_model_profile_switch" as const
    : scenarioId === "epoch.compaction/v1" ? "history_compaction" as const
      : scenarioId === "epoch.rewind-fork/v1" ? "history_rewind_or_fork" as const
        : scenarioId === "epoch.legacy-import-rebuild/v1" ? "legacy_context_import" as const
          : scenarioId === "epoch.resource-revision/v1" || scenarioId === "resource.old-new-actor/v1" ? "frozen_resource_revision_accepted" as const
            : scenarioId === "epoch.surface-revision/v1" ? "provider_surface_revision_accepted" as const
              : undefined
  const twoTurns = scenarioId === "context.long-128/v1" || Boolean(epochTransition)
    || scenarioId === "ordinary.no-tool.forward/v1" || scenarioId === "isolation.four-actors-two-sessions/v1"
  return Object.freeze({
    scenarioId,
    tools: scenarioId === "tool.reasoning-parallel-pending/v1" ? "clock"
      : scenarioId === "ordinary.code.all-tools/v1" ? "all" : "none",
    turns: twoTurns ? 2 : 1,
    sessionId: "matrix-session-a",
    ...(scenarioId === "context.long-128/v1" || scenarioId === "epoch.compaction/v1" ? { retainedMessages: 128 } : {}),
    ...(scenarioId === "recovery.fresh-runtime/v1" ? { freshRecovery: true } : {}),
    ...(scenarioId === "transport.retry-503/v1" ? { retry503: true } : {}),
    ...(scenarioId === "tool.reasoning-parallel-pending/v1" ? { parallelToolCalls: true } : {}),
    ...(epochTransition ? { epochTransition } : {}),
  })
}

function issueRecordsChild(input: Readonly<{
  scenarioId: ProviderCacheProductProductionScenarioId
  childId: string
  childOrdinal: number
  actorClass: OpenedVerifiedProductChild["actorClass"]
  sessionId: string
  actorKey: string
  actorId: string
  records: readonly ProviderCacheProductSourceRecord[]
  recoveryBoundary?: boolean
  contractFacts?: OpenedVerifiedProductChild["contractFacts"]
}>): VerifiedProductChildHandle {
  const immutableRecords = cloneProductRecords(input.records)
  return issueVerifiedProductChild({
    ...input,
    recoveryBoundary: input.recoveryBoundary ?? false,
    readPort: Object.freeze({ read: () => immutableRecords }),
  })
}

function workflowSurfaceProductRecords(
  journey: VerifiedWorkflowSurfaceProductJourney,
  requests: VerifiedWorkflowSurfaceProductJourney["requests"],
): readonly ProviderCacheProductSourceRecord[] {
  const records: ProviderCacheProductSourceRecord[] = []
  for (const request of requests) {
    const admission = request.requestAdmission as any
    const epoch = request.providerEpochReceipt as any
    const providerCallId = `workflow-surface-${request.callOrdinal}`
    const observation = createProviderCacheCostObservation({
      identity: {
        schemaVersion: 1,
        providerId: "workflow-surface-experiment",
        providerProfile: "deepseek_compatible",
        providerProfileId: "deepseek-compatible-chat@1",
        model: "deepseek-chat",
        actorClass: "workflow_lifecycle",
        contextEpoch: Number(epoch.epoch),
      },
      serializedRequestBody: request.finalWireBody,
      tokenEstimates: estimateFinalWireProviderCacheCostTokens(request.finalWireBody),
      usage: {
        promptTokens: request.providerUsage.cacheHitTokens + request.providerUsage.cacheMissTokens,
        completionTokens: 4,
        cacheHitTokens: request.providerUsage.cacheHitTokens,
        cacheMissTokens: request.providerUsage.cacheMissTokens,
      },
      priceWeights: { cacheHitWeight: 0.1, cacheMissWeight: 1 },
    })
    if (admission.finalRequestDigest !== observation.requestDigest
      || observation.tokenBreakdown.normalizedInputCost !== request.providerUsage.normalizedInputCost) {
      throw new Error(`provider_cache_product_workflow_admission_usage_mismatch:${request.callOrdinal}`)
    }
    const add = (kind: ProviderCacheProductSourceKind, sourceId: string, facts: unknown, attemptOrdinal: number | null = null) => {
      records.push(sourceRecord({
        kind,
        sourceId,
        sessionId: journey.sessionId,
        actorKey: journey.actorKey,
        actorId: journey.actorId,
        providerCallId,
        callOrdinal: request.callOrdinal,
        attemptOrdinal: attemptOrdinal ?? undefined,
        facts,
      }))
    }
    add("request_admission", `workflow-admission-${request.callOrdinal}`, {
      admissionDigest: admission.admissionDigest,
      previousAdmissionDigest: admission.previousAdmissionDigest,
      finalRequestDigest: admission.finalRequestDigest,
      historyFrontierDigest: admission.historyFrontierDigest,
    })
    add("final_wire", `workflow-wire-${request.callOrdinal}`, {
      requestDigest: observation.requestDigest,
      cacheUnits: observation.units,
    })
    add("provider_epoch", `workflow-epoch-${request.callOrdinal}`, {
      receiptDigest: epoch.receiptDigest,
      previousReceiptDigest: epoch.previousReceiptDigest,
      epoch: epoch.epoch,
      reason: epoch.reason,
      predecessorFrontierDigest: null,
      sourceFrontierDigest: epoch.sourceFrontierDigest,
    })
    request.attemptBodies.forEach((body, attemptIndex) => add(
      "transport_attempt",
      `workflow-attempt-${request.callOrdinal}-${attemptIndex + 1}`,
      {
        bodyDigest: sha(body),
        status: attemptIndex === request.attemptBodies.length - 1 ? "final_success" : "failed_retryable",
        globalOrdinal: null,
      },
      attemptIndex + 1,
    ))
    add("final_success_usage", `workflow-usage-${request.callOrdinal}`, {
      usageDigest: digestProviderCacheProductClosedValue(request.providerUsage),
      status: "final_success",
      cacheHitTokens: request.providerUsage.cacheHitTokens,
      cacheMissTokens: request.providerUsage.cacheMissTokens,
      normalizedInputCost: request.providerUsage.normalizedInputCost,
    })
    if (request.toolCallRecord !== null) {
      add("tool_effect", String((request.toolCallRecord as any).toolCallId), {
        effectId: String((request.toolCallRecord as any).toolCallId),
        funcName: String((request.toolCallRecord as any).funcName),
        effectDigest: digestProviderCacheProductClosedValue(request.toolCallRecord),
        status: "completed",
      })
    }
  }
  return Object.freeze(records)
}

async function runClosedLifecycleProductScenario(
  scenarioId: Extract<ProviderCacheProductProductionScenarioId,
    "workflow.lifecycle.stable-superset/v1" | "workflow.complete-authoring-release/v1">,
): Promise<readonly VerifiedProductChildHandle[]> {
  const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-provider-cache-lifecycle-owner-"))
  try {
    await installBundledSystemSkills({ globalRoot })
    const resourcePackage = await freezeAiWorkflowResourcePackage({ globalRoot })
    const frozenActorSnapshot = Object.freeze({
      key: "g5-workflow-author",
      id: "g5-workflow-author-id",
      systemPrompts: Object.freeze(["Frozen G5 WorkflowAuthor authority."]),
    })
    const frozenConversationSnapshot = Object.freeze({
      sessionId: "matrix-session-b",
      messages: Object.freeze([{ role: "user" as const, content: "Run the complete lifecycle product journey." }]),
    })
    const experimentInput = createClosedWorkflowSurfaceExperimentInput({
      frozenActorSnapshotDigest: digestClosedWorkflowSurfaceValue(frozenActorSnapshot),
      frozenConversationSnapshotDigest: digestClosedWorkflowSurfaceValue(frozenConversationSnapshot),
      lifecycleToolProfileDigest: digestClosedWorkflowSurfaceValue(WORKFLOW_LIFECYCLE_TOOL_PROFILE),
      lifecycleResourcePackageDigest: resourcePackage.digest as `sha256:${string}`,
      providerProfileId: "deepseek-compatible-chat@1",
      model: "deepseek-chat",
    })
    const runtime = createLocalWorkflowSurfaceExperimentRuntime({
      globalRoot,
      resourcePackage,
      frozenActorSnapshot,
      frozenConversationSnapshot,
      providerProfileId: experimentInput.providerProfileId,
      model: experimentInput.model,
      lifecycleToolProfileDigest: experimentInput.lifecycleToolProfileDigest,
      lifecycleResourcePackageDigest: experimentInput.lifecycleResourcePackageDigest,
    })
    const report = await runClosedWorkflowSurfaceExperiment({ input: experimentInput, runtime })
    const selection = selectWorkflowSurfaceStrategy(report, runtime)
    const journey = readVerifiedWorkflowSurfaceProductJourney({ runtime, report, selection })
    const selected = selection.ranking.find((candidate) => candidate.strategyRevision === "stable-superset/v1")
    if (selection.selectedStrategyRevision !== "stable-superset/v1"
      || selection.selectedStrategyDigest !== WORKFLOW_SURFACE_STRATEGY_REGISTRY.resolve("stable-superset/v1").strategyDigest
      || !selected?.eligible || selected.surfaceEpochCount !== 1 || selected.toolSelectionErrors !== 0
      || report.candidates.length !== 3 || new Set(report.candidates.map((candidate) => candidate.cloneInstanceDigest)).size !== 3
      || WORKFLOW_SURFACE_EXPERIMENT_STAGES.length !== 5 || journey.requests.length !== 11
      || journey.requests.slice(0, 10).some((request) => request.toolCallRecord === null)
      || journey.requests[10]!.toolCallRecord !== null || !journey.freshRecoveryVerified) {
      throw new Error("provider_cache_product_lifecycle_owner_selection_invalid")
    }
    const liveFacts = Object.freeze({
      lifecycleStages: Object.freeze([...WORKFLOW_SURFACE_EXPERIMENT_STAGES]),
      providerRequestsPerStage: 2,
      terminalCount: 1,
      recoveryCount: 0,
    })
    const recoveryFacts = Object.freeze({
      lifecycleStages: Object.freeze([...WORKFLOW_SURFACE_EXPERIMENT_STAGES]),
      providerRequestsPerStage: 2,
      terminalCount: 1,
      recoveryCount: 1,
    })
    return Object.freeze([
      issueRecordsChild({
        scenarioId,
        childId: `${scenarioId}#live-lifecycle`,
        childOrdinal: 1,
        actorClass: "workflow_lifecycle",
        sessionId: journey.sessionId,
        actorKey: journey.actorKey,
        actorId: journey.actorId,
        records: workflowSurfaceProductRecords(journey, journey.requests),
        contractFacts: liveFacts,
      }),
      issueRecordsChild({
        scenarioId,
        childId: `${scenarioId}#fresh-recovery`,
        childOrdinal: 2,
        actorClass: "workflow_lifecycle",
        sessionId: journey.sessionId,
        actorKey: journey.actorKey,
        actorId: journey.actorId,
        records: workflowSurfaceProductRecords(journey, Object.freeze([journey.recoveryRequest])),
        recoveryBoundary: true,
        contractFacts: recoveryFacts,
      }),
    ])
  } finally {
    fs.rmSync(globalRoot, { recursive: true, force: true })
  }
}

export async function runClosedProviderCacheProductScenario(
  input: Readonly<{ scenarioId: ProviderCacheProductProductionScenarioId }>,
): Promise<readonly VerifiedProductChildHandle[]> {
  exactClosedProductInput(input)
  const scenarioId = input.scenarioId
  if (scenarioId === "workflow.lifecycle.stable-superset/v1"
    || scenarioId === "workflow.complete-authoring-release/v1") {
    return runClosedLifecycleProductScenario(scenarioId)
  }
  if (scenarioId === "workflow.ctrl-node.stage-free/v1" || scenarioId === "workflow.data-node.stage-free/v1") {
    const kind = scenarioId.includes("ctrl-node") ? "ai_ctrl" as const : "ai_data" as const
    const run = await runWorkflowNodeProductScenario(kind, {
      sessionId: kind === "ai_ctrl" ? "matrix-session-a" : "matrix-session-b",
    })
    const handle = issueRecordsChild({
      scenarioId,
      childId: scenarioId,
      childOrdinal: 1,
      actorClass: kind === "ai_ctrl" ? "workflow_ctrl_node" : "workflow_data_node",
      sessionId: run.sessionId,
      actorKey: run.actorKey,
      actorId: run.actorId,
      records: recordsForSingleProductCall(run),
    })
    fs.rmSync(run.sessionDir, { recursive: true, force: true })
    return Object.freeze([handle])
  }

  const run = await runOrdinaryProductScenario(fixedOrdinaryOptions(scenarioId))
  const handles: VerifiedProductChildHandle[] = []
  try {
    const allRecords = [...run.sourceRecords.values()]
    if (scenarioId === "recovery.fresh-runtime/v1") {
      for (const [index, childId] of [
        `${scenarioId}#initial-runtime`,
        `${scenarioId}#recovered-runtime`,
      ].entries()) {
        handles.push(issueRecordsChild({
          scenarioId,
          childId,
          childOrdinal: index + 1,
          actorClass: "ordinary",
          sessionId: "matrix-session-a",
          actorKey: run.actorKey,
          actorId: run.actorId,
          records: allRecords.filter((record) => record.identity.callOrdinal === index + 1),
          recoveryBoundary: index === 1,
        }))
      }
    } else if (scenarioId === "resource.old-new-actor/v1") {
      const oldActor = await runOrdinaryProductScenario({
        scenarioId: "resource.old-actor-recovery/internal",
        tools: "none",
        turns: 1,
        freshRecovery: true,
        sessionId: "matrix-session-b",
      })
      const newActor = await runOrdinaryProductScenario({
        scenarioId: "resource.new-actor-initial/internal",
        tools: "none",
        turns: 1,
        initialDurableMaterials: PRODUCT_RESOURCE_V2_MATERIALS,
        sessionId: "matrix-session-b",
      })
      try {
        handles.push(issueRecordsChild({
          scenarioId,
          childId: `${scenarioId}#old-recovered`,
          childOrdinal: 1,
          actorClass: "ordinary",
          sessionId: "matrix-session-b",
          actorKey: oldActor.actorKey,
          actorId: oldActor.actorId,
          records: [...oldActor.sourceRecords.values()],
          recoveryBoundary: true,
        }))
        handles.push(issueRecordsChild({
          scenarioId,
          childId: `${scenarioId}#new-initial`,
          childOrdinal: 2,
          actorClass: "ordinary",
          sessionId: "matrix-session-b",
          actorKey: newActor.actorKey,
          actorId: newActor.actorId,
          records: [...newActor.sourceRecords.values()],
        }))
        handles.push(issueRecordsChild({
          scenarioId,
          childId: `${scenarioId}#ordinary`,
          childOrdinal: 3,
          actorClass: "ordinary",
          sessionId: "matrix-session-a",
          actorKey: run.actorKey,
          actorId: run.actorId,
          records: allRecords,
        }))
      } finally {
        fs.rmSync(oldActor.cleanupDir, { recursive: true, force: true })
        fs.rmSync(newActor.cleanupDir, { recursive: true, force: true })
      }
    } else if (scenarioId === "isolation.four-actors-two-sessions/v1") {
      if (!run.isolation) throw new Error("provider_cache_product_isolation_closed_runner_missing")
      const { lifecycle, ctrl, data } = run.isolation
      handles.push(issueRecordsChild({
        scenarioId,
        childId: `${scenarioId}#ordinary`,
        childOrdinal: 1,
        actorClass: "ordinary",
        sessionId: "matrix-session-a",
        actorKey: run.actorKey,
        actorId: run.actorId,
        records: allRecords,
      }))
      for (const [index, child] of [
        { id: `${scenarioId}#workflow-lifecycle`, actorClass: "workflow_lifecycle" as const, run: lifecycle },
        { id: `${scenarioId}#workflow-ctrl`, actorClass: "workflow_ctrl_node" as const, run: ctrl },
        { id: `${scenarioId}#workflow-data`, actorClass: "workflow_data_node" as const, run: data },
      ].entries()) {
        handles.push(issueRecordsChild({
          scenarioId,
          childId: child.id,
          childOrdinal: index + 2,
          actorClass: child.actorClass,
          sessionId: child.run.sessionId,
          actorKey: child.run.actorKey,
          actorId: child.run.actorId,
          records: recordsForSingleProductCall(child.run),
        }))
      }
      fs.rmSync(lifecycle.sessionDir, { recursive: true, force: true })
      fs.rmSync(ctrl.sessionDir, { recursive: true, force: true })
      fs.rmSync(data.sessionDir, { recursive: true, force: true })
    } else {
      handles.push(issueRecordsChild({
        scenarioId,
        childId: scenarioId,
        childOrdinal: 1,
        actorClass: "ordinary",
        sessionId: "matrix-session-a",
        actorKey: run.actorKey,
        actorId: run.actorId,
        records: allRecords,
      }))
    }
    return Object.freeze(handles)
  } finally {
    fs.rmSync(run.cleanupDir, { recursive: true, force: true })
  }
}
