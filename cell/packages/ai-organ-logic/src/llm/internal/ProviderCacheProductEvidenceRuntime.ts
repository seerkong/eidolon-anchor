import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import { freezeAiWorkflowResourcePackage, installBundledSystemSkills } from "@cell/ai-support"
import { getConversationActorRawStateFromVm } from "../../conversation/ConversationDomainRuntime"

import {
  PROVIDER_CACHE_PRODUCT_PRODUCTION_SCENARIOS,
  openVerifiedProductChild,
  runClosedProviderCacheProductScenario,
  type OpenedVerifiedProductChild,
} from "./ProviderCacheProductRuntime"
import {
  WORKFLOW_SURFACE_EXPERIMENT_STAGES,
  WORKFLOW_SURFACE_STRATEGY_REGISTRY,
  createClosedWorkflowSurfaceExperimentInput,
  digestClosedWorkflowSurfaceValue,
  type WorkflowSurfaceStrategySelection,
} from "../../workflow/runtime/WorkflowProviderSurfaceStrategy"
import {
  createLocalWorkflowSurfaceExperimentRuntime,
  readVerifiedWorkflowSurfaceProductJourney,
  runClosedWorkflowSurfaceExperiment,
  selectWorkflowSurfaceStrategy,
  type VerifiedWorkflowSurfaceProductJourney,
} from "../../workflow/runtime/WorkflowProviderSurfaceExperimentRuntime"
import { WORKFLOW_LIFECYCLE_TOOL_PROFILE } from "../../workflow/tools"

type ProviderCacheProductProductionScenarioId = typeof PROVIDER_CACHE_PRODUCT_PRODUCTION_SCENARIOS[number]

// Lexically private product-evidence authority. No owner, repository, ref,
// signing or verification capability is exported from an importable module.

// Package-internal authority. Public callers enter through ProviderCacheProductMatrix.

type ProviderCacheProductActorClass = "ordinary" | "workflow_lifecycle" | "workflow_ctrl_node" | "workflow_data_node"
type ProviderCacheProductProfileId = "deepseek-chat@1"
type ProviderCacheProductEpochReason =
  | "initial_projection"
  | "provider_model_profile_switch"
  | "history_compaction"
  | "history_rewind_or_fork"
  | "frozen_resource_revision_accepted"
  | "provider_surface_revision_accepted"
  | "legacy_context_import"
  | "recovery_rebuild"

type ProviderCacheProductScenarioManifest = Readonly<{
  schemaVersion: "eidolon.provider-cache-product-scenario/v1"
  scenarioId: string
  revision: `sha256:${string}`
  actorClass: ProviderCacheProductActorClass
  productEntry: string
  providerProfileId: ProviderCacheProductProfileId
  model: string
  strategyProofDigest: `sha256:${string}`
  steps: readonly Readonly<{
    stepId: string
    kind: "provider_turn" | "tool_turn" | "transition" | "recovery" | "retry"
  }>[]
  expectedEpochReasons: readonly ProviderCacheProductEpochReason[]
  bounds: Readonly<{
    retainedMessages: number
    actorCount: number
    sessionCount: number
  }>
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

type ProviderCacheProductEvidenceRef = Readonly<{
  schemaVersion: "eidolon.provider-cache-product-evidence-ref/v1"
  ownerId: `sha256:${string}`
  kind: ProviderCacheProductSourceKind
  sourceId: string
  sourceDigest: `sha256:${string}`
}>

interface ProviderCacheProductEvidenceOwner {
  readonly schemaVersion: "eidolon.provider-cache-product-evidence-owner/v1"
  readonly ownerId: `sha256:${string}`
}

interface ProviderCacheProductSourceRepository {
  read(kind: ProviderCacheProductSourceKind, sourceId: string): ProviderCacheProductSourceRecord
}

type ProviderCacheProductJourneyReceipt = Readonly<{
  schemaVersion: "eidolon.provider-cache-product-journey-receipt/v1"
  scenarioId: string
  scenarioRevision: `sha256:${string}`
  ownerId: `sha256:${string}`
  sessionId: string
  actorKey: string
  actorId: string
  scenarioRef: ProviderCacheProductEvidenceRef
  calls: readonly Readonly<{
    providerCallId: string
    callOrdinal: number
    attemptOrdinals: readonly number[]
    sourceRefs: readonly ProviderCacheProductEvidenceRef[]
  }>[]
  journeySourceRefs: readonly ProviderCacheProductEvidenceRef[]
  closureDigest: `sha256:${string}`
  seal: `hmac-sha256:${string}`
}>

type OwnerState = Readonly<{
  secret: Buffer
  repository: ProviderCacheProductSourceRepository
}>

const OWNER_STATES = new WeakMap<object, OwnerState>()
const SHA256 = /^sha256:[a-f0-9]{64}$/
const HMAC_SHA256 = /^hmac-sha256:[a-f0-9]{64}$/
const ACTOR_CLASSES = new Set<ProviderCacheProductActorClass>([
  "ordinary", "workflow_lifecycle", "workflow_ctrl_node", "workflow_data_node",
])
const PROFILES = new Set<ProviderCacheProductProfileId>([
  "deepseek-chat@1",
])
const REASONS = new Set<ProviderCacheProductEpochReason>([
  "initial_projection", "provider_model_profile_switch", "history_compaction", "history_rewind_or_fork",
  "frozen_resource_revision_accepted", "provider_surface_revision_accepted", "legacy_context_import", "recovery_rebuild",
])
const SOURCE_KINDS = new Set<ProviderCacheProductSourceKind>([
  "scenario", "actor", "session", "strategy_proof", "frozen_resource", "request_admission", "final_wire",
  "provider_epoch", "tool_effect", "transport_attempt", "final_success_usage",
])
const CALL_REQUIRED_KINDS = [
  "request_admission", "final_wire", "provider_epoch", "transport_attempt", "final_success_usage",
] as const

export const PROVIDER_CACHE_PRODUCT_EPOCH_REASON_MATRIX = Object.freeze({
  "epoch.initial-projection/v1": "initial_projection",
  "epoch.provider-model-profile/v1": "provider_model_profile_switch",
  "epoch.compaction/v1": "history_compaction",
  "epoch.rewind-fork/v1": "history_rewind_or_fork",
  "epoch.resource-revision/v1": "frozen_resource_revision_accepted",
  "epoch.surface-revision/v1": "provider_surface_revision_accepted",
  "epoch.legacy-import-rebuild/v1": "legacy_context_import",
  "epoch.recovery-rebuild/v1": "recovery_rebuild",
  "epoch.reset/v1": null,
} satisfies Readonly<Record<string, ProviderCacheProductEpochReason | null>>)

class ProviderCacheProductEvidenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = "ProviderCacheProductEvidenceError"
  }
}

function fail(code: string, message: string): never {
  throw new ProviderCacheProductEvidenceError(code, message)
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function exactKeys(value: object, expected: readonly string[], field: string): void {
  const actual = Reflect.ownKeys(value)
  if (actual.some((key) => typeof key === "symbol")) fail("PRODUCT_EVIDENCE_SHAPE_INVALID", `${field} has symbol fields`)
  const strings = (actual as string[]).sort(compareCodeUnits)
  const wanted = [...expected].sort(compareCodeUnits)
  if (strings.length !== wanted.length || strings.some((key, index) => key !== wanted[index])) {
    fail("PRODUCT_EVIDENCE_SHAPE_INVALID", `${field} has an unknown or missing field`)
  }
}

function cloneClosed(value: unknown, field: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("PRODUCT_EVIDENCE_CLOSED_VALUE_INVALID", `${field} is not finite`)
    return value
  }
  if (typeof value !== "object") fail("PRODUCT_EVIDENCE_CLOSED_VALUE_INVALID", `${field} is not closed own-data`)
  const prototype = Object.getPrototypeOf(value)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")) {
    fail("PRODUCT_EVIDENCE_CLOSED_VALUE_INVALID", `${field} has symbol fields`)
  }
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) fail("PRODUCT_EVIDENCE_CLOSED_VALUE_INVALID", `${field} has a custom prototype`)
    const keys = Reflect.ownKeys(descriptors).filter((key) => key !== "length")
    const wanted = Array.from({ length: value.length }, (_, index) => String(index))
    if (keys.length !== wanted.length || wanted.some((key) => !keys.includes(key))) {
      fail("PRODUCT_EVIDENCE_CLOSED_VALUE_INVALID", `${field} must be a dense non-sparse array`)
    }
    return Object.freeze(wanted.map((key) => {
      const descriptor = descriptors[key]!
      if (!("value" in descriptor) || !descriptor.enumerable) {
        return fail("PRODUCT_EVIDENCE_CLOSED_VALUE_INVALID", `${field}[${key}] is not enumerable own-data`)
      }
      return cloneClosed(descriptor.value, `${field}[${key}]`)
    }))
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail("PRODUCT_EVIDENCE_CLOSED_VALUE_INVALID", `${field} has a custom prototype`)
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(descriptors).sort(compareCodeUnits)) {
    const descriptor = descriptors[key]!
    if (!("value" in descriptor) || !descriptor.enumerable) {
      fail("PRODUCT_EVIDENCE_CLOSED_VALUE_INVALID", `${field}.${key} is not enumerable own-data`)
    }
    result[key] = cloneClosed(descriptor.value, `${field}.${key}`)
  }
  return Object.freeze(result)
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort(compareCodeUnits).map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`
}

function digestProviderCacheProductClosedValue(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(cloneClosed(value, "value")), "utf8").digest("hex")}`
}

function exactText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail("PRODUCT_EVIDENCE_SHAPE_INVALID", `${field} must be exact non-empty text`)
  }
  return value
}

function exactInteger(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    fail("PRODUCT_EVIDENCE_SHAPE_INVALID", `${field} must be a safe integer >= ${minimum}`)
  }
  return Number(value)
}

function exactDigest(value: unknown, field: string): `sha256:${string}` {
  if (typeof value !== "string" || !SHA256.test(value)) fail("PRODUCT_EVIDENCE_SHAPE_INVALID", `${field} must be sha256`)
  return value as `sha256:${string}`
}

function assertScenarioInput(value: unknown): asserts value is Omit<ProviderCacheProductScenarioManifest, "schemaVersion" | "revision"> {
  cloneClosed(value, "scenario")
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("PRODUCT_EVIDENCE_SHAPE_INVALID", "scenario must be an object")
  exactKeys(value, [
    "actorClass", "bounds", "expectedEpochReasons", "model", "productEntry", "providerProfileId", "scenarioId",
    "steps", "strategyProofDigest",
  ], "scenario")
  const record = value as Record<string, unknown>
  exactText(record.scenarioId, "scenarioId")
  exactText(record.productEntry, "productEntry")
  exactText(record.model, "model")
  if (!ACTOR_CLASSES.has(record.actorClass as ProviderCacheProductActorClass)) fail("PRODUCT_EVIDENCE_SHAPE_INVALID", "actorClass is invalid")
  if (!PROFILES.has(record.providerProfileId as ProviderCacheProductProfileId)) fail("PRODUCT_EVIDENCE_SHAPE_INVALID", "providerProfileId is invalid")
  exactDigest(record.strategyProofDigest, "strategyProofDigest")
  if (!Array.isArray(record.steps) || record.steps.length === 0) fail("PRODUCT_EVIDENCE_SHAPE_INVALID", "steps must be non-empty")
  const stepIds = new Set<string>()
  record.steps.forEach((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) fail("PRODUCT_EVIDENCE_SHAPE_INVALID", `steps[${index}] must be an object`)
    exactKeys(step, ["kind", "stepId"], `steps[${index}]`)
    const stepRecord = step as Record<string, unknown>
    const stepId = exactText(stepRecord.stepId, `steps[${index}].stepId`)
    if (stepIds.has(stepId)) fail("PRODUCT_EVIDENCE_SHAPE_INVALID", "step ids must be unique")
    stepIds.add(stepId)
    if (!["provider_turn", "tool_turn", "transition", "recovery", "retry"].includes(String(stepRecord.kind))) {
      fail("PRODUCT_EVIDENCE_SHAPE_INVALID", `steps[${index}].kind is invalid`)
    }
  })
  if (!Array.isArray(record.expectedEpochReasons) || record.expectedEpochReasons.length === 0) {
    fail("PRODUCT_EVIDENCE_SHAPE_INVALID", "expectedEpochReasons must be non-empty")
  }
  record.expectedEpochReasons.forEach((reason) => {
    if (!REASONS.has(reason as ProviderCacheProductEpochReason)) fail("PRODUCT_EVIDENCE_SHAPE_INVALID", "epoch reason is invalid")
  })
  if (!record.bounds || typeof record.bounds !== "object" || Array.isArray(record.bounds)) fail("PRODUCT_EVIDENCE_SHAPE_INVALID", "bounds is invalid")
  exactKeys(record.bounds, ["actorCount", "retainedMessages", "sessionCount"], "bounds")
  const bounds = record.bounds as Record<string, unknown>
  exactInteger(bounds.retainedMessages, "bounds.retainedMessages")
  exactInteger(bounds.actorCount, "bounds.actorCount", 1)
  exactInteger(bounds.sessionCount, "bounds.sessionCount", 1)
}

function createProviderCacheProductScenarioManifest(
  input: Omit<ProviderCacheProductScenarioManifest, "schemaVersion" | "revision">,
): ProviderCacheProductScenarioManifest {
  assertScenarioInput(input)
  const facts = cloneClosed({
    schemaVersion: "eidolon.provider-cache-product-scenario/v1" as const,
    ...input,
  }, "scenarioFacts") as Omit<ProviderCacheProductScenarioManifest, "revision">
  return cloneClosed({
    ...facts,
    revision: digestProviderCacheProductClosedValue(facts),
  }, "scenarioManifest") as ProviderCacheProductScenarioManifest
}

function requireOwner(owner: ProviderCacheProductEvidenceOwner): OwnerState {
  const state = OWNER_STATES.get(owner as object)
  if (!state) fail("PRODUCT_EVIDENCE_OWNER_REQUIRED", "an admitted opaque evidence owner is required")
  return state
}

function createProviderCacheProductEvidenceOwner(
  repository: ProviderCacheProductSourceRepository,
): ProviderCacheProductEvidenceOwner {
  cloneClosed(Object.keys(repository), "repositorySurface")
  if (!repository || typeof repository.read !== "function") fail("PRODUCT_EVIDENCE_OWNER_INVALID", "repository read port is required")
  const secret = randomBytes(32)
  const owner = Object.freeze(Object.seal({
    schemaVersion: "eidolon.provider-cache-product-evidence-owner/v1" as const,
    ownerId: `sha256:${createHash("sha256").update(secret).digest("hex")}` as const,
  }))
  OWNER_STATES.set(owner, Object.freeze({ secret, repository }))
  return owner
}

function validateSourceRecord(value: unknown, expectedKind: ProviderCacheProductSourceKind, expectedId: string): ProviderCacheProductSourceRecord {
  cloneClosed(value, "source")
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("PRODUCT_EVIDENCE_SOURCE_INVALID", "source must be an object")
  exactKeys(value, ["facts", "identity", "kind", "schemaVersion", "sourceId"], "source")
  const source = value as ProviderCacheProductSourceRecord
  if (source.schemaVersion !== "eidolon.provider-cache-product-source/v1" || source.kind !== expectedKind || source.sourceId !== expectedId) {
    fail("PRODUCT_EVIDENCE_SOURCE_INVALID", "source identity does not match its requested reference")
  }
  if (!SOURCE_KINDS.has(source.kind)) fail("PRODUCT_EVIDENCE_SOURCE_INVALID", "source kind is invalid")
  exactText(source.sourceId, "sourceId")
  if (!source.identity || typeof source.identity !== "object" || Array.isArray(source.identity)) fail("PRODUCT_EVIDENCE_SOURCE_INVALID", "source identity is invalid")
  exactKeys(source.identity, ["actorId", "actorKey", "attemptOrdinal", "callOrdinal", "providerCallId", "sessionId"], "source.identity")
  exactText(source.identity.sessionId, "source.identity.sessionId")
  exactText(source.identity.actorKey, "source.identity.actorKey")
  exactText(source.identity.actorId, "source.identity.actorId")
  const isJourney = source.kind === "scenario" || source.kind === "actor" || source.kind === "session" || source.kind === "strategy_proof" || source.kind === "frozen_resource"
  if (isJourney) {
    if (source.identity.providerCallId !== null || source.identity.callOrdinal !== null || source.identity.attemptOrdinal !== null) {
      fail("PRODUCT_EVIDENCE_SOURCE_INVALID", "journey source must not claim a provider call")
    }
  } else {
    exactText(source.identity.providerCallId, "source.identity.providerCallId")
    exactInteger(source.identity.callOrdinal, "source.identity.callOrdinal", 1)
    if (source.kind === "transport_attempt") exactInteger(source.identity.attemptOrdinal, "source.identity.attemptOrdinal", 1)
    else if (source.identity.attemptOrdinal !== null) fail("PRODUCT_EVIDENCE_SOURCE_INVALID", "only transport attempts have attempt ordinals")
  }
  return source
}

