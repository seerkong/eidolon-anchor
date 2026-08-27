import { createHash } from "node:crypto"

import type {
  ActorRuntimeFacetCodecEntry,
  ActorRuntimeFacetEnvelope,
  ActorRuntimeFacetIndex,
  ActorRuntimeFacetRegistry,
  ActorRuntimeFacetVmRuntime,
  RuntimeSnapshotImporter,
  RuntimeSnapshotMigrationSource,
  RuntimeSnapshotPersistedState,
  AiAgentActorContract,
} from "@cell/ai-core-contract"
import {
  ActorRuntimeFacetProviderBoundaryError,
  createActorRuntimeFacetRegistry,
  replaceActorRuntimeFacet,
} from "@cell/ai-core-logic/runtime/ActorRuntimeFacet"
import {
  createActorDurableMaterial,
  readActorDurableMaterialText,
} from "@cell/ai-core-logic/runtime/ActorDurableMaterial"
import { AI_WORKFLOW_PROVIDER_TOOL_SURFACE, AI_WORKFLOW_STAGE_TOOL_POLICY } from "../tools/WorkflowStageToolCatalog"
import type { WorkflowLifecycleToolProfileRegistry } from "../tools/WorkflowLifecycleToolProfileRuntime"
import {
  parseFrozenAiWorkflowResourcePackage,
  serializeFrozenAiWorkflowResourcePackage,
  type FrozenAiWorkflowResourcePackage,
} from "@cell/ai-support/system-skill/SystemSkillInstaller"
import {
  normalizeWorkflowDomainProgressFact,
  parseWorkflowDomainProgressFact,
  type WorkflowDomainProgressTransition,
} from "./WorkflowDomainProgress"
import {
  WORKFLOW_SURFACE_STRATEGY_REGISTRY,
  isExactWorkflowSurfaceStrategyProof,
  projectWorkflowProviderSurface,
  type WorkflowSurfaceStrategyRevision,
} from "./WorkflowProviderSurfaceStrategy"

export const WORKFLOW_LIFECYCLE_FACET_ID = "eidolon.workflow-lifecycle/v1"
export const WORKFLOW_LIFECYCLE_FACET_SCHEMA_VERSION = "2"
export const WORKFLOW_LIFECYCLE_FACET_LEGACY_SCHEMA_VERSION = "1"
export const WORKFLOW_LIFECYCLE_TOOL_PROFILE_ID = "eidolon.workflow-lifecycle-tools/v1"
export const WORKFLOW_LIFECYCLE_TOOL_PROFILE_REVISION = "1"

export type WorkflowLifecycleDiagnosticEvidence =
  | Readonly<{ kind: "tool-call-digest"; actorKey: string; toolCallId: string; recordDigest: string }>
  | Readonly<{ kind: "legacy-digest"; digest: string }>

export type WorkflowLifecycleFacetValue = Readonly<{
  stageId?: string
  stageStartedAt: number
  deadlineAt: number
  turnsSinceProgress: number
  maxNoProgressTurns: number
  proofRepairAttempts: number
  maxProofRepairAttempts: number
  lastProgressAt: number
  lastOutcome?: string
  activeAuthoringSessionId?: string
  activeAuthoringRevision?: string
  systemSkill: Readonly<{
    skillName: "sys-eidolon-anchor-devops"
    materialDigest: string
    sourceRevision?: string
    provenanceDigest: string
  }>
  toolProfile: Readonly<{
    profileId: typeof WORKFLOW_LIFECYCLE_TOOL_PROFILE_ID
    profileRevision: typeof WORKFLOW_LIFECYCLE_TOOL_PROFILE_REVISION
    admittedNamesDigest: string
  }>
  resourcePackage: Readonly<{
    schemaVersion: "eidolon.ai-workflow-resource-package-ref/v1"
    revision: string
    packageDigest: string
    materialDigest: string
    provenanceDigest: string
  }>
  providerSurfaceStrategy: Readonly<{
    schemaVersion: "eidolon.workflow-provider-surface-strategy-ref/v1"
    strategyRevision: WorkflowSurfaceStrategyRevision
    strategyDigest: string
  }>
  lastDiagnosticEvidence?: WorkflowLifecycleDiagnosticEvidence
}>

const VALUE_KEYS = new Set([
  "stageId", "stageStartedAt", "deadlineAt", "turnsSinceProgress", "maxNoProgressTurns",
  "proofRepairAttempts", "maxProofRepairAttempts", "lastProgressAt", "lastOutcome",
  "activeAuthoringSessionId", "activeAuthoringRevision", "systemSkill", "toolProfile",
  "resourcePackage", "providerSurfaceStrategy", "lastDiagnosticEvidence",
])

const LEGACY_VALUE_KEYS = new Set([...VALUE_KEYS].filter((key) => key !== "providerSurfaceStrategy"))

