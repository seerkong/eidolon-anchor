import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { createActor, type AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import {
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFileRuntimeDerivedIndexesStore,
  LocalFileRuntimeSnapshotRepositoryFactory,
  parseFrozenAiWorkflowResourcePackage,
  serializeFrozenAiWorkflowResourcePackage,
  type FrozenAiWorkflowResourcePackage,
} from "@cell/ai-support"
import { applyFileStoreAiRuntimeSessionUpgrade } from "@cell/ai-runtime-control-composer"

import { composeToolRegistry } from "../../composer/AIAgent/ToolFuncComposer"
import {
  ensureVmConversationDomainRuntime,
  getConversationActorRawStateFromVm,
} from "../../conversation/ConversationDomainRuntime"
import {
  createProviderEpochReceiptV2,
  digestProviderContextClosedValue,
  digestProviderContextHistoryFrontier,
} from "../../conversation/ProviderContextEpochV2"
import {
  compareProviderCacheCostObservations,
  createProviderCacheCostObservation,
} from "../../llm/ProviderCacheCostObservation"
import { estimateFinalWireProviderCacheCostTokens } from "../../llm/ProviderCacheCostEstimates"
import { OpenAICompletionsNodejsFetchLlmAdapter } from "../../llm/OpenAICompletionsNodejsFetchAdapter"
import { deepSeekCompatibleChatEffectBundle } from "../../llm/ChatCompletionsEffectBundles"
import { createProviderStreamWithRetry } from "../../llm/ProviderErrors"
import { chatCompletionsStreamCoreBinding } from "../../stream/ChatCompletionsStreamCore"
import { createAiAgentOrchestratorDriverWithCooperative } from "../../OrchestratorDriver"
import {
  configureRuntimePersistenceSupport,
  recoverAiAgentRuntime,
  saveAiAgentRuntimeSnapshot,
} from "../../persistence/RuntimeSnapshots"
import { digestToolCallRecord, getVmToolCallDomain } from "../../runtime/ToolCallDomainRuntime"
import {
  AI_WORKFLOW_PROVIDER_TOOL_SURFACE,
  AI_WORKFLOW_STAGE_TOOL_POLICY,
} from "../tools/WorkflowStageToolCatalog"
import { spawnWorkflowLifecycleSurfaceExperimentActor } from "./WorkflowLifecycleActorCapsule"
import {
  createWorkflowLifecycleResourcePackageMaterial,
  readWorkflowLifecycleFacet,
} from "./WorkflowLifecycleFacet"
import {
  resolveWorkflowLifecycleToolProfileRegistry,
} from "../tools/WorkflowLifecycleToolProfileRuntime"
import {
  WORKFLOW_LIFECYCLE_TOOL_PROFILE_ID,
  WORKFLOW_LIFECYCLE_TOOL_PROFILE_REVISION,
} from "./WorkflowLifecycleFacet"
import {
  CLOSED_WORKFLOW_SURFACE_EXPERIMENT,
  REQUIRED_TOOL_BY_EXPERIMENT_STAGE,
  WORKFLOW_SURFACE_EXPERIMENT_STAGES,
  WORKFLOW_SURFACE_STRATEGY_REGISTRY,
  WORKFLOW_SURFACE_STRATEGY_REVISIONS,
  assertClosedWorkflowSurfaceValue,
  digestClosedWorkflowSurfaceValue,
  projectWorkflowProviderSurface,
  validateClosedWorkflowSurfaceExperimentInput,
  type ClosedWorkflowSurfaceExperimentInput,
  type WorkflowSurfaceEvidenceRef,
  type WorkflowSurfaceRawCandidateObservation,
  type WorkflowSurfaceRawExperimentReport,
  type WorkflowSurfaceStrategyRevision,
  type WorkflowSurfaceStrategySelection,
  type WorkflowSurfaceStrategySelectionCandidate,
} from "./WorkflowProviderSurfaceStrategy"

type Sha256 = `sha256:${string}`
type HmacSha256 = `hmac-sha256:${string}`

type FrozenActorSnapshot = Readonly<{
  key: string
  id: string
  systemPrompts: readonly string[]
}>

type FrozenConversationSnapshot = Readonly<{
  sessionId: string
  messages: readonly Readonly<{ role: "user"; content: string }>[]
}>

type FinalWireArtifact = Readonly<{
  schemaVersion: "eidolon.workflow-provider-final-wire/v1"
  body: string
}>

type RequestEvidenceArtifact = Readonly<{
  schemaVersion: "eidolon.workflow-provider-request-evidence/v1"
  sessionId: string
  actorKey: string
  actorId: string
  finalWireRef: WorkflowSurfaceEvidenceRef
  transportAttemptRefs: readonly WorkflowSurfaceEvidenceRef[]
  requestAdmission: Readonly<Record<string, unknown>>
  providerEpochReceipt: Readonly<Record<string, unknown>>
  toolCallRecord: Readonly<Record<string, unknown>> | null
  providerUsage: Readonly<{
    cacheHitTokens: number
    cacheMissTokens: number
    normalizedInputCost: number
  }>
}>

export type VerifiedWorkflowSurfaceProductJourney = Readonly<{
  schemaVersion: "eidolon.workflow-surface-product-journey/v1"
  strategyRevision: "stable-superset/v1"
  strategyDigest: Sha256
  sessionId: string
  actorKey: string
  actorId: string
  requests: readonly Readonly<{
    callOrdinal: number
    finalWireBody: string
    attemptBodies: readonly string[]
    requestAdmission: Readonly<Record<string, unknown>>
    providerEpochReceipt: Readonly<Record<string, unknown>>
    toolCallRecord: Readonly<Record<string, unknown>> | null
    providerUsage: Readonly<{
      cacheHitTokens: number
      cacheMissTokens: number
      normalizedInputCost: number
    }>
  }>[]
  recoveryRequest: Readonly<{
    callOrdinal: 1
    finalWireBody: string
    attemptBodies: readonly string[]
    requestAdmission: Readonly<Record<string, unknown>>
    providerEpochReceipt: Readonly<Record<string, unknown>>
    toolCallRecord: null
    providerUsage: Readonly<{
      cacheHitTokens: number
      cacheMissTokens: number
      normalizedInputCost: number
    }>
  }>
  recoveryReceiptDigest: Sha256
  freshRecoveryVerified: true
}>

type RecoveryEvidenceArtifact = Readonly<{
  schemaVersion: "eidolon.workflow-provider-fresh-recovery-evidence/v1"
  recoveredRuntimeInstanceDigest: Sha256
  recoveryRequestEvidenceRef: WorkflowSurfaceEvidenceRef
  recoveredFacetRef: WorkflowSurfaceEvidenceRef
  recoveredActorReceipt: Readonly<Record<string, unknown>>
  recoveredFacetReceipt: Readonly<Record<string, unknown>>
  recoveredConversationReceipt: Readonly<Record<string, unknown>>
  recoveredProviderEpochReceipt: Readonly<Record<string, unknown>>
  recoveredTerminalToolCallRecord: Readonly<Record<string, unknown>>
  receiptDigest: Sha256
}>

type CandidateEvidenceArtifact = Readonly<{
  schemaVersion: "eidolon.workflow-provider-candidate-evidence/v1"
  strategyRevision: WorkflowSurfaceStrategyRevision
  sourceSnapshotDigest: Sha256
  cloneInstanceDigest: Sha256
  loadedActorSnapshotDigest: Sha256
  loadedConversationSnapshotDigest: Sha256
  recoveredActorSnapshotDigest: Sha256
  recoveredConversationSnapshotDigest: Sha256
  requestEvidenceRefs: readonly WorkflowSurfaceEvidenceRef[]
  recoveryEvidenceRef: WorkflowSurfaceEvidenceRef
}>

export type LocalWorkflowSurfaceExperimentRuntimeConfig = Readonly<{
  globalRoot: string
  resourcePackage: FrozenAiWorkflowResourcePackage
  frozenActorSnapshot: FrozenActorSnapshot
  frozenConversationSnapshot: FrozenConversationSnapshot
  providerProfileId: "deepseek-official-chat@1" | "deepseek-compatible-chat@1"
  model: string
  lifecycleToolProfileDigest: Sha256
  lifecycleResourcePackageDigest: Sha256
}>

export interface WorkflowSurfaceExperimentRuntime {
  readonly schemaVersion: "eidolon.workflow-provider-surface-runtime-owner/v1"
  readonly ownerId: Sha256
}

type OwnerState = Readonly<{
  secret: Buffer
  artifactRoot: string
  config: LocalWorkflowSurfaceExperimentRuntimeConfig
  sourceRefs?: Readonly<{
    actorSnapshotRef: WorkflowSurfaceEvidenceRef
    conversationSnapshotRef: WorkflowSurfaceEvidenceRef
    resourcePackageRef: WorkflowSurfaceEvidenceRef
    toolProfileRef: WorkflowSurfaceEvidenceRef
    strategyRegistryRef: WorkflowSurfaceEvidenceRef
  }>
}>

type ClosedWorkflowSurfaceSourceAuthority = Readonly<{
  actor: FrozenActorSnapshot
  conversation: FrozenConversationSnapshot
  resourcePackage: FrozenAiWorkflowResourcePackage
  toolProfile: Readonly<{
    profileId: string
    profileRevision: string
    admittedNames: readonly string[]
    admittedNamesDigest: string
    schemaDigest: string
  }>
  strategyRegistry: Readonly<{
    schemaVersion: "eidolon.workflow-provider-surface-strategy-registry-authority/v1"
    registryDigest: Sha256
    strategies: readonly Readonly<{
      strategyRevision: WorkflowSurfaceStrategyRevision
      transitionScope: "actor" | "stage"
      derivation: string
      strategyDigest: Sha256
    }>[]
  }>
}>

const OWNER_STATES = new WeakMap<object, OwnerState>()
const PRIVATE_CHAT_CREATE_STREAM = OpenAICompletionsNodejsFetchLlmAdapter.prototype.createStream
const PRIVATE_CHAT_CREATE_ADMITTED_STREAM = OpenAICompletionsNodejsFetchLlmAdapter.prototype.createAdmittedStream
const PRIVATE_PROVIDER_RETRY = createProviderStreamWithRetry
const PRIVATE_CHAT_STREAM_CORE = chatCompletionsStreamCoreBinding

function sealPrivateChatAdapter(adapter: OpenAICompletionsNodejsFetchLlmAdapter): OpenAICompletionsNodejsFetchLlmAdapter {
  Object.defineProperty(adapter, "createAdmittedStream", {
    value: (options: unknown, authority: unknown) => PRIVATE_CHAT_CREATE_ADMITTED_STREAM.call(
      adapter,
      options as never,
      authority as never,
    ),
    configurable: false,
    enumerable: false,
    writable: false,
  })
  return Object.freeze(adapter) as OpenAICompletionsNodejsFetchLlmAdapter
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function exactArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

function closedJsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function exactObjectKeys(value: object, expected: readonly string[], label: string): void {
  assertClosedWorkflowSurfaceValue(value)
  const actual = (Reflect.ownKeys(value) as string[]).sort(compareCodeUnits)
  const wanted = [...expected].sort(compareCodeUnits)
  if (!exactArray(actual, wanted)) {
    throw new Error(`WORKFLOW_SURFACE_RAW_REPORT_INVALID: ${label} contains an unknown or missing field (winner claims are forbidden)`)
  }
}

function exactOwnDataObject(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
  assertClosedWorkflowSurfaceValue(value)
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`WORKFLOW_SURFACE_AUTHORITY_INVALID: ${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`WORKFLOW_SURFACE_AUTHORITY_INVALID: ${label} must be plain own-data`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key === "symbol") {
      throw new Error(`WORKFLOW_SURFACE_AUTHORITY_INVALID: ${label} symbol keys are forbidden`)
    }
    const descriptor = descriptors[key]!
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`WORKFLOW_SURFACE_AUTHORITY_INVALID: ${label}.${key} must be enumerable own-data`)
    }
  }
  exactObjectKeys(value, expected, label)
}

function exactDenseArray(value: unknown, label: string): asserts value is unknown[] {
  assertClosedWorkflowSurfaceValue(value)
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`WORKFLOW_SURFACE_AUTHORITY_INVALID: ${label} must be a built-in array`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const expected = Array.from({ length: value.length }, (_, index) => String(index)).sort(compareCodeUnits)
  const actual = (Reflect.ownKeys(value) as string[]).filter((key) => key !== "length").sort(compareCodeUnits)
  if (!exactArray(actual, expected)) {
    throw new Error(`WORKFLOW_SURFACE_AUTHORITY_INVALID: ${label} must be dense and contain no extra fields`)
  }
  for (const key of expected) {
    const descriptor = descriptors[key]!
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`WORKFLOW_SURFACE_AUTHORITY_INVALID: ${label}.${key} must be enumerable own-data`)
    }
  }
}

function exactStringArray(value: unknown, label: string): asserts value is string[] {
  exactDenseArray(value, label)
  if (value.some((entry) => typeof entry !== "string")) {
    throw new Error(`WORKFLOW_SURFACE_AUTHORITY_INVALID: ${label} must contain strings`)
  }
}

function normalizeActorSnapshot(value: unknown): FrozenActorSnapshot {
  exactOwnDataObject(value, ["key", "id", "systemPrompts"], "frozenActorSnapshot")
  if (typeof value.key !== "string" || !value.key || typeof value.id !== "string" || !value.id) {
    throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: frozen Actor identity is invalid")
  }
  exactStringArray(value.systemPrompts, "frozenActorSnapshot.systemPrompts")
  return deepFreeze(closedJsonCopy(value as unknown as FrozenActorSnapshot))
}

function normalizeConversationSnapshot(value: unknown): FrozenConversationSnapshot {
  exactOwnDataObject(value, ["sessionId", "messages"], "frozenConversationSnapshot")
  if (typeof value.sessionId !== "string" || !value.sessionId) {
    throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: frozen Conversation identity is invalid")
  }
  exactDenseArray(value.messages, "frozenConversationSnapshot.messages")
  if (value.messages.length !== 1) {
    throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: fixed Conversation must have exactly one user message")
  }
  value.messages.forEach((message, index) => {
    exactOwnDataObject(message, ["role", "content"], `frozenConversationSnapshot.messages.${index}`)
    if (message.role !== "user" || typeof message.content !== "string" || !message.content) {
      throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: frozen Conversation message is invalid")
    }
  })
  return deepFreeze(closedJsonCopy(value as unknown as FrozenConversationSnapshot))
}

function normalizeResourcePackage(value: unknown): FrozenAiWorkflowResourcePackage {
  exactOwnDataObject(value, ["schemaVersion", "revision", "digest", "resources"], "resourcePackage")
  exactOwnDataObject(value.resources, Object.keys(value.resources as object), "resourcePackage.resources")
  for (const [resourcePath, material] of Object.entries(value.resources)) {
    if (!resourcePath || typeof material !== "string") {
      throw new Error("WORKFLOW_SURFACE_AUTHORITY_INVALID: resourcePackage resources must be path/string own-data")
    }
  }
  const parsed = parseFrozenAiWorkflowResourcePackage(
    serializeFrozenAiWorkflowResourcePackage(value as unknown as FrozenAiWorkflowResourcePackage),
  )
  return deepFreeze(closedJsonCopy(parsed))
}

function strategyRegistryAuthority(): ClosedWorkflowSurfaceSourceAuthority["strategyRegistry"] {
  return deepFreeze({
    schemaVersion: "eidolon.workflow-provider-surface-strategy-registry-authority/v1" as const,
    registryDigest: WORKFLOW_SURFACE_STRATEGY_REGISTRY.registryDigest,
    strategies: WORKFLOW_SURFACE_STRATEGY_REGISTRY.strategies.map((strategy) => ({
      strategyRevision: strategy.strategyRevision,
      transitionScope: strategy.transitionScope,
      derivation: strategy.derivation,
      strategyDigest: strategy.strategyDigest,
    })),
  })
}

function requireOwner(runtime: WorkflowSurfaceExperimentRuntime): OwnerState {
  const state = OWNER_STATES.get(runtime as object)
  if (!state) {
    throw new Error("WORKFLOW_SURFACE_RUNTIME_REQUIRED: an admitted runtime owner is required before candidate execution")
  }
  return state
}

function artifactPath(state: OwnerState, ref: WorkflowSurfaceEvidenceRef): string {
  exactOwnDataObject(ref, ["schemaVersion", "ownerId", "artifactDigest"], "evidenceRef")
  if (ref.schemaVersion !== "eidolon.workflow-provider-surface-evidence-ref/v1"
    || ref.ownerId !== digestClosedWorkflowSurfaceValue({ ownerSecret: state.secret.toString("hex") })
    || !/^sha256:[a-f0-9]{64}$/.test(ref.artifactDigest)) {
    throw new Error("WORKFLOW_SURFACE_EVIDENCE_INVALID: evidence ref is not owned by this runtime")
  }
  return path.join(state.artifactRoot, `${ref.artifactDigest.slice("sha256:".length)}.json`)
}

function writeArtifact(runtime: WorkflowSurfaceExperimentRuntime, value: unknown): WorkflowSurfaceEvidenceRef {
  const state = requireOwner(runtime)
  const artifactDigest = digestClosedWorkflowSurfaceValue(value)
  const ref = Object.freeze({
    schemaVersion: "eidolon.workflow-provider-surface-evidence-ref/v1" as const,
    ownerId: runtime.ownerId,
    artifactDigest,
  })
  const target = artifactPath(state, ref)
  if (!fs.existsSync(target)) fs.writeFileSync(target, `${JSON.stringify(value)}\n`, { flag: "wx" })
  return ref
}

function readArtifact<T>(runtime: WorkflowSurfaceExperimentRuntime, ref: WorkflowSurfaceEvidenceRef): T {
  const state = requireOwner(runtime)
  const value = JSON.parse(fs.readFileSync(artifactPath(state, ref), "utf8")) as T
  if (digestClosedWorkflowSurfaceValue(value) !== ref.artifactDigest) {
    throw new Error("WORKFLOW_SURFACE_EVIDENCE_INVALID: content-addressed artifact digest mismatch")
  }
  return deepFreeze(value)
}

function issueOwnerReceipt(runtime: WorkflowSurfaceExperimentRuntime, value: unknown): HmacSha256 {
  const state = requireOwner(runtime)
  const payloadDigest = digestClosedWorkflowSurfaceValue(value)
  return `hmac-sha256:${createHmac("sha256", state.secret).update(payloadDigest).digest("hex")}`
}

function verifyOwnerReceipt(runtime: WorkflowSurfaceExperimentRuntime, value: unknown, receipt: unknown): boolean {
  if (typeof receipt !== "string" || !/^hmac-sha256:[a-f0-9]{64}$/.test(receipt)) return false
  const expected = issueOwnerReceipt(runtime, value)
  return timingSafeEqual(Buffer.from(receipt), Buffer.from(expected))
}

function verifyCandidateArtifactClosure(
  runtime: WorkflowSurfaceExperimentRuntime,
  candidateRef: WorkflowSurfaceEvidenceRef,
): void {
  readClosedSourceAuthority(runtime)
  const candidate = readArtifact<CandidateEvidenceArtifact>(runtime, candidateRef)
  for (const requestRef of candidate.requestEvidenceRefs) {
    const request = readArtifact<RequestEvidenceArtifact>(runtime, requestRef)
    readArtifact<FinalWireArtifact>(runtime, request.finalWireRef)
    for (const attemptRef of request.transportAttemptRefs) readArtifact<FinalWireArtifact>(runtime, attemptRef)
  }
  const recovery = readArtifact<RecoveryEvidenceArtifact>(runtime, candidate.recoveryEvidenceRef)
  const recoveryRequest = readArtifact<RequestEvidenceArtifact>(runtime, recovery.recoveryRequestEvidenceRef)
  readArtifact<FinalWireArtifact>(runtime, recoveryRequest.finalWireRef)
  for (const attemptRef of recoveryRequest.transportAttemptRefs) readArtifact<FinalWireArtifact>(runtime, attemptRef)
  readArtifact(runtime, recovery.recoveredFacetRef)
}

async function executeFixedCandidate(
  runtime: WorkflowSurfaceExperimentRuntime,
  input: {
    authority: ClosedWorkflowSurfaceExperimentInput
    strategyRevision: WorkflowSurfaceStrategyRevision
    sourceSnapshotDigest: Sha256
    cloneInstanceDigest: Sha256
  },
): Promise<WorkflowSurfaceEvidenceRef> {
    const state = requireOwner(runtime)
    if (!state.sourceRefs) throw new Error("WORKFLOW_SURFACE_RUNTIME_INVALID: frozen source authority is unavailable")
    const sourceAuthority = readClosedSourceAuthority(runtime)
    const actorSnapshot = sourceAuthority.actor
    const conversationSnapshot = sourceAuthority.conversation
    const resourcePackage = sourceAuthority.resourcePackage
    const sessionDir = fs.mkdtempSync(path.join(state.artifactRoot, "candidate-runtime-"))
    fs.mkdirSync(sessionDir, { recursive: true })
    const cloneDir = path.join(sessionDir, "experiment-clone")
    fs.mkdirSync(cloneDir, { recursive: true })
    const actorCloneRef = writeArtifact(runtime, structuredClone(actorSnapshot))
    const conversationCloneRef = writeArtifact(runtime, structuredClone(conversationSnapshot))
    const loadedActor = readArtifact<FrozenActorSnapshot>(runtime, actorCloneRef)
    const loadedConversation = readArtifact<FrozenConversationSnapshot>(runtime, conversationCloneRef)

    const registry = composeToolRegistry({ includeWorkflowLifecycle: true })
    const liveProfile = resolveWorkflowLifecycleToolProfileRegistry(registry).resolve(
      WORKFLOW_LIFECYCLE_TOOL_PROFILE_ID,
      WORKFLOW_LIFECYCLE_TOOL_PROFILE_REVISION,
    )
    if (digestClosedWorkflowSurfaceValue(liveProfile) !== digestClosedWorkflowSurfaceValue(sourceAuthority.toolProfile)) {
      throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: runtime tool profile differs from admitted authority")
    }
    if (digestClosedWorkflowSurfaceValue(strategyRegistryAuthority())
      !== digestClosedWorkflowSurfaceValue(sourceAuthority.strategyRegistry)) {
      throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: runtime strategy registry differs from admitted authority")
    }
    const schemaNames = new Set(ToolFuncRegistry.list(registry).map((definition) => definition.schema.function.name))
    for (const name of AI_WORKFLOW_PROVIDER_TOOL_SURFACE) {
      if (!schemaNames.has(name)) throw new Error(`WORKFLOW_SURFACE_EXPERIMENT_INVALID: admitted schema missing '${name}'`)
    }
    const managedSkill = resourcePackage.resources["sys-eidolon-anchor-devops/SKILL.md"]
    if (!managedSkill) throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: lifecycle resource package is incomplete")
    let activeAttempts: string[] = []
    let injectTestingRetry = true
    let successfulProviderTurns = 0
    let lifecycleActor: AiAgentActor | undefined
    const transports: Array<{
      serializedBody: string
      attempts: string[]
      providerEpochReceipt: Readonly<Record<string, unknown>>
    }> = []
    const canonicalAdmissions: Array<{
      requestAdmission: Readonly<Record<string, unknown>>
      providerEpochReceipt: Readonly<Record<string, unknown>>
    }> = []
    const seenAdmissionDigests = new Set<string>()
    const privateFetch = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = String(init?.body ?? "")
      activeAttempts.push(body)
      const nextTurn = successfulProviderTurns + 1
      if (nextTurn === 7 && injectTestingRetry) {
        injectTestingRetry = false
        return new Response(JSON.stringify({ error: { message: "temporary unavailable" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })
      }
      successfulProviderTurns = nextTurn
      const delta = nextTurn <= 10
        ? (() => {
            const stageIndex = Math.floor((nextTurn - 1) / 2)
            const stage = WORKFLOW_SURFACE_EXPERIMENT_STAGES[stageIndex]!
            const nextStage = WORKFLOW_SURFACE_EXPERIMENT_STAGES[Math.min(stageIndex + 1, 4)]!
            const selectedStage = nextTurn % 2 === 0 ? nextStage : stage
            return {
              tool_calls: [{
                index: 0,
                id: `surface-${nextTurn}`,
                type: "function",
                function: {
                  name: REQUIRED_TOOL_BY_EXPERIMENT_STAGE[stage],
                  arguments: JSON.stringify({ stage: selectedStage }),
                },
              }],
            }
          })()
        : { content: "WorkflowAuthor experiment complete." }
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta, finish_reason: nextTurn <= 10 ? "tool_calls" : "stop" }] })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } })
    }
    const adapter = sealPrivateChatAdapter(new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "experiment-runtime-owner",
      baseUrl: "https://surface-experiment.invalid/v1",
      effectBundle: deepSeekCompatibleChatEffectBundle,
      providerOptions: { fetch: privateFetch },
    }))
    const createPrivateStream = (options: any) => PRIVATE_PROVIDER_RETRY(
      () => PRIVATE_CHAT_CREATE_STREAM.call(adapter, options),
      {
        stage: "workflow-surface-experiment",
        providerId: "surface-experiment",
        selectedModel: state.config.model,
        sleep: async () => {},
        random: () => 0,
      },
    )
    let vm: ReturnType<typeof createVM>
    const llmClient = {
      type: "openai" as const,
      async createStream(options: any) {
        if (!lifecycleActor) throw new Error("experiment lifecycle Actor must be registered")
        const receipt = getConversationActorRawStateFromVm({ vm, actorKey: lifecycleActor.key })
          ?.session.actorBindings[lifecycleActor.key]?.providerEpochReceiptV2
        if (!receipt) throw new Error("experiment transport requires a persisted provider epoch")
        activeAttempts = []
        const result = createPrivateStream(options)
        const providerOutput = result.providerOutput?.then((output) => {
          const serializedBody = activeAttempts.at(-1)
          if (!serializedBody) throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: provider output lacks final wire")
          const providerCacheCostObservation = createProviderCacheCostObservation({
            identity: {
              schemaVersion: 1,
              providerId: "workflow-surface-experiment",
              providerProfile: state.config.providerProfileId === "deepseek-official-chat@1"
                ? "deepseek_official"
                : "deepseek_compatible",
              providerProfileId: state.config.providerProfileId,
              model: state.config.model,
              actorClass: "workflow_lifecycle",
              contextEpoch: Number(receipt.epoch),
            },
            serializedRequestBody: serializedBody,
            tokenEstimates: estimateFinalWireProviderCacheCostTokens(serializedBody),
            usage: {
              promptTokens: 100,
              completionTokens: 4,
              cacheHitTokens: 75,
              cacheMissTokens: 25,
            },
            priceWeights: { cacheHitWeight: 0.1, cacheMissWeight: 1 },
          })
          const native = output && typeof output === "object" && !Array.isArray(output)
            ? structuredClone(output) as Record<string, unknown>
            : {}
          return Object.freeze({ ...native, provider_cache_cost_observation: providerCacheCostObservation })
        })
        async function* observedStream() {
          for await (const chunk of result.stream) yield chunk
          if (activeAttempts.length < 1) throw new Error("experiment adapter did not reach transport")
          const serializedBody = activeAttempts[activeAttempts.length - 1]!
          transports.push({
            serializedBody,
            attempts: [...activeAttempts],
            providerEpochReceipt: structuredClone(receipt) as unknown as Readonly<Record<string, unknown>>,
          })
        }
        return { ...result, stream: observedStream(), providerOutput }
      },
    }
    const parent = createActor({
      key: loadedActor.key,
      id: loadedActor.id,
      llmClient,
      modelConfig: {
        model: state.config.model,
        provider: "surface-experiment",
        adapter: "deepseek",
        options: { compatibilityProfile: state.config.providerProfileId },
        capabilities: {
          family: "deepseek",
          cachePolicy: {
            stablePrefix: true,
            providerManagedPrefixCache: true,
            preferLateCompaction: true,
          },
        },
      },
      systemPrompts: [...loadedActor.systemPrompts],
      messages: [...loadedConversation.messages],
      callbacks: {
        buildToolset: () => [],
        processStream: async (_vm, _actor, stream) => {
          let streamState = PRIVATE_CHAT_STREAM_CORE.createState()
          for await (const chunk of stream as AsyncIterable<unknown>) {
            streamState = PRIVATE_CHAT_STREAM_CORE.reduceChunk(
              streamState,
              chunk,
              deepSeekCompatibleChatEffectBundle.streamReasoningPolicy,
            ).state
          }
          return PRIVATE_CHAT_STREAM_CORE.buildAssistantMessage(streamState)
        },
      },
    })
    vm = createVM({
      controlActorKey: parent.key,
      actors: { [parent.key]: parent },
      registries: {
        toolRegistry: registry,
        agentRegistry: new AgentRegistry({
          workflow: {
            name: "workflow",
            description: "Closed WorkflowAuthor strategy experiment",
            tools: "*",
            prompt: ["Execute the closed WorkflowAuthor journey."],
          },
        }),
      },
      outerCtx: {
        workDir: sessionDir,
        metadata: {
          sessionId: `surface-${input.strategyRevision}`,
          sessionDir,
          aiWorkflow: { roots: { systemRoot: state.config.globalRoot } },
        },
        conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
      },
    })
    // Observe the Conversation owner itself.  Admissions may be cleared by a
    // later legitimate epoch transition, so reading only the final binding
    // loses completed requests.  The signal emits after the canonical
    // AiAgentExecutor writer commits; this observer has no write capability.
    const conversationRuntime = ensureVmConversationDomainRuntime(vm)
    const admissionSubscription = conversationRuntime.sessionStateSignal.subscribe((sessions) => {
      if (!lifecycleActor) return
      const binding = sessions[`surface-${input.strategyRevision}`]
        ?.actorBindings[lifecycleActor.key]
      const receipt = binding?.providerEpochReceiptV2
      if (!receipt) return
      for (const admission of binding.providerRequestAdmissions ?? []) {
        if (seenAdmissionDigests.has(admission.admissionDigest)) continue
        seenAdmissionDigests.add(admission.admissionDigest)
        canonicalAdmissions.push({
          requestAdmission: structuredClone(admission) as unknown as Readonly<Record<string, unknown>>,
          providerEpochReceipt: structuredClone(receipt) as unknown as Readonly<Record<string, unknown>>,
        })
      }
    })
    try {
      await spawnWorkflowLifecycleSurfaceExperimentActor(vm, parent, {
        description: "WorkflowAuthor closed surface experiment",
        prompt: loadedConversation.messages[0]!.content,
        systemSkillMaterial: managedSkill,
        systemSkillPackage: resourcePackage,
        strategyRevision: input.strategyRevision,
        mode: "sync_wait",
        retainActor: true,
        onActorCreated: (actor) => { lifecycleActor = actor },
      })
      if (transports.length !== 11 || injectTestingRetry) {
        throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: fixed product journey or 503 retry is incomplete")
      }
      if (canonicalAdmissions.length !== transports.length) {
        throw new Error(
          `WORKFLOW_SURFACE_EXPERIMENT_INVALID: canonical admission/transport closure differs (${canonicalAdmissions.length}/${transports.length})`,
        )
      }
      const toolDomain = getVmToolCallDomain(vm)
      if (!toolDomain || !lifecycleActor) throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: durable tool domain is unavailable")
      const liveFacet = readWorkflowLifecycleFacet(lifecycleActor)
      const packageMaterial = createWorkflowLifecycleResourcePackageMaterial(resourcePackage)
      if (!liveFacet
        || liveFacet.resourcePackage.packageDigest !== resourcePackage.digest
        || liveFacet.resourcePackage.revision !== resourcePackage.revision
        || liveFacet.resourcePackage.materialDigest !== packageMaterial.digest
        || liveFacet.toolProfile.profileId !== sourceAuthority.toolProfile.profileId
        || liveFacet.toolProfile.profileRevision !== sourceAuthority.toolProfile.profileRevision
        || liveFacet.toolProfile.admittedNamesDigest !== sourceAuthority.toolProfile.admittedNamesDigest
        || liveFacet.providerSurfaceStrategy.strategyDigest
          !== WORKFLOW_SURFACE_STRATEGY_REGISTRY.resolve(input.strategyRevision).strategyDigest) {
        throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: Actor facet is not bound to admitted package/profile/strategy bytes")
      }
      const freshSession = await LocalFileConversationPersistenceRepositoryFactory
        .createRepository(sessionDir)
        .loadSessionIndex()
      const freshReceipt = freshSession.session.actorBindings[lifecycleActor.key]?.providerEpochReceiptV2
      const liveReceipt = getConversationActorRawStateFromVm({ vm, actorKey: lifecycleActor.key })
        ?.session.actorBindings[lifecycleActor.key]?.providerEpochReceiptV2
      if (digestClosedWorkflowSurfaceValue(freshReceipt) !== digestClosedWorkflowSurfaceValue(liveReceipt)) {
        throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: ProviderEpoch durable owner readback differs")
      }
      const requestEvidenceRefs = transports.map((entry, index) => {
        const canonical = canonicalAdmissions[index]
        if (!canonical) throw new Error(`WORKFLOW_SURFACE_EXPERIMENT_INVALID: request admission ${index + 1} is unavailable`)
        const record = index < WORKFLOW_SURFACE_EXPERIMENT_STAGES.length * 2
          ? toolDomain.getRecord(`surface-${index + 1}`)
          : null
        if (index < WORKFLOW_SURFACE_EXPERIMENT_STAGES.length * 2
          && (!record || record.status !== "completed")) {
          throw new Error(`WORKFLOW_SURFACE_EXPERIMENT_INVALID: tool execution did not complete for request ${index + 1}`)
        }
        const finalWireRef = writeArtifact(runtime, {
          schemaVersion: "eidolon.workflow-provider-final-wire/v1",
          body: entry.serializedBody,
        } satisfies FinalWireArtifact)
        const transportAttemptRefs = entry.attempts.map((body) => writeArtifact(runtime, {
          schemaVersion: "eidolon.workflow-provider-final-wire/v1",
          body,
        } satisfies FinalWireArtifact))
        return writeArtifact(runtime, {
          schemaVersion: "eidolon.workflow-provider-request-evidence/v1",
          sessionId: `surface-${input.strategyRevision}`,
          actorKey: lifecycleActor!.key,
          actorId: lifecycleActor!.id,
          finalWireRef,
          transportAttemptRefs,
          requestAdmission: canonical.requestAdmission,
          providerEpochReceipt: canonical.providerEpochReceipt,
          toolCallRecord: record
            ? structuredClone(record) as unknown as Readonly<Record<string, unknown>>
            : null,
          providerUsage: Object.freeze({
            cacheHitTokens: 75,
            cacheMissTokens: 25,
            normalizedInputCost: 32.5,
          }),
        } satisfies RequestEvidenceArtifact)
      })
      const driver = createAiAgentOrchestratorDriverWithCooperative({
        fibers: [{
          fiberId: `${parent.key}:${parent.id}`,
          vm,
          actor: parent,
          messages: parent.messages,
          basePriority: 1,
        }],
        options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
      })
      const snapshotResult = await saveAiAgentRuntimeSnapshot({
        sessionDir,
        sessionId: `surface-${input.strategyRevision}`,
        vm,
        driver,
      })
      if (snapshotResult.status !== "saved") {
        throw new Error(`WORKFLOW_SURFACE_EXPERIMENT_INVALID: candidate runtime snapshot was not saved (${snapshotResult.status})`)
      }
      const upgrade = await applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })
      if (upgrade.status !== "applied" && upgrade.status !== "already_upgraded") {
        throw new Error(`WORKFLOW_SURFACE_EXPERIMENT_INVALID: candidate snapshot recovery gate was not admitted (${upgrade.status})`)
      }
      const recoveryAdapter = sealPrivateChatAdapter(new OpenAICompletionsNodejsFetchLlmAdapter({
        apiKey: "experiment-runtime-owner-recovery",
        baseUrl: "https://surface-experiment.invalid/v1",
        effectBundle: deepSeekCompatibleChatEffectBundle,
        providerOptions: { fetch: privateFetch },
      }))
      const createRecoveryTransport = (options: any) => PRIVATE_PROVIDER_RETRY(
        () => PRIVATE_CHAT_CREATE_STREAM.call(recoveryAdapter, options),
        {
          stage: "workflow-surface-recovery",
          providerId: "surface-experiment",
          selectedModel: state.config.model,
          sleep: async () => {},
          random: () => 0,
        },
      )
      let recoveredVmForTransport: ReturnType<typeof createVM> | undefined
      let recoveredActorForTransport: AiAgentActor | undefined
      const recoveryTransports: Array<{
        serializedBody: string
        attempts: string[]
        providerEpochReceipt: Readonly<Record<string, unknown>>
      }> = []
      const recoveryLlmClient = Object.freeze({
        type: "openai" as const,
        async createStream(options: any) {
          if (!recoveredVmForTransport || !recoveredActorForTransport) {
            throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: recovery transport Actor is unavailable")
          }
          const receipt = getConversationActorRawStateFromVm({
            vm: recoveredVmForTransport,
            actorKey: recoveredActorForTransport.key,
          })?.session.actorBindings[recoveredActorForTransport.key]?.providerEpochReceiptV2
          if (!receipt) throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: recovered provider epoch is unavailable")
          activeAttempts = []
          const result = createRecoveryTransport(options)
          const providerOutput = result.providerOutput?.then((output) => {
            const serializedBody = activeAttempts.at(-1)
            if (!serializedBody) throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: recovery provider output lacks final wire")
            const providerCacheCostObservation = createProviderCacheCostObservation({
              identity: {
                schemaVersion: 1,
                providerId: "workflow-surface-experiment-recovery",
                providerProfile: state.config.providerProfileId === "deepseek-official-chat@1"
                  ? "deepseek_official"
                  : "deepseek_compatible",
                providerProfileId: state.config.providerProfileId,
                model: state.config.model,
                actorClass: "workflow_lifecycle",
                contextEpoch: Number(receipt.epoch),
              },
              serializedRequestBody: serializedBody,
              tokenEstimates: estimateFinalWireProviderCacheCostTokens(serializedBody),
              usage: { promptTokens: 100, completionTokens: 4, cacheHitTokens: 75, cacheMissTokens: 25 },
              priceWeights: { cacheHitWeight: 0.1, cacheMissWeight: 1 },
            })
            const native = output && typeof output === "object" && !Array.isArray(output)
              ? structuredClone(output) as Record<string, unknown>
              : {}
            return Object.freeze({ ...native, provider_cache_cost_observation: providerCacheCostObservation })
          })
          async function* observedRecoveryStream() {
            for await (const chunk of result.stream) yield chunk
            const serializedBody = activeAttempts.at(-1)
            if (!serializedBody) throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: recovery transport lacks final wire")
            recoveryTransports.push({
              serializedBody,
              attempts: [...activeAttempts],
              providerEpochReceipt: structuredClone(receipt) as unknown as Readonly<Record<string, unknown>>,
            })
          }
          return { ...result, stream: observedRecoveryStream(), providerOutput }
        },
      })
      const recovered = await recoverAiAgentRuntime({
        sessionDir,
        sessionId: `surface-${input.strategyRevision}`,
        llmClient: recoveryLlmClient,
        registries: vm.registries,
        outerCtx: {
          workDir: sessionDir,
          metadata: {
            sessionId: `surface-${input.strategyRevision}`,
            sessionDir,
            aiWorkflow: { roots: { systemRoot: state.config.globalRoot } },
          },
          conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
        },
        actorCallbacks: {
          buildToolset: () => [],
          processStream: async (_vm, _actor, stream) => {
            for await (const _chunk of stream as AsyncIterable<unknown>) { /* recovery fallback */ }
            return { role: "assistant", content: "recovered" }
          },
        },
      })
      if (!recovered) throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: fresh runtime recovery returned no VM")
      const recoveredLifecycleActor = recovered.vm.actors[lifecycleActor.key]
      if (!recoveredLifecycleActor || recoveredLifecycleActor === lifecycleActor || recovered.vm === vm) {
        throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: recovery did not hydrate a distinct VM/Actor")
      }
      recoveredVmForTransport = recovered.vm
      recoveredActorForTransport = recoveredLifecycleActor
      const recoveredRuntime = ensureVmConversationDomainRuntime(recovered.vm)
      const recoveredBindingBefore = recoveredRuntime.sessionStateSignal.get()[`surface-${input.strategyRevision}`]
        ?.actorBindings[recoveredLifecycleActor.key]
      const recoveredEpochBefore = recoveredBindingBefore?.providerEpochReceiptV2
      const expectedLiveBoundary = canonicalAdmissions.at(-1)
      const recoveredAdmissionBefore = recoveredBindingBefore?.providerRequestAdmissions?.at(-1)
      if (!expectedLiveBoundary
        || recoveredEpochBefore?.receiptDigest !== (expectedLiveBoundary.providerEpochReceipt as any).receiptDigest
        || recoveredAdmissionBefore?.admissionDigest !== (expectedLiveBoundary.requestAdmission as any).admissionDigest) {
        throw new Error(`WORKFLOW_SURFACE_EXPERIMENT_INVALID: recovered provider boundary differs before continuation: ${JSON.stringify({
          expectedEpoch: (expectedLiveBoundary?.providerEpochReceipt as any)?.receiptDigest ?? null,
          recoveredEpoch: recoveredEpochBefore?.receiptDigest ?? null,
          expectedAdmission: (expectedLiveBoundary?.requestAdmission as any)?.admissionDigest ?? null,
          recoveredAdmission: recoveredAdmissionBefore?.admissionDigest ?? null,
        })}`)
      }
      const recoveredHistoryState = Object.values(recoveredRuntime.historyStateSignal.get()).find((candidate) => (
        candidate.sessionId === `surface-${input.strategyRevision}` && candidate.actorKey === recoveredLifecycleActor.key
      ))
      const recoveredBaseline = recoveredHistoryState?.generations.find((generation) => (
        generation.generationId === recoveredEpochBefore?.baselineHeads.historyHeadGenerationId
      ))
      const recoveredBaselineFrontier = digestProviderContextHistoryFrontier(
        (recoveredBaseline?.messages ?? []).slice(0, recoveredEpochBefore?.sourceHistoryMessageCount ?? 0),
      )
      if (!recoveredEpochBefore || recoveredBaselineFrontier !== recoveredEpochBefore.sourceFrontierDigest) {
        throw new Error(
          `WORKFLOW_SURFACE_EXPERIMENT_INVALID: recovered baseline frontier differs (${recoveredEpochBefore?.sourceHistoryMessageCount ?? -1}/${recoveredBaseline?.messages.length ?? -1})`,
        )
      }
      const recoveredPromptState = Object.values(recoveredRuntime.promptStateSignal.get()).find((candidate) => (
        candidate.sessionId === `surface-${input.strategyRevision}` && candidate.actorKey === recoveredLifecycleActor.key
      ))
      const recoveredPromptHead = recoveredBindingBefore?.promptHeadGenerationId
      const recoveredPrompt = recoveredPromptState?.generations.find((generation) => (
        generation.promptGenerationId === recoveredPromptHead
      ))
      if (recoveredPromptHead && recoveredPromptHead !== "__empty_prompt__" && !recoveredPrompt) {
        throw new Error(
          `WORKFLOW_SURFACE_EXPERIMENT_INVALID: recovered prompt generation missing (${recoveredPromptHead ?? "missing"}/${recoveredPromptState?.activePromptGenerationId ?? "missing"}/${recoveredPromptState?.generations.map((generation) => generation.promptGenerationId).join(",") ?? "missing"})`,
        )
      }
      const priorRecoveryAdmissions = new Set(
        (recoveredBindingBefore?.providerRequestAdmissions ?? []).map((admission) => admission.admissionDigest),
      )
      const recoveryAdmissions: Array<{
        requestAdmission: Readonly<Record<string, unknown>>
        providerEpochReceipt: Readonly<Record<string, unknown>>
      }> = []
      const recoveryAdmissionSubscription = recoveredRuntime.sessionStateSignal.subscribe((sessions) => {
        const binding = sessions[`surface-${input.strategyRevision}`]?.actorBindings[recoveredLifecycleActor.key]
        const receipt = binding?.providerEpochReceiptV2
        if (!receipt) return
        for (const admission of binding.providerRequestAdmissions ?? []) {
          if (priorRecoveryAdmissions.has(admission.admissionDigest)) continue
          priorRecoveryAdmissions.add(admission.admissionDigest)
          recoveryAdmissions.push({
            requestAdmission: structuredClone(admission) as unknown as Readonly<Record<string, unknown>>,
            providerEpochReceipt: structuredClone(receipt) as unknown as Readonly<Record<string, unknown>>,
          })
        }
      })
      try {
        const recoveryFiberId = `${recoveredLifecycleActor.key}:${recoveredLifecycleActor.id}`
        const recoveryDriver = createAiAgentOrchestratorDriverWithCooperative({
          fibers: [{
            fiberId: recoveryFiberId,
            vm: recovered.vm,
            actor: recoveredLifecycleActor,
            messages: recoveredLifecycleActor.messages,
            basePriority: 1,
          }],
          options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
        })
        recoveryDriver.resumeFiber(recoveryFiberId, Date.now())
        await recoveryDriver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 20, maxWallMs: 5_000 })
        const fiber = recoveryDriver.getState().fibers[recoveryFiberId]
        if (fiber?.status === "failed") {
          throw new Error(fiber.lastError || "WORKFLOW_SURFACE_EXPERIMENT_INVALID: recovered continuation failed")
        }
      } finally {
        recoveryAdmissionSubscription.unsubscribe()
      }
      if (recoveryTransports.length !== 1 || recoveryAdmissions.length !== 1) {
        throw new Error(
          `WORKFLOW_SURFACE_EXPERIMENT_INVALID: recovered continuation closure differs (${recoveryTransports.length}/${recoveryAdmissions.length})`,
        )
      }
      const recoveredFacet = readWorkflowLifecycleFacet(recoveredLifecycleActor)
      const recoveredToolDomain = getVmToolCallDomain(recovered.vm)
      const recoveredTerminalToolRecord = recoveredToolDomain?.getRecord("surface-10")
      const recoveredSourceAuthority = readClosedSourceAuthority(runtime)
      if (!recoveredFacet || !recoveredTerminalToolRecord || recoveredTerminalToolRecord.status !== "completed"
        || recoveredFacet.resourcePackage.packageDigest !== recoveredSourceAuthority.resourcePackage.digest
        || recoveredFacet.resourcePackage.materialDigest !== createWorkflowLifecycleResourcePackageMaterial(
          recoveredSourceAuthority.resourcePackage,
        ).digest
        || recoveredFacet.toolProfile.admittedNamesDigest !== recoveredSourceAuthority.toolProfile.admittedNamesDigest) {
        throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: fresh recovery lacks facet or terminal ToolCall receipt")
      }
      const freshRecoveredSession = await LocalFileConversationPersistenceRepositoryFactory
        .createRepository(sessionDir)
        .loadSessionIndex()
      const recoveredProviderEpochReceipt = freshRecoveredSession.session
        .actorBindings[recoveredLifecycleActor.key]?.providerEpochReceiptV2
      if (!recoveredProviderEpochReceipt) {
        throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: fresh recovery lacks ProviderEpoch receipt")
      }
      const recoveredActorReceipt = Object.freeze({
        actorKey: recoveredLifecycleActor.key,
        actorId: recoveredLifecycleActor.id,
        messagesDigest: digestClosedWorkflowSurfaceValue(closedJsonCopy(recoveredLifecycleActor.messages)),
        systemPromptsDigest: digestClosedWorkflowSurfaceValue(closedJsonCopy(recoveredLifecycleActor.systemPrompts)),
        toolPolicyDigest: digestClosedWorkflowSurfaceValue(closedJsonCopy(recoveredLifecycleActor.toolPolicy)),
      })
      const recoveredFacetReceipt = Object.freeze({
        facetDigest: digestClosedWorkflowSurfaceValue(recoveredFacet),
        strategyRevision: recoveredFacet.providerSurfaceStrategy.strategyRevision,
        strategyDigest: recoveredFacet.providerSurfaceStrategy.strategyDigest,
        stageId: recoveredFacet.stageId,
      })
      const recoveredConversationReceipt = Object.freeze({
        actorKey: recoveredLifecycleActor.key,
        historyMessageCount: recoveredLifecycleActor.messages.length,
        sessionBindingDigest: digestClosedWorkflowSurfaceValue(
          freshRecoveredSession.session.actorBindings[recoveredLifecycleActor.key],
        ),
      })
      const recoveryTransport = recoveryTransports[0]!
      const recoveryCanonical = recoveryAdmissions[0]!
      const recoveryRequestEvidenceRef = writeArtifact(runtime, {
        schemaVersion: "eidolon.workflow-provider-request-evidence/v1",
        sessionId: `surface-${input.strategyRevision}`,
        actorKey: recoveredLifecycleActor.key,
        actorId: recoveredLifecycleActor.id,
        finalWireRef: writeArtifact(runtime, {
          schemaVersion: "eidolon.workflow-provider-final-wire/v1",
          body: recoveryTransport.serializedBody,
        } satisfies FinalWireArtifact),
        transportAttemptRefs: recoveryTransport.attempts.map((body) => writeArtifact(runtime, {
          schemaVersion: "eidolon.workflow-provider-final-wire/v1",
          body,
        } satisfies FinalWireArtifact)),
        requestAdmission: recoveryCanonical.requestAdmission,
        providerEpochReceipt: recoveryCanonical.providerEpochReceipt,
        toolCallRecord: null,
        providerUsage: Object.freeze({ cacheHitTokens: 75, cacheMissTokens: 25, normalizedInputCost: 32.5 }),
      } satisfies RequestEvidenceArtifact)
      const recoveryReceiptBody = {
        schemaVersion: "eidolon.workflow-provider-fresh-recovery-evidence/v1" as const,
        recoveredRuntimeInstanceDigest: digestClosedWorkflowSurfaceValue({
          candidate: input.cloneInstanceDigest,
          runtimeNonce: randomBytes(32).toString("hex"),
          actorId: recoveredLifecycleActor.id,
        }),
        recoveryRequestEvidenceRef,
        recoveredFacetRef: writeArtifact(runtime, recoveredFacet),
        recoveredActorReceipt,
        recoveredFacetReceipt,
        recoveredConversationReceipt,
        recoveredProviderEpochReceipt: structuredClone(recoveredProviderEpochReceipt) as unknown as Readonly<Record<string, unknown>>,
        recoveredTerminalToolCallRecord: structuredClone(recoveredTerminalToolRecord) as unknown as Readonly<Record<string, unknown>>,
      }
      const recoveryEvidenceRef = writeArtifact(runtime, {
        ...recoveryReceiptBody,
        receiptDigest: digestClosedWorkflowSurfaceValue(recoveryReceiptBody),
      } satisfies RecoveryEvidenceArtifact)
      const recoveredActor = readArtifact<FrozenActorSnapshot>(runtime, actorCloneRef)
      const recoveredConversation = readArtifact<FrozenConversationSnapshot>(runtime, conversationCloneRef)
      return writeArtifact(runtime, {
        schemaVersion: "eidolon.workflow-provider-candidate-evidence/v1",
        strategyRevision: input.strategyRevision,
        sourceSnapshotDigest: input.sourceSnapshotDigest,
        cloneInstanceDigest: input.cloneInstanceDigest,
        loadedActorSnapshotDigest: digestClosedWorkflowSurfaceValue(loadedActor),
        loadedConversationSnapshotDigest: digestClosedWorkflowSurfaceValue(loadedConversation),
        recoveredActorSnapshotDigest: digestClosedWorkflowSurfaceValue(recoveredActor),
        recoveredConversationSnapshotDigest: digestClosedWorkflowSurfaceValue(recoveredConversation),
        requestEvidenceRefs,
        recoveryEvidenceRef,
      } satisfies CandidateEvidenceArtifact)
    } finally {
      admissionSubscription.unsubscribe()
    }
}

export function createLocalWorkflowSurfaceExperimentRuntime(
  config: LocalWorkflowSurfaceExperimentRuntimeConfig,
): WorkflowSurfaceExperimentRuntime {
  exactOwnDataObject(config, [
    "globalRoot", "resourcePackage", "frozenActorSnapshot", "frozenConversationSnapshot",
    "providerProfileId", "model", "lifecycleToolProfileDigest", "lifecycleResourcePackageDigest",
  ], "runtimeConfig")
  if (!path.isAbsolute(config.globalRoot)) {
    throw new Error("WORKFLOW_SURFACE_RUNTIME_INVALID: absolute globalRoot is required")
  }
  if (config.providerProfileId !== "deepseek-official-chat@1"
    && config.providerProfileId !== "deepseek-compatible-chat@1") {
    throw new Error("WORKFLOW_SURFACE_RUNTIME_INVALID: provider profile is not admitted")
  }
  if (typeof config.model !== "string" || !config.model
    || !/^sha256:[a-f0-9]{64}$/.test(config.lifecycleToolProfileDigest)
    || !/^sha256:[a-f0-9]{64}$/.test(config.lifecycleResourcePackageDigest)) {
    throw new Error("WORKFLOW_SURFACE_RUNTIME_INVALID: model or authority digest is invalid")
  }
  const actorSnapshot = normalizeActorSnapshot(config.frozenActorSnapshot)
  const conversationSnapshot = normalizeConversationSnapshot(config.frozenConversationSnapshot)
  const resourcePackage = normalizeResourcePackage(config.resourcePackage)
  const registry = composeToolRegistry({ includeWorkflowLifecycle: true })
  const toolProfile = deepFreeze(closedJsonCopy(
    resolveWorkflowLifecycleToolProfileRegistry(registry).resolve(
      WORKFLOW_LIFECYCLE_TOOL_PROFILE_ID,
      WORKFLOW_LIFECYCLE_TOOL_PROFILE_REVISION,
    ),
  ))
  const toolProfileDigest = digestClosedWorkflowSurfaceValue(toolProfile)
  if (config.lifecycleToolProfileDigest !== toolProfileDigest) {
    throw new Error("WORKFLOW_SURFACE_RUNTIME_INVALID: claimed tool profile digest differs from actual profile bytes")
  }
  if (config.lifecycleResourcePackageDigest !== resourcePackage.digest) {
    throw new Error("WORKFLOW_SURFACE_RUNTIME_INVALID: claimed resource package digest differs from actual package bytes")
  }
  const strategyRegistry = strategyRegistryAuthority()
  const normalizedConfig = deepFreeze({
    globalRoot: config.globalRoot,
    resourcePackage,
    frozenActorSnapshot: actorSnapshot,
    frozenConversationSnapshot: conversationSnapshot,
    providerProfileId: config.providerProfileId,
    model: config.model,
    lifecycleToolProfileDigest: toolProfileDigest,
    lifecycleResourcePackageDigest: resourcePackage.digest,
  } satisfies LocalWorkflowSurfaceExperimentRuntimeConfig)
  const secret = randomBytes(32)
  const token = Object.freeze({
    schemaVersion: "eidolon.workflow-provider-surface-runtime-owner/v1" as const,
    ownerId: digestClosedWorkflowSurfaceValue({ ownerSecret: secret.toString("hex") }),
  })
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-workflow-surface-owner-"))
  const stateWithoutSources = Object.freeze({ secret, artifactRoot, config: normalizedConfig })
  OWNER_STATES.set(token, stateWithoutSources)
  const sourceRefs = Object.freeze({
    actorSnapshotRef: writeArtifact(token, actorSnapshot),
    conversationSnapshotRef: writeArtifact(token, conversationSnapshot),
    resourcePackageRef: writeArtifact(token, resourcePackage),
    toolProfileRef: writeArtifact(token, toolProfile),
    strategyRegistryRef: writeArtifact(token, strategyRegistry),
  })
  OWNER_STATES.set(token, Object.freeze({ ...stateWithoutSources, sourceRefs }))
  configureRuntimePersistenceSupport({
    snapshotRepositoryFactory: LocalFileRuntimeSnapshotRepositoryFactory,
    derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore,
    conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
  })
  return token
}

function readClosedSourceAuthority(runtime: WorkflowSurfaceExperimentRuntime): ClosedWorkflowSurfaceSourceAuthority {
  const refs = requireOwner(runtime).sourceRefs
  if (!refs) throw new Error("WORKFLOW_SURFACE_RUNTIME_INVALID: frozen source authority is unavailable")
  const actor = normalizeActorSnapshot(readArtifact(runtime, refs.actorSnapshotRef))
  const conversation = normalizeConversationSnapshot(readArtifact(runtime, refs.conversationSnapshotRef))
  const resourcePackage = normalizeResourcePackage(readArtifact(runtime, refs.resourcePackageRef))
  const toolProfile = readArtifact<ClosedWorkflowSurfaceSourceAuthority["toolProfile"]>(runtime, refs.toolProfileRef)
  exactOwnDataObject(toolProfile, [
    "profileId", "profileRevision", "admittedNames", "admittedNamesDigest", "schemaDigest",
  ], "toolProfile")
  exactStringArray(toolProfile.admittedNames, "toolProfile.admittedNames")
  if (toolProfile.profileId !== WORKFLOW_LIFECYCLE_TOOL_PROFILE_ID
    || toolProfile.profileRevision !== WORKFLOW_LIFECYCLE_TOOL_PROFILE_REVISION
    || !/^sha256:[a-f0-9]{64}$/.test(toolProfile.admittedNamesDigest)
    || !/^sha256:[a-f0-9]{64}$/.test(toolProfile.schemaDigest)) {
    throw new Error("WORKFLOW_SURFACE_EVIDENCE_INVALID: tool profile artifact is invalid")
  }
  const actualRegistry = strategyRegistryAuthority()
  const strategyRegistry = readArtifact<ClosedWorkflowSurfaceSourceAuthority["strategyRegistry"]>(
    runtime,
    refs.strategyRegistryRef,
  )
  if (digestClosedWorkflowSurfaceValue(strategyRegistry) !== digestClosedWorkflowSurfaceValue(actualRegistry)) {
    throw new Error("WORKFLOW_SURFACE_EVIDENCE_INVALID: strategy registry artifact differs from actual frozen policy bytes")
  }
  const state = requireOwner(runtime)
  if (digestClosedWorkflowSurfaceValue(toolProfile) !== state.config.lifecycleToolProfileDigest
    || resourcePackage.digest !== state.config.lifecycleResourcePackageDigest) {
    throw new Error("WORKFLOW_SURFACE_EVIDENCE_INVALID: source authority differs from admitted runtime config")
  }
  return {
    actor,
    conversation,
    resourcePackage,
    toolProfile,
    strategyRegistry,
  }
}

function sourceAuthority(runtime: WorkflowSurfaceExperimentRuntime) {
  const authority = readClosedSourceAuthority(runtime)
  return {
    ...authority,
    actorDigest: digestClosedWorkflowSurfaceValue(authority.actor),
    conversationDigest: digestClosedWorkflowSurfaceValue(authority.conversation),
    sourceSnapshotDigest: digestClosedWorkflowSurfaceValue({
      actor: authority.actor,
      conversation: authority.conversation,
    }),
  }
}

export async function runClosedWorkflowSurfaceExperiment(input: {
  input: ClosedWorkflowSurfaceExperimentInput
  runtime: WorkflowSurfaceExperimentRuntime
}): Promise<WorkflowSurfaceRawExperimentReport> {
  exactOwnDataObject(input, ["input", "runtime"], "runInput")
  exactOwnDataObject(input.runtime, ["schemaVersion", "ownerId"], "runtimeCapability")
  exactOwnDataObject(input.input, [
    "schemaVersion", "frozenActorSnapshotDigest", "frozenConversationSnapshotDigest",
    "lifecycleToolProfileDigest", "lifecycleResourcePackageDigest", "providerProfileId", "model",
    "strategySetDigest", "journey", "priceWeights", "cloneRule", "inputDigest",
  ], "experimentInput")
  const authority = validateClosedWorkflowSurfaceExperimentInput(input.input)
  const ownerState = requireOwner(input.runtime)
  if (ownerState.config.providerProfileId !== authority.providerProfileId
    || ownerState.config.model !== authority.model
    || ownerState.config.lifecycleToolProfileDigest !== authority.lifecycleToolProfileDigest
    || ownerState.config.lifecycleResourcePackageDigest !== authority.lifecycleResourcePackageDigest) {
    throw new Error("WORKFLOW_SURFACE_RUNTIME_INVALID: runtime config differs from frozen experiment input")
  }
  const source = sourceAuthority(input.runtime)
  if (source.actorDigest !== authority.frozenActorSnapshotDigest
    || source.conversationDigest !== authority.frozenConversationSnapshotDigest) {
    throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: frozen source ref digest mismatch")
  }
  const candidates: WorkflowSurfaceRawCandidateObservation[] = []
  for (const strategyRevision of WORKFLOW_SURFACE_STRATEGY_REVISIONS) {
    const cloneInstanceDigest = digestClosedWorkflowSurfaceValue({
      sourceSnapshotDigest: source.sourceSnapshotDigest,
      strategyRevision,
      cloneOrdinal: candidates.length,
    })
    const evidenceRef = await executeFixedCandidate(input.runtime, {
      authority,
      strategyRevision,
      sourceSnapshotDigest: source.sourceSnapshotDigest,
      cloneInstanceDigest,
    })
    candidates.push(Object.freeze({
      strategyRevision,
      strategyDigest: WORKFLOW_SURFACE_STRATEGY_REGISTRY.resolve(strategyRevision).strategyDigest,
      sourceSnapshotDigest: source.sourceSnapshotDigest,
      cloneInstanceDigest,
      evidenceRef,
    }))
  }
  const unsigned = {
    schemaVersion: "eidolon.workflow-provider-surface-raw-report/v2" as const,
    experimentInputDigest: authority.inputDigest,
    strategySetDigest: authority.strategySetDigest,
    sourceSnapshotDigest: source.sourceSnapshotDigest,
    ownerId: input.runtime.ownerId,
    sourceActorRef: ownerState.sourceRefs!.actorSnapshotRef,
    sourceConversationRef: ownerState.sourceRefs!.conversationSnapshotRef,
    resourcePackageRef: ownerState.sourceRefs!.resourcePackageRef,
    toolProfileRef: ownerState.sourceRefs!.toolProfileRef,
    strategyRegistryRef: ownerState.sourceRefs!.strategyRegistryRef,
    candidates: Object.freeze(candidates),
  }
  // A receipt is issued only after the owner has reread every referenced byte
  // and the execution/recovery provenance closure from its private store.
  for (const candidate of candidates) verifyCandidateArtifactClosure(input.runtime, candidate.evidenceRef)
  const ownerReceipt = issueOwnerReceipt(input.runtime, unsigned)
  const signed = { ...unsigned, ownerReceipt }
  return deepFreeze({ ...signed, reportDigest: digestClosedWorkflowSurfaceValue(signed) })
}

function finalWire(runtime: WorkflowSurfaceExperimentRuntime, ref: WorkflowSurfaceEvidenceRef): string {
  const artifact = readArtifact<FinalWireArtifact>(runtime, ref)
  exactObjectKeys(artifact, ["schemaVersion", "body"], "finalWireArtifact")
  if (artifact.schemaVersion !== "eidolon.workflow-provider-final-wire/v1" || typeof artifact.body !== "string") {
    throw new Error("WORKFLOW_SURFACE_EVIDENCE_INVALID: final wire artifact is invalid")
  }
  return artifact.body
}

function schemaName(schema: unknown): string {
  const fn = schema && typeof schema === "object" && !Array.isArray(schema)
    ? (schema as any).function
    : undefined
  if (!fn || typeof fn !== "object" || typeof fn.name !== "string") {
    throw new Error("WORKFLOW_SURFACE_EVIDENCE_INVALID: final wire tool schema is invalid")
  }
  return fn.name
}

function validateSerializedSurface(serialized: string, expectedNames: readonly string[]): void {
  const body = JSON.parse(serialized)
  if (!Array.isArray(body?.messages) || !Array.isArray(body?.tools)) {
    throw new Error("WORKFLOW_SURFACE_EVIDENCE_INVALID: final wire lacks messages/tools")
  }
  const actual = body.tools.map(schemaName)
  const expected = [...expectedNames].sort(compareCodeUnits)
  if (!exactArray(actual, expected)) {
    throw new Error(`WORKFLOW_SURFACE_EVIDENCE_INVALID: tool surface differs from frozen projector actual=${actual.join(",")} expected=${expected.join(",")}`)
  }
}

function evaluateCandidate(
  runtime: WorkflowSurfaceExperimentRuntime,
  report: WorkflowSurfaceRawExperimentReport,
  candidate: WorkflowSurfaceRawCandidateObservation,
): WorkflowSurfaceStrategySelectionCandidate {
  exactObjectKeys(candidate, [
    "strategyRevision", "strategyDigest", "sourceSnapshotDigest", "cloneInstanceDigest", "evidenceRef",
  ], `candidate ${String((candidate as any).strategyRevision)}`)
  const strategy = WORKFLOW_SURFACE_STRATEGY_REGISTRY.resolve(candidate.strategyRevision)
  if (candidate.strategyDigest !== strategy.strategyDigest || candidate.sourceSnapshotDigest !== report.sourceSnapshotDigest) {
    throw new Error("WORKFLOW_SURFACE_RAW_REPORT_INVALID: candidate authority mismatch")
  }
  const evidence = readArtifact<CandidateEvidenceArtifact>(runtime, candidate.evidenceRef)
  const source = sourceAuthority(runtime)
  exactObjectKeys(evidence, [
    "schemaVersion", "strategyRevision", "sourceSnapshotDigest", "cloneInstanceDigest",
    "loadedActorSnapshotDigest", "loadedConversationSnapshotDigest", "recoveredActorSnapshotDigest",
    "recoveredConversationSnapshotDigest", "requestEvidenceRefs", "recoveryEvidenceRef",
  ], "candidateEvidence")
  if (evidence.schemaVersion !== "eidolon.workflow-provider-candidate-evidence/v1"
    || evidence.strategyRevision !== candidate.strategyRevision
    || evidence.sourceSnapshotDigest !== candidate.sourceSnapshotDigest
    || evidence.cloneInstanceDigest !== candidate.cloneInstanceDigest
    || evidence.loadedActorSnapshotDigest !== source.actorDigest
    || evidence.loadedConversationSnapshotDigest !== source.conversationDigest
    || evidence.requestEvidenceRefs.length !== WORKFLOW_SURFACE_EXPERIMENT_STAGES.length * 2 + 1
    || evidence.loadedActorSnapshotDigest !== evidence.recoveredActorSnapshotDigest
    || evidence.loadedConversationSnapshotDigest !== evidence.recoveredConversationSnapshotDigest) {
    throw new Error("WORKFLOW_SURFACE_EVIDENCE_INVALID: candidate durable readback differs")
  }
  const rejectionReasons = new Set<string>()
  let normalizedJourneyCost = 0
  let toolSelectionErrors = 0
  let surfaceEpochCount = 0
  let expectedEpoch = 0
  let priorSurfaceDigest: string | undefined
  let priorProviderSurfaceDigest: string | undefined
  let priorProviderReceiptDigest: string | undefined
  let terminalToolRecordDigest: Sha256 | undefined
  let priorObservation: ReturnType<typeof createProviderCacheCostObservation> | undefined
  evidence.requestEvidenceRefs.forEach((requestRef, index) => {
    const request = readArtifact<RequestEvidenceArtifact>(runtime, requestRef)
    exactObjectKeys(request, [
      "schemaVersion", "sessionId", "actorKey", "actorId", "finalWireRef", "transportAttemptRefs",
      "requestAdmission", "providerEpochReceipt", "toolCallRecord", "providerUsage",
    ], `requestEvidence/${index + 1}`)
    if (request.schemaVersion !== "eidolon.workflow-provider-request-evidence/v1") {
      throw new Error("WORKFLOW_SURFACE_EVIDENCE_INVALID: request evidence schema")
    }
    const isTerminal = index === WORKFLOW_SURFACE_EXPERIMENT_STAGES.length * 2
    const stage = isTerminal
      ? WORKFLOW_SURFACE_EXPERIMENT_STAGES.at(-1)!
      : WORKFLOW_SURFACE_EXPERIMENT_STAGES[Math.floor(index / 2)]!
    const turn = isTerminal
      ? "terminal-forward" as const
      : index % 2 === 0 ? "stage-entry" as const : "same-stage-forward" as const
    const projection = projectWorkflowProviderSurface({ strategyRevision: candidate.strategyRevision, stage })
    const surfaceChanged = projection.surfaceDigest !== priorSurfaceDigest
    if (index === 0 || (turn === "stage-entry" && surfaceChanged)) {
      expectedEpoch += 1
      surfaceEpochCount += 1
    }
    const expectedReason = index === 0
      ? "initial_projection"
      : turn === "stage-entry" && surfaceChanged
        ? "provider_surface_revision_accepted"
        : "same_epoch_forward"
    const receipt = request.providerEpochReceipt as any
    const providerSurfaceDigest = receipt?.providerSurfaceDigest
    const expectedProviderSurfaceDigest = digestProviderContextClosedValue({
      mode: "exact",
      toolNames: projection.toolNames,
    })
    const providerSurfaceRelationshipInvalid = index > 0 && (
      (surfaceChanged && providerSurfaceDigest === priorProviderSurfaceDigest)
      || (!surfaceChanged && providerSurfaceDigest !== priorProviderSurfaceDigest)
    )
    const beginsEpoch = index === 0 || (turn === "stage-entry" && surfaceChanged)
    const receiptReasonInvalid = beginsEpoch
      ? receipt?.reason !== expectedReason
      : receipt?.receiptDigest !== priorProviderReceiptDigest
    if (receipt?.epoch !== expectedEpoch || receiptReasonInvalid
      || typeof providerSurfaceDigest !== "string"
      || !/^sha256:[a-f0-9]{64}$/.test(providerSurfaceDigest)
      || providerSurfaceDigest !== expectedProviderSurfaceDigest
      || providerSurfaceRelationshipInvalid) {
      rejectionReasons.add("epoch_contract")
    }
    try {
      const { schemaVersion, receiptDigest, ...receiptInput } = receipt ?? {}
      const recreated = createProviderEpochReceiptV2(receiptInput as any)
      if (schemaVersion !== "provider.epoch-receipt/v2" || recreated.receiptDigest !== receiptDigest) {
        rejectionReasons.add("epoch_contract")
      }
    } catch {
      rejectionReasons.add("epoch_contract")
    }
    const body = finalWire(runtime, request.finalWireRef)
    validateSerializedSurface(body, projection.toolNames)
    const attempts = request.transportAttemptRefs.map((ref) => finalWire(runtime, ref))
    if (attempts.length < 1 || attempts.some((attempt) => attempt !== body)) {
      rejectionReasons.add("retry_wire_mismatch")
    }
    if (stage === "testing" && turn === "stage-entry" && attempts.length !== 2) {
      rejectionReasons.add("retry_wire_mismatch")
    }
    const estimates = estimateFinalWireProviderCacheCostTokens(body)
    const observation = createProviderCacheCostObservation({
      identity: {
        schemaVersion: 1,
        providerId: "workflow-surface-experiment",
        providerProfile: "deepseek_compatible",
        providerProfileId: "deepseek-compatible-chat@1",
        model: "deepseek-chat",
        actorClass: "workflow_lifecycle",
        contextEpoch: expectedEpoch,
      },
      serializedRequestBody: body,
      tokenEstimates: estimates,
      priceWeights: CLOSED_WORKFLOW_SURFACE_EXPERIMENT.priceWeights,
    })
    const sameEpoch = Boolean(priorObservation && expectedReason === "same_epoch_forward")
    const comparison = priorObservation && sameEpoch
      ? compareProviderCacheCostObservations(priorObservation, observation)
      : undefined
    if (comparison && comparison.retainedPrefixIntegrity !== 1) rejectionReasons.add("same_epoch_prefix_divergence")
    const hit = comparison
      ? Math.min(priorObservation!.tokenBreakdown.finalWireInputTokens, estimates.finalWireInputTokens)
      : 0
    const miss = Math.max(0, estimates.finalWireInputTokens - hit)
    normalizedJourneyCost += hit * CLOSED_WORKFLOW_SURFACE_EXPERIMENT.priceWeights.cacheHitWeight
      + miss * CLOSED_WORKFLOW_SURFACE_EXPERIMENT.priceWeights.cacheMissWeight
    if (estimates.toolSurfaceTokens > 18_079) rejectionReasons.add("product_tool_ceiling")
    if (estimates.workflowControlTokens > 10_626) rejectionReasons.add("product_control_ceiling")
    if (isTerminal) {
      if (request.toolCallRecord !== null) rejectionReasons.add("terminal_tool_effect_unexpected")
    } else {
      const record = request.toolCallRecord as any
      const requiredTool = REQUIRED_TOOL_BY_EXPERIMENT_STAGE[stage]
      if (record?.status !== "completed" || record?.funcName !== requiredTool
        || !projection.toolNames.includes(requiredTool)
        || !AI_WORKFLOW_STAGE_TOOL_POLICY[stage].includes(requiredTool as never)
        || !/^sha256:[a-f0-9]{64}$/.test(digestToolCallRecord(record))) {
        toolSelectionErrors += 1
        rejectionReasons.add("required_tool_unavailable")
      }
      terminalToolRecordDigest = digestToolCallRecord(record)
    }
    priorObservation = observation
    priorSurfaceDigest = projection.surfaceDigest
    priorProviderSurfaceDigest = providerSurfaceDigest
    priorProviderReceiptDigest = receipt?.receiptDigest
  })
  const recovery = readArtifact<RecoveryEvidenceArtifact>(runtime, evidence.recoveryEvidenceRef)
  exactObjectKeys(recovery, [
    "schemaVersion", "recoveredRuntimeInstanceDigest", "recoveryRequestEvidenceRef",
    "recoveredFacetRef", "recoveredActorReceipt", "recoveredFacetReceipt",
    "recoveredConversationReceipt", "recoveredProviderEpochReceipt",
    "recoveredTerminalToolCallRecord", "receiptDigest",
  ], "freshRecoveryEvidence")
  const { receiptDigest: recoveryReceiptDigest, ...recoveryReceiptBody } = recovery
  if (recovery.schemaVersion !== "eidolon.workflow-provider-fresh-recovery-evidence/v1"
    || recoveryReceiptDigest !== digestClosedWorkflowSurfaceValue(recoveryReceiptBody)
    || !/^sha256:[a-f0-9]{64}$/.test(recovery.recoveredRuntimeInstanceDigest)) {
    throw new Error("WORKFLOW_SURFACE_EVIDENCE_INVALID: fresh recovery receipt mismatch")
  }
  const recoveryRequest = readArtifact<RequestEvidenceArtifact>(runtime, recovery.recoveryRequestEvidenceRef)
  exactObjectKeys(recoveryRequest, [
    "schemaVersion", "sessionId", "actorKey", "actorId", "finalWireRef", "transportAttemptRefs",
    "requestAdmission", "providerEpochReceipt", "toolCallRecord", "providerUsage",
  ], "freshRecoveryRequest")
  const recoveryContinuationBody = finalWire(runtime, recoveryRequest.finalWireRef)
  const finalStage = WORKFLOW_SURFACE_EXPERIMENT_STAGES[WORKFLOW_SURFACE_EXPERIMENT_STAGES.length - 1]!
  const finalProjection = projectWorkflowProviderSurface({ strategyRevision: candidate.strategyRevision, stage: finalStage })
  validateSerializedSurface(recoveryContinuationBody, finalProjection.toolNames)
  const recoveryAttempts = recoveryRequest.transportAttemptRefs.map((ref) => finalWire(runtime, ref))
  if (recoveryRequest.schemaVersion !== "eidolon.workflow-provider-request-evidence/v1"
    || recoveryRequest.toolCallRecord !== null
    || recoveryAttempts.length !== 1
    || recoveryAttempts[0] !== recoveryContinuationBody) {
    rejectionReasons.add("recovery_mismatch")
  }
  const recoveryObservation = createProviderCacheCostObservation({
    identity: {
      schemaVersion: 1,
      providerId: "workflow-surface-experiment-recovery",
      providerProfile: "deepseek_compatible",
      providerProfileId: "deepseek-compatible-chat@1",
      model: "deepseek-chat",
      actorClass: "workflow_lifecycle",
      contextEpoch: Number((recoveryRequest.providerEpochReceipt as any)?.epoch),
    },
    serializedRequestBody: recoveryContinuationBody,
    tokenEstimates: estimateFinalWireProviderCacheCostTokens(recoveryContinuationBody),
    usage: {
      promptTokens: recoveryRequest.providerUsage.cacheHitTokens + recoveryRequest.providerUsage.cacheMissTokens,
      completionTokens: 4,
      cacheHitTokens: recoveryRequest.providerUsage.cacheHitTokens,
      cacheMissTokens: recoveryRequest.providerUsage.cacheMissTokens,
    },
    priceWeights: CLOSED_WORKFLOW_SURFACE_EXPERIMENT.priceWeights,
  })
  if ((recoveryRequest.requestAdmission as any)?.finalRequestDigest !== recoveryObservation.requestDigest
    || recoveryObservation.tokenBreakdown.normalizedInputCost !== recoveryRequest.providerUsage.normalizedInputCost) {
    rejectionReasons.add("recovery_mismatch")
  }
  const recoveredFacetReceipt = recovery.recoveredFacetReceipt as any
  const recoveredFacet = readArtifact<ReturnType<typeof readWorkflowLifecycleFacet>>(
    runtime,
    recovery.recoveredFacetRef,
  )
  const managedSkill = source.resourcePackage.resources["sys-eidolon-anchor-devops/SKILL.md"]
  const managedSkillDigest = managedSkill
    ? `sha256:${createHash("sha256").update(managedSkill).digest("hex")}`
    : undefined
  if (!recoveredFacet
    || recoveredFacetReceipt?.facetDigest !== digestClosedWorkflowSurfaceValue(recoveredFacet)
    || recoveredFacet.resourcePackage.packageDigest !== source.resourcePackage.digest
    || recoveredFacet.resourcePackage.revision !== source.resourcePackage.revision
    || recoveredFacet.resourcePackage.materialDigest
      !== createWorkflowLifecycleResourcePackageMaterial(source.resourcePackage).digest
    || recoveredFacet.systemSkill.materialDigest !== managedSkillDigest
    || recoveredFacet.toolProfile.profileId !== source.toolProfile.profileId
    || recoveredFacet.toolProfile.profileRevision !== source.toolProfile.profileRevision
    || recoveredFacet.toolProfile.admittedNamesDigest !== source.toolProfile.admittedNamesDigest
    || recoveredFacet.providerSurfaceStrategy.strategyRevision !== candidate.strategyRevision
    || recoveredFacet.providerSurfaceStrategy.strategyDigest !== strategy.strategyDigest
    || recoveredFacet.stageId !== finalStage) {
    rejectionReasons.add("recovery_mismatch")
  }
  if (recoveredFacetReceipt?.strategyRevision !== candidate.strategyRevision
    || recoveredFacetReceipt?.strategyDigest !== strategy.strategyDigest
    || recoveredFacetReceipt?.stageId !== finalStage
    || !/^sha256:[a-f0-9]{64}$/.test(recoveredFacetReceipt?.facetDigest)) {
    rejectionReasons.add("recovery_mismatch")
  }
  const recoveredActorReceipt = recovery.recoveredActorReceipt as any
  const recoveredConversationReceipt = recovery.recoveredConversationReceipt as any
  if (!recoveredActorReceipt?.actorKey || !recoveredActorReceipt?.actorId
    || !/^sha256:[a-f0-9]{64}$/.test(recoveredActorReceipt?.messagesDigest)
    || !/^sha256:[a-f0-9]{64}$/.test(recoveredActorReceipt?.systemPromptsDigest)
    || !/^sha256:[a-f0-9]{64}$/.test(recoveredActorReceipt?.toolPolicyDigest)
    || recoveredConversationReceipt?.actorKey !== recoveredActorReceipt.actorKey
    || !/^sha256:[a-f0-9]{64}$/.test(recoveredConversationReceipt?.sessionBindingDigest)) {
    rejectionReasons.add("recovery_mismatch")
  }
  try {
    const recoveredEpoch = recovery.recoveredProviderEpochReceipt as any
    const { schemaVersion, receiptDigest, ...receiptInput } = recoveredEpoch ?? {}
    const recreated = createProviderEpochReceiptV2(receiptInput as any)
    if (schemaVersion !== "provider.epoch-receipt/v2" || recreated.receiptDigest !== receiptDigest
      || recoveredEpoch.actorKey !== recoveredActorReceipt.actorKey
      || recoveredEpoch.providerSurfaceDigest !== priorProviderSurfaceDigest
      || recoveredEpoch.receiptDigest !== (recoveryRequest.providerEpochReceipt as any)?.receiptDigest) {
      rejectionReasons.add("recovery_mismatch")
    }
  } catch {
    rejectionReasons.add("recovery_mismatch")
  }
  const recoveredTerminalDigest = digestToolCallRecord(recovery.recoveredTerminalToolCallRecord as any)
  if (recoveredTerminalDigest !== terminalToolRecordDigest
    || (recovery.recoveredTerminalToolCallRecord as any)?.status !== "completed") {
    rejectionReasons.add("recovery_mismatch")
  }
  return Object.freeze({
    strategyRevision: candidate.strategyRevision,
    eligible: rejectionReasons.size === 0,
    rejectionReasons: Object.freeze([...rejectionReasons].sort(compareCodeUnits)),
    normalizedJourneyCost,
    toolSelectionErrors,
    surfaceEpochCount,
  })
}

export function selectWorkflowSurfaceStrategy(
  value: unknown,
  runtime: WorkflowSurfaceExperimentRuntime,
): WorkflowSurfaceStrategySelection {
  exactOwnDataObject(runtime, ["schemaVersion", "ownerId"], "runtimeCapability")
  requireOwner(runtime)
  exactOwnDataObject(value, [
    "schemaVersion", "experimentInputDigest", "strategySetDigest", "sourceSnapshotDigest",
    "ownerId", "sourceActorRef", "sourceConversationRef", "resourcePackageRef", "toolProfileRef",
    "strategyRegistryRef", "candidates", "ownerReceipt", "reportDigest",
  ], "report")
  const report = value as WorkflowSurfaceRawExperimentReport
  if (report.schemaVersion !== "eidolon.workflow-provider-surface-raw-report/v2"
    || report.strategySetDigest !== CLOSED_WORKFLOW_SURFACE_EXPERIMENT.strategySetDigest
    || report.ownerId !== runtime.ownerId) {
    throw new Error("WORKFLOW_SURFACE_RAW_REPORT_INVALID: authority mismatch")
  }
  const { reportDigest, ...signed } = report
  if (reportDigest !== digestClosedWorkflowSurfaceValue(signed)) {
    throw new Error("WORKFLOW_SURFACE_RAW_REPORT_INVALID: immutable report digest mismatch")
  }
  const { ownerReceipt, ...unsigned } = signed
  if (!verifyOwnerReceipt(runtime, unsigned, ownerReceipt)) {
    throw new Error("WORKFLOW_SURFACE_RAW_REPORT_INVALID: runtime owner receipt mismatch")
  }
  const state = requireOwner(runtime)
  const refs = state.sourceRefs
  if (!refs
    || digestClosedWorkflowSurfaceValue(report.sourceActorRef) !== digestClosedWorkflowSurfaceValue(refs.actorSnapshotRef)
    || digestClosedWorkflowSurfaceValue(report.sourceConversationRef) !== digestClosedWorkflowSurfaceValue(refs.conversationSnapshotRef)
    || digestClosedWorkflowSurfaceValue(report.resourcePackageRef) !== digestClosedWorkflowSurfaceValue(refs.resourcePackageRef)
    || digestClosedWorkflowSurfaceValue(report.toolProfileRef) !== digestClosedWorkflowSurfaceValue(refs.toolProfileRef)
    || digestClosedWorkflowSurfaceValue(report.strategyRegistryRef) !== digestClosedWorkflowSurfaceValue(refs.strategyRegistryRef)) {
    throw new Error("WORKFLOW_SURFACE_RAW_REPORT_INVALID: source authority refs differ from runtime owner closure")
  }
  const source = sourceAuthority(runtime)
  if (source.sourceSnapshotDigest !== report.sourceSnapshotDigest
    || source.resourcePackage.digest !== state.config.lifecycleResourcePackageDigest
    || digestClosedWorkflowSurfaceValue(source.toolProfile) !== state.config.lifecycleToolProfileDigest
    || source.strategyRegistry.registryDigest !== report.strategySetDigest) {
    throw new Error("WORKFLOW_SURFACE_RAW_REPORT_INVALID: source/package/profile/strategy authority chain mismatch")
  }
  if (!Array.isArray(report.candidates) || report.candidates.length !== WORKFLOW_SURFACE_STRATEGY_REVISIONS.length) {
    throw new Error("WORKFLOW_SURFACE_RAW_REPORT_INVALID: exact candidate set is required")
  }
  const revisions = report.candidates.map((candidate) => candidate.strategyRevision).sort(compareCodeUnits)
  if (!exactArray(revisions, WORKFLOW_SURFACE_STRATEGY_REVISIONS)) {
    throw new Error("WORKFLOW_SURFACE_RAW_REPORT_INVALID: candidate revisions differ from frozen set")
  }
  if (new Set(report.candidates.map((candidate) => candidate.cloneInstanceDigest)).size !== report.candidates.length) {
    throw new Error("WORKFLOW_SURFACE_RAW_REPORT_INVALID: independent clone identity is invalid")
  }
  const ranking = report.candidates.map((candidate) => evaluateCandidate(runtime, report, candidate)).sort((left, right) => {
    if (left.eligible !== right.eligible) return left.eligible ? -1 : 1
    if (left.normalizedJourneyCost !== right.normalizedJourneyCost) return left.normalizedJourneyCost - right.normalizedJourneyCost
    if (left.toolSelectionErrors !== right.toolSelectionErrors) return left.toolSelectionErrors - right.toolSelectionErrors
    if (left.surfaceEpochCount !== right.surfaceEpochCount) return left.surfaceEpochCount - right.surfaceEpochCount
    return compareCodeUnits(left.strategyRevision, right.strategyRevision)
  })
  const selected = ranking.find((candidate) => candidate.eligible)
  if (!selected) {
    throw new Error(`WORKFLOW_SURFACE_SELECTION_FAILED: no correct candidate ${JSON.stringify(ranking)}`)
  }
  const selectedStrategy = WORKFLOW_SURFACE_STRATEGY_REGISTRY.resolve(selected.strategyRevision)
  const result = {
    schemaVersion: "eidolon.workflow-provider-surface-selection/v1" as const,
    rawReportDigest: report.reportDigest,
    selectorRevision: "lowest-correct-normalized-cost/v1" as const,
    selectedStrategyRevision: selected.strategyRevision,
    selectedStrategyDigest: selectedStrategy.strategyDigest,
    ranking: Object.freeze(ranking),
  }
  return deepFreeze({ ...result, selectionDigest: digestClosedWorkflowSurfaceValue(result) })
}

/**
 * Data-only canonical read port for the already owner-verified selected
 * product journey. It exposes no artifact writer, owner token, signing key or
 * receipt issuance capability; every call re-runs the private selector and
 * content-addressed artifact closure verification first.
 */
export function readVerifiedWorkflowSurfaceProductJourney(input: Readonly<{
  runtime: WorkflowSurfaceExperimentRuntime
  report: WorkflowSurfaceRawExperimentReport
  selection: WorkflowSurfaceStrategySelection
}>): VerifiedWorkflowSurfaceProductJourney {
  const recomputed = selectWorkflowSurfaceStrategy(input.report, input.runtime)
  if (recomputed.selectionDigest !== input.selection.selectionDigest
    || recomputed.selectedStrategyRevision !== "stable-superset/v1") {
    throw new Error("WORKFLOW_SURFACE_EVIDENCE_INVALID: selected journey authority changed before readback")
  }
  const candidate = input.report.candidates.find((entry) => (
    entry.strategyRevision === recomputed.selectedStrategyRevision
  ))
  if (!candidate) throw new Error("WORKFLOW_SURFACE_EVIDENCE_INVALID: selected candidate disappeared")
  verifyCandidateArtifactClosure(input.runtime, candidate.evidenceRef)
  const evidence = readArtifact<CandidateEvidenceArtifact>(input.runtime, candidate.evidenceRef)
  const requests = evidence.requestEvidenceRefs.map((requestRef, index) => {
    const request = readArtifact<RequestEvidenceArtifact>(input.runtime, requestRef)
    const finalWire = readArtifact<FinalWireArtifact>(input.runtime, request.finalWireRef)
    const attemptBodies = request.transportAttemptRefs.map((ref) => (
      readArtifact<FinalWireArtifact>(input.runtime, ref).body
    ))
    return Object.freeze({
      callOrdinal: index + 1,
      finalWireBody: finalWire.body,
      attemptBodies: Object.freeze(attemptBodies),
      requestAdmission: request.requestAdmission,
      providerEpochReceipt: request.providerEpochReceipt,
      toolCallRecord: request.toolCallRecord,
      providerUsage: request.providerUsage,
    })
  })
  if (requests.length !== WORKFLOW_SURFACE_EXPERIMENT_STAGES.length * 2 + 1) {
    throw new Error("WORKFLOW_SURFACE_EVIDENCE_INVALID: exact selected request set is incomplete")
  }
  const first = readArtifact<RequestEvidenceArtifact>(input.runtime, evidence.requestEvidenceRefs[0]!)
  if (evidence.requestEvidenceRefs.some((ref) => {
    const request = readArtifact<RequestEvidenceArtifact>(input.runtime, ref)
    return request.sessionId !== first.sessionId || request.actorKey !== first.actorKey || request.actorId !== first.actorId
  })) {
    throw new Error("WORKFLOW_SURFACE_EVIDENCE_INVALID: selected request identity is not one Actor journey")
  }
  const recovery = readArtifact<RecoveryEvidenceArtifact>(input.runtime, evidence.recoveryEvidenceRef)
  const recoveryRequest = readArtifact<RequestEvidenceArtifact>(input.runtime, recovery.recoveryRequestEvidenceRef)
  const recoveryFinalWire = readArtifact<FinalWireArtifact>(input.runtime, recoveryRequest.finalWireRef)
  const recoveryAttemptBodies = recoveryRequest.transportAttemptRefs.map((ref) => (
    readArtifact<FinalWireArtifact>(input.runtime, ref).body
  ))
  return Object.freeze({
    schemaVersion: "eidolon.workflow-surface-product-journey/v1",
    strategyRevision: "stable-superset/v1",
    strategyDigest: recomputed.selectedStrategyDigest,
    sessionId: first.sessionId,
    actorKey: first.actorKey,
    actorId: first.actorId,
    requests: Object.freeze(requests),
    recoveryRequest: Object.freeze({
      callOrdinal: 1 as const,
      finalWireBody: recoveryFinalWire.body,
      attemptBodies: Object.freeze(recoveryAttemptBodies),
      requestAdmission: recoveryRequest.requestAdmission,
      providerEpochReceipt: recoveryRequest.providerEpochReceipt,
      toolCallRecord: null,
      providerUsage: recoveryRequest.providerUsage,
    }),
    recoveryReceiptDigest: recovery.receiptDigest,
    freshRecoveryVerified: true,
  })
}