function readSource(owner: ProviderCacheProductEvidenceOwner, kind: ProviderCacheProductSourceKind, sourceId: string): ProviderCacheProductSourceRecord {
  const state = requireOwner(owner)
  return validateSourceRecord(state.repository.read(kind, sourceId), kind, sourceId)
}

function createProviderCacheProductEvidenceRef(
  owner: ProviderCacheProductEvidenceOwner,
  kind: ProviderCacheProductSourceKind,
  sourceId: string,
): ProviderCacheProductEvidenceRef {
  if (!SOURCE_KINDS.has(kind)) fail("PRODUCT_EVIDENCE_SOURCE_INVALID", "source kind is invalid")
  exactText(sourceId, "sourceId")
  const source = readSource(owner, kind, sourceId)
  return Object.freeze({
    schemaVersion: "eidolon.provider-cache-product-evidence-ref/v1" as const,
    ownerId: owner.ownerId,
    kind,
    sourceId,
    sourceDigest: digestProviderCacheProductClosedValue(source),
  })
}

function validateRef(owner: ProviderCacheProductEvidenceOwner, value: unknown): ProviderCacheProductEvidenceRef {
  cloneClosed(value, "evidenceRef")
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("PRODUCT_EVIDENCE_REF_INVALID", "evidence ref must be an object")
  exactKeys(value, ["kind", "ownerId", "schemaVersion", "sourceDigest", "sourceId"], "evidenceRef")
  const ref = value as ProviderCacheProductEvidenceRef
  if (ref.schemaVersion !== "eidolon.provider-cache-product-evidence-ref/v1" || ref.ownerId !== owner.ownerId) {
    fail("PRODUCT_EVIDENCE_OWNER_MISMATCH", "evidence ref owner mismatch")
  }
  if (!SOURCE_KINDS.has(ref.kind)) fail("PRODUCT_EVIDENCE_REF_INVALID", "evidence ref kind is invalid")
  exactText(ref.sourceId, "evidenceRef.sourceId")
  exactDigest(ref.sourceDigest, "evidenceRef.sourceDigest")
  const source = readSource(owner, ref.kind, ref.sourceId)
  if (digestProviderCacheProductClosedValue(source) !== ref.sourceDigest) {
    fail("PRODUCT_EVIDENCE_SOURCE_DIGEST_MISMATCH", `source digest changed for ${ref.kind}/${ref.sourceId}`)
  }
  return ref
}

function compareRefs(left: ProviderCacheProductEvidenceRef, right: ProviderCacheProductEvidenceRef): number {
  return compareCodeUnits(`${left.kind}\0${left.sourceId}`, `${right.kind}\0${right.sourceId}`)
}

function createClosure(
  owner: ProviderCacheProductEvidenceOwner,
  input: Readonly<{ scenarioRef: ProviderCacheProductEvidenceRef; sourceRefs: readonly ProviderCacheProductEvidenceRef[] }>,
) {
  exactKeys(input as object, ["scenarioRef", "sourceRefs"], "receiptInput")
  const scenarioRef = validateRef(owner, input.scenarioRef)
  if (scenarioRef.kind !== "scenario") fail("PRODUCT_EVIDENCE_SCENARIO_INVALID", "scenarioRef must reference scenario authority")
  if (!Array.isArray(input.sourceRefs)) fail("PRODUCT_EVIDENCE_REF_INVALID", "sourceRefs must be an array")
  const sourceRefs = input.sourceRefs.map((ref) => validateRef(owner, ref)).sort(compareRefs)
  if (new Set(sourceRefs.map((ref) => `${ref.kind}\0${ref.sourceId}`)).size !== sourceRefs.length) {
    fail("PRODUCT_EVIDENCE_DUPLICATE_SOURCE", "duplicate evidence refs are forbidden")
  }
  if (sourceRefs.some((ref) => ref.kind === "scenario")) fail("PRODUCT_EVIDENCE_SCENARIO_INVALID", "scenario source may occur only once")
  const scenarioSource = readSource(owner, scenarioRef.kind, scenarioRef.sourceId)
  const manifest = scenarioSource.facts as ProviderCacheProductScenarioManifest
  if (!manifest || typeof manifest !== "object" || manifest.schemaVersion !== "eidolon.provider-cache-product-scenario/v1") {
    fail("PRODUCT_EVIDENCE_SCENARIO_INVALID", "scenario source does not contain the canonical manifest")
  }
  const { revision, ...manifestFacts } = manifest
  if (digestProviderCacheProductClosedValue(manifestFacts) !== revision) fail("PRODUCT_EVIDENCE_SCENARIO_INVALID", "scenario revision is not canonical")
  const allSources = sourceRefs.map((ref) => readSource(owner, ref.kind, ref.sourceId))
  if (!sourceRefs.some((ref) => ref.kind === "actor") || !sourceRefs.some((ref) => ref.kind === "session") || !sourceRefs.some((ref) => ref.kind === "strategy_proof")) {
    fail("PRODUCT_EVIDENCE_CLOSURE_INCOMPLETE", "actor, session and strategy proof sources are required")
  }
  const identities = [scenarioSource, ...allSources].map((source) => source.identity)
  const first = identities[0]!
  if (identities.some((identity) => identity.sessionId !== first.sessionId || identity.actorKey !== first.actorKey || identity.actorId !== first.actorId)) {
    fail("PRODUCT_EVIDENCE_IDENTITY_MISMATCH", "cross-session or cross-Actor source substitution is forbidden")
  }
  const strategy = allSources.find((source) => source.kind === "strategy_proof")!
  if ((strategy.facts as Record<string, unknown>)?.strategyProofDigest !== manifest.strategyProofDigest) {
    fail("PRODUCT_EVIDENCE_STRATEGY_MISMATCH", "scenario strategy proof does not match the admitted source")
  }
  const byCall = new Map<number, ProviderCacheProductSourceRecord[]>()
  for (const source of allSources) {
    if (source.identity.callOrdinal === null) continue
    const existing = byCall.get(source.identity.callOrdinal) ?? []
    existing.push(source)
    byCall.set(source.identity.callOrdinal, existing)
  }
  if (byCall.size === 0) fail("PRODUCT_EVIDENCE_CLOSURE_INCOMPLETE", "at least one provider call is required")
  const calls = [...byCall.entries()].sort((left, right) => left[0] - right[0]).map(([callOrdinal, sources], index) => {
    if (callOrdinal !== index + 1) fail("PRODUCT_EVIDENCE_CALL_ORDER_INVALID", "provider call ordinals must be contiguous")
    const providerCallId = sources[0]!.identity.providerCallId!
    if (sources.some((source) => source.identity.providerCallId !== providerCallId)) {
      fail("PRODUCT_EVIDENCE_IDENTITY_MISMATCH", "provider call identity substitution is forbidden")
    }
    for (const kind of CALL_REQUIRED_KINDS) {
      const count = sources.filter((source) => source.kind === kind).length
      if (kind === "transport_attempt" ? count < 1 : count !== 1) {
        fail("PRODUCT_EVIDENCE_CLOSURE_INCOMPLETE", `provider call ${callOrdinal} requires exact ${kind} authority`)
      }
    }
    const attempts = sources.filter((source) => source.kind === "transport_attempt")
      .map((source) => source.identity.attemptOrdinal!)
      .sort((left, right) => left - right)
    if (new Set(attempts).size !== attempts.length || attempts.some((ordinal, ordinalIndex) => ordinal !== ordinalIndex + 1)) {
      fail("PRODUCT_EVIDENCE_ATTEMPT_ORDER_INVALID", "transport attempt ordinals must be unique and contiguous")
    }
    const refs = sourceRefs.filter((ref) => {
      const source = readSource(owner, ref.kind, ref.sourceId)
      return source.identity.callOrdinal === callOrdinal
    }).sort(compareRefs)
    return Object.freeze({ providerCallId, callOrdinal, attemptOrdinals: Object.freeze(attempts), sourceRefs: Object.freeze(refs) })
  })
  const journeySourceRefs = sourceRefs.filter((ref) => readSource(owner, ref.kind, ref.sourceId).identity.callOrdinal === null)
  return Object.freeze({
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.revision,
    ownerId: owner.ownerId,
    sessionId: first.sessionId,
    actorKey: first.actorKey,
    actorId: first.actorId,
    scenarioRef,
    calls: Object.freeze(calls),
    journeySourceRefs: Object.freeze(journeySourceRefs),
  })
}

function issueProviderCacheProductJourneyReceipt(
  owner: ProviderCacheProductEvidenceOwner,
  input: Readonly<{ scenarioRef: ProviderCacheProductEvidenceRef; sourceRefs: readonly ProviderCacheProductEvidenceRef[] }>,
): ProviderCacheProductJourneyReceipt {
  const state = requireOwner(owner)
  const closure = createClosure(owner, input)
  const closureDigest = digestProviderCacheProductClosedValue(closure)
  const unsigned = Object.freeze({
    schemaVersion: "eidolon.provider-cache-product-journey-receipt/v1" as const,
    ...closure,
    closureDigest,
  })
  const seal = `hmac-sha256:${createHmac("sha256", state.secret).update(canonical(unsigned), "utf8").digest("hex")}` as const
  return cloneClosed({ ...unsigned, seal }, "journeyReceipt") as ProviderCacheProductJourneyReceipt
}

function assertReceiptShape(value: unknown): asserts value is ProviderCacheProductJourneyReceipt {
  cloneClosed(value, "receipt")
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("PRODUCT_EVIDENCE_RECEIPT_INVALID", "receipt must be an object")
  exactKeys(value, [
    "actorId", "actorKey", "calls", "closureDigest", "journeySourceRefs", "ownerId", "scenarioId", "scenarioRef",
    "scenarioRevision", "schemaVersion", "seal", "sessionId",
  ], "receipt")
  const receipt = value as ProviderCacheProductJourneyReceipt
  if (receipt.schemaVersion !== "eidolon.provider-cache-product-journey-receipt/v1") fail("PRODUCT_EVIDENCE_RECEIPT_INVALID", "receipt version is invalid")
  exactText(receipt.scenarioId, "receipt.scenarioId")
  exactDigest(receipt.scenarioRevision, "receipt.scenarioRevision")
  exactDigest(receipt.ownerId, "receipt.ownerId")
  exactText(receipt.sessionId, "receipt.sessionId")
  exactText(receipt.actorKey, "receipt.actorKey")
  exactText(receipt.actorId, "receipt.actorId")
  exactDigest(receipt.closureDigest, "receipt.closureDigest")
  if (typeof receipt.seal !== "string" || !HMAC_SHA256.test(receipt.seal)) fail("PRODUCT_EVIDENCE_RECEIPT_INVALID", "receipt seal is invalid")
  if (!Array.isArray(receipt.calls) || !Array.isArray(receipt.journeySourceRefs)) fail("PRODUCT_EVIDENCE_RECEIPT_INVALID", "receipt refs are invalid")
  receipt.calls.forEach((call, index) => {
    exactKeys(call, ["attemptOrdinals", "callOrdinal", "providerCallId", "sourceRefs"], `receipt.calls[${index}]`)
    exactText(call.providerCallId, `receipt.calls[${index}].providerCallId`)
    exactInteger(call.callOrdinal, `receipt.calls[${index}].callOrdinal`, 1)
    if (!Array.isArray(call.attemptOrdinals) || !Array.isArray(call.sourceRefs)) fail("PRODUCT_EVIDENCE_RECEIPT_INVALID", "call arrays are invalid")
  })
}

function verifyProviderCacheProductJourney(
  owner: ProviderCacheProductEvidenceOwner,
  receipt: ProviderCacheProductJourneyReceipt,
): Readonly<{ verified: true; closureDigest: `sha256:${string}` }> {
  const state = requireOwner(owner)
  assertReceiptShape(receipt)
  if (receipt.ownerId !== owner.ownerId) fail("PRODUCT_EVIDENCE_OWNER_MISMATCH", "receipt owner mismatch")
  const sourceRefs = [...receipt.journeySourceRefs, ...receipt.calls.flatMap((call) => call.sourceRefs)]
  const recomputed = createClosure(owner, { scenarioRef: receipt.scenarioRef, sourceRefs })
  const suppliedClosure = {
    scenarioId: receipt.scenarioId,
    scenarioRevision: receipt.scenarioRevision,
    ownerId: receipt.ownerId,
    sessionId: receipt.sessionId,
    actorKey: receipt.actorKey,
    actorId: receipt.actorId,
    scenarioRef: receipt.scenarioRef,
    calls: receipt.calls,
    journeySourceRefs: receipt.journeySourceRefs,
  }
  if (canonical(cloneClosed(suppliedClosure, "receiptClosure")) !== canonical(recomputed)) {
    fail("PRODUCT_EVIDENCE_CLOSURE_MISMATCH", "receipt closure has been tampered")
  }
  const recomputedDigest = digestProviderCacheProductClosedValue(recomputed)
  if (recomputedDigest !== receipt.closureDigest) fail("PRODUCT_EVIDENCE_CLOSURE_MISMATCH", "receipt closure has been tampered")
  const unsigned = Object.freeze({
    schemaVersion: receipt.schemaVersion,
    ...recomputed,
    closureDigest: receipt.closureDigest,
  })
  const expected = `hmac-sha256:${createHmac("sha256", state.secret).update(canonical(unsigned), "utf8").digest("hex")}`
  if (expected.length !== receipt.seal.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(receipt.seal))) {
    fail("PRODUCT_EVIDENCE_SEAL_MISMATCH", "receipt HMAC seal is invalid")
  }
  return Object.freeze({ verified: true as const, closureDigest: receipt.closureDigest })
}

type CacheUnit = Readonly<{
  kind: string
  ordinal: number
  byteLength: number
  digest: `sha256:${string}`
}>

type ProviderCacheProductJourneyResult = Readonly<{
  schemaVersion: "eidolon.provider-cache-product-journey-result/v1"
  scenarioId: string
  scenarioRevision: `sha256:${string}`
  ownerId: `sha256:${string}`
  receiptClosureDigest: `sha256:${string}`
  structuralStatus: "PASS"
  calls: readonly Readonly<{
    providerCallId: string
    callOrdinal: number
    epoch: number
    epochReason: ProviderCacheProductEpochReason
    epochReceiptDigest: `sha256:${string}`
    requestDigest: `sha256:${string}`
    admissionDigest: `sha256:${string}`
    previousAdmissionDigest: `sha256:${string}` | null
    retryBodyIdentical: true
    finalSuccessUsageRows: 1
  }>[]
  comparisons: readonly Readonly<{
    previousCallOrdinal: number
    currentCallOrdinal: number
    sameEpoch: boolean
    retainedPrefixIntegrity: number
    firstDivergence: number | null
    localAttribution: "same_epoch_exact" | ProviderCacheProductEpochReason
  }>[]
  providerAggregate: Readonly<{
    cacheHitTokens: number
    cacheMissTokens: number
    normalizedInputCost: number
  }>
}>