function fail(reason: string): never {
  throw new Error(`WORKFLOW_LIFECYCLE_FACET_INVALID: ${reason}`)
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a plain object`)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`)
  if (Object.getOwnPropertySymbols(value).length > 0) fail(`${label} contains symbol fields`)
  const result: Record<string, unknown> = {}
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail(`${label}.${key} must be an enumerable data field`)
    }
    result[key] = descriptor.value
  }
  return result
}

function exactKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(record)) if (!allowed.has(key)) fail(`${label}.${key} is not allowed`)
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`)
  return value
}

function prefixedSha256(value: unknown, label: string): string {
  const digest = nonEmptyString(value, label)
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) fail(`${label} must be a sha256 digest`)
  return digest
}

function materialSha256(value: unknown, label: string): string {
  const digest = nonEmptyString(value, label)
  if (!/^[a-f0-9]{64}$/.test(digest)) fail(`${label} must be a material sha256 digest`)
  return digest
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be finite`)
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  const number = finiteNumber(value, label)
  if (!Number.isSafeInteger(number) || number < 0) fail(`${label} must be a non-negative safe integer`)
  return number
}

function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function normalizeResourcePackage(value: unknown): WorkflowLifecycleFacetValue["resourcePackage"] {
  const resourcePackage = plainRecord(value, "resourcePackage")
  exactKeys(resourcePackage, new Set(["schemaVersion", "revision", "packageDigest", "materialDigest", "provenanceDigest"]), "resourcePackage")
  if (resourcePackage.schemaVersion !== "eidolon.ai-workflow-resource-package-ref/v1") {
    fail("resourcePackage.schemaVersion is unsupported")
  }
  return Object.freeze({
    schemaVersion: "eidolon.ai-workflow-resource-package-ref/v1",
    revision: nonEmptyString(resourcePackage.revision, "resourcePackage.revision"),
    packageDigest: prefixedSha256(resourcePackage.packageDigest, "resourcePackage.packageDigest"),
    materialDigest: materialSha256(resourcePackage.materialDigest, "resourcePackage.materialDigest"),
    provenanceDigest: prefixedSha256(resourcePackage.provenanceDigest, "resourcePackage.provenanceDigest"),
  })
}

function normalizeProviderSurfaceStrategy(value: unknown): WorkflowLifecycleFacetValue["providerSurfaceStrategy"] {
  const proof = plainRecord(value, "providerSurfaceStrategy")
  exactKeys(proof, new Set(["schemaVersion", "strategyRevision", "strategyDigest"]), "providerSurfaceStrategy")
  if (proof.schemaVersion !== "eidolon.workflow-provider-surface-strategy-ref/v1") {
    fail("providerSurfaceStrategy.schemaVersion is unsupported")
  }
  const candidate = {
    strategyRevision: nonEmptyString(proof.strategyRevision, "providerSurfaceStrategy.strategyRevision"),
    strategyDigest: prefixedSha256(proof.strategyDigest, "providerSurfaceStrategy.strategyDigest"),
  }
  if (!isExactWorkflowSurfaceStrategyProof(candidate)) {
    fail("providerSurfaceStrategy strategy revision/digest is unavailable or conflicting")
  }
  return Object.freeze({
    schemaVersion: "eidolon.workflow-provider-surface-strategy-ref/v1",
    strategyRevision: candidate.strategyRevision,
    strategyDigest: candidate.strategyDigest,
  })
}

export function digestWorkflowLifecycleEvidence(value: string): string {
  return sha256(value)
}

function normalizeDiagnostic(value: unknown): WorkflowLifecycleDiagnosticEvidence | undefined {
  if (value === undefined) return undefined
  const record = plainRecord(value, "lastDiagnosticEvidence")
  if (record.kind === "legacy-digest") {
    exactKeys(record, new Set(["kind", "digest"]), "lastDiagnosticEvidence")
    return Object.freeze({ kind: "legacy-digest", digest: nonEmptyString(record.digest, "lastDiagnosticEvidence.digest") })
  }
  if (record.kind === "tool-call-digest") {
    exactKeys(record, new Set(["kind", "actorKey", "toolCallId", "recordDigest"]), "lastDiagnosticEvidence")
    return Object.freeze({
      kind: "tool-call-digest",
      actorKey: nonEmptyString(record.actorKey, "lastDiagnosticEvidence.actorKey"),
      toolCallId: nonEmptyString(record.toolCallId, "lastDiagnosticEvidence.toolCallId"),
      recordDigest: nonEmptyString(record.recordDigest, "lastDiagnosticEvidence.recordDigest"),
    })
  }
  return fail("lastDiagnosticEvidence.kind is unsupported")
}

