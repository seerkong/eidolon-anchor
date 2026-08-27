import { createHash } from "node:crypto"

import type { AiWorkflowStageId } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import {
  AI_WORKFLOW_PROVIDER_TOOL_SURFACE,
  AI_WORKFLOW_STAGE_TOOL_POLICY,
} from "../tools/WorkflowStageToolCatalog"

export const WORKFLOW_SURFACE_STRATEGY_REVISIONS = Object.freeze([
  "hybrid/v1",
  "stable-superset/v1",
  "stage-epoch/v1",
] as const)

export type WorkflowSurfaceStrategyRevision = (typeof WORKFLOW_SURFACE_STRATEGY_REVISIONS)[number]

export const WORKFLOW_SURFACE_EXPERIMENT_STAGES = Object.freeze([
  "planning",
  "coding",
  "building",
  "testing",
  "releasing",
] as const satisfies readonly AiWorkflowStageId[])

export type WorkflowSurfaceExperimentStage = (typeof WORKFLOW_SURFACE_EXPERIMENT_STAGES)[number]

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value)
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error("WORKFLOW_SURFACE_AUTHORITY_INVALID: array must use the built-in prototype")
    }
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new Error("WORKFLOW_SURFACE_AUTHORITY_INVALID: symbol keys are forbidden")
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const expectedKeys = Array.from({ length: value.length }, (_, index) => String(index))
    const actualKeys = (ownKeys as string[]).filter((key) => key !== "length").sort(compareCodeUnits)
    const sortedExpectedKeys = [...expectedKeys].sort(compareCodeUnits)
    if (actualKeys.length !== sortedExpectedKeys.length || actualKeys.some((key, index) => key !== sortedExpectedKeys[index])) {
      throw new Error("WORKFLOW_SURFACE_AUTHORITY_INVALID: array must be dense and contain no extra fields")
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length")
    if (!lengthDescriptor || !("value" in lengthDescriptor)
      || lengthDescriptor.value !== value.length || lengthDescriptor.enumerable
      || lengthDescriptor.configurable) {
      throw new Error("WORKFLOW_SURFACE_AUTHORITY_INVALID: array length descriptor is not standard")
    }
    return `[${expectedKeys.map((key) => {
      const descriptor = descriptors[key]!
      if (!("value" in descriptor) || !descriptor.enumerable) {
        throw new Error(`WORKFLOW_SURFACE_AUTHORITY_INVALID: array.${key} must be enumerable own-data`)
      }
      return canonicalJson(descriptor.value)
    }).join(",")}]`
  }
  if (!value || typeof value !== "object") throw new Error("WORKFLOW_SURFACE_AUTHORITY_INVALID: value is not closed JSON")
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("WORKFLOW_SURFACE_AUTHORITY_INVALID: value must be a plain own-data object")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key === "symbol")) {
    throw new Error("WORKFLOW_SURFACE_AUTHORITY_INVALID: symbol keys are forbidden")
  }
  const keys = (ownKeys as string[]).sort(compareCodeUnits)
  return `{${keys.map((key) => {
    const descriptor = descriptors[key]!
    if (!("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`WORKFLOW_SURFACE_AUTHORITY_INVALID: ${key} must be enumerable own-data`)
    }
    return `${JSON.stringify(key)}:${canonicalJson(descriptor.value)}`
  }).join(",")}}`
}

export function assertClosedWorkflowSurfaceValue(value: unknown): void {
  canonicalJson(value)
}

function assertExactClosedObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  assertClosedWorkflowSurfaceValue(value)
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`WORKFLOW_SURFACE_AUTHORITY_INVALID: ${label} must be an object`)
  }
  const keys = Reflect.ownKeys(value) as string[]
  const actual = [...keys].sort(compareCodeUnits)
  const expected = [...expectedKeys].sort(compareCodeUnits)
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`WORKFLOW_SURFACE_AUTHORITY_INVALID: ${label} contains an unknown or missing field`)
  }
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`
}

export function digestClosedWorkflowSurfaceValue(value: unknown): `sha256:${string}` {
  return digest(value)
}

const allStagePolicies = Object.values(AI_WORKFLOW_STAGE_TOOL_POLICY)
const stableControlToolNames = Object.freeze(
  AI_WORKFLOW_PROVIDER_TOOL_SURFACE.filter((name) => allStagePolicies.every((policy) => policy.includes(name as never))),
)

type WorkflowSurfaceStrategyDescriptor = Readonly<{
  strategyRevision: WorkflowSurfaceStrategyRevision
  transitionScope: "actor" | "stage"
  derivation: "code-unit-sorted-union" | "exact-stage-policy" | "stable-intersection-plus-stage-capsule"
  strategyDigest: `sha256:${string}`
}>

function strategyDescriptor(
  strategyRevision: WorkflowSurfaceStrategyRevision,
  transitionScope: WorkflowSurfaceStrategyDescriptor["transitionScope"],
  derivation: WorkflowSurfaceStrategyDescriptor["derivation"],
): WorkflowSurfaceStrategyDescriptor {
  const authority = {
    schemaVersion: "eidolon.workflow-provider-surface-strategy/v1",
    strategyRevision,
    transitionScope,
    derivation,
    union: AI_WORKFLOW_PROVIDER_TOOL_SURFACE,
    stagePolicies: AI_WORKFLOW_STAGE_TOOL_POLICY,
    stableIntersection: stableControlToolNames,
  }
  return Object.freeze({ strategyRevision, transitionScope, derivation, strategyDigest: digest(authority) })
}

const strategies = Object.freeze([
  strategyDescriptor("hybrid/v1", "stage", "stable-intersection-plus-stage-capsule"),
  strategyDescriptor("stable-superset/v1", "actor", "code-unit-sorted-union"),
  strategyDescriptor("stage-epoch/v1", "stage", "exact-stage-policy"),
])

export const WORKFLOW_SURFACE_STRATEGY_REGISTRY = Object.freeze({
  schemaVersion: "eidolon.workflow-provider-surface-strategy-registry/v1" as const,
  strategies,
  registryDigest: digest(strategies),
  resolve(strategyRevision: string): WorkflowSurfaceStrategyDescriptor {
    const strategy = strategies.find((candidate) => candidate.strategyRevision === strategyRevision)
    if (!strategy) throw new Error(`WORKFLOW_SURFACE_STRATEGY_UNAVAILABLE: ${strategyRevision}`)
    return strategy
  },
})

/** Ratified by the closed v1 experiment; changing it requires a new experiment revision. */
export const SELECTED_WORKFLOW_SURFACE_STRATEGY_REVISION = "stable-superset/v1" as const
export const SELECTED_WORKFLOW_SURFACE_STRATEGY_PROOF = Object.freeze({
  schemaVersion: "eidolon.workflow-provider-surface-strategy-ref/v1" as const,
  strategyRevision: SELECTED_WORKFLOW_SURFACE_STRATEGY_REVISION,
  strategyDigest: WORKFLOW_SURFACE_STRATEGY_REGISTRY.resolve(SELECTED_WORKFLOW_SURFACE_STRATEGY_REVISION).strategyDigest,
})

export const CLOSED_WORKFLOW_SURFACE_EXPERIMENT = Object.freeze({
  schemaVersion: "eidolon.workflow-provider-surface-experiment/v1" as const,
  strategySetDigest: WORKFLOW_SURFACE_STRATEGY_REGISTRY.registryDigest,
  strategyRevisions: WORKFLOW_SURFACE_STRATEGY_REVISIONS,
  journey: Object.freeze({
    gateway: "WorkflowAuthor" as const,
    stages: WORKFLOW_SURFACE_EXPERIMENT_STAGES,
    sameStageForwardTurns: 1 as const,
    requiredToolInvocationsPerStage: 1 as const,
  }),
  priceWeights: Object.freeze({ cacheHitWeight: 0.1 as const, cacheMissWeight: 1 as const }),
  structuralCeilings: Object.freeze({
    retainedPrefixIntegrity: 1 as const,
    ordinaryWorkflowLifecycleOnlyTokens: 0 as const,
    workflowNodeLifecycleOnlyTokens: 0 as const,
  }),
  liveCeilings: Object.freeze({
    minimumGroupHitRate: 0.85,
    minimumP50HitRate: 0.90,
    maximumP50NormalizedInputCost: 248,
    maximumP95AndGroupNormalizedInputCost: 260,
  }),
  cloneRule: "independent-fresh-clone-per-strategy" as const,
})

export type ClosedWorkflowSurfaceExperimentInput = Readonly<{
  schemaVersion: "eidolon.workflow-provider-surface-experiment-input/v1"
  frozenActorSnapshotDigest: `sha256:${string}`
  frozenConversationSnapshotDigest: `sha256:${string}`
  lifecycleToolProfileDigest: `sha256:${string}`
  lifecycleResourcePackageDigest: `sha256:${string}`
  providerProfileId: "deepseek-official-chat@1" | "deepseek-compatible-chat@1"
  model: string
  strategySetDigest: `sha256:${string}`
  journey: typeof CLOSED_WORKFLOW_SURFACE_EXPERIMENT.journey
  priceWeights: typeof CLOSED_WORKFLOW_SURFACE_EXPERIMENT.priceWeights
  cloneRule: typeof CLOSED_WORKFLOW_SURFACE_EXPERIMENT.cloneRule
  inputDigest: `sha256:${string}`
}>

function requireDigest(value: unknown, label: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`WORKFLOW_SURFACE_EXPERIMENT_INVALID: ${label} must be sha256`)
  }
  return value as `sha256:${string}`
}

export function createClosedWorkflowSurfaceExperimentInput(input: {
  frozenActorSnapshotDigest: `sha256:${string}`
  frozenConversationSnapshotDigest: `sha256:${string}`
  lifecycleToolProfileDigest: `sha256:${string}`
  lifecycleResourcePackageDigest: `sha256:${string}`
  providerProfileId: "deepseek-official-chat@1" | "deepseek-compatible-chat@1"
  model: string
}): ClosedWorkflowSurfaceExperimentInput {
  assertExactClosedObject(input, [
    "frozenActorSnapshotDigest", "frozenConversationSnapshotDigest", "lifecycleToolProfileDigest",
    "lifecycleResourcePackageDigest", "providerProfileId", "model",
  ], "experiment input material")
  const authority = Object.freeze({
    schemaVersion: "eidolon.workflow-provider-surface-experiment-input/v1" as const,
    frozenActorSnapshotDigest: requireDigest(input.frozenActorSnapshotDigest, "frozenActorSnapshotDigest"),
    frozenConversationSnapshotDigest: requireDigest(input.frozenConversationSnapshotDigest, "frozenConversationSnapshotDigest"),
    lifecycleToolProfileDigest: requireDigest(input.lifecycleToolProfileDigest, "lifecycleToolProfileDigest"),
    lifecycleResourcePackageDigest: requireDigest(input.lifecycleResourcePackageDigest, "lifecycleResourcePackageDigest"),
    providerProfileId: input.providerProfileId,
    model: input.model,
    strategySetDigest: CLOSED_WORKFLOW_SURFACE_EXPERIMENT.strategySetDigest,
    journey: CLOSED_WORKFLOW_SURFACE_EXPERIMENT.journey,
    priceWeights: CLOSED_WORKFLOW_SURFACE_EXPERIMENT.priceWeights,
    cloneRule: CLOSED_WORKFLOW_SURFACE_EXPERIMENT.cloneRule,
  })
  if (!authority.providerProfileId || !authority.model) {
    throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: provider profile and model are required")
  }
  return Object.freeze({ ...authority, inputDigest: digest(authority) })
}

export function validateClosedWorkflowSurfaceExperimentInput(value: unknown): ClosedWorkflowSurfaceExperimentInput {
  assertExactClosedObject(value, [
    "schemaVersion", "frozenActorSnapshotDigest", "frozenConversationSnapshotDigest",
    "lifecycleToolProfileDigest", "lifecycleResourcePackageDigest", "providerProfileId", "model",
    "strategySetDigest", "journey", "priceWeights", "cloneRule", "inputDigest",
  ], "experiment input")
  const input = value as ClosedWorkflowSurfaceExperimentInput
  if (input.schemaVersion !== "eidolon.workflow-provider-surface-experiment-input/v1") {
    throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: schema version")
  }
  if (input.strategySetDigest !== CLOSED_WORKFLOW_SURFACE_EXPERIMENT.strategySetDigest) {
    throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: strategy set does not match frozen authority")
  }
  if (canonicalJson(input.journey) !== canonicalJson(CLOSED_WORKFLOW_SURFACE_EXPERIMENT.journey)) {
    throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: journey does not match frozen authority")
  }
  if (canonicalJson(input.priceWeights) !== canonicalJson(CLOSED_WORKFLOW_SURFACE_EXPERIMENT.priceWeights)
    || input.cloneRule !== CLOSED_WORKFLOW_SURFACE_EXPERIMENT.cloneRule) {
    throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: weights or clone rule do not match frozen authority")
  }
  const expected = createClosedWorkflowSurfaceExperimentInput({
    frozenActorSnapshotDigest: input.frozenActorSnapshotDigest,
    frozenConversationSnapshotDigest: input.frozenConversationSnapshotDigest,
    lifecycleToolProfileDigest: input.lifecycleToolProfileDigest,
    lifecycleResourcePackageDigest: input.lifecycleResourcePackageDigest,
    providerProfileId: input.providerProfileId,
    model: input.model,
  })
  if (expected.inputDigest !== input.inputDigest) {
    throw new Error("WORKFLOW_SURFACE_EXPERIMENT_INVALID: input digest mismatch")
  }
  return input
}

export type WorkflowProviderSurfaceProjection = Readonly<{
  strategyRevision: WorkflowSurfaceStrategyRevision
  strategyDigest: `sha256:${string}`
  stage: AiWorkflowStageId
  transitionScope: "actor" | "stage"
  toolNames: readonly string[]
  stableControlToolNames: readonly string[]
  stageCapsuleToolNames: readonly string[]
  surfaceDigest: `sha256:${string}`
}>

export function projectWorkflowProviderSurface(input: {
  strategyRevision: WorkflowSurfaceStrategyRevision
  stage: AiWorkflowStageId
}): WorkflowProviderSurfaceProjection {
  const strategy = WORKFLOW_SURFACE_STRATEGY_REGISTRY.resolve(input.strategyRevision)
  const stagePolicy = AI_WORKFLOW_STAGE_TOOL_POLICY[input.stage]
  if (!stagePolicy) throw new Error(`WORKFLOW_SURFACE_STAGE_UNAVAILABLE: ${input.stage}`)
  const stableControl = input.strategyRevision === "hybrid/v1" ? stableControlToolNames : Object.freeze([])
  const stageCapsule = input.strategyRevision === "hybrid/v1"
    ? Object.freeze(stagePolicy.filter((name) => !stableControlToolNames.includes(name as never)))
    : Object.freeze([])
  const toolNames = input.strategyRevision === "stable-superset/v1"
    ? AI_WORKFLOW_PROVIDER_TOOL_SURFACE
    : input.strategyRevision === "stage-epoch/v1"
      ? Object.freeze([...stagePolicy])
      : Object.freeze([...stableControl, ...stageCapsule])
  if (toolNames.length !== new Set(toolNames).size) {
    throw new Error("WORKFLOW_SURFACE_PROJECTION_INVALID: duplicate tool name")
  }
  return Object.freeze({
    strategyRevision: input.strategyRevision,
    strategyDigest: strategy.strategyDigest,
    stage: input.stage,
    transitionScope: strategy.transitionScope,
    toolNames,
    stableControlToolNames: stableControl,
    stageCapsuleToolNames: stageCapsule,
    surfaceDigest: digest({ strategyRevision: input.strategyRevision, stage: strategy.transitionScope === "actor" ? null : input.stage, toolNames }),
  })
}

export function isExactWorkflowSurfaceStrategyProof(value: unknown): value is Readonly<{
  strategyRevision: WorkflowSurfaceStrategyRevision
  strategyDigest: `sha256:${string}`
}> {
  try {
    assertExactClosedObject(value, ["strategyRevision", "strategyDigest"], "strategy proof")
  } catch {
    return false
  }
  const proof = value as { strategyRevision?: string; strategyDigest?: string }
  try {
    return WORKFLOW_SURFACE_STRATEGY_REGISTRY.resolve(proof.strategyRevision ?? "").strategyDigest === proof.strategyDigest
  } catch {
    return false
  }
}

export const REQUIRED_TOOL_BY_EXPERIMENT_STAGE: Readonly<Record<WorkflowSurfaceExperimentStage, string>> = Object.freeze({
  planning: "WorkflowLoadStageContext",
  coding: "WorkflowLoadStageContext",
  building: "WorkflowLoadStageContext",
  testing: "WorkflowLoadStageContext",
  releasing: "WorkflowLoadStageContext",
})

export type WorkflowSurfaceEvidenceRef = Readonly<{
  schemaVersion: "eidolon.workflow-provider-surface-evidence-ref/v1"
  ownerId: `sha256:${string}`
  artifactDigest: `sha256:${string}`
}>

export type WorkflowSurfaceRawCandidateObservation = Readonly<{
  strategyRevision: WorkflowSurfaceStrategyRevision
  strategyDigest: `sha256:${string}`
  sourceSnapshotDigest: `sha256:${string}`
  cloneInstanceDigest: `sha256:${string}`
  evidenceRef: WorkflowSurfaceEvidenceRef
}>

export type WorkflowSurfaceRawExperimentReport = Readonly<{
  schemaVersion: "eidolon.workflow-provider-surface-raw-report/v2"
  experimentInputDigest: `sha256:${string}`
  strategySetDigest: `sha256:${string}`
  sourceSnapshotDigest: `sha256:${string}`
  ownerId: `sha256:${string}`
  sourceActorRef: WorkflowSurfaceEvidenceRef
  sourceConversationRef: WorkflowSurfaceEvidenceRef
  resourcePackageRef: WorkflowSurfaceEvidenceRef
  toolProfileRef: WorkflowSurfaceEvidenceRef
  strategyRegistryRef: WorkflowSurfaceEvidenceRef
  candidates: readonly WorkflowSurfaceRawCandidateObservation[]
  ownerReceipt: `hmac-sha256:${string}`
  reportDigest: `sha256:${string}`
}>
export type WorkflowSurfaceStrategySelectionCandidate = Readonly<{
  strategyRevision: WorkflowSurfaceStrategyRevision
  eligible: boolean
  rejectionReasons: readonly string[]
  normalizedJourneyCost: number
  toolSelectionErrors: number
  surfaceEpochCount: number
}>

export type WorkflowSurfaceStrategySelection = Readonly<{
  schemaVersion: "eidolon.workflow-provider-surface-selection/v1"
  rawReportDigest: `sha256:${string}`
  selectorRevision: "lowest-correct-normalized-cost/v1"
  selectedStrategyRevision: WorkflowSurfaceStrategyRevision
  selectedStrategyDigest: `sha256:${string}`
  ranking: readonly WorkflowSurfaceStrategySelectionCandidate[]
  selectionDigest: `sha256:${string}`
}>