function exactRecord(value: unknown, expected: readonly string[], field: string): Record<string, unknown> {
  cloneClosed(value, field)
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("PRODUCT_EVIDENCE_FACT_INVALID", `${field} must be an object`)
  exactKeys(value, expected, field)
  return value as Record<string, unknown>
}

function parseCacheUnits(value: unknown, field: string): readonly CacheUnit[] {
  if (!Array.isArray(value)) fail("PRODUCT_EVIDENCE_FACT_INVALID", `${field} must be an array`)
  return Object.freeze(value.map((entry, index) => {
    const record = exactRecord(entry, ["byteLength", "digest", "kind", "ordinal"], `${field}[${index}]`)
    const ordinal = exactInteger(record.ordinal, `${field}[${index}].ordinal`)
    if (ordinal !== index) fail("PRODUCT_EVIDENCE_FACT_INVALID", `${field} ordinals must be contiguous`)
    return Object.freeze({
      kind: exactText(record.kind, `${field}[${index}].kind`),
      ordinal,
      byteLength: exactInteger(record.byteLength, `${field}[${index}].byteLength`),
      digest: exactDigest(record.digest, `${field}[${index}].digest`),
    })
  }))
}

function exactUnit(left: CacheUnit, right: CacheUnit): boolean {
  return left.kind === right.kind && left.ordinal === right.ordinal && left.byteLength === right.byteLength && left.digest === right.digest
}

function reduceProviderCacheProductJourney(
  owner: ProviderCacheProductEvidenceOwner,
  receipt: ProviderCacheProductJourneyReceipt,
  externalBoundary: Readonly<{
    externalPredecessorAdmissionDigest: `sha256:${string}`
    externalEpochReceiptDigest: `sha256:${string}`
  }> | null = null,
): ProviderCacheProductJourneyResult {
  verifyProviderCacheProductJourney(owner, receipt)
  const scenarioSource = readSource(owner, receipt.scenarioRef.kind, receipt.scenarioRef.sourceId)
  const manifest = scenarioSource.facts as ProviderCacheProductScenarioManifest
  const expectedReasons = new Set(manifest.expectedEpochReasons)
  const seenEffects = new Set<string>()
  const parsed = receipt.calls.map((call) => {
    const sources = call.sourceRefs.map((ref) => readSource(owner, ref.kind, ref.sourceId))
    const one = (kind: ProviderCacheProductSourceKind) => sources.find((source) => source.kind === kind)!
    const wire = exactRecord(one("final_wire").facts, ["cacheUnits", "requestDigest"], `call.${call.callOrdinal}.finalWire`)
    const requestDigest = exactDigest(wire.requestDigest, `call.${call.callOrdinal}.requestDigest`)
    const cacheUnits = parseCacheUnits(wire.cacheUnits, `call.${call.callOrdinal}.cacheUnits`)
    const admission = exactRecord(one("request_admission").facts, [
      "admissionDigest", "finalRequestDigest", "historyFrontierDigest", "previousAdmissionDigest",
    ], `call.${call.callOrdinal}.admission`)
    const admissionDigest = exactDigest(admission.admissionDigest, `call.${call.callOrdinal}.admissionDigest`)
    const previousAdmissionDigest = admission.previousAdmissionDigest === null
      ? null
      : exactDigest(admission.previousAdmissionDigest, `call.${call.callOrdinal}.previousAdmissionDigest`)
    if (admission.finalRequestDigest !== requestDigest) fail("PRODUCT_EVIDENCE_ADMISSION_MISMATCH", "request admission does not bind final wire")
    const historyFrontierDigest = exactDigest(admission.historyFrontierDigest, `call.${call.callOrdinal}.historyFrontierDigest`)
    const epoch = exactRecord(one("provider_epoch").facts, [
      "epoch", "predecessorFrontierDigest", "previousReceiptDigest", "reason", "receiptDigest", "sourceFrontierDigest",
    ], `call.${call.callOrdinal}.epoch`)
    const epochNumber = exactInteger(epoch.epoch, `call.${call.callOrdinal}.epoch`, 1)
    const epochReason = epoch.reason as ProviderCacheProductEpochReason
    if (!REASONS.has(epochReason) || !expectedReasons.has(epochReason)) {
      fail("PRODUCT_EVIDENCE_EPOCH_REASON_INVALID", `call ${call.callOrdinal} has an unplanned epoch reason`)
    }
    const epochReceiptDigest = exactDigest(epoch.receiptDigest, `call.${call.callOrdinal}.epochReceiptDigest`)
    const previousEpochReceiptDigest = epoch.previousReceiptDigest === null
      ? null
      : exactDigest(epoch.previousReceiptDigest, `call.${call.callOrdinal}.previousEpochReceiptDigest`)
    const predecessorFrontierDigest = epoch.predecessorFrontierDigest === null
      ? null
      : exactDigest(epoch.predecessorFrontierDigest, `call.${call.callOrdinal}.predecessorFrontierDigest`)
    const epochFrontierDigest = exactDigest(epoch.sourceFrontierDigest, `call.${call.callOrdinal}.sourceFrontierDigest`)
    const attempts = sources.filter((source) => source.kind === "transport_attempt").sort((left, right) => left.identity.attemptOrdinal! - right.identity.attemptOrdinal!)
    const bodyDigests = attempts.map((attempt, index) => {
      const hasGlobalOrdinal = Boolean(attempt.facts && typeof attempt.facts === "object"
        && Object.prototype.hasOwnProperty.call(attempt.facts, "globalOrdinal"))
      const facts = exactRecord(attempt.facts, hasGlobalOrdinal
        ? ["bodyDigest", "globalOrdinal", "status"]
        : ["bodyDigest", "status"], `call.${call.callOrdinal}.attempt.${index + 1}`)
      if (hasGlobalOrdinal && facts.globalOrdinal !== null) {
        exactInteger(facts.globalOrdinal, `call.${call.callOrdinal}.attempt.${index + 1}.globalOrdinal`, 1)
      }
      const status = facts.status
      if (status !== (index === attempts.length - 1 ? "final_success" : "failed_retryable")) {
        fail("PRODUCT_EVIDENCE_ATTEMPT_STATUS_INVALID", "only the last transport attempt may be final success")
      }
      return exactDigest(facts.bodyDigest, `call.${call.callOrdinal}.attempt.${index + 1}.bodyDigest`)
    })
    if (bodyDigests.some((digest) => digest !== requestDigest)) fail("PRODUCT_EVIDENCE_RETRY_BODY_MISMATCH", "retry bodies must be byte-identical to the admitted final wire")
    const usage = exactRecord(one("final_success_usage").facts, [
      "cacheHitTokens", "cacheMissTokens", "normalizedInputCost", "status", "usageDigest",
    ], `call.${call.callOrdinal}.usage`)
    if (usage.status !== "final_success") fail("PRODUCT_EVIDENCE_USAGE_INVALID", "usage must belong to final success")
    exactDigest(usage.usageDigest, `call.${call.callOrdinal}.usageDigest`)
    const cacheHitTokens = exactInteger(usage.cacheHitTokens, `call.${call.callOrdinal}.cacheHitTokens`)
    const cacheMissTokens = exactInteger(usage.cacheMissTokens, `call.${call.callOrdinal}.cacheMissTokens`)
    if (typeof usage.normalizedInputCost !== "number" || !Number.isFinite(usage.normalizedInputCost) || usage.normalizedInputCost < 0) {
      fail("PRODUCT_EVIDENCE_USAGE_INVALID", "normalized input cost is invalid")
    }
    for (const effect of sources.filter((source) => source.kind === "tool_effect")) {
      const facts = exactRecord(effect.facts, ["effectDigest", "effectId", "status"], `call.${call.callOrdinal}.toolEffect`)
      const effectId = exactText(facts.effectId, "toolEffect.effectId")
      exactDigest(facts.effectDigest, "toolEffect.effectDigest")
      if (facts.status !== "completed" || seenEffects.has(effectId)) fail("PRODUCT_EVIDENCE_DUPLICATE_EFFECT", "tool effects must be unique terminal completions")
      seenEffects.add(effectId)
    }
    return Object.freeze({
      providerCallId: call.providerCallId,
      callOrdinal: call.callOrdinal,
      epoch: epochNumber,
      epochReason,
      epochReceiptDigest,
      previousEpochReceiptDigest,
      predecessorFrontierDigest,
      epochFrontierDigest,
      historyFrontierDigest,
      admissionDigest,
      previousAdmissionDigest,
      requestDigest,
      cacheUnits,
      retryBodyIdentical: true as const,
      finalSuccessUsageRows: 1 as const,
      cacheHitTokens,
      cacheMissTokens,
      normalizedInputCost: usage.normalizedInputCost,
    })
  })
  const comparisons = parsed.slice(1).map((current, index) => {
    const previous = parsed[index]!
    let lcp = 0
    while (lcp < previous.cacheUnits.length && lcp < current.cacheUnits.length && exactUnit(previous.cacheUnits[lcp]!, current.cacheUnits[lcp]!)) lcp += 1
    const retainedPrefixIntegrity = previous.cacheUnits.length === 0 ? 1 : lcp / previous.cacheUnits.length
    const firstDivergence = lcp === previous.cacheUnits.length ? null : lcp
    const sameEpoch = current.epochReceiptDigest === previous.epochReceiptDigest
    if (sameEpoch) {
      if (current.previousAdmissionDigest !== previous.admissionDigest) {
        fail(
          "PRODUCT_EVIDENCE_ADMISSION_CHAIN_INVALID",
          `same-epoch request admission predecessor chain is not exact (${previous.callOrdinal}->${current.callOrdinal}; expected ${previous.admissionDigest}, received ${current.previousAdmissionDigest})`,
        )
      }
      if (current.epoch !== previous.epoch || retainedPrefixIntegrity !== 1 || firstDivergence !== null) {
        fail("PRODUCT_EVIDENCE_SAME_EPOCH_DIVERGENCE", "same-epoch retained prefix must be exact")
      }
      return Object.freeze({
        previousCallOrdinal: previous.callOrdinal,
        currentCallOrdinal: current.callOrdinal,
        sameEpoch: true,
        retainedPrefixIntegrity,
        firstDivergence,
        localAttribution: "same_epoch_exact" as const,
      })
    }
    if (current.previousAdmissionDigest !== null) {
      fail("PRODUCT_EVIDENCE_ADMISSION_CHAIN_INVALID", "an epoch successor must start a new request admission chain")
    }
    if (firstDivergence === null) fail("PRODUCT_EVIDENCE_SPURIOUS_EPOCH", "an epoch successor requires a changed local prefix")
    if (current.epoch !== previous.epoch + 1
      || current.previousEpochReceiptDigest !== previous.epochReceiptDigest
      || current.predecessorFrontierDigest !== previous.historyFrontierDigest
      || current.epochReason === "initial_projection"
      || current.epochReason === "recovery_rebuild") {
      fail("PRODUCT_EVIDENCE_EPOCH_FRONTIER_MISMATCH", `changed local prefix lacks one exact canonical epoch successor/frontier: ${JSON.stringify({
        previousEpoch: previous.epoch,
        currentEpoch: current.epoch,
        previousReceipt: previous.epochReceiptDigest,
        currentPreviousReceipt: current.previousEpochReceiptDigest,
        previousFrontier: previous.historyFrontierDigest,
        currentPredecessorFrontier: current.predecessorFrontierDigest,
        currentFrontier: current.historyFrontierDigest,
        currentEpochFrontier: current.epochFrontierDigest,
        reason: current.epochReason,
      })}`)
    }
    return Object.freeze({
      previousCallOrdinal: previous.callOrdinal,
      currentCallOrdinal: current.callOrdinal,
      sameEpoch: false,
      retainedPrefixIntegrity,
      firstDivergence,
      localAttribution: current.epochReason,
    })
  })
  const first = parsed[0]!
  const legacyImportBoundary = manifest.scenarioId === "epoch.legacy-import-rebuild/v1"
    && first.epochReason === "legacy_context_import"
    && first.previousEpochReceiptDigest !== null
    && first.previousAdmissionDigest === null
  if (externalBoundary) {
    if (first.previousAdmissionDigest !== externalBoundary.externalPredecessorAdmissionDigest
      || first.epochReceiptDigest !== externalBoundary.externalEpochReceiptDigest) {
      fail("PRODUCT_EVIDENCE_EXTERNAL_BOUNDARY_INVALID", `recovery child does not continue the exact external admission/epoch boundary: ${JSON.stringify({
        expectedAdmission: externalBoundary.externalPredecessorAdmissionDigest,
        actualAdmission: first.previousAdmissionDigest,
        expectedEpoch: externalBoundary.externalEpochReceiptDigest,
        actualEpoch: first.epochReceiptDigest,
      })}`)
    }
  } else if (!legacyImportBoundary
    && (first.epochReason !== "initial_projection" || first.previousEpochReceiptDigest !== null || first.previousAdmissionDigest !== null)) {
    fail("PRODUCT_EVIDENCE_INITIAL_PROJECTION_INVALID", "first call must be the initial projection")
  }
  return cloneClosed({
    schemaVersion: "eidolon.provider-cache-product-journey-result/v1" as const,
    scenarioId: receipt.scenarioId,
    scenarioRevision: receipt.scenarioRevision,
    ownerId: receipt.ownerId,
    receiptClosureDigest: receipt.closureDigest,
    structuralStatus: "PASS" as const,
    calls: parsed.map((call) => ({
      providerCallId: call.providerCallId,
      callOrdinal: call.callOrdinal,
      epoch: call.epoch,
      epochReason: call.epochReason,
      epochReceiptDigest: call.epochReceiptDigest,
      requestDigest: call.requestDigest,
      admissionDigest: call.admissionDigest,
      previousAdmissionDigest: call.previousAdmissionDigest,
      retryBodyIdentical: call.retryBodyIdentical,
      finalSuccessUsageRows: call.finalSuccessUsageRows,
    })),
    comparisons,
    providerAggregate: {
      cacheHitTokens: parsed.reduce((sum, call) => sum + call.cacheHitTokens, 0),
      cacheMissTokens: parsed.reduce((sum, call) => sum + call.cacheMissTokens, 0),
      normalizedInputCost: parsed.reduce((sum, call) => sum + call.normalizedInputCost, 0),
    },
  }, "journeyResult") as ProviderCacheProductJourneyResult
}

export const PROVIDER_CACHE_PRODUCT_FROZEN_SCENARIO_IDS = Object.freeze([
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
  "workflow.complete-authoring-release/v1",
  "workflow.ctrl-node.stage-free/v1",
  "workflow.data-node.stage-free/v1",
  "workflow.lifecycle.stable-superset/v1",
] as const)

export type ProviderCacheProductMatrixJourney = Readonly<{
  scenarioId: typeof PROVIDER_CACHE_PRODUCT_FROZEN_SCENARIO_IDS[number]
  actorClass: "ordinary" | "workflow_lifecycle" | "ai_ctrl_node" | "ai_data_node"
  sessionId: string
  actorId: string
  epochReasons: readonly string[]
  normalizedInputCost: number | null
  cacheHitTokens: number | null
  cacheMissTokens: number | null
  provenance: "canonical_product_runtime"
  verified: true
  stepCount: number
  bounds: Readonly<{ retainedMessages: number; currentMessages: number; actorCount: number; sessionCount: number }>
  firstDivergence: string | null
  unexplainedLocalDivergences: number
  childReceiptCount: number
  providerCallCount: number
  recoveryStepCount: number
  compositeVerified: true
}>