export function normalizeWorkflowLifecycleFacetValue(value: unknown): WorkflowLifecycleFacetValue {
  const record = plainRecord(value, "value")
  exactKeys(record, VALUE_KEYS, "value")
  const systemSkill = plainRecord(record.systemSkill, "systemSkill")
  exactKeys(systemSkill, new Set(["skillName", "materialDigest", "sourceRevision", "provenanceDigest"]), "systemSkill")
  if (systemSkill.skillName !== "sys-eidolon-anchor-devops") fail("systemSkill.skillName is unsupported")
  const toolProfile = plainRecord(record.toolProfile, "toolProfile")
  exactKeys(toolProfile, new Set(["profileId", "profileRevision", "admittedNamesDigest"]), "toolProfile")
  if (toolProfile.profileId !== WORKFLOW_LIFECYCLE_TOOL_PROFILE_ID) fail("toolProfile.profileId is unsupported")
  if (toolProfile.profileRevision !== WORKFLOW_LIFECYCLE_TOOL_PROFILE_REVISION) fail("toolProfile.profileRevision is unsupported")

  const result: WorkflowLifecycleFacetValue = {
    ...(record.stageId === undefined ? {} : { stageId: nonEmptyString(record.stageId, "stageId") }),
    stageStartedAt: finiteNumber(record.stageStartedAt, "stageStartedAt"),
    deadlineAt: finiteNumber(record.deadlineAt, "deadlineAt"),
    turnsSinceProgress: nonNegativeInteger(record.turnsSinceProgress, "turnsSinceProgress"),
    maxNoProgressTurns: nonNegativeInteger(record.maxNoProgressTurns, "maxNoProgressTurns"),
    proofRepairAttempts: nonNegativeInteger(record.proofRepairAttempts, "proofRepairAttempts"),
    maxProofRepairAttempts: nonNegativeInteger(record.maxProofRepairAttempts, "maxProofRepairAttempts"),
    lastProgressAt: finiteNumber(record.lastProgressAt, "lastProgressAt"),
    ...(record.lastOutcome === undefined ? {} : { lastOutcome: nonEmptyString(record.lastOutcome, "lastOutcome") }),
    ...(record.activeAuthoringSessionId === undefined ? {} : { activeAuthoringSessionId: nonEmptyString(record.activeAuthoringSessionId, "activeAuthoringSessionId") }),
    ...(record.activeAuthoringRevision === undefined ? {} : { activeAuthoringRevision: nonEmptyString(record.activeAuthoringRevision, "activeAuthoringRevision") }),
    systemSkill: Object.freeze({
      skillName: "sys-eidolon-anchor-devops",
      materialDigest: nonEmptyString(systemSkill.materialDigest, "systemSkill.materialDigest"),
      ...(systemSkill.sourceRevision === undefined ? {} : { sourceRevision: nonEmptyString(systemSkill.sourceRevision, "systemSkill.sourceRevision") }),
      provenanceDigest: nonEmptyString(systemSkill.provenanceDigest, "systemSkill.provenanceDigest"),
    }),
    toolProfile: Object.freeze({
      profileId: WORKFLOW_LIFECYCLE_TOOL_PROFILE_ID,
      profileRevision: WORKFLOW_LIFECYCLE_TOOL_PROFILE_REVISION,
      admittedNamesDigest: nonEmptyString(toolProfile.admittedNamesDigest, "toolProfile.admittedNamesDigest"),
    }),
    resourcePackage: normalizeResourcePackage(record.resourcePackage),
    providerSurfaceStrategy: normalizeProviderSurfaceStrategy(record.providerSurfaceStrategy),
    ...(record.lastDiagnosticEvidence === undefined ? {} : { lastDiagnosticEvidence: normalizeDiagnostic(record.lastDiagnosticEvidence) }),
  }
  return Object.freeze(result)
}

function normalizeLegacyWorkflowLifecycleFacetValue(value: unknown): Omit<WorkflowLifecycleFacetValue, "providerSurfaceStrategy"> {
  const record = plainRecord(value, "value")
  exactKeys(record, LEGACY_VALUE_KEYS, "value")
  const stable = WORKFLOW_SURFACE_STRATEGY_REGISTRY.resolve("stable-superset/v1")
  const migrated = normalizeWorkflowLifecycleFacetValue({
    ...record,
    providerSurfaceStrategy: {
      schemaVersion: "eidolon.workflow-provider-surface-strategy-ref/v1",
      strategyRevision: stable.strategyRevision,
      strategyDigest: stable.strategyDigest,
    },
  })
  const { providerSurfaceStrategy: _removed, ...legacy } = migrated
  return Object.freeze(legacy)
}