export type ProviderCacheProductMatrixResult = Readonly<{
  schemaVersion: "eidolon.provider-cache-product-matrix/v1"
  structuralStatus: "PASS"
  unexplainedLocalDivergences: 0
  scenarioIds: typeof PROVIDER_CACHE_PRODUCT_FROZEN_SCENARIO_IDS
  journeys: readonly ProviderCacheProductMatrixJourney[]
  actorClasses: readonly ["ordinary", "workflow_lifecycle", "ai_ctrl_node", "ai_data_node"]
  bounds: Readonly<{ actorCount: 4; sessionCount: 2; retainedMessages: 128; appendMessages: 1 }>
  epochReasonSequence: readonly string[]
  epochReasonOccurrences: readonly Readonly<{ reason: string; count: number }>[]
  strategyProof: Readonly<{
    strategyRevision: "stable-superset/v1"
    strategyDigest: string
    selectionAuthorityDigest: string
    lifecycleStages: 5
    providerRequestsPerStage: 2
    freshRecoveryVerified: true
    verified: true
  }>
  fixtureUsage: Readonly<{ cacheHitTokens: number; cacheMissTokens: number; normalizedInputCost: number }>
  compositeAdversarialRejections: typeof COMPOSITE_ADVERSARIAL_KINDS
}>

type ClosedMatrixInput = Readonly<{ mode: "deterministic" }>

type VerifiedG4StrategySelection = Readonly<{
  selection: WorkflowSurfaceStrategySelection
  productJourney: VerifiedWorkflowSurfaceProductJourney
  lifecycleStages: typeof WORKFLOW_SURFACE_EXPERIMENT_STAGES
  providerRequestsPerStage: 2
  freshRecoveryVerified: true
}>

type VerifiedScenarioIdentity = Readonly<{
  verified: true
  stepCount: number
  bounds: Readonly<{ retainedMessages: number; actorCount: number; sessionCount: number }>
  unexplainedLocalDivergences: 0
  child: PrivateChildReceipt
}>

type PrivateChildReceipt = Readonly<{
  owner: ProviderCacheProductEvidenceOwner
  receipt: ProviderCacheProductJourneyReceipt
  result: ProviderCacheProductJourneyResult
  sessionId: string
  actorId: string
  actorKey: string
  providerCallCount: number
  externalPredecessorAdmissionDigest: `sha256:${string}` | null
  externalEpochReceiptDigest: `sha256:${string}` | null
  distinctRuntimeProofDigest: `sha256:${string}` | null
}>

function assertClosedInput(input: ClosedMatrixInput): void {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== 1
    || !Object.prototype.hasOwnProperty.call(input, "mode")
    || input.mode !== "deterministic") {
    throw new Error("provider_cache_product_matrix_input_not_closed")
  }
}

function expectedEpochReason(scenarioId: string): string {
  if (scenarioId === "epoch.provider-model-profile/v1") return "provider_model_profile_switch"
  if (scenarioId === "epoch.compaction/v1") return "history_compaction"
  if (scenarioId === "epoch.rewind-fork/v1") return "history_rewind_or_fork"
  if (scenarioId === "epoch.resource-revision/v1" || scenarioId === "resource.old-new-actor/v1") return "frozen_resource_revision_accepted"
  if (scenarioId === "epoch.surface-revision/v1") return "provider_surface_revision_accepted"
  if (scenarioId === "epoch.legacy-import-rebuild/v1") return "legacy_context_import"
  return "initial_projection"
}

function exactScenarioShape(input: Readonly<{
  scenarioId: typeof PROVIDER_CACHE_PRODUCT_FROZEN_SCENARIO_IDS[number]
  canonicalCallSources: readonly ProviderCacheProductSourceRecord[]
  g4: VerifiedG4StrategySelection
}>): Readonly<{
  steps: readonly Readonly<{ stepId: string; kind: "provider_turn" | "tool_turn" | "transition" | "recovery" | "retry" }>[]
  bounds: Readonly<{ retainedMessages: number; actorCount: number; sessionCount: number }>
}> {
  const callOrdinals = [...new Set(input.canonicalCallSources
    .filter((source) => source.kind === "request_admission")
    .map((source) => source.identity.callOrdinal)
    .filter((ordinal): ordinal is number => ordinal !== null))].sort((left, right) => left - right)
  const toolEffectCount = input.canonicalCallSources.filter((source) => source.kind === "tool_effect").length
  const attemptCount = input.canonicalCallSources.filter((source) => source.kind === "transport_attempt").length
  const frozenFacts = input.canonicalCallSources
    .filter((source) => source.kind === "frozen_resource")
    .map((source) => source.facts as any)
  const isolation = frozenFacts.find((facts) => facts?.actorCount === 4 && facts?.sessionCount === 2)
  const long = frozenFacts.find((facts) => facts?.retainedMessages === 128 && facts?.appendMessages === 1)
  const resource = frozenFacts.find((facts) => facts?.oldActorReceiptDigest && facts?.newActorReceiptDigest)

  if (input.scenarioId === "workflow.lifecycle.stable-superset/v1"
    || input.scenarioId === "workflow.complete-authoring-release/v1") {
    const expectedStageRequestCount = input.g4.lifecycleStages.length * input.g4.providerRequestsPerStage
    const stageRequests = input.g4.productJourney.requests.slice(0, expectedStageRequestCount)
    const terminalRequests = input.g4.productJourney.requests.slice(expectedStageRequestCount)
    const steps = stageRequests.map((request) => {
      const stage = input.g4.lifecycleStages[Math.floor((request.callOrdinal - 1) / input.g4.providerRequestsPerStage)]!
      const requestOrdinal = ((request.callOrdinal - 1) % input.g4.providerRequestsPerStage) + 1
      return Object.freeze({
        stepId: `${stage}-forward-${requestOrdinal}`,
        kind: "provider_turn" as const,
      })
    })
    if (steps.length !== expectedStageRequestCount
      || terminalRequests.length !== 1
      || !input.g4.freshRecoveryVerified || !input.g4.productJourney.freshRecoveryVerified) {
      throw new Error(`provider_cache_product_lifecycle_contract_invalid:${input.scenarioId}`)
    }
    return Object.freeze({
      steps: Object.freeze([
        ...steps,
        Object.freeze({ stepId: "terminal-forward", kind: "provider_turn" as const }),
        Object.freeze({ stepId: "fresh-recovery", kind: "recovery" as const }),
      ]),
      bounds: Object.freeze({ retainedMessages: 1, actorCount: 1, sessionCount: 1 }),
    })
  }

  if (input.scenarioId === "isolation.four-actors-two-sessions/v1") {
    const expectedActorOrder = ["ordinary", "workflow_lifecycle", "workflow_ctrl_node", "workflow_data_node", "ordinary"]
    if (!isolation || !Array.isArray(isolation.actors) || isolation.actors.length !== 4
      || !Array.isArray(isolation.executionSequence)
      || JSON.stringify(isolation.executionSequence.map((row: any) => row.globalOrdinal)) !== JSON.stringify([1, 2, 3, 4, 5])
      || JSON.stringify(isolation.executionSequence.map((row: any) => row.actorClass)) !== JSON.stringify(expectedActorOrder)
      || callOrdinals.length !== 2) {
      throw new Error("provider_cache_product_isolation_manifest_authority_missing")
    }
    return Object.freeze({
      steps: Object.freeze([
        Object.freeze({ stepId: "ordinary-forward-1", kind: "provider_turn" as const }),
        Object.freeze({ stepId: "workflow-lifecycle-forward", kind: "provider_turn" as const }),
        Object.freeze({ stepId: "workflow-ctrl-forward", kind: "provider_turn" as const }),
        Object.freeze({ stepId: "workflow-data-forward", kind: "provider_turn" as const }),
        Object.freeze({ stepId: "ordinary-forward-2", kind: "provider_turn" as const }),
      ]),
      bounds: Object.freeze({ retainedMessages: 1, actorCount: isolation.actorCount, sessionCount: isolation.sessionCount }),
    })
  }

  if (input.scenarioId === "resource.old-new-actor/v1") {
    if (!resource || callOrdinals.length !== 2) {
      throw new Error("provider_cache_product_resource_manifest_authority_missing")
    }
    return Object.freeze({
      steps: Object.freeze([
        Object.freeze({ stepId: "old-actor-forward", kind: "provider_turn" as const }),
        Object.freeze({ stepId: "old-actor-fresh-recovery", kind: "recovery" as const }),
        Object.freeze({ stepId: "new-actor-forward", kind: "provider_turn" as const }),
        Object.freeze({ stepId: "existing-actor-resource-transition", kind: "transition" as const }),
        Object.freeze({ stepId: "existing-actor-forward", kind: "provider_turn" as const }),
      ]),
      bounds: Object.freeze({ retainedMessages: 1, actorCount: 3, sessionCount: 2 }),
    })
  }

  if (input.scenarioId === "recovery.fresh-runtime/v1") {
    if (callOrdinals.length !== 2) {
      throw new Error("provider_cache_product_recovery_manifest_authority_missing")
    }
    return Object.freeze({
      steps: Object.freeze([
        Object.freeze({ stepId: "initial-forward", kind: "provider_turn" as const }),
        Object.freeze({ stepId: "fresh-runtime-recovery", kind: "recovery" as const }),
      ]),
      bounds: Object.freeze({ retainedMessages: 1, actorCount: 1, sessionCount: 1 }),
    })
  }

  const steps: Array<Readonly<{ stepId: string; kind: "provider_turn" | "tool_turn" | "transition" | "recovery" | "retry" }>> = []
  for (const ordinal of callOrdinals) steps.push(Object.freeze({ stepId: `provider-forward-${ordinal}`, kind: "provider_turn" }))
  for (let index = 0; index < toolEffectCount; index += 1) steps.push(Object.freeze({ stepId: `tool-effect-${index + 1}`, kind: "tool_turn" }))
  if (input.scenarioId.startsWith("epoch.")) steps.splice(Math.min(1, steps.length), 0, Object.freeze({ stepId: "accepted-epoch-transition", kind: "transition" }))
  if (input.scenarioId === "transport.retry-503/v1") {
    if (attemptCount <= callOrdinals.length) throw new Error("provider_cache_product_retry_manifest_authority_missing")
    steps.splice(Math.min(1, steps.length), 0, Object.freeze({ stepId: "retry-503-byte-identical", kind: "retry" }))
  }
  if (steps.length === 0) throw new Error(`provider_cache_product_scenario_has_no_product_step:${input.scenarioId}`)
  if (input.scenarioId === "context.long-128/v1" && !long) {
    throw new Error("provider_cache_product_long_context_manifest_authority_missing")
  }
  return Object.freeze({
    steps: Object.freeze(steps),
    bounds: Object.freeze({
      retainedMessages: long?.retainedMessages ?? 1,
      actorCount: 1,
      sessionCount: 1,
    }),
  })
}

function verifyCanonicalIdentity(input: Readonly<{
  scenarioId: typeof PROVIDER_CACHE_PRODUCT_FROZEN_SCENARIO_IDS[number]
  actorClass: ProviderCacheProductActorClass
  productEntry: string
  sessionId: string
  actorKey: string
  actorId: string
  epochReasons: readonly string[]
  canonicalCallSources: readonly ProviderCacheProductSourceRecord[]
  g4: VerifiedG4StrategySelection
}>): VerifiedScenarioIdentity {
  const strategyProofDigest = input.g4.selection.selectionDigest
  const scenarioShape = exactScenarioShape({
    scenarioId: input.scenarioId,
    canonicalCallSources: input.canonicalCallSources,
    g4: input.g4,
  })
  const manifest = createProviderCacheProductScenarioManifest({
    scenarioId: input.scenarioId,
    actorClass: input.actorClass,
    productEntry: input.productEntry,
    providerProfileId: "deepseek-chat@1",
    model: "deepseek-chat",
    strategyProofDigest,
    steps: scenarioShape.steps,
    expectedEpochReasons: input.epochReasons as any,
    bounds: scenarioShape.bounds,
  })
  const identity = Object.freeze({
    sessionId: input.sessionId,
    actorKey: input.actorKey,
    actorId: input.actorId,
    providerCallId: null,
    callOrdinal: null,
    attemptOrdinal: null,
  })
  const records = new Map<string, ProviderCacheProductSourceRecord>()
  for (const record of [
    { kind: "scenario" as const, sourceId: "scenario", facts: manifest },
    { kind: "actor" as const, sourceId: "actor", facts: { actorKey: input.actorKey, actorId: input.actorId, actorClass: input.actorClass } },
    { kind: "session" as const, sourceId: "session", facts: { sessionId: input.sessionId } },
    { kind: "strategy_proof" as const, sourceId: "strategy", facts: {
      strategyRevision: input.g4.selection.selectedStrategyRevision,
      strategyDigest: input.g4.selection.selectedStrategyDigest,
      strategyProofDigest,
      rawReportDigest: input.g4.selection.rawReportDigest,
      selectorRevision: input.g4.selection.selectorRevision,
      lifecycleStages: input.g4.lifecycleStages,
      providerRequestsPerStage: input.g4.providerRequestsPerStage,
      freshRecoveryVerified: input.g4.freshRecoveryVerified,
    } },
  ]) {
    records.set(`${record.kind}\0${record.sourceId}`, Object.freeze({
      schemaVersion: "eidolon.provider-cache-product-source/v1",
      kind: record.kind,
      sourceId: record.sourceId,
      identity,
      facts: Object.freeze(record.facts),
    }))
  }
  for (const record of input.canonicalCallSources) {
    records.set(`${record.kind}\0${record.sourceId}`, record)
  }
  const observedEpochReasons = input.canonicalCallSources
    .filter((record) => record.kind === "provider_epoch")
    .sort((left, right) => left.identity.callOrdinal! - right.identity.callOrdinal!)
    .map((record) => String((record.facts as any).reason))
  if (JSON.stringify(observedEpochReasons) !== JSON.stringify(input.epochReasons)) {
    throw new Error(`provider_cache_product_epoch_sequence_mismatch:${input.scenarioId}`)
  }
  const owner = createProviderCacheProductEvidenceOwner({
    read: (kind, sourceId) => {
      const record = records.get(`${kind}\0${sourceId}`)
      if (!record) throw new Error("canonical product source disappeared")
      return record
    },
  })
  const refs = [...records.values()].map((record) => createProviderCacheProductEvidenceRef(owner, record.kind, record.sourceId))
  const receipt = issueProviderCacheProductJourneyReceipt(owner, {
    scenarioRef: refs.find((ref) => ref.kind === "scenario")!,
    sourceRefs: refs.filter((ref) => ref.kind !== "scenario"),
  })
  const result = reduceProviderCacheProductJourney(owner, receipt)
  const unexplainedLocalDivergences = result.comparisons.filter((comparison) => (
    comparison.sameEpoch
      ? comparison.localAttribution !== "same_epoch_exact"
      : !input.epochReasons.includes(comparison.localAttribution)
  )).length
  if (result.structuralStatus !== "PASS" || unexplainedLocalDivergences !== 0) {
    throw new Error(`provider_cache_product_local_divergence:${input.scenarioId}`)
  }
  return Object.freeze({
    verified: true,
    stepCount: manifest.steps.length,
    bounds: manifest.bounds,
    unexplainedLocalDivergences: unexplainedLocalDivergences as 0,
    child: Object.freeze({
      owner,
      receipt,
      result,
      sessionId: input.sessionId,
      actorId: input.actorId,
      actorKey: input.actorKey,
      providerCallCount: result.calls.length,
      externalPredecessorAdmissionDigest: null,
      externalEpochReceiptDigest: null,
      distinctRuntimeProofDigest: null,
    }),
  })
}

function signProductChild(input: Readonly<{
  childId: string
  actorClass: ProviderCacheProductActorClass
  sessionId: string
  actorKey: string
  actorId: string
  canonicalCallSources: readonly ProviderCacheProductSourceRecord[]
  g4: VerifiedG4StrategySelection
  recoveryBoundary?: Readonly<{
    externalPredecessorAdmissionDigest: `sha256:${string}`
    externalEpochReceiptDigest: `sha256:${string}`
    distinctRuntimeProofDigest: `sha256:${string}`
  }>
}>): PrivateChildReceipt {
  const callCount = new Set(input.canonicalCallSources
    .filter((source) => source.kind === "request_admission")
    .map((source) => source.identity.callOrdinal)).size
  const epochReasons = input.canonicalCallSources
    .filter((source) => source.kind === "provider_epoch")
    .sort((left, right) => left.identity.callOrdinal! - right.identity.callOrdinal!)
    .map((source) => (source.facts as any).reason as ProviderCacheProductEpochReason)
  if (callCount < 1 || epochReasons.length !== callCount) {
    throw new Error(`provider_cache_product_child_call_closure_invalid:${input.childId}`)
  }
  const manifest = createProviderCacheProductScenarioManifest({
    scenarioId: input.childId,
    actorClass: input.actorClass,
    productEntry: "canonical-product-child",
    providerProfileId: "deepseek-chat@1",
    model: "deepseek-chat",
    strategyProofDigest: input.g4.selection.selectionDigest,
    steps: Array.from({ length: callCount }, (_, index) => Object.freeze({
      stepId: `provider-call-${index + 1}`,
      kind: "provider_turn" as const,
    })),
    expectedEpochReasons: epochReasons,
    bounds: { retainedMessages: 1, actorCount: 1, sessionCount: 1 },
  })
  const identity = Object.freeze({
    sessionId: input.sessionId,
    actorKey: input.actorKey,
    actorId: input.actorId,
    providerCallId: null,
    callOrdinal: null,
    attemptOrdinal: null,
  })
  const records = new Map<string, ProviderCacheProductSourceRecord>()
  const put = (kind: ProviderCacheProductSourceKind, sourceId: string, facts: unknown) => records.set(`${kind}\0${sourceId}`, Object.freeze({
    schemaVersion: "eidolon.provider-cache-product-source/v1",
    kind,
    sourceId,
    identity,
    facts: structuredClone(facts),
  }))
  put("scenario", "scenario", manifest)
  put("actor", "actor", { actorKey: input.actorKey, actorId: input.actorId, actorClass: input.actorClass })
  put("session", "session", { sessionId: input.sessionId })
  put("strategy_proof", "strategy", {
    strategyRevision: input.g4.selection.selectedStrategyRevision,
    strategyDigest: input.g4.selection.selectedStrategyDigest,
    strategyProofDigest: input.g4.selection.selectionDigest,
  })
  for (const record of input.canonicalCallSources) records.set(`${record.kind}\0${record.sourceId}`, record)
  const owner = createProviderCacheProductEvidenceOwner({
    read: (kind, sourceId) => {
      const record = records.get(`${kind}\0${sourceId}`)
      if (!record) throw new Error(`provider_cache_product_child_source_missing:${input.childId}`)
      return record
    },
  })
  const refs = [...records.values()].map((record) => createProviderCacheProductEvidenceRef(owner, record.kind, record.sourceId))
  const receipt = issueProviderCacheProductJourneyReceipt(owner, {
    scenarioRef: refs.find((ref) => ref.kind === "scenario")!,
    sourceRefs: refs.filter((ref) => ref.kind !== "scenario"),
  })
  const result = reduceProviderCacheProductJourney(owner, receipt, input.recoveryBoundary
    ? {
        externalPredecessorAdmissionDigest: input.recoveryBoundary.externalPredecessorAdmissionDigest,
        externalEpochReceiptDigest: input.recoveryBoundary.externalEpochReceiptDigest,
      }
    : null)
  if (result.structuralStatus !== "PASS" || result.calls.length !== callCount) {
    throw new Error(`provider_cache_product_child_reducer_invalid:${input.childId}`)
  }
  return Object.freeze({
    owner,
    receipt,
    result,
    sessionId: input.sessionId,
    actorId: input.actorId,
    actorKey: input.actorKey,
    providerCallCount: result.calls.length,
    externalPredecessorAdmissionDigest: input.recoveryBoundary?.externalPredecessorAdmissionDigest ?? null,
    externalEpochReceiptDigest: input.recoveryBoundary?.externalEpochReceiptDigest ?? null,
    distinctRuntimeProofDigest: input.recoveryBoundary?.distinctRuntimeProofDigest ?? null,
  })
}

type CompositeOwner = Readonly<{ schemaVersion: "eidolon.provider-cache-composite-owner/v1"; ownerId: `sha256:${string}` }>
type CompositeReceipt = Readonly<{
  schemaVersion: "eidolon.provider-cache-composite-receipt/v1"
  ownerId: `sha256:${string}`
  scenarioId: string
  orderedChildren: readonly Readonly<{
    childOrdinal: number
    childClosureDigest: `sha256:${string}`
    sessionId: string
    actorKey: string
    actorId: string
    providerCallCount: number
    externalPredecessorAdmissionDigest: `sha256:${string}` | null
    externalEpochReceiptDigest: `sha256:${string}` | null
    distinctRuntimeProofDigest: `sha256:${string}` | null
  }>[]
  recoveryStepCount: number
  closureDigest: `sha256:${string}`
  seal: `hmac-sha256:${string}`
}>
const COMPOSITE_STATES = new WeakMap<object, Readonly<{ secret: Buffer }>>()

function createCompositeOwner(): CompositeOwner {
  const secret = randomBytes(32)
  const token = Object.freeze({
    schemaVersion: "eidolon.provider-cache-composite-owner/v1" as const,
    ownerId: digestProviderCacheProductClosedValue({ nonce: randomBytes(32).toString("hex") }),
  })
  COMPOSITE_STATES.set(token, Object.freeze({ secret }))
  return token
}

function issueCompositeReceipt(input: Readonly<{
  owner: CompositeOwner
  scenarioId: string
  children: readonly PrivateChildReceipt[]
  recoveryStepCount: number
}>): CompositeReceipt {
  const state = COMPOSITE_STATES.get(input.owner as object)
  if (!state || input.children.length < 1) throw new Error("provider_cache_product_composite_owner_invalid")
  const orderedChildren = Object.freeze(input.children.map((child, index) => Object.freeze({
    childOrdinal: index + 1,
    childClosureDigest: child.receipt.closureDigest,
    sessionId: child.sessionId,
    actorKey: child.actorKey,
    actorId: child.actorId,
    providerCallCount: child.providerCallCount,
    externalPredecessorAdmissionDigest: child.externalPredecessorAdmissionDigest,
    externalEpochReceiptDigest: child.externalEpochReceiptDigest,
    distinctRuntimeProofDigest: child.distinctRuntimeProofDigest,
  })))
  const body = Object.freeze({
    schemaVersion: "eidolon.provider-cache-composite-receipt/v1" as const,
    ownerId: input.owner.ownerId,
    scenarioId: input.scenarioId,
    orderedChildren,
    recoveryStepCount: input.recoveryStepCount,
  })
  const closureDigest = digestProviderCacheProductClosedValue(body)
  const seal = `hmac-sha256:${createHmac("sha256", state.secret).update(closureDigest).digest("hex")}` as const
  return Object.freeze({ ...body, closureDigest, seal })
}

function expectedCompositeChildIds(scenarioId: string): readonly string[] {
  if (scenarioId === "recovery.fresh-runtime/v1") return [`${scenarioId}#initial-runtime`, `${scenarioId}#recovered-runtime`]
  if (scenarioId === "resource.old-new-actor/v1") return [`${scenarioId}#old-recovered`, `${scenarioId}#new-initial`, `${scenarioId}#ordinary`]
  if (scenarioId === "isolation.four-actors-two-sessions/v1") return [`${scenarioId}#ordinary`, `${scenarioId}#workflow-lifecycle`, `${scenarioId}#workflow-ctrl`, `${scenarioId}#workflow-data`]
  if (scenarioId === "workflow.lifecycle.stable-superset/v1" || scenarioId === "workflow.complete-authoring-release/v1") {
    return [scenarioId, `${scenarioId}#fresh-recovery`]
  }
  return [scenarioId]
}

function verifyCompositeReceipt(input: Readonly<{
  owner: CompositeOwner
  receipt: CompositeReceipt
  children: readonly PrivateChildReceipt[]
}>): Readonly<{
  childReceiptCount: number
  providerCallCount: number
  recoveryStepCount: number
  actorCount: number
  sessionCount: number
  epochReasons: readonly string[]
  verified: true
}> {
  const state = COMPOSITE_STATES.get(input.owner as object)
  if (!state || input.children.length < 1 || input.receipt.ownerId !== input.owner.ownerId) {
    throw new Error("provider_cache_product_composite_owner_invalid")
  }
  const expectedChildIds = expectedCompositeChildIds(input.receipt.scenarioId)
  if (JSON.stringify(input.children.map((child) => child.receipt.scenarioId)) !== JSON.stringify(expectedChildIds)) {
    throw new Error(`provider_cache_product_composite_manifest_children_invalid:${input.receipt.scenarioId}`)
  }
  const orderedChildren = Object.freeze(input.children.map((child, index) => {
    const verified = verifyProviderCacheProductJourney(child.owner, child.receipt)
    const rereadResult = reduceProviderCacheProductJourney(child.owner, child.receipt,
      child.externalPredecessorAdmissionDigest && child.externalEpochReceiptDigest
        ? {
            externalPredecessorAdmissionDigest: child.externalPredecessorAdmissionDigest,
            externalEpochReceiptDigest: child.externalEpochReceiptDigest,
          }
        : null)
    if (!verified.verified
      || rereadResult.receiptClosureDigest !== child.result.receiptClosureDigest
      || rereadResult.calls.length !== child.providerCallCount) {
      throw new Error(`provider_cache_product_composite_child_invalid:${input.receipt.scenarioId}:${index + 1}`)
    }
    return Object.freeze({
      childOrdinal: index + 1,
      childClosureDigest: child.receipt.closureDigest,
      sessionId: child.sessionId,
      actorKey: child.actorKey,
      actorId: child.actorId,
      providerCallCount: child.providerCallCount,
      externalPredecessorAdmissionDigest: child.externalPredecessorAdmissionDigest,
      externalEpochReceiptDigest: child.externalEpochReceiptDigest,
      distinctRuntimeProofDigest: child.distinctRuntimeProofDigest,
    })
  }))
  orderedChildren.forEach((child, index) => {
    const current = input.children[index]!
    const hasExternalBoundary = child.externalPredecessorAdmissionDigest !== null
      || child.externalEpochReceiptDigest !== null
      || child.distinctRuntimeProofDigest !== null
    if (index === 0 && hasExternalBoundary) {
      throw new Error(`provider_cache_product_composite_initial_child_has_external_boundary:${input.receipt.scenarioId}`)
    }
    if (index > 0 && hasExternalBoundary) {
      const previousLastCall = input.children[index - 1]!.result.calls.at(-1)!
      const currentFirstCall = current.result.calls[0]!
      if (!child.externalPredecessorAdmissionDigest
        || !child.externalEpochReceiptDigest
        || !child.distinctRuntimeProofDigest
        || child.externalPredecessorAdmissionDigest !== previousLastCall.admissionDigest
        || child.externalEpochReceiptDigest !== previousLastCall.epochReceiptDigest
        || currentFirstCall.previousAdmissionDigest !== child.externalPredecessorAdmissionDigest
        || currentFirstCall.epochReceiptDigest !== child.externalEpochReceiptDigest) {
        throw new Error(`provider_cache_product_composite_external_boundary_invalid:${input.receipt.scenarioId}:${index + 1}`)
      }
    } else if (index > 0 && current.result.calls[0]!.previousAdmissionDigest !== null) {
      throw new Error(`provider_cache_product_composite_unanchored_child:${input.receipt.scenarioId}:${index + 1}`)
    }
  })
  if (new Set(orderedChildren.map((child) => child.childClosureDigest)).size !== orderedChildren.length) {
    throw new Error(`provider_cache_product_composite_duplicate_child:${input.receipt.scenarioId}`)
  }
  const body = Object.freeze({
    schemaVersion: "eidolon.provider-cache-composite-receipt/v1" as const,
    ownerId: input.owner.ownerId,
    scenarioId: input.receipt.scenarioId,
    orderedChildren,
    recoveryStepCount: input.receipt.recoveryStepCount,
  })
  const closureDigest = digestProviderCacheProductClosedValue(body)
  const expectedSeal = `hmac-sha256:${createHmac("sha256", state.secret).update(closureDigest).digest("hex")}`
  if (canonical(input.receipt.orderedChildren) !== canonical(orderedChildren)
    || input.receipt.closureDigest !== closureDigest
    || !timingSafeEqual(Buffer.from(expectedSeal), Buffer.from(input.receipt.seal))) {
    throw new Error(`provider_cache_product_composite_seal_invalid:${input.receipt.scenarioId}`)
  }
  if (input.receipt.scenarioId === "isolation.four-actors-two-sessions/v1") {
    const globalRows = input.children.flatMap((child) => {
      const actorClass = (readSource(child.owner, "scenario", "scenario").facts as ProviderCacheProductScenarioManifest).actorClass
      return child.receipt.calls.flatMap((call) => call.sourceRefs
        .filter((ref) => ref.kind === "transport_attempt")
        .map((ref) => readSource(child.owner, ref.kind, ref.sourceId))
        .filter((source) => source.identity.attemptOrdinal === 1)
        .map((source) => ({ actorClass, globalOrdinal: (source.facts as any).globalOrdinal })))
    }).sort((left, right) => left.globalOrdinal - right.globalOrdinal)
    if (JSON.stringify(globalRows) !== JSON.stringify([
      { actorClass: "ordinary", globalOrdinal: 1 },
      { actorClass: "workflow_lifecycle", globalOrdinal: 2 },
      { actorClass: "workflow_ctrl_node", globalOrdinal: 3 },
      { actorClass: "workflow_data_node", globalOrdinal: 4 },
      { actorClass: "ordinary", globalOrdinal: 5 },
    ])) throw new Error("provider_cache_product_composite_global_order_invalid")
  }
  return Object.freeze({
    childReceiptCount: orderedChildren.length,
    providerCallCount: orderedChildren.reduce((sum, child) => sum + child.providerCallCount, 0),
    recoveryStepCount: input.receipt.recoveryStepCount,
    actorCount: new Set(orderedChildren.map((child) => child.actorId)).size,
    sessionCount: new Set(orderedChildren.map((child) => child.sessionId)).size,
    epochReasons: Object.freeze(input.children.flatMap((child) => child.result.calls.map((call) => call.epochReason))),
    verified: true,
  })
}

const COMPOSITE_ADVERSARIAL_KINDS = Object.freeze([
  "missing", "duplicate", "substitute", "reorder", "cross-owner", "ref", "body", "closure", "hmac",
  "measured-bounds", "measured-actor-class", "measured-divergence",
  "ordinary-recovery-call-count", "ordinary-recovery-child-count", "ordinary-recovery-recovery-count",
  "resource-call-count", "resource-child-count", "resource-actor-count", "resource-session-count", "resource-recovery-count",
  "lifecycle-call-count", "lifecycle-child-count", "lifecycle-actor", "lifecycle-session",
  "lifecycle-stage-count", "lifecycle-terminal-count", "lifecycle-recovery-count",
  "isolation-call-count", "isolation-child-count", "isolation-actor-class", "isolation-actor-count",
  "isolation-session-count", "isolation-global-ordinal",
] as const)