function reduceAfterToolOutcome(
  current: WorkflowLifecycleFacetValue,
  event: Extract<import("@cell/ai-core-contract").ActorRuntimeFacetEvent, { kind: "afterToolOutcome" }>,
  actorKey: string,
): WorkflowLifecycleFacetValue | null {
  const evidence: WorkflowLifecycleDiagnosticEvidence = Object.freeze({
    kind: "tool-call-digest",
    actorKey,
    toolCallId: event.toolCallId,
    recordDigest: event.recordDigest,
  })
  let next: WorkflowLifecycleFacetValue = { ...current, lastDiagnosticEvidence: evidence }
  const failed = event.isError
  const isProofTool = event.toolName === "WorkflowValidateAuthoringSession"
    || event.toolName === "WorkflowDryRunAuthoringSession"

  if (isProofTool && failed) {
    next = { ...next, proofRepairAttempts: next.proofRepairAttempts + 1 }
    if (next.proofRepairAttempts > next.maxProofRepairAttempts) {
      throw new Error(
        `workflow_proof_repair_exhausted: stage=${next.stageId ?? "testing"} exhausted ${next.maxProofRepairAttempts} proof repair attempts; workspace is preserved`,
      )
    }
    return next
  }

  if (failed) return next
  if (event.ownerFact === undefined) return null
  const fact = normalizeWorkflowDomainProgressFact(event.ownerFact)
  if (!fact) fail("afterToolOutcome.ownerFact is not a closed Workflow progress fact")
  const outcomeByTransition: Readonly<Record<WorkflowDomainProgressTransition, string>> = {
    workspace_opened: "workspace_opened",
    workspace_revision_changed: "workspace_changed",
    candidate_diagnostic: "candidate_diagnostic",
    proof_prepared: "proof",
    lifecycle_completed: "lifecycle_changed",
    publication_created: "published",
    instance_prepared: "prepared",
    run_started: "running",
    run_advanced: "running",
    result_observed: "result",
  }
  const outcome = outcomeByTransition[fact.transition]
  if (fact.transition === "candidate_diagnostic") {
    next = {
      ...next,
      turnsSinceProgress: 0,
      lastProgressAt: event.occurredAt,
      lastOutcome: outcome,
      proofRepairAttempts: next.proofRepairAttempts + 1,
    }
    if (next.proofRepairAttempts > next.maxProofRepairAttempts) {
      throw new Error(
        `workflow_proof_repair_exhausted: stage=${next.stageId ?? "coding"} exhausted ${next.maxProofRepairAttempts} candidate repair attempts`,
      )
    }
    return next
  }

  const { lastDiagnosticEvidence: _diagnostic, ...withoutDiagnostic } = next
  next = {
    ...withoutDiagnostic,
    turnsSinceProgress: 0,
    lastProgressAt: event.occurredAt,
    lastOutcome: outcome,
    ...(fact.owner === "workflow.authoring"
      ? { activeAuthoringSessionId: fact.subjectId, activeAuthoringRevision: fact.revision }
      : {}),
    ...(outcome === "proof" ? { proofRepairAttempts: 0 } : {}),
  }
  return next
}

export const WORKFLOW_LIFECYCLE_FACET_CODEC: ActorRuntimeFacetCodecEntry = Object.freeze({
  facetId: WORKFLOW_LIFECYCLE_FACET_ID,
  schemaVersion: WORKFLOW_LIFECYCLE_FACET_SCHEMA_VERSION,
  normalize: normalizeWorkflowLifecycleFacetValue,
  projectAfterToolOutcome: (input) => input.isError
    ? undefined
    : parseWorkflowDomainProgressFact(input.outputText),
  onEvent: (context) => {
    const current = normalizeWorkflowLifecycleFacetValue(context.envelope.value)
    if (context.event.kind === "aroundProvider") {
      if (context.event.occurredAt >= current.deadlineAt) {
        throw new Error(`workflow_stage_deadline: stage=${current.stageId ?? "unselected"} provider attempt started after deadline`)
      }
      return null
    }
    if (context.event.kind === "afterToolOutcome") {
      const next = reduceAfterToolOutcome(current, context.event, context.selector.actorKey)
      return next === null
        ? null
        : Object.freeze({
            expectedRevision: context.envelope.revision,
            nextValue: next,
            reason: "workflow_after_tool_outcome",
          })
    }
    if (context.event.kind !== "beforeTurn") return null
    if (context.event.occurredAt >= current.deadlineAt) {
      throw new Error(`workflow_stage_deadline: stage=${current.stageId ?? "unselected"} exceeded deadline`)
    }
    const turnsSinceProgress = current.turnsSinceProgress + 1
    if (turnsSinceProgress > current.maxNoProgressTurns) {
      throw new Error(`workflow_no_progress: stage=${current.stageId ?? "unselected"} produced no progress for ${turnsSinceProgress} turns`)
    }
    return Object.freeze({
      expectedRevision: context.envelope.revision,
      nextValue: { ...current, turnsSinceProgress },
      reason: "workflow_before_turn",
    })
  },
  aroundProvider: async (context, runtime) => {
    const current = normalizeWorkflowLifecycleFacetValue(context.envelope.value)
    const remaining = current.deadlineAt - context.event.occurredAt
    if (remaining <= 0) {
      throw new ActorRuntimeFacetProviderBoundaryError(
        WORKFLOW_LIFECYCLE_FACET_ID,
        "workflow_stage_deadline: provider request started after the stage deadline",
      )
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        runtime.providerBoundary.run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            runtime.providerBoundary.abort("workflow_stage_deadline")
            reject(new ActorRuntimeFacetProviderBoundaryError(
              WORKFLOW_LIFECYCLE_FACET_ID,
              "workflow_stage_deadline: provider request exceeded the interactive stage deadline",
            ))
          }, remaining)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  },
})