function assertCompositeAdversarialRejections(input: Readonly<{
  owner: CompositeOwner
  receipt: CompositeReceipt
  children: readonly PrivateChildReceipt[]
}>): typeof COMPOSITE_ADVERSARIAL_KINDS {
  const rejected: string[] = []
  const expectRejected = (kind: typeof COMPOSITE_ADVERSARIAL_KINDS[number], attempt: () => void) => {
    try {
      attempt()
    } catch {
      rejected.push(kind)
      return
    }
    throw new Error(`provider_cache_product_composite_adversarial_accepted:${kind}`)
  }
  expectRejected("missing", () => verifyCompositeReceipt({ ...input, children: input.children.slice(0, -1) }))
  expectRejected("duplicate", () => verifyCompositeReceipt({
    ...input,
    children: [...input.children.slice(0, -1), input.children[0]!],
  }))
  expectRejected("substitute", () => verifyCompositeReceipt({
    ...input,
    children: [{ ...input.children[0]!, actorId: `${input.children[0]!.actorId}-substituted` }, ...input.children.slice(1)],
  }))
  expectRejected("reorder", () => verifyCompositeReceipt({ ...input, children: [...input.children].reverse() }))
  expectRejected("cross-owner", () => verifyCompositeReceipt({ ...input, owner: createCompositeOwner() }))
  const first = input.children[0]!
  const firstRef = first.receipt.journeySourceRefs[0]!
  const refTampered = {
    ...first,
    receipt: {
      ...first.receipt,
      journeySourceRefs: [{ ...firstRef, sourceDigest: `sha256:${"0".repeat(64)}` }, ...first.receipt.journeySourceRefs.slice(1)],
    },
  } as PrivateChildReceipt
  expectRejected("ref", () => verifyCompositeReceipt({ ...input, children: [refTampered, ...input.children.slice(1)] }))
  const bodyTampered = {
    ...input.receipt,
    orderedChildren: [
      { ...input.receipt.orderedChildren[0]!, providerCallCount: input.receipt.orderedChildren[0]!.providerCallCount + 1 },
      ...input.receipt.orderedChildren.slice(1),
    ],
  } as CompositeReceipt
  expectRejected("body", () => verifyCompositeReceipt({ ...input, receipt: bodyTampered }))
  expectRejected("closure", () => verifyCompositeReceipt({
    ...input,
    receipt: { ...input.receipt, closureDigest: `sha256:${"0".repeat(64)}` } as CompositeReceipt,
  }))
  expectRejected("hmac", () => verifyCompositeReceipt({
    ...input,
    receipt: { ...input.receipt, seal: `hmac-sha256:${"0".repeat(64)}` } as CompositeReceipt,
  }))
  if (JSON.stringify(rejected) !== JSON.stringify(COMPOSITE_ADVERSARIAL_KINDS)) {
    throw new Error(`provider_cache_product_composite_adversarial_incomplete:${JSON.stringify(rejected)}`)
  }
  return COMPOSITE_ADVERSARIAL_KINDS
}


async function runVerifiedG4StrategySelection(globalRoot: string): Promise<VerifiedG4StrategySelection> {
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
  const input = createClosedWorkflowSurfaceExperimentInput({
    frozenActorSnapshotDigest: digestClosedWorkflowSurfaceValue(frozenActorSnapshot),
    frozenConversationSnapshotDigest: digestClosedWorkflowSurfaceValue(frozenConversationSnapshot),
    lifecycleToolProfileDigest: digestClosedWorkflowSurfaceValue(WORKFLOW_LIFECYCLE_TOOL_PROFILE),
    lifecycleResourcePackageDigest: resourcePackage.digest as `sha256:${string}`,
    providerProfileId: "deepseek-chat@1",
    model: "deepseek-chat",
  })
  const runtime = createLocalWorkflowSurfaceExperimentRuntime({
    globalRoot,
    resourcePackage,
    frozenActorSnapshot,
    frozenConversationSnapshot,
    providerProfileId: input.providerProfileId,
    model: input.model,
    lifecycleToolProfileDigest: input.lifecycleToolProfileDigest,
    lifecycleResourcePackageDigest: input.lifecycleResourcePackageDigest,
  })
  const raw = await runClosedWorkflowSurfaceExperiment({ input, runtime })
  const selection = selectWorkflowSurfaceStrategy(raw, runtime)
  const productJourney = readVerifiedWorkflowSurfaceProductJourney({ runtime, report: raw, selection })
  const selected = selection.ranking.find((candidate) => candidate.strategyRevision === "stable-superset/v1")
  if (selection.selectedStrategyRevision !== "stable-superset/v1"
    || selection.selectedStrategyDigest !== WORKFLOW_SURFACE_STRATEGY_REGISTRY.resolve("stable-superset/v1").strategyDigest
    || !selected?.eligible
    || selected.surfaceEpochCount !== 1
    || selected.toolSelectionErrors !== 0
    || raw.candidates.length !== 3
    || new Set(raw.candidates.map((candidate) => candidate.cloneInstanceDigest)).size !== 3
    || WORKFLOW_SURFACE_EXPERIMENT_STAGES.length !== 5) {
    throw new Error("provider_cache_product_g4_owner_selection_invalid")
  }
  // selectWorkflowSurfaceStrategy privately rereads the owner artifacts and
  // validates exactly two provider requests per stage plus fresh recovery.
  return Object.freeze({
    selection,
    productJourney,
    lifecycleStages: WORKFLOW_SURFACE_EXPERIMENT_STAGES,
    providerRequestsPerStage: 2,
    freshRecoveryVerified: true,
  })
}

type ProductionCompositeContract = Readonly<{
  childIds: readonly string[]
  callCounts: readonly number[]
  actorClasses: readonly ProviderCacheProductActorClass[]
  actorCount: number
  sessionCount: number
  recoveryCount: number
  stepCount: number
  stepEvidence: "calls" | "calls_plus_retry" | "calls_plus_tool_effects" | "calls_plus_epoch_transition"
  bounds: Readonly<{ minimumRetainedMessages: number; actorCount: number; sessionCount: number }>
  expectedAppendMessages?: number
  globalOrder?: readonly Readonly<{ actorClass: ProviderCacheProductActorClass; globalOrdinal: number }>[]
  lifecycle?: Readonly<{
    stages: readonly string[]
    providerRequestsPerStage: 2
    liveTerminalCount: 1
    recoveryTerminalCount: 1
  }>
}>

function productionCompositeContract(scenarioId: typeof PROVIDER_CACHE_PRODUCT_FROZEN_SCENARIO_IDS[number]): ProductionCompositeContract {
  const one = (input: Omit<ProductionCompositeContract, "childIds" | "callCounts" | "actorClasses" | "actorCount" | "sessionCount" | "recoveryCount" | "bounds" | "stepEvidence"> & {
    calls: number
    actorClass?: ProviderCacheProductActorClass
    stepCount: number
    retainedMessages?: number
    expectedAppendMessages?: number
    stepEvidence?: ProductionCompositeContract["stepEvidence"]
  }): ProductionCompositeContract => Object.freeze({
    childIds: Object.freeze([scenarioId]),
    callCounts: Object.freeze([input.calls]),
    actorClasses: Object.freeze([input.actorClass ?? "ordinary"]) as readonly ProviderCacheProductActorClass[],
    actorCount: 1,
    sessionCount: 1,
    recoveryCount: 0,
    stepCount: input.stepCount,
    stepEvidence: input.stepEvidence ?? "calls",
    bounds: Object.freeze({ minimumRetainedMessages: input.retainedMessages ?? 1, actorCount: 1, sessionCount: 1 }),
    ...(input.expectedAppendMessages === undefined ? {} : { expectedAppendMessages: input.expectedAppendMessages }),
  })
  if (scenarioId === "recovery.fresh-runtime/v1") return Object.freeze({
    childIds: Object.freeze([`${scenarioId}#initial-runtime`, `${scenarioId}#recovered-runtime`]),
    callCounts: Object.freeze([1, 1]),
    actorClasses: Object.freeze(["ordinary", "ordinary"]) as readonly ProviderCacheProductActorClass[],
    actorCount: 1,
    sessionCount: 1,
    recoveryCount: 1,
    stepCount: 2,
    stepEvidence: "calls",
    bounds: Object.freeze({ minimumRetainedMessages: 1, actorCount: 1, sessionCount: 1 }),
  })
  if (scenarioId === "resource.old-new-actor/v1") return Object.freeze({
    childIds: Object.freeze([`${scenarioId}#old-recovered`, `${scenarioId}#new-initial`, `${scenarioId}#ordinary`]),
    callCounts: Object.freeze([2, 1, 2]),
    actorClasses: Object.freeze(["ordinary", "ordinary", "ordinary"]) as readonly ProviderCacheProductActorClass[],
    actorCount: 3,
    sessionCount: 2,
    recoveryCount: 1,
    stepCount: 5,
    stepEvidence: "calls",
    bounds: Object.freeze({ minimumRetainedMessages: 1, actorCount: 3, sessionCount: 2 }),
  })
  if (scenarioId === "isolation.four-actors-two-sessions/v1") return Object.freeze({
    childIds: Object.freeze([
      `${scenarioId}#ordinary`, `${scenarioId}#workflow-lifecycle`, `${scenarioId}#workflow-ctrl`, `${scenarioId}#workflow-data`,
    ]),
    callCounts: Object.freeze([2, 1, 1, 1]),
    actorClasses: Object.freeze(["ordinary", "workflow_lifecycle", "workflow_ctrl_node", "workflow_data_node"]) as readonly ProviderCacheProductActorClass[],
    actorCount: 4,
    sessionCount: 2,
    recoveryCount: 0,
    stepCount: 5,
    stepEvidence: "calls",
    bounds: Object.freeze({ minimumRetainedMessages: 1, actorCount: 4, sessionCount: 2 }),
    globalOrder: Object.freeze([
      Object.freeze({ actorClass: "ordinary", globalOrdinal: 1 }),
      Object.freeze({ actorClass: "workflow_lifecycle", globalOrdinal: 2 }),
      Object.freeze({ actorClass: "workflow_ctrl_node", globalOrdinal: 3 }),
      Object.freeze({ actorClass: "workflow_data_node", globalOrdinal: 4 }),
      Object.freeze({ actorClass: "ordinary", globalOrdinal: 5 }),
    ]),
  })
  if (scenarioId === "workflow.lifecycle.stable-superset/v1"
    || scenarioId === "workflow.complete-authoring-release/v1") return Object.freeze({
    childIds: Object.freeze([`${scenarioId}#live-lifecycle`, `${scenarioId}#fresh-recovery`]),
    callCounts: Object.freeze([11, 1]),
    actorClasses: Object.freeze(["workflow_lifecycle", "workflow_lifecycle"]) as readonly ProviderCacheProductActorClass[],
    actorCount: 1,
    sessionCount: 1,
    recoveryCount: 1,
    stepCount: 12,
    stepEvidence: "calls",
    bounds: Object.freeze({ minimumRetainedMessages: 1, actorCount: 1, sessionCount: 1 }),
    lifecycle: Object.freeze({
      stages: Object.freeze([...WORKFLOW_SURFACE_EXPERIMENT_STAGES]),
      providerRequestsPerStage: 2,
      liveTerminalCount: 1,
      recoveryTerminalCount: 1,
    }),
  })
  if (scenarioId === "workflow.ctrl-node.stage-free/v1") return one({ calls: 1, actorClass: "workflow_ctrl_node", stepCount: 1 })
  if (scenarioId === "workflow.data-node.stage-free/v1") return one({ calls: 1, actorClass: "workflow_data_node", stepCount: 1 })
  if (scenarioId === "ordinary.no-tool.forward/v1") return one({ calls: 2, stepCount: 2 })
  if (scenarioId === "context.long-128/v1") return one({
    calls: 2,
    stepCount: 2,
    retainedMessages: 128,
    expectedAppendMessages: 1,
  })
  if (scenarioId === "tool.reasoning-parallel-pending/v1") return one({ calls: 2, stepCount: 4, stepEvidence: "calls_plus_tool_effects" })
  if (scenarioId === "transport.retry-503/v1") return one({ calls: 1, stepCount: 2, stepEvidence: "calls_plus_retry" })
  if (scenarioId === "epoch.legacy-import-rebuild/v1") return one({ calls: 1, stepCount: 2, stepEvidence: "calls_plus_epoch_transition" })
  if (scenarioId.startsWith("epoch.")) return one({ calls: 2, stepCount: 3, stepEvidence: "calls_plus_epoch_transition" })
  return one({ calls: 1, stepCount: 1 })
}

type ProductionCompositeVerification = Readonly<{
  openedChildren: readonly OpenedVerifiedProductChild[]
  childReceiptCount: number
  providerCallCount: number
  recoveryStepCount: number
  actorCount: number
  sessionCount: number
  epochReasons: readonly string[]
  lastUsage: Readonly<{ cacheHitTokens: number; cacheMissTokens: number; normalizedInputCost: number }> | null
  verified: true
  stepCount: number
  bounds: Readonly<{ retainedMessages: number; currentMessages: number; actorCount: number; sessionCount: number }>
  firstDivergence: string | null
  localDivergenceCount: number
}>

function verifyOpenedChildCalls(child: OpenedVerifiedProductChild): Readonly<{
  epochReasons: readonly string[]
  lastUsage: ProductionCompositeVerification["lastUsage"]
  globalRows: readonly Readonly<{ actorClass: ProviderCacheProductActorClass; globalOrdinal: number }>[]
  messageCounts: readonly number[]
  failedRetryCount: number
  nonInitialEpochCount: number
  toolEffectCount: number
  firstDivergence: string | null
  localDivergenceCount: number
}> {
  const records = child.sourceRecords as readonly ProviderCacheProductSourceRecord[]
  if (records.some((record) => record.identity.sessionId !== child.sessionId
    || record.identity.actorKey !== child.actorKey || record.identity.actorId !== child.actorId)) {
    throw new Error(`provider_cache_product_production_child_identity_mismatch:${child.childId}`)
  }
  const byCall = new Map<number, ProviderCacheProductSourceRecord[]>()
  for (const record of records) {
    if (record.identity.callOrdinal === null) continue
    const rows = byCall.get(record.identity.callOrdinal) ?? []
    rows.push(record)
    byCall.set(record.identity.callOrdinal, rows)
  }
  const calls = [...byCall.entries()].sort(([left], [right]) => left - right)
  if (calls.length !== child.callCount) throw new Error(`provider_cache_product_production_child_call_count_mismatch:${child.childId}`)
  let previousWire: readonly CacheUnit[] | null = null
  let previousEpoch: string | null = null
  const epochReasons: string[] = []
  const globalRows: Array<Readonly<{ actorClass: ProviderCacheProductActorClass; globalOrdinal: number }>> = []
  const messageCounts: number[] = []
  const divergenceLocations: string[] = []
  let failedRetryCount = 0
  let nonInitialEpochCount = 0
  let lastUsage: ProductionCompositeVerification["lastUsage"] = null
  for (const [ordinal, rows] of calls) {
    const one = (kind: ProviderCacheProductSourceKind) => {
      const matched = rows.filter((row) => row.kind === kind)
      if (matched.length !== 1) throw new Error(`provider_cache_product_production_call_kind_mismatch:${child.childId}:${ordinal}:${kind}`)
      return matched[0]!
    }
    const admission = one("request_admission")
    const wire = one("final_wire")
    const epoch = one("provider_epoch")
    const usage = one("final_success_usage")
    const attempts = rows.filter((row) => row.kind === "transport_attempt")
      .sort((left, right) => left.identity.attemptOrdinal! - right.identity.attemptOrdinal!)
    if (attempts.length < 1 || new Set(attempts.map((row) => (row.facts as any).bodyDigest)).size !== 1
      || (attempts.at(-1)!.facts as any).status !== "final_success") {
      throw new Error(`provider_cache_product_production_transport_closure_invalid:${child.childId}:${ordinal}`)
    }
    failedRetryCount += attempts.length - 1
    const admissionFacts = admission.facts as any
    const wireFacts = wire.facts as any
    if (admissionFacts.finalRequestDigest !== wireFacts.requestDigest) {
      throw new Error(`provider_cache_product_production_admission_wire_mismatch:${child.childId}:${ordinal}`)
    }
    const units = parseCacheUnits(wireFacts.cacheUnits, `${child.childId}.${ordinal}.cacheUnits`)
    let messageCount: number
    if (typeof wireFacts.body === "string") {
      const parsedBody = JSON.parse(wireFacts.body) as { messages?: unknown }
      if (!Array.isArray(parsedBody.messages)) {
        throw new Error(`provider_cache_product_production_body_messages_invalid:${child.childId}:${ordinal}`)
      }
      messageCount = parsedBody.messages.length
    } else {
      messageCount = units.filter((unit) => unit.kind === "message").length
    }
    if (messageCount !== units.filter((unit) => unit.kind === "message").length) {
      throw new Error(`provider_cache_product_production_message_count_mismatch:${child.childId}:${ordinal}`)
    }
    messageCounts.push(messageCount)
    const epochFacts = epoch.facts as any
    if (epochFacts.reason !== "initial_projection") nonInitialEpochCount += 1
    if (previousWire && previousEpoch === epochFacts.receiptDigest) {
      const firstChangedIndex = previousWire.findIndex((unit, index) => !exactUnit(unit, units[index]!))
      if (previousWire.length > units.length || firstChangedIndex !== -1) {
        divergenceLocations.push(`${child.childId}:${ordinal}:${firstChangedIndex === -1 ? units.length : firstChangedIndex}`)
        throw new Error(`provider_cache_product_production_same_epoch_divergence:${child.childId}:${ordinal}`)
      }
    }
    previousWire = units
    previousEpoch = String(epochFacts.receiptDigest)
    epochReasons.push(String(epochFacts.reason))
    const usageFacts = usage.facts as any
    if (usageFacts.status !== "final_success") throw new Error(`provider_cache_product_production_usage_not_final:${child.childId}:${ordinal}`)
    lastUsage = Object.freeze({
      cacheHitTokens: exactInteger(usageFacts.cacheHitTokens, `${child.childId}.usage.cacheHitTokens`),
      cacheMissTokens: exactInteger(usageFacts.cacheMissTokens, `${child.childId}.usage.cacheMissTokens`),
      normalizedInputCost: Number(usageFacts.normalizedInputCost),
    })
    for (const attempt of attempts.filter((row) => row.identity.attemptOrdinal === 1)) {
      const globalOrdinal = (attempt.facts as any).globalOrdinal
      if (globalOrdinal !== null && globalOrdinal !== undefined) {
        globalRows.push(Object.freeze({ actorClass: child.actorClass, globalOrdinal: exactInteger(globalOrdinal, "globalOrdinal", 1) }))
      }
    }
  }
  return Object.freeze({
    epochReasons: Object.freeze(epochReasons),
    lastUsage,
    globalRows: Object.freeze(globalRows),
    messageCounts: Object.freeze(messageCounts),
    failedRetryCount,
    nonInitialEpochCount,
    toolEffectCount: records.filter((record) => record.kind === "tool_effect").length,
    firstDivergence: divergenceLocations.at(0) ?? null,
    localDivergenceCount: divergenceLocations.length,
  })
}

type ProductionCompositeMeasurement = Readonly<{
  actorCount: number
  sessionCount: number
  recoveryStepCount: number
  providerCallCount: number
  stepCount: number
  bounds: ProductionCompositeVerification["bounds"]
  globalRows: readonly Readonly<{ actorClass: ProviderCacheProductActorClass; globalOrdinal: number }>[]
  firstDivergence: string | null
  localDivergenceCount: number
}>

function reduceProductionCompositeMeasurements(
  children: readonly OpenedVerifiedProductChild[],
  results: readonly ReturnType<typeof verifyOpenedChildCalls>[],
  contract: ProductionCompositeContract,
): ProductionCompositeMeasurement {
  const actorCount = new Set(children.map((child) => `${child.actorKey}\0${child.actorId}`)).size
  const sessionCount = new Set(children.map((child) => child.sessionId)).size
  const recoveryStepCount = children.filter((child) => child.recoveryBoundary).length
  const providerCallCount = results.reduce((sum, result) => sum + result.messageCounts.length, 0)
  const retryCount = results.reduce((sum, result) => sum + result.failedRetryCount, 0)
  const toolEffectCount = results.reduce((sum, result) => sum + result.toolEffectCount, 0)
  const epochTransitionCount = results.reduce((sum, result) => sum + result.nonInitialEpochCount, 0)
  const stepCount = providerCallCount + (contract.stepEvidence === "calls_plus_retry" ? retryCount
    : contract.stepEvidence === "calls_plus_tool_effects" ? toolEffectCount
      : contract.stepEvidence === "calls_plus_epoch_transition" ? epochTransitionCount
        : 0)
  const messageCounts = results.flatMap((result) => result.messageCounts)
  if (messageCounts.length < 1) throw new Error("provider_cache_product_production_messages_missing")
  const retainedMessages = messageCounts[0]!
  const currentMessages = messageCounts.at(-1)!
  const divergenceLocations = results.flatMap((result) => (
    result.firstDivergence === null ? [] : [result.firstDivergence]
  ))
  const localDivergenceCount = results.reduce((sum, result) => sum + result.localDivergenceCount, 0)
  return Object.freeze({
    actorCount,
    sessionCount,
    recoveryStepCount,
    providerCallCount,
    stepCount,
    bounds: Object.freeze({ retainedMessages, currentMessages, actorCount, sessionCount }),
    globalRows: Object.freeze(results.flatMap((result) => result.globalRows)
      .sort((left, right) => left.globalOrdinal - right.globalOrdinal)),
    firstDivergence: divergenceLocations.at(0) ?? null,
    localDivergenceCount,
  })
}

function verifyProductionCompositeExact(
  scenarioId: ProviderCacheProductProductionScenarioId,
  handles: readonly import("./ProviderCacheProductRuntime").VerifiedProductChildHandle[],
  adversarialTransform?: (
    children: readonly OpenedVerifiedProductChild[],
  ) => readonly OpenedVerifiedProductChild[],
): ProductionCompositeVerification {
  const contract = productionCompositeContract(scenarioId)
  const ownerChildren = Object.freeze(handles.map((handle) => openVerifiedProductChild(handle)))
  const openedChildren = Object.freeze(adversarialTransform
    ? [...adversarialTransform(ownerChildren)]
    : [...ownerChildren])
  const ownerRereadChildren = Object.freeze(handles.map((handle) => openVerifiedProductChild(handle)))
  if (JSON.stringify(openedChildren) !== JSON.stringify(ownerRereadChildren)) {
    throw new Error(`provider_cache_product_exact_composite_owner_readback_invalid:${scenarioId}`)
  }
  if (JSON.stringify(openedChildren.map((child) => child.childId)) !== JSON.stringify(contract.childIds)
    || JSON.stringify(openedChildren.map((child) => child.childOrdinal)) !== JSON.stringify(contract.childIds.map((_, index) => index + 1))
    || JSON.stringify(openedChildren.map((child) => child.callCount)) !== JSON.stringify(contract.callCounts)
    || JSON.stringify(openedChildren.map((child) => child.actorClass)) !== JSON.stringify(contract.actorClasses)) {
    throw new Error(`provider_cache_product_exact_composite_shape_invalid:${scenarioId}`)
  }
  const childResults = openedChildren.map(verifyOpenedChildCalls)
  const measurement = reduceProductionCompositeMeasurements(openedChildren, childResults, contract)
  if (measurement.actorCount !== contract.actorCount
    || measurement.sessionCount !== contract.sessionCount
    || measurement.recoveryStepCount !== contract.recoveryCount
    || measurement.stepCount !== contract.stepCount
    || measurement.bounds.retainedMessages < contract.bounds.minimumRetainedMessages
    || measurement.bounds.actorCount !== contract.bounds.actorCount
    || measurement.bounds.sessionCount !== contract.bounds.sessionCount
    || (contract.expectedAppendMessages !== undefined
      && measurement.bounds.currentMessages - measurement.bounds.retainedMessages !== contract.expectedAppendMessages)
    || measurement.localDivergenceCount !== 0) {
    throw new Error(`provider_cache_product_exact_composite_bounds_invalid:${scenarioId}`)
  }
  if (contract.lifecycle) {
    const [live, recovery] = openedChildren
    const expectedLiveFacts = {
      lifecycleStages: contract.lifecycle.stages,
      providerRequestsPerStage: contract.lifecycle.providerRequestsPerStage,
      terminalCount: contract.lifecycle.liveTerminalCount,
      recoveryCount: 0,
    }
    const expectedRecoveryFacts = {
      lifecycleStages: contract.lifecycle.stages,
      providerRequestsPerStage: contract.lifecycle.providerRequestsPerStage,
      terminalCount: contract.lifecycle.recoveryTerminalCount,
      recoveryCount: 1,
    }
    const liveToolEffects = live!.sourceRecords.filter((record) => record.kind === "tool_effect")
    const recoveryToolEffects = recovery!.sourceRecords.filter((record) => record.kind === "tool_effect")
    const liveToolOrdinals = liveToolEffects.map((record) => record.identity.callOrdinal)
    if (JSON.stringify(live!.contractFacts) !== JSON.stringify(expectedLiveFacts)
      || JSON.stringify(recovery!.contractFacts) !== JSON.stringify(expectedRecoveryFacts)
      || liveToolEffects.length !== contract.lifecycle.stages.length * contract.lifecycle.providerRequestsPerStage
      || JSON.stringify(liveToolOrdinals) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      || recoveryToolEffects.length !== 0) {
      throw new Error(`provider_cache_product_exact_lifecycle_contract_invalid:${scenarioId}`)
    }
  } else if (openedChildren.some((child) => child.contractFacts !== null)) {
    throw new Error(`provider_cache_product_unexpected_contract_facts:${scenarioId}`)
  }
  if (contract.globalOrder && JSON.stringify(measurement.globalRows) !== JSON.stringify(contract.globalOrder)) {
    throw new Error(`provider_cache_product_exact_composite_global_order_invalid:${scenarioId}`)
  }
  const exactBody = Object.freeze({
    scenarioId,
    children: Object.freeze(openedChildren.map((child) => Object.freeze({
      childId: child.childId,
      childOrdinal: child.childOrdinal,
      receiptDigest: child.receiptDigest,
      actorClass: child.actorClass,
      sessionId: child.sessionId,
      actorKey: child.actorKey,
      actorId: child.actorId,
      callCount: child.callCount,
      recoveryBoundary: child.recoveryBoundary,
      contractFacts: child.contractFacts,
      sourceClosureDigest: child.sourceClosureDigest,
    }))),
    actorCount: measurement.actorCount,
    sessionCount: measurement.sessionCount,
    recoveryStepCount: measurement.recoveryStepCount,
    providerCallCount: measurement.providerCallCount,
    globalRows: measurement.globalRows,
    stepCount: measurement.stepCount,
    bounds: measurement.bounds,
    firstDivergence: measurement.firstDivergence,
    localDivergenceCount: measurement.localDivergenceCount,
  })
  const secret = randomBytes(32)
  const closureDigest = digestProviderCacheProductClosedValue(exactBody)
  const seal = createHmac("sha256", secret).update(closureDigest).digest()
  const rereadChildren = handles.map((handle) => openVerifiedProductChild(handle))
  const rereadResults = rereadChildren.map(verifyOpenedChildCalls)
  const rereadMeasurement = reduceProductionCompositeMeasurements(rereadChildren, rereadResults, contract)
  const rereadBody = Object.freeze({
    scenarioId,
    children: Object.freeze(rereadChildren.map((child) => Object.freeze({
      childId: child.childId,
      childOrdinal: child.childOrdinal,
      receiptDigest: child.receiptDigest,
      actorClass: child.actorClass,
      sessionId: child.sessionId,
      actorKey: child.actorKey,
      actorId: child.actorId,
      callCount: child.callCount,
      recoveryBoundary: child.recoveryBoundary,
      contractFacts: child.contractFacts,
      sourceClosureDigest: child.sourceClosureDigest,
    }))),
    actorCount: rereadMeasurement.actorCount,
    sessionCount: rereadMeasurement.sessionCount,
    recoveryStepCount: rereadMeasurement.recoveryStepCount,
    providerCallCount: rereadMeasurement.providerCallCount,
    globalRows: rereadMeasurement.globalRows,
    stepCount: rereadMeasurement.stepCount,
    bounds: rereadMeasurement.bounds,
    firstDivergence: rereadMeasurement.firstDivergence,
    localDivergenceCount: rereadMeasurement.localDivergenceCount,
  })
  const rereadDigest = digestProviderCacheProductClosedValue(rereadBody)
  const rereadSeal = createHmac("sha256", secret).update(rereadDigest).digest()
  if (closureDigest !== rereadDigest || !timingSafeEqual(seal, rereadSeal)) {
    throw new Error(`provider_cache_product_exact_composite_hmac_invalid:${scenarioId}`)
  }
  return Object.freeze({
    openedChildren,
    childReceiptCount: openedChildren.length,
    providerCallCount: measurement.providerCallCount,
    recoveryStepCount: measurement.recoveryStepCount,
    actorCount: measurement.actorCount,
    sessionCount: measurement.sessionCount,
    epochReasons: Object.freeze(childResults.flatMap((result) => result.epochReasons)),
    lastUsage: childResults.at(-1)?.lastUsage ?? null,
    verified: true,
    stepCount: measurement.stepCount,
    bounds: measurement.bounds,
    firstDivergence: measurement.firstDivergence,
    localDivergenceCount: measurement.localDivergenceCount,
  })
}

type ProductChildHandle = import("./ProviderCacheProductRuntime").VerifiedProductChildHandle