export const WORKFLOW_LIFECYCLE_FACET_V1_IMPORT_CODEC: ActorRuntimeFacetCodecEntry = Object.freeze({
  facetId: WORKFLOW_LIFECYCLE_FACET_ID,
  schemaVersion: WORKFLOW_LIFECYCLE_FACET_LEGACY_SCHEMA_VERSION,
  normalize: normalizeLegacyWorkflowLifecycleFacetValue,
})

export function createWorkflowLifecycleFacetRegistry(): ActorRuntimeFacetRegistry {
  return createActorRuntimeFacetRegistry([
    WORKFLOW_LIFECYCLE_FACET_V1_IMPORT_CODEC,
    WORKFLOW_LIFECYCLE_FACET_CODEC,
  ])
}

export function extendWorkflowLifecycleFacetRegistry(
  registry: ActorRuntimeFacetRegistry,
): ActorRuntimeFacetRegistry {
  const lifecycle = registry.entries.filter((entry) => entry.facetId === WORKFLOW_LIFECYCLE_FACET_ID)
  for (const present of lifecycle) {
    if (present.schemaVersion !== WORKFLOW_LIFECYCLE_FACET_SCHEMA_VERSION
      && present.schemaVersion !== WORKFLOW_LIFECYCLE_FACET_LEGACY_SCHEMA_VERSION) {
      fail(`registry contains conflicting schema ${present.schemaVersion}`)
    }
  }
  const entries = [...registry.entries]
  if (!lifecycle.some((entry) => entry.schemaVersion === WORKFLOW_LIFECYCLE_FACET_LEGACY_SCHEMA_VERSION)) {
    entries.push(WORKFLOW_LIFECYCLE_FACET_V1_IMPORT_CODEC)
  }
  if (!lifecycle.some((entry) => entry.schemaVersion === WORKFLOW_LIFECYCLE_FACET_SCHEMA_VERSION)) {
    entries.push(WORKFLOW_LIFECYCLE_FACET_CODEC)
  }
  return entries.length === registry.entries.length ? registry : createActorRuntimeFacetRegistry(entries)
}

function sourceRevisionFromSkill(material: string): string | undefined {
  const match = material.match(/^revision:\s*(\S+)\s*$/m)
  return match?.[1]
}

export function resolveWorkflowLifecycleFrozenResourcePackage(input: {
  systemPrompts: readonly string[]
  resourcePackage?: FrozenAiWorkflowResourcePackage
}): FrozenAiWorkflowResourcePackage {
  if (input.resourcePackage) return input.resourcePackage
  const managed = input.systemPrompts.filter((prompt) => /^name:\s*sys-eidolon-anchor-devops\s*$/m.test(prompt))
  if (managed.length !== 1) fail("exactly one managed sys-eidolon-anchor-devops Skill material is required")
  const material = managed[0]!
  const resources = Object.freeze({ "sys-eidolon-anchor-devops/SKILL.md": material })
  return Object.freeze({
    schemaVersion: "eidolon.ai-workflow-resource-package/v1",
    revision: sourceRevisionFromSkill(material) ?? sha256(material),
    digest: sha256(`sys-eidolon-anchor-devops/SKILL.md\0${sha256(material)}\0`),
    resources,
  })
}

export function createWorkflowLifecycleResourcePackageMaterial(resourcePackage: FrozenAiWorkflowResourcePackage) {
  return createActorDurableMaterial(
    serializeFrozenAiWorkflowResourcePackage(resourcePackage),
    "application/vnd.eidolon.ai-workflow-resource-package+json",
  )
}

export function readWorkflowLifecycleFrozenResourcePackage(input: {
  actor: Pick<AiAgentActorContract, "durableMaterials">
  facet: WorkflowLifecycleFacetValue
}): FrozenAiWorkflowResourcePackage {
  const serialized = readActorDurableMaterialText(input.actor, input.facet.resourcePackage.materialDigest)
  const resourcePackage = parseFrozenAiWorkflowResourcePackage(serialized)
  if (resourcePackage.revision !== input.facet.resourcePackage.revision
    || resourcePackage.digest !== input.facet.resourcePackage.packageDigest
    || sha256(`actor-durable-material\0${serialized}`) !== input.facet.resourcePackage.provenanceDigest) {
    fail("frozen resource package reference mismatch")
  }
  return resourcePackage
}