function assertProductionCompositeAdversarialRejections(
  handlesByScenario: ReadonlyMap<ProviderCacheProductProductionScenarioId, readonly ProductChildHandle[]>,
): typeof COMPOSITE_ADVERSARIAL_KINDS {
  const rejected: string[] = []
  const expectRejected = (kind: typeof COMPOSITE_ADVERSARIAL_KINDS[number], attempt: () => void) => {
    try {
      attempt()
    } catch {
      rejected.push(kind)
      return
    }
    throw new Error(`provider_cache_product_composite_adversarial_accepted:${kind}`)
  }
  const handles = (scenarioId: ProviderCacheProductProductionScenarioId) => {
    const value = handlesByScenario.get(scenarioId)
    if (!value) throw new Error(`provider_cache_product_adversarial_fixture_missing:${scenarioId}`)
    return value
  }
  const mutateChild = (
    index: number,
    patch: (child: OpenedVerifiedProductChild) => OpenedVerifiedProductChild,
  ) => (children: readonly OpenedVerifiedProductChild[]) => children.map((child, childIndex) => (
    childIndex === index ? patch(child) : child
  ))
  const mutateRecord = (
    child: OpenedVerifiedProductChild,
    predicate: (record: ProviderCacheProductSourceRecord) => boolean,
    patch: (record: ProviderCacheProductSourceRecord) => ProviderCacheProductSourceRecord,
  ): OpenedVerifiedProductChild => ({
    ...child,
    sourceRecords: child.sourceRecords.map((record) => predicate(record as ProviderCacheProductSourceRecord)
      ? patch(record as ProviderCacheProductSourceRecord)
      : record) as readonly ProviderCacheProductSourceRecord[],
  })

  const isolationId = "isolation.four-actors-two-sessions/v1" as const
  const isolation = handles(isolationId)
  expectRejected("missing", () => verifyProductionCompositeExact(isolationId, isolation.slice(0, -1)))
  expectRejected("duplicate", () => verifyProductionCompositeExact(isolationId, [...isolation.slice(0, -1), isolation[0]!]))
  expectRejected("substitute", () => verifyProductionCompositeExact(isolationId, [
    Object.freeze({ ...isolation[0]!, handleId: `sha256:${"0".repeat(64)}` as const }),
    ...isolation.slice(1),
  ]))
  expectRejected("reorder", () => verifyProductionCompositeExact(isolationId, [...isolation].reverse()))
  expectRejected("cross-owner", () => verifyProductionCompositeExact(isolationId, [
    handles("ordinary.no-tool.forward/v1")[0]!, ...isolation.slice(1),
  ]))
  expectRejected("ref", () => verifyProductionCompositeExact(isolationId, isolation, mutateChild(0, (child) => (
    mutateRecord(child, () => true, (record) => ({ ...record, sourceId: `${record.sourceId}-tampered` }))
  ))))
  expectRejected("body", () => verifyProductionCompositeExact(isolationId, isolation, mutateChild(0, (child) => ({
    ...child, childId: `${child.childId}-tampered`,
  }))))
  expectRejected("closure", () => verifyProductionCompositeExact(isolationId, isolation, mutateChild(0, (child) => ({
    ...child, sourceClosureDigest: `sha256:${"0".repeat(64)}`,
  }))))
  expectRejected("hmac", () => verifyProductionCompositeExact(isolationId, isolation, mutateChild(0, (child) => ({
    ...child, seal: `hmac-sha256:${"0".repeat(64)}`,
  }))))

  const longId = "context.long-128/v1" as const
  const long = handles(longId)
  expectRejected("measured-bounds", () => verifyProductionCompositeExact(
    longId,
    long,
    mutateChild(0, (child) => mutateRecord(
      child,
      (record) => record.kind === "final_wire" && record.identity.callOrdinal === 1,
      (record) => ({ ...record, facts: { ...(record.facts as object), body: JSON.stringify({ messages: [] }) } }),
    )),
  ))
  expectRejected("measured-actor-class", () => verifyProductionCompositeExact(
    longId,
    long,
    mutateChild(0, (child) => ({ ...child, actorClass: "workflow_lifecycle" })),
  ))
  expectRejected("measured-divergence", () => verifyProductionCompositeExact(
    longId,
    long,
    mutateChild(0, (child) => mutateRecord(
      child,
      (record) => record.kind === "final_wire" && record.identity.callOrdinal === 2,
      (record) => ({
        ...record,
        facts: {
          ...(record.facts as object),
          cacheUnits: (record.facts as any).cacheUnits.map((unit: CacheUnit, index: number) => (
            index === 0 ? { ...unit, digest: `sha256:${"0".repeat(64)}` } : unit
          )),
        },
      }),
    )),
  ))

  const ordinaryRecoveryId = "recovery.fresh-runtime/v1" as const
  const ordinaryRecovery = handles(ordinaryRecoveryId)
  expectRejected("ordinary-recovery-call-count", () => verifyProductionCompositeExact(
    ordinaryRecoveryId, ordinaryRecovery, mutateChild(0, (child) => ({ ...child, callCount: child.callCount + 1 })),
  ))
  expectRejected("ordinary-recovery-child-count", () => verifyProductionCompositeExact(ordinaryRecoveryId, ordinaryRecovery.slice(0, 1)))
  expectRejected("ordinary-recovery-recovery-count", () => verifyProductionCompositeExact(
    ordinaryRecoveryId, ordinaryRecovery, mutateChild(1, (child) => ({ ...child, recoveryBoundary: false })),
  ))

  const resourceId = "resource.old-new-actor/v1" as const
  const resource = handles(resourceId)
  expectRejected("resource-call-count", () => verifyProductionCompositeExact(
    resourceId, resource, mutateChild(0, (child) => ({ ...child, callCount: child.callCount - 1 })),
  ))
  expectRejected("resource-child-count", () => verifyProductionCompositeExact(resourceId, resource.slice(0, -1)))
  expectRejected("resource-actor-count", () => verifyProductionCompositeExact(
    resourceId, resource, mutateChild(1, (child) => ({ ...child, actorKey: openVerifiedProductChild(resource[0]!).actorKey })),
  ))
  expectRejected("resource-session-count", () => verifyProductionCompositeExact(
    resourceId, resource, mutateChild(2, (child) => ({ ...child, sessionId: openVerifiedProductChild(resource[0]!).sessionId })),
  ))
  expectRejected("resource-recovery-count", () => verifyProductionCompositeExact(
    resourceId, resource, mutateChild(0, (child) => ({ ...child, recoveryBoundary: false })),
  ))

  const lifecycleId = "workflow.lifecycle.stable-superset/v1" as const
  const lifecycle = handles(lifecycleId)
  expectRejected("lifecycle-call-count", () => verifyProductionCompositeExact(
    lifecycleId, lifecycle, mutateChild(0, (child) => ({ ...child, callCount: 10 })),
  ))
  expectRejected("lifecycle-child-count", () => verifyProductionCompositeExact(lifecycleId, lifecycle.slice(0, 1)))
  expectRejected("lifecycle-actor", () => verifyProductionCompositeExact(
    lifecycleId, lifecycle, mutateChild(1, (child) => ({ ...child, actorId: `${child.actorId}-tampered` })),
  ))
  expectRejected("lifecycle-session", () => verifyProductionCompositeExact(
    lifecycleId, lifecycle, mutateChild(1, (child) => ({ ...child, sessionId: `${child.sessionId}-tampered` })),
  ))
  expectRejected("lifecycle-stage-count", () => verifyProductionCompositeExact(
    lifecycleId, lifecycle, mutateChild(0, (child) => ({
      ...child,
      contractFacts: { ...child.contractFacts!, lifecycleStages: child.contractFacts!.lifecycleStages.slice(0, -1) },
    })),
  ))
  expectRejected("lifecycle-terminal-count", () => verifyProductionCompositeExact(
    lifecycleId, lifecycle, mutateChild(0, (child) => ({
      ...child, contractFacts: { ...child.contractFacts!, terminalCount: 0 },
    })),
  ))
  expectRejected("lifecycle-recovery-count", () => verifyProductionCompositeExact(
    lifecycleId, lifecycle, mutateChild(1, (child) => ({ ...child, recoveryBoundary: false })),
  ))

  expectRejected("isolation-call-count", () => verifyProductionCompositeExact(
    isolationId, isolation, mutateChild(0, (child) => ({ ...child, callCount: child.callCount - 1 })),
  ))
  expectRejected("isolation-child-count", () => verifyProductionCompositeExact(isolationId, isolation.slice(0, -1)))
  expectRejected("isolation-actor-class", () => verifyProductionCompositeExact(
    isolationId, isolation, mutateChild(1, (child) => ({ ...child, actorClass: "ordinary" })),
  ))
  expectRejected("isolation-actor-count", () => verifyProductionCompositeExact(
    isolationId, isolation, mutateChild(1, (child) => ({ ...child, actorId: openVerifiedProductChild(isolation[0]!).actorId })),
  ))
  expectRejected("isolation-session-count", () => verifyProductionCompositeExact(
    isolationId, isolation, mutateChild(3, (child) => ({ ...child, sessionId: openVerifiedProductChild(isolation[0]!).sessionId })),
  ))
  expectRejected("isolation-global-ordinal", () => verifyProductionCompositeExact(
    isolationId,
    isolation,
    mutateChild(0, (child) => mutateRecord(
      child,
      (record) => record.kind === "transport_attempt" && record.identity.callOrdinal === 1,
      (record) => ({ ...record, facts: { ...(record.facts as object), globalOrdinal: 99 } }),
    )),
  ))
  if (JSON.stringify(rejected) !== JSON.stringify(COMPOSITE_ADVERSARIAL_KINDS)) {
    throw new Error(`provider_cache_product_composite_adversarial_incomplete:${JSON.stringify(rejected)}`)
  }
  return Object.freeze(rejected) as typeof COMPOSITE_ADVERSARIAL_KINDS
}

export async function runProviderCacheProductMatrix(
  input: ClosedMatrixInput,
): Promise<ProviderCacheProductMatrixResult> {
  assertClosedInput(input)
  const roots: string[] = []
  const journeys: ProviderCacheProductMatrixJourney[] = []
  let longBounds: ProductionCompositeVerification["bounds"] | null = null
  let isolationSessions = new Set<string>()
  let isolationActors = new Set<string>()
  let compositeAdversarialRejections: typeof COMPOSITE_ADVERSARIAL_KINDS | null = null
  const handlesByScenario = new Map<ProviderCacheProductProductionScenarioId, readonly ProductChildHandle[]>()
  try {
    const g4Root = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-provider-cache-g4-"))
    roots.push(g4Root)
    const g4 = await runVerifiedG4StrategySelection(g4Root)
    for (const scenarioId of PROVIDER_CACHE_PRODUCT_FROZEN_SCENARIO_IDS) {
      if ((PROVIDER_CACHE_PRODUCT_PRODUCTION_SCENARIOS as readonly string[]).includes(scenarioId)) {
        const handles = await runClosedProviderCacheProductScenario({ scenarioId: scenarioId as ProviderCacheProductProductionScenarioId })
        handlesByScenario.set(scenarioId as ProviderCacheProductProductionScenarioId, handles)
        const composite = verifyProductionCompositeExact(scenarioId as ProviderCacheProductProductionScenarioId, handles)
        const measuredActorClass = composite.openedChildren[0]!.actorClass
        const actorClass = measuredActorClass === "workflow_ctrl_node" ? "ai_ctrl_node" as const
          : measuredActorClass === "workflow_data_node" ? "ai_data_node" as const
            : measuredActorClass
        if (scenarioId === "context.long-128/v1") longBounds = composite.bounds
        if (scenarioId === "isolation.four-actors-two-sessions/v1") {
          isolationActors = new Set(composite.openedChildren.map((child) => child.actorId))
          isolationSessions = new Set(composite.openedChildren.map((child) => child.sessionId))
        }
        const requiredReason = expectedEpochReason(scenarioId)
        if (!composite.epochReasons.includes(requiredReason)) {
          throw new Error(`provider_cache_product_epoch_reason_not_observed:${scenarioId}:${requiredReason}`)
        }
        journeys.push(Object.freeze({
          scenarioId,
          actorClass,
          sessionId: composite.openedChildren[0]!.sessionId,
          actorId: composite.openedChildren[0]!.actorId,
          epochReasons: composite.epochReasons,
          normalizedInputCost: composite.lastUsage?.normalizedInputCost ?? null,
          cacheHitTokens: composite.lastUsage?.cacheHitTokens ?? null,
          cacheMissTokens: composite.lastUsage?.cacheMissTokens ?? null,
          provenance: "canonical_product_runtime",
          verified: composite.verified,
          stepCount: composite.stepCount,
          bounds: composite.bounds,
          firstDivergence: composite.firstDivergence,
          unexplainedLocalDivergences: composite.localDivergenceCount,
          childReceiptCount: composite.childReceiptCount,
          providerCallCount: composite.providerCallCount,
          recoveryStepCount: composite.recoveryStepCount,
          compositeVerified: composite.verified,
        }))
        continue
      }
    }
    compositeAdversarialRejections = assertProductionCompositeAdversarialRejections(handlesByScenario)
    const longContract = productionCompositeContract("context.long-128/v1")
    if (journeys.length !== PROVIDER_CACHE_PRODUCT_FROZEN_SCENARIO_IDS.length
      || new Set(journeys.map((journey) => journey.scenarioId)).size !== journeys.length
      || longBounds === null
      || longBounds.retainedMessages !== longContract.bounds.minimumRetainedMessages
      || longBounds.currentMessages - longBounds.retainedMessages !== longContract.expectedAppendMessages
      || isolationActors.size !== 4 || isolationSessions.size !== 2) {
      throw new Error("provider_cache_product_matrix_exact_closure_failed")
    }
    const verifiedLongBounds = longBounds
    if (!compositeAdversarialRejections) {
      throw new Error("provider_cache_product_composite_adversarial_checks_missing")
    }
    const usageRows = journeys.filter((journey) => journey.cacheHitTokens !== null)
    const fixtureUsage = Object.freeze({
      cacheHitTokens: Math.min(...usageRows.map((journey) => journey.cacheHitTokens!)),
      cacheMissTokens: Math.min(...usageRows.map((journey) => journey.cacheMissTokens!)),
      normalizedInputCost: Math.min(...usageRows.map((journey) => journey.normalizedInputCost!)),
    })
    const scenarioIds = Object.freeze(journeys.map((journey) => journey.scenarioId))
    if (JSON.stringify(scenarioIds) !== JSON.stringify(PROVIDER_CACHE_PRODUCT_FROZEN_SCENARIO_IDS)) {
      throw new Error("provider_cache_product_scenario_order_mismatch")
    }
    const unexplainedLocalDivergences = journeys.reduce(
      (sum, journey) => sum + journey.unexplainedLocalDivergences,
      0,
    )
    const structuralStatus = journeys.every((journey) => journey.verified && journey.compositeVerified)
      && unexplainedLocalDivergences === 0
      ? "PASS" as const
      : null
    if (!structuralStatus) throw new Error("provider_cache_product_structural_gate_failed")
    const strategy = WORKFLOW_SURFACE_STRATEGY_REGISTRY.resolve(g4.selection.selectedStrategyRevision)
    const isolationJourney = journeys.find((journey) => (
      journey.scenarioId === "isolation.four-actors-two-sessions/v1"
    ))
    if (!isolationJourney
      || isolationJourney.bounds.actorCount !== isolationActors.size
      || isolationJourney.bounds.sessionCount !== isolationSessions.size) {
      throw new Error("provider_cache_product_aggregate_bounds_differ_from_joined_authority")
    }
    const selectionAuthorityDigest = digestProviderCacheProductClosedValue({
      selectorRevision: g4.selection.selectorRevision,
      selectedStrategyRevision: g4.selection.selectedStrategyRevision,
      selectedStrategyDigest: g4.selection.selectedStrategyDigest,
      ranking: g4.selection.ranking,
      lifecycleStages: g4.lifecycleStages,
      providerRequestsPerStage: g4.providerRequestsPerStage,
      freshRecoveryVerified: g4.freshRecoveryVerified,
    })
    const epochReasonOrder = Object.freeze([
      "initial_projection",
      "provider_model_profile_switch",
      "history_compaction",
      "history_rewind_or_fork",
      "frozen_resource_revision_accepted",
      "provider_surface_revision_accepted",
      "legacy_context_import",
    ])
    const observedReasons = new Set(journeys.flatMap((journey) => journey.epochReasons))
    const epochReasonSequence = Object.freeze(epochReasonOrder.filter((reason) => observedReasons.has(reason)))
    if (epochReasonSequence.length !== epochReasonOrder.length) {
      throw new Error("provider_cache_product_epoch_reason_occurrence_incomplete")
    }
    const epochReasonCounts = new Map<string, number>()
    for (const reason of journeys.flatMap((journey) => journey.epochReasons)) {
      epochReasonCounts.set(reason, (epochReasonCounts.get(reason) ?? 0) + 1)
    }
    const epochReasonOccurrences = Object.freeze([...epochReasonCounts.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([reason, count]) => Object.freeze({ reason, count })))
    const actorClassOrder = Object.freeze(["ordinary", "workflow_lifecycle", "ai_ctrl_node", "ai_data_node"] as const)
    const actorClasses = Object.freeze(actorClassOrder.filter((actorClass) => (
      journeys.some((journey) => journey.actorClass === actorClass)
    )))
    if (actorClasses.length !== actorClassOrder.length) {
      throw new Error("provider_cache_product_actor_class_occurrence_incomplete")
    }
    return Object.freeze({
      schemaVersion: "eidolon.provider-cache-product-matrix/v1",
      structuralStatus,
      unexplainedLocalDivergences: unexplainedLocalDivergences as 0,
      scenarioIds: scenarioIds as typeof PROVIDER_CACHE_PRODUCT_FROZEN_SCENARIO_IDS,
      journeys: Object.freeze(journeys),
      actorClasses: actorClasses as ProviderCacheProductMatrixResult["actorClasses"],
      bounds: Object.freeze({
        actorCount: isolationJourney.bounds.actorCount as 4,
        sessionCount: isolationJourney.bounds.sessionCount as 2,
        retainedMessages: verifiedLongBounds.retainedMessages as 128,
        appendMessages: (verifiedLongBounds.currentMessages - verifiedLongBounds.retainedMessages) as 1,
      }),
      epochReasonSequence,
      strategyProof: Object.freeze({
        strategyRevision: g4.selection.selectedStrategyRevision as "stable-superset/v1",
        strategyDigest: strategy.strategyDigest,
        selectionAuthorityDigest,
        lifecycleStages: g4.lifecycleStages.length as 5,
        providerRequestsPerStage: g4.providerRequestsPerStage,
        freshRecoveryVerified: g4.freshRecoveryVerified,
        verified: (structuralStatus === "PASS") as true,
      }),
      epochReasonOccurrences,
      fixtureUsage,
      compositeAdversarialRejections,
    })
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
  }
}