export function createWorkflowLifecycleFacetEnvelope(input: {
  systemPrompts: readonly string[]
  toolNames: readonly string[]
  strategyRevision: WorkflowSurfaceStrategyRevision
  resourcePackage?: FrozenAiWorkflowResourcePackage
  progress: Omit<WorkflowLifecycleFacetValue, "systemSkill" | "toolProfile" | "resourcePackage" | "providerSurfaceStrategy" | "lastDiagnosticEvidence"> & {
    lastDiagnosticEvidence?: WorkflowLifecycleDiagnosticEvidence
  }
}): ActorRuntimeFacetEnvelope {
  const managed = input.systemPrompts.filter((prompt) => /^name:\s*sys-eidolon-anchor-devops\s*$/m.test(prompt))
  if (managed.length !== 1) fail("exactly one managed sys-eidolon-anchor-devops Skill material is required")
  const canonicalTools = [...input.toolNames].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  if (canonicalTools.length !== new Set(canonicalTools).size) fail("toolNames must be unique")
  const material = managed[0]!
  const resourcePackage = resolveWorkflowLifecycleFrozenResourcePackage(input)
  const surfaceStrategy = WORKFLOW_SURFACE_STRATEGY_REGISTRY.resolve(input.strategyRevision)
  const packageMaterial = createWorkflowLifecycleResourcePackageMaterial(resourcePackage)
  const serializedPackage = serializeFrozenAiWorkflowResourcePackage(resourcePackage)
  const value = normalizeWorkflowLifecycleFacetValue({
    ...input.progress,
    systemSkill: {
      skillName: "sys-eidolon-anchor-devops",
      materialDigest: sha256(material),
      ...(sourceRevisionFromSkill(material) ? { sourceRevision: sourceRevisionFromSkill(material) } : {}),
      provenanceDigest: sha256(`snapshot-system-prompt\0${material}`),
    },
    toolProfile: {
      profileId: WORKFLOW_LIFECYCLE_TOOL_PROFILE_ID,
      profileRevision: WORKFLOW_LIFECYCLE_TOOL_PROFILE_REVISION,
      admittedNamesDigest: sha256(canonicalTools.join("\n")),
    },
    resourcePackage: {
      schemaVersion: "eidolon.ai-workflow-resource-package-ref/v1",
      revision: resourcePackage.revision,
      packageDigest: resourcePackage.digest,
      materialDigest: packageMaterial.digest,
      provenanceDigest: sha256(`actor-durable-material\0${serializedPackage}`),
    },
    providerSurfaceStrategy: {
      schemaVersion: "eidolon.workflow-provider-surface-strategy-ref/v1",
      strategyRevision: surfaceStrategy.strategyRevision,
      strategyDigest: surfaceStrategy.strategyDigest,
    },
  })
  return Object.freeze({
    facetId: WORKFLOW_LIFECYCLE_FACET_ID,
    schemaVersion: WORKFLOW_LIFECYCLE_FACET_SCHEMA_VERSION,
    revision: 0,
    value,
  })
}

export function readWorkflowLifecycleFacet(actor: Pick<AiAgentActorContract, "runtimeFacets">): WorkflowLifecycleFacetValue | undefined {
  const envelope = actor.runtimeFacets?.[WORKFLOW_LIFECYCLE_FACET_ID]
  if (!envelope) return undefined
  if (envelope.schemaVersion === WORKFLOW_LIFECYCLE_FACET_LEGACY_SCHEMA_VERSION) {
    fail("facet-v1 requires the explicit one-way v2 importer before admission")
  }
  if (envelope.schemaVersion !== WORKFLOW_LIFECYCLE_FACET_SCHEMA_VERSION) {
    fail(`unsupported schemaVersion ${envelope.schemaVersion}`)
  }
  return normalizeWorkflowLifecycleFacetValue(envelope.value)
}

export function migrateWorkflowLifecycleFacetV1(actor: {
  runtimeFacets: ActorRuntimeFacetIndex
  toolPolicy?: {
    providerToolSurface?: { mode: "all" | "exact"; toolNames: string[] }
  }
}): boolean {
  const envelope = actor.runtimeFacets?.[WORKFLOW_LIFECYCLE_FACET_ID]
  if (!envelope) return false
  if (envelope.schemaVersion === WORKFLOW_LIFECYCLE_FACET_SCHEMA_VERSION) {
    normalizeWorkflowLifecycleFacetValue(envelope.value)
    return false
  }
  if (envelope.schemaVersion !== WORKFLOW_LIFECYCLE_FACET_LEGACY_SCHEMA_VERSION) {
    fail(`unsupported schemaVersion ${envelope.schemaVersion}`)
  }
  const surface = actor.toolPolicy?.providerToolSurface
  if (surface?.mode !== "exact" || !exactArray(surface.toolNames, AI_WORKFLOW_PROVIDER_TOOL_SURFACE)) {
    fail("facet-v1 importer requires the exact stable-superset provider surface witness")
  }
  const legacy = normalizeLegacyWorkflowLifecycleFacetValue(envelope.value)
  const strategy = WORKFLOW_SURFACE_STRATEGY_REGISTRY.resolve("stable-superset/v1")
  const nextValue = normalizeWorkflowLifecycleFacetValue({
    ...legacy,
    providerSurfaceStrategy: {
      schemaVersion: "eidolon.workflow-provider-surface-strategy-ref/v1",
      strategyRevision: strategy.strategyRevision,
      strategyDigest: strategy.strategyDigest,
    },
  })
  actor.runtimeFacets = Object.freeze({
    ...actor.runtimeFacets,
    [WORKFLOW_LIFECYCLE_FACET_ID]: Object.freeze({
      facetId: WORKFLOW_LIFECYCLE_FACET_ID,
      schemaVersion: WORKFLOW_LIFECYCLE_FACET_SCHEMA_VERSION,
      revision: envelope.revision + 1,
      value: nextValue,
    }),
  })
  return true
}

export function assertWorkflowLifecycleActorCapability(input: {
  actor: Pick<AiAgentActorContract, "runtimeFacets" | "systemPrompts" | "toolPolicy" | "durableMaterials">
  profileRegistry: WorkflowLifecycleToolProfileRegistry
}): WorkflowLifecycleFacetValue {
  const facet = readWorkflowLifecycleFacet(input.actor)
  if (!facet) fail("facet proof is required")
  const managed = input.actor.systemPrompts.filter((prompt) => (
    /^name:\s*sys-eidolon-anchor-devops\s*$/m.test(prompt)
  ))
  if (managed.length !== 1) fail("exactly one delivered managed Skill material is required")
  const material = managed[0]!
  if (facet.systemSkill.materialDigest !== sha256(material)) {
    fail("Skill material digest mismatch")
  }
  if (facet.systemSkill.provenanceDigest !== sha256(`snapshot-system-prompt\0${material}`)) {
    fail("Skill provenance digest mismatch")
  }
  if (facet.systemSkill.sourceRevision !== sourceRevisionFromSkill(material)) {
    fail("Skill source revision mismatch")
  }
  const resourcePackage = readWorkflowLifecycleFrozenResourcePackage({ actor: input.actor, facet })
  if (resourcePackage.resources["sys-eidolon-anchor-devops/SKILL.md"] !== material) {
    fail("frozen resource package Skill material mismatch")
  }
  const profile = input.profileRegistry.resolve(
    facet.toolProfile.profileId,
    facet.toolProfile.profileRevision,
  )
  if (profile.admittedNamesDigest !== facet.toolProfile.admittedNamesDigest) {
    fail("tool profile admitted names digest mismatch")
  }
  const stage = (facet.stageId ?? "planning") as keyof typeof AI_WORKFLOW_STAGE_TOOL_POLICY
  if (!AI_WORKFLOW_STAGE_TOOL_POLICY[stage]) fail(`unsupported provider surface stage '${stage}'`)
  const projected = projectWorkflowProviderSurface({
    strategyRevision: facet.providerSurfaceStrategy.strategyRevision,
    stage,
  })
  const surface = input.actor.toolPolicy.providerToolSurface
  if (surface?.mode !== "exact" || !exactArray(surface.toolNames, projected.toolNames)) {
    fail("provider surface presentation does not match the frozen strategy")
  }
  return facet
}

export function replaceWorkflowLifecycleFacet(
  actor: Pick<AiAgentActorContract, "runtimeFacets">,
  value: WorkflowLifecycleFacetValue,
  options: Readonly<{
    runtime?: ActorRuntimeFacetVmRuntime
    actorKey?: string
    expectedRevision?: number
    reason?: string
  }> = {},
): WorkflowLifecycleFacetValue {
  const current = actor.runtimeFacets[WORKFLOW_LIFECYCLE_FACET_ID]
  if (!current) fail("facet proof is required")
  const currentValue = readWorkflowLifecycleFacet(actor)
  const nextValue = normalizeWorkflowLifecycleFacetValue(value)
  if (!currentValue || currentValue.providerSurfaceStrategy.strategyRevision !== nextValue.providerSurfaceStrategy.strategyRevision
    || currentValue.providerSurfaceStrategy.strategyDigest !== nextValue.providerSurfaceStrategy.strategyDigest) {
    fail("provider surface strategy is frozen for the Actor lifetime")
  }
  const actorKey = options.actorKey ?? (actor as { key?: string }).key ?? "__workflow_lifecycle_actor__"
  const runtime = options.runtime ?? {
    actors: { [actorKey]: actor as { key: string; runtimeFacets: ActorRuntimeFacetIndex } },
    runtimeContext: { actorFacetRuntime: createWorkflowLifecycleFacetRegistry() },
  }
  const next = replaceActorRuntimeFacet(
    runtime,
    { actorKey, facetId: WORKFLOW_LIFECYCLE_FACET_ID },
    {
      expectedRevision: options.expectedRevision ?? current.revision,
      nextValue,
      reason: options.reason ?? "workflow_lifecycle_transition",
    },
    {},
  )
  return normalizeWorkflowLifecycleFacetValue(next.value)
}

function exactArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

function legacyToolWitness(actor: Record<string, any>): boolean {
  const surface = actor.toolPolicy?.providerToolSurface
  if (surface?.mode === "exact" && Array.isArray(surface.toolNames)
    && exactArray(surface.toolNames, AI_WORKFLOW_PROVIDER_TOOL_SURFACE)) return true
  const allowed = actor.toolPolicy?.allowedTools
  return Array.isArray(allowed) && Object.values(AI_WORKFLOW_STAGE_TOOL_POLICY)
    .some((stageTools) => exactArray(allowed, stageTools))
}

function migrationFail(actorKey: string, reason: string): never {
  throw new Error(`WORKFLOW_LIFECYCLE_MIGRATION_WITNESS: actor=${actorKey} ${reason}`)
}

function importWorkflowActor(actorKey: string, actor: Record<string, any>): Record<string, any> {
  const legacy = actor.workflowProgress
  const hasWorkflowIdentity = actor.agentName === "workflow"
  if (!hasWorkflowIdentity && legacy === undefined) return { ...actor, version: 4 }
  if (!hasWorkflowIdentity || legacy === undefined) migrationFail(actorKey, "workflow identity and progress must be present together")
  if (actor.type !== "delegate" || typeof actor.parentKey !== "string" || !actor.parentKey) migrationFail(actorKey, "delegate parent witness is missing")
  const legacyProviderContextClass = (actor as typeof actor & { providerContextClass?: unknown }).providerContextClass
  if (legacyProviderContextClass !== undefined && legacyProviderContextClass !== "workflow_lifecycle") migrationFail(actorKey, "provider context conflicts")
  if (!legacyToolWitness(actor)) migrationFail(actorKey, "frozen provider surface or stage policy is missing")
  if (actor.runtimeFacets && Object.keys(actor.runtimeFacets).length > 0) migrationFail(actorKey, "legacy facet state is ambiguous")
  let progress: WorkflowLifecycleFacetValue
  let durableMaterials: Record<string, ReturnType<typeof createWorkflowLifecycleResourcePackageMaterial>>
  try {
    const legacyRecord = plainRecord(legacy, "legacy workflowProgress")
    exactKeys(legacyRecord, new Set([
      "stageId", "stageStartedAt", "deadlineAt", "turnsSinceProgress", "maxNoProgressTurns",
      "proofRepairAttempts", "maxProofRepairAttempts", "lastProgressAt", "lastOutcome",
      "lastDiagnostic", "activeAuthoringSessionId", "activeAuthoringRevision",
    ]), "legacy workflowProgress")
    const diagnostic = legacyRecord.lastDiagnostic
    delete legacyRecord.lastDiagnostic
    const systemPrompts = Array.isArray(actor.systemPrompts) ? actor.systemPrompts : []
    const resourcePackage = resolveWorkflowLifecycleFrozenResourcePackage({ systemPrompts })
    const packageMaterial = createWorkflowLifecycleResourcePackageMaterial(resourcePackage)
    durableMaterials = { [packageMaterial.digest]: packageMaterial }
    progress = createWorkflowLifecycleFacetEnvelope({
      systemPrompts,
      toolNames: AI_WORKFLOW_PROVIDER_TOOL_SURFACE,
      strategyRevision: "stable-superset/v1",
      resourcePackage,
      progress: {
        ...(legacyRecord as any),
        ...(typeof diagnostic === "string" && diagnostic.length > 0
          ? { lastDiagnosticEvidence: { kind: "legacy-digest", digest: sha256(diagnostic) } }
          : {}),
      },
    }).value as WorkflowLifecycleFacetValue
  } catch (error) {
    migrationFail(actorKey, error instanceof Error ? error.message : String(error))
  }
  const { workflowProgress: _removed, ...retained } = actor
  return {
    ...retained,
    version: 4,
    runtimeFacets: {
      [WORKFLOW_LIFECYCLE_FACET_ID]: {
        facetId: WORKFLOW_LIFECYCLE_FACET_ID,
        schemaVersion: WORKFLOW_LIFECYCLE_FACET_SCHEMA_VERSION,
        revision: 0,
        value: progress,
      },
    },
    durableMaterials,
  }
}

export function createWorkflowLifecycleSnapshotImporter(): RuntimeSnapshotImporter {
  return Object.freeze({
    migrationId: "eidolon.workflow-lifecycle/v3-to-v4",
    sourceVersion: 3,
    targetVersion: 4,
    importSnapshot(source: RuntimeSnapshotMigrationSource): RuntimeSnapshotPersistedState {
      if (source.sourceVersion !== 3 || source.snapshot.manifest.version !== 3) {
        throw new Error("WORKFLOW_LIFECYCLE_MIGRATION_WITNESS: trusted schema-v3 manifest is required")
      }
      const actors = Object.fromEntries(Object.entries(source.snapshot.actors).map(([actorKey, actor]) => [
        actorKey,
        importWorkflowActor(actorKey, actor as unknown as Record<string, any>),
      ])) as RuntimeSnapshotPersistedState["actors"]
      const fibers = Object.fromEntries(Object.entries(source.snapshot.fibers).map(([fiberId, fiber]) => [
        fiberId,
        { ...fiber, version: 4 },
      ]))
      const indexes = Object.fromEntries(Object.entries(source.snapshot.indexes).map(([name, index]) => [
        name,
        index ? { ...index, schemaVersion: 4 } : index,
      ])) as RuntimeSnapshotPersistedState["indexes"]
      return {
        vm: { ...source.snapshot.vm, version: 4 },
        actors,
        questionnaires: source.snapshot.questionnaires,
        fibers,
        indexes,
      }
    },
  })
}
