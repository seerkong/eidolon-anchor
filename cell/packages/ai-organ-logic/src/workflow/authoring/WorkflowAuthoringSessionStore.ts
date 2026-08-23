import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import type { AiWorkflowForm, AIWorkflowDefinitionBinding } from "@cell/ai-workflow-contract"
import type { AIWorkflowAgentTaskRef } from "ai-workflow-contract"
import { freezeAIWorkflowRunResources } from "ai-workflow-logic/run-freeze"
import { loadResourceTree, type ResourceDiagnostic } from "halfcode-compiler.xnl/resource-core"
import ts from "typescript"
import type {
  EidolonAppResourceRegistryAdapter,
  EidolonResourceRegistrySnapshot,
  ResourcePackageLayerBinding,
} from "../../resources"
import {
  WorkflowResourceLoader,
  type WorkflowResourceLoadResult,
  type WorkflowStaticProjection,
} from "../resources"
import {
  hashWorkflowSources,
  hashWorkflowBinaryFiles,
  NodeWorkflowAuthoringStore,
  type WorkflowAuthoringBinaryFile,
  type WorkflowAuthoringFile,
  type WorkflowAuthoringStore,
} from "./WorkflowAuthoringStore"

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const MOUNTS = Object.freeze({
  "/base": "read_only",
  "/refs": "read_only",
  "/work": "read_write",
  "/out": "read_write",
} as const)

export type WorkflowLegacyVfsTarget = {
  kind: "legacy-vfs-workflow-bundle"
  path: string
  id?: string
  scope?: string
}

export type WorkflowResourcePackageTarget = {
  kind: "workspace-resource-package"
  layerId: "workspace"
  rootDir: string
  packageId: string
  packageVersion: string
  baseArtifactRevision: string
  baseRegistryRevision: string
  selectedResourceRefs: string[]
}

export type WorkflowAuthoringTarget = WorkflowLegacyVfsTarget | WorkflowResourcePackageTarget

export type WorkflowAuthoringSession = {
  kind: "workflow.authoringSession"
  schemaVersion: 3
  artifactKind: "resource-package" | "legacy-vfs-workflow-bundle"
  sessionId: string
  form: AiWorkflowForm
  status: "open" | "published"
  lifecycle: "editing" | "ready_for_publication" | "published_clean" | "published_dirty"
  dirty: boolean
  target: WorkflowAuthoringTarget
  mounts: typeof MOUNTS
  baseRevision: string
  workingRevision: string
  publishedRevision?: string
  latestPublicationReceiptId?: string
  resourcePackagePublicationIssuances?: WorkflowResourcePackagePublicationIssuance[]
  pendingPublication?: WorkflowPendingPublication
  proofSet?: WorkflowPublicationProofSet
  resourcePackageProofSet?: WorkflowResourcePackagePublicationProofSet
  /** Compatibility projection for callers that predate schema v2. */
  currentRevision: string
  diffRevision?: string
  validationRevision?: string
  dryRunRevision?: string
  diffResult?: WorkflowAuthoringDiffResult
  validationResult?: WorkflowResourceLoadResult
  dryRunProjection?: WorkflowStaticProjection
  createdAt: string
  updatedAt: string
}

type WorkflowResourcePackageProofReceiptBase = {
  receiptId: string
  workingRevision: string
  baseArtifactRevision: string
  baseRegistryRevision: string
  artifactDigest: string
  createdAt: string
}

export type WorkflowResourcePackagePublicationProofSet = {
  kind: "workflow.resourcePackagePublicationProofSet"
  revision: string
  baseArtifactRevision: string
  baseRegistryRevision: string
  artifactDigest: string
  packageLoadReceipt: WorkflowResourcePackageProofReceiptBase & {
    kind: "workflow.resourcePackageLoadReceipt"
    packageId: string
    packageVersion: string
    manifestResourceId: string
    contentTreeDigest: string
    diagnosticCount: 0
  }
  registryProjectionReceipt: WorkflowResourcePackageProofReceiptBase & {
    kind: "workflow.resourceRegistryProjectionReceipt"
    compositionRevision: string
    registryRevision: string
    resourceCount: number
    contentIdentityCount: number
  }
  appProjectionReceipt: WorkflowResourcePackageProofReceiptBase & {
    kind: "workflow.resourceAppProjectionReceipt"
    appRefs: string[]
    workflowRefs: string[]
    entrypointWorkflowRefs: string[]
  }
  agentMaterialProjectionReceipt: WorkflowResourcePackageProofReceiptBase & {
    kind: "workflow.resourceAgentMaterialProjectionReceipt"
    agentRefs: string[]
    promptRefs: string[]
    toolRefs: string[]
    materialPortRefs: string[]
    materialBindingRefs: string[]
    materialRefs: string[]
    dependencyEdgeCount: number
  }
  workflowProfileReceipts: Array<WorkflowResourcePackageProofReceiptBase & {
    kind: "workflow.resourceWorkflowProfileReceipt"
    workflowRef: string
    definitionFqn: string
    profileDigest: string
    workflowKind: AiWorkflowForm
  }>
  runResourceReceipts: Array<WorkflowResourcePackageProofReceiptBase & {
    kind: "workflow.resourceRunFreezeReceipt"
    task: AIWorkflowAgentTaskRef
    bindingResourceIds: string[]
    closureResourceRefs: string[]
    dependencySnapshotRevision: string
    semanticFingerprint: string
  }>
  buildReceipt: WorkflowResourcePackageProofReceiptBase & {
    kind: "workflow.resourcePackageBuildReceipt"
    fileCount: number
    assemblyDigest: string
    proofReceiptIds: string[]
    effectDispatched: false
  }
}

export type WorkflowResourcePackageAuthoringBinding = {
  registry: EidolonAppResourceRegistryAdapter
  layers: readonly ResourcePackageLayerBinding[]
}

export type WorkflowResourcePackageSource =
  | { kind: "workspace-layer" }
  | { kind: "explicit-complete-package"; files: readonly WorkflowAuthoringBinaryFile[] }

export type WorkflowResourcePackageSelectionRead = {
  kind: "workflow.resourcePackageSelectionRead"
  sessionId: string
  revision: string
  selectedResourceRefs: string[]
  resourceRefs: string[]
  files: Array<{ path: string; content: string }>
  total: number
  truncated: boolean
}

export type WorkflowPendingPublication = {
  attemptId: string
  revision: string
  targetPath: string
  startedAt: string
}

export type WorkflowPublicationReceipt = {
  kind: "workflow.publicationReceipt"
  receiptId: string
  sequence: number
  sessionId: string
  revision: string
  targetPath: string
  definitionFqn: string
  workflowRef: string
  contract: {
    inputPorts: string[]
    outputPorts: string[]
  }
  artifactDigest: string
  proofReceiptIds: string[]
  createdAt: string
}

export type WorkflowResourcePackagePublicationReceipt = {
  kind: "workflow.resourcePackagePublicationReceipt"
  schemaVersion: "workflow.resource-package-publication-receipt/v1"
  receiptId: string
  sessionId: string
  sourceRevision: string
  baseArtifactRevision: string
  baseRegistryRevision: string
  packageId: string
  packageVersion: string
  artifactDigest: string
  compositionRevision: string
  registryRevision: string
  appRefs: string[]
  entrypointWorkflowRefs: string[]
  workflowRefs: string[]
  agentRefs: string[]
  materialRefs: string[]
  proofReceiptIds: string[]
  createdAt: string
  publicationEffectDispatched: true
  runtimeEffectDispatched: false
}

export type WorkflowResourcePackagePublicationIssuance = {
  kind: "workflow.resourcePackagePublicationIssuance"
  schemaVersion: "workflow.resource-package-publication-issuance/v1"
  sequence: number
  sessionId: string
  sourceRevision: string
  receiptId: string
  issuedAt: string
}

export type WorkflowResourcePackagePublicationCandidate = {
  session: WorkflowAuthoringSession & {
    artifactKind: "resource-package"
    target: WorkflowResourcePackageTarget
  }
  revision: string
  proofSet: WorkflowResourcePackagePublicationProofSet
  files: WorkflowAuthoringBinaryFile[]
}

export type WorkflowResourcePackagePublicationRecovery = {
  readonly receipt: WorkflowResourcePackagePublicationReceipt
  readonly authority: object
}

type WorkflowProofReceiptBase = {
  receiptId: string
  revision: string
  bundleDigest: string
  createdAt: string
}

export type WorkflowPublicationProofSet = {
  revision: string
  bundleDigest: string
  diffReceipt: WorkflowProofReceiptBase & {
    kind: "workflow.diffReceipt"
    baseRevision: string
    summary: WorkflowAuthoringDiffResult["summary"]
  }
  validationReceipt: WorkflowProofReceiptBase & {
    kind: "workflow.validationReceipt"
    definitionFqn: string
    diagnosticCount: number
  }
  staticProjectionReceipt: WorkflowProofReceiptBase & {
    kind: "workflow.staticProjectionReceipt"
    projectionDigest: string
    effectDispatched: false
    acceptanceClaimed: false
  }
  buildReceipt: WorkflowProofReceiptBase & {
    kind: "workflow.buildReceipt"
    definitionFqn: string
    assemblyDigest: string
  }
  acceptanceDispositionReceipt: WorkflowProofReceiptBase & {
    kind: "workflow.acceptanceDispositionReceipt"
    disposition: "required" | "not_required"
    policySource: string
  }
  candidateAcceptanceReceipt?: WorkflowProofReceiptBase & {
    kind: "workflow.candidateAcceptanceReceipt"
    fixtureId: string
    outcome: "passed" | "degraded" | "failed"
    evidenceDigest: string
    isolated: true
    realEffectDispatched: false
    runtime: "canonical-depa-flows"
    effectProvider: "isolated-fixture"
  }
}

export type WorkflowCandidateAcceptanceHarness = {
  run(input: {
    session: WorkflowAuthoringSession
    files: readonly WorkflowAuthoringFile[]
    projection: WorkflowStaticProjection
    fixtureId: string
  }): Promise<{
    outcome: "passed" | "degraded" | "failed"
    evidence: Record<string, unknown>
    isolated: true
    realEffectDispatched: false
    runtime: "canonical-depa-flows"
    effectProvider: "isolated-fixture"
  }>
}

export type WorkflowAcceptancePolicy = {
  requirement: "required" | "not_required"
  source: string
  fixtureId?: string
}

function proofReceiptIds(proofSet: WorkflowPublicationProofSet): string[] {
  return [
    proofSet.diffReceipt.receiptId,
    proofSet.validationReceipt.receiptId,
    proofSet.staticProjectionReceipt.receiptId,
    proofSet.buildReceipt.receiptId,
    proofSet.acceptanceDispositionReceipt.receiptId,
    proofSet.candidateAcceptanceReceipt?.receiptId,
  ].filter((item): item is string => Boolean(item))
}

function resourcePackageProofReceiptIds(proofSet: WorkflowResourcePackagePublicationProofSet): string[] {
  return [
    proofSet.packageLoadReceipt.receiptId,
    proofSet.registryProjectionReceipt.receiptId,
    proofSet.appProjectionReceipt.receiptId,
    proofSet.agentMaterialProjectionReceipt.receiptId,
    ...proofSet.workflowProfileReceipts.map((item) => item.receiptId),
    ...proofSet.runResourceReceipts.map((item) => item.receiptId),
    proofSet.buildReceipt.receiptId,
  ]
}

export type WorkflowStructuredPatchOperation =
  | { kind: "add" | "update"; path: string; content: string }
  | { kind: "delete"; path: string }

export type WorkflowAuthoringReceipt = {
  kind: "workflow.authoringReceipt"
  receiptId: string
  authoringSessionId: string
  stage: "coding" | "testing" | "releasing"
  outcome: "ready" | "published" | "waiting" | "failed"
  workingRevision: string
  publishedRevision?: string
  dirty: boolean
  changedPaths: string[]
  proofReceiptIds: string[]
  publicationReceiptId?: string
  diagnosticCodes: string[]
  diagnosticsTruncated: boolean
  nextAction: string
  createdAt: string
}

export type WorkflowAuthoringDiffResult = {
  summary: { created: number; modified: number; deleted: number; unchanged: number }
  changes: Array<{ path: string; kind: "created" | "modified" | "deleted" | "unchanged" }>
}

export type WorkflowAuthoringAuditEntry = {
  seq: number
  at: string
  operation: string
  detail: Record<string, unknown>
}

type ResolvedLogicalPath = {
  mount: keyof typeof MOUNTS
  relative: string
  storePath: string
}

export type WorkflowAuthoringVfsDiagnostic = {
  kind: "workflow.authoringVfsDiagnostic"
  code: "not_found" | "operation_mismatch"
  operation: "read" | "tree" | "search" | "write"
  path: string
  expected: "file" | "directory"
  actual: "file" | "directory" | "missing"
  mounts: typeof MOUNTS
}

export class WorkflowAuthoringVfsError extends Error {
  constructor(readonly diagnostic: WorkflowAuthoringVfsDiagnostic) {
    super(JSON.stringify(diagnostic))
    this.name = "WorkflowAuthoringVfsError"
  }
}

export class WorkflowResourcePackageValidationError extends Error {
  readonly code = "WORKFLOW_RESOURCE_PACKAGE_VALIDATION_FAILED"
  readonly diagnostics: readonly ResourceDiagnostic[]
  readonly diagnosticsTruncated: boolean

  constructor(message: string, diagnostics: readonly ResourceDiagnostic[] = []) {
    const bounded = diagnostics.slice(0, 20)
    super(`${message}${bounded.length ? `: ${bounded.map((item) => `${item.code}@${item.location}`).join(", ")}` : ""}`)
    this.name = "WorkflowResourcePackageValidationError"
    this.diagnostics = Object.freeze(bounded)
    this.diagnosticsTruncated = diagnostics.length > bounded.length
  }
}

export class WorkflowResourcePackageReceiptValidationError extends Error {
  readonly code = "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_INVALID"

  constructor(message: string) {
    super(`${"WORKFLOW_RESOURCE_PACKAGE_RECEIPT_INVALID"}: ${message}`)
    this.name = "WorkflowResourcePackageReceiptValidationError"
  }
}

export class WorkflowResourcePackageReceiptIssuanceError extends Error {
  readonly code = "WORKFLOW_RESOURCE_PACKAGE_RECEIPT_ISSUANCE_MISMATCH"

  constructor(message: string) {
    super(`${"WORKFLOW_RESOURCE_PACKAGE_RECEIPT_ISSUANCE_MISMATCH"}: ${message}`)
    this.name = "WorkflowResourcePackageReceiptIssuanceError"
  }
}

const RESOURCE_PACKAGE_PUBLICATION_RECEIPT_KEYS = Object.freeze([
  "agentRefs",
  "appRefs",
  "artifactDigest",
  "baseArtifactRevision",
  "baseRegistryRevision",
  "compositionRevision",
  "createdAt",
  "entrypointWorkflowRefs",
  "kind",
  "materialRefs",
  "packageId",
  "packageVersion",
  "proofReceiptIds",
  "publicationEffectDispatched",
  "receiptId",
  "registryRevision",
  "runtimeEffectDispatched",
  "schemaVersion",
  "sessionId",
  "sourceRevision",
  "workflowRefs",
] as const)

const RESOURCE_PACKAGE_PROOF_RECEIPT_KINDS = Object.freeze([
  "resource-package-load",
  "resource-registry-projection",
  "resource-app-projection",
  "resource-agent-material-projection",
  "resource-workflow-profile",
  "resource-run-freeze",
  "resource-package-build",
] as const)

const RESOURCE_PACKAGE_PUBLICATION_ISSUANCE_KEYS = Object.freeze([
  "issuedAt",
  "kind",
  "receiptId",
  "schemaVersion",
  "sequence",
  "sessionId",
  "sourceRevision",
] as const)

function receiptInvalid(message: string): never {
  throw new WorkflowResourcePackageReceiptValidationError(message)
}

function receiptIssuanceMismatch(message: string): never {
  throw new WorkflowResourcePackageReceiptIssuanceError(message)
}

function isLowerHex(value: string, length: number): boolean {
  if (value.length !== length) return false
  for (const character of value) {
    if (!"0123456789abcdef".includes(character)) return false
  }
  return true
}

function exactSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.startsWith("sha256:") || !isLowerHex(value.slice(7), 64)) {
    receiptInvalid(`${field} must be one canonical sha256 digest.`)
  }
  return value
}

function exactReceiptString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.includes("\0")) {
    receiptInvalid(`${field} must be one exact non-empty string.`)
  }
  return value
}

function exactCanonicalTimestamp(value: unknown, field: string): string {
  const exact = exactReceiptString(value, field)
  try {
    if (new Date(exact).toISOString() !== exact) receiptInvalid(`${field} is not canonical.`)
  } catch (error) {
    if (error instanceof WorkflowResourcePackageReceiptValidationError) throw error
    receiptInvalid(`${field} is not one canonical timestamp.`)
  }
  return exact
}

function exactResourcePackageReceiptId(value: unknown, field: string): string {
  const exact = exactReceiptString(value, field)
  const prefix = "resource-package-"
  if (!exact.startsWith(prefix) || !isLowerHex(exact.slice(prefix.length), 64)) {
    receiptInvalid(`${field} must be one canonical ResourcePackage receipt identity.`)
  }
  return exact
}

function exactReceiptResourceRef(value: unknown, field: string): string {
  const exact = exactReceiptString(value, field)
  try {
    return exactResourceRef(exact)
  } catch {
    return receiptInvalid(`${field} must be one exact resource ref.`)
  }
}

function exactDataArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    receiptInvalid(`${field} must be one plain array.`)
  }
  if (Object.getOwnPropertySymbols(value).length > 0) receiptInvalid(`${field} must not contain symbol fields.`)
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== value.length + 1 || names[names.length - 1] !== "length") {
    receiptInvalid(`${field} must be one dense array without extra fields.`)
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      receiptInvalid(`${field} must contain only data elements.`)
    }
  }
  return value
}

function exactCanonicalResourceRefs(
  value: unknown,
  field: string,
  options: { readonly nonEmpty?: boolean } = {},
): string[] {
  const refs = exactDataArray(value, field).map((item, index) => (
    exactReceiptResourceRef(item, `${field}[${index}]`)
  ))
  if (options.nonEmpty && refs.length === 0) receiptInvalid(`${field} must not be empty.`)
  for (let index = 1; index < refs.length; index += 1) {
    if (compareCodeUnits(refs[index - 1]!, refs[index]!) >= 0) {
      receiptInvalid(`${field} must be unique and sorted by canonical code-unit order.`)
    }
  }
  return refs
}

function exactStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function proofReceiptKind(receiptId: string): string {
  if (receiptId.length <= 65 || receiptId[receiptId.length - 65] !== "-") {
    return receiptInvalid("proofReceiptIds must contain canonical proof identities.")
  }
  const kind = receiptId.slice(0, -65)
  if (!RESOURCE_PACKAGE_PROOF_RECEIPT_KINDS.includes(kind as typeof RESOURCE_PACKAGE_PROOF_RECEIPT_KINDS[number])
    || !isLowerHex(receiptId.slice(-64), 64)) {
    return receiptInvalid("proofReceiptIds must contain canonical proof identities.")
  }
  return kind
}

function exactProofReceiptIds(
  value: unknown,
  topology: {
    readonly workflowRefCount: number
    readonly agentRefCount: number
  },
): string[] {
  const ids = exactDataArray(value, "proofReceiptIds").map((item, index) => (
    exactReceiptString(item, `proofReceiptIds[${index}]`)
  ))
  if (ids.length < 5 || new Set(ids).size !== ids.length) {
    receiptInvalid("proofReceiptIds must contain one unique complete proof sequence.")
  }
  const kinds = ids.map(proofReceiptKind)
  const ranks = kinds.map((kind) => RESOURCE_PACKAGE_PROOF_RECEIPT_KINDS.indexOf(
    kind as typeof RESOURCE_PACKAGE_PROOF_RECEIPT_KINDS[number],
  ))
  if (ranks.some((rank, index) => index > 0 && rank < ranks[index - 1]!)) {
    receiptInvalid("proofReceiptIds are not in canonical proof topology order.")
  }
  for (const required of [
    "resource-package-load",
    "resource-registry-projection",
    "resource-app-projection",
    "resource-agent-material-projection",
    "resource-package-build",
  ]) {
    if (kinds.filter((kind) => kind === required).length !== 1) {
      receiptInvalid(`proofReceiptIds require one exact ${required} identity.`)
    }
  }
  if (kinds.filter((kind) => kind === "resource-workflow-profile").length !== topology.workflowRefCount) {
    receiptInvalid("proofReceiptIds require one workflow profile identity for each workflow ref.")
  }
  if (topology.agentRefCount === 0 && kinds.includes("resource-run-freeze")) {
    receiptInvalid("proofReceiptIds cannot contain run-freeze identities without agent refs.")
  }
  return ids
}

function parseResourcePackagePublicationIssuances(
  value: unknown,
  sessionId: string,
): WorkflowResourcePackagePublicationIssuance[] {
  if (value === undefined) return []
  const items = exactDataArray(value, "resourcePackagePublicationIssuances")
  const issuances = items.map((item, index): WorkflowResourcePackagePublicationIssuance => {
    if (typeof item !== "object" || item === null || Array.isArray(item)
      || Object.getPrototypeOf(item) !== Object.prototype
      || Object.getOwnPropertySymbols(item).length > 0) {
      receiptIssuanceMismatch(`Issuance ${index + 1} must be one plain data object.`)
    }
    const names = Object.getOwnPropertyNames(item).sort(compareCodeUnits)
    if (names.length !== RESOURCE_PACKAGE_PUBLICATION_ISSUANCE_KEYS.length
      || names.some((name, keyIndex) => name !== RESOURCE_PACKAGE_PUBLICATION_ISSUANCE_KEYS[keyIndex])) {
      receiptIssuanceMismatch(`Issuance ${index + 1} fields do not match the closed v1 schema.`)
    }
    const record: Record<string, unknown> = {}
    for (const name of RESOURCE_PACKAGE_PUBLICATION_ISSUANCE_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(item, name)
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        receiptIssuanceMismatch(`Issuance ${index + 1} ${name} must be one enumerable data field.`)
      }
      record[name] = descriptor.value
    }
    if (record.kind !== "workflow.resourcePackagePublicationIssuance"
      || record.schemaVersion !== "workflow.resource-package-publication-issuance/v1") {
      receiptIssuanceMismatch(`Issuance ${index + 1} kind or schemaVersion is not supported.`)
    }
    if (record.sequence !== index + 1) {
      receiptIssuanceMismatch("Publication issuance sequence must be contiguous and append-only.")
    }
    const issuanceSessionId = exactReceiptString(record.sessionId, `issuance[${index}].sessionId`)
    if (issuanceSessionId !== sessionId) {
      receiptIssuanceMismatch(`Issuance ${index + 1} does not belong to its owner session.`)
    }
    return Object.freeze({
      kind: "workflow.resourcePackagePublicationIssuance",
      schemaVersion: "workflow.resource-package-publication-issuance/v1",
      sequence: index + 1,
      sessionId: issuanceSessionId,
      sourceRevision: exactSha256(record.sourceRevision, `issuance[${index}].sourceRevision`),
      receiptId: exactResourcePackageReceiptId(record.receiptId, `issuance[${index}].receiptId`),
      issuedAt: exactCanonicalTimestamp(record.issuedAt, `issuance[${index}].issuedAt`),
    })
  })
  if (new Set(issuances.map((item) => item.sourceRevision)).size !== issuances.length
    || new Set(issuances.map((item) => item.receiptId)).size !== issuances.length) {
    receiptIssuanceMismatch("Publication issuances must bind unique source revisions and receipt identities.")
  }
  return issuances
}

function exactResourcePackagePublicationIssuances(
  value: unknown,
  sessionId: string,
): WorkflowResourcePackagePublicationIssuance[] {
  try {
    return parseResourcePackagePublicationIssuances(value, sessionId)
  } catch (error) {
    if (error instanceof WorkflowResourcePackageReceiptValidationError) {
      receiptIssuanceMismatch(error.message)
    }
    throw error
  }
}

export type WorkflowResourcePackagePublicationReceiptPayload = Omit<
  WorkflowResourcePackagePublicationReceipt,
  "receiptId"
>

function canonicalResourcePackagePublicationReceiptPayload(
  input: WorkflowResourcePackagePublicationReceiptPayload,
): WorkflowResourcePackagePublicationReceiptPayload {
  return {
    kind: input.kind,
    schemaVersion: input.schemaVersion,
    sessionId: input.sessionId,
    sourceRevision: input.sourceRevision,
    baseArtifactRevision: input.baseArtifactRevision,
    baseRegistryRevision: input.baseRegistryRevision,
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    artifactDigest: input.artifactDigest,
    compositionRevision: input.compositionRevision,
    registryRevision: input.registryRevision,
    appRefs: [...input.appRefs],
    entrypointWorkflowRefs: [...input.entrypointWorkflowRefs],
    workflowRefs: [...input.workflowRefs],
    agentRefs: [...input.agentRefs],
    materialRefs: [...input.materialRefs],
    proofReceiptIds: [...input.proofReceiptIds],
    createdAt: input.createdAt,
    publicationEffectDispatched: input.publicationEffectDispatched,
    runtimeEffectDispatched: input.runtimeEffectDispatched,
  }
}

export function workflowResourcePackagePublicationReceiptId(
  payload: WorkflowResourcePackagePublicationReceiptPayload,
): string {
  const digest = createHash("sha256")
    .update("workflow.resource-package-publication-receipt/v1\0")
    .update(JSON.stringify(canonicalResourcePackagePublicationReceiptPayload(payload)))
    .digest("hex")
  return `resource-package-${digest}`
}

function requireResourcePackagePublicationIssuance(
  session: WorkflowAuthoringSession,
  receipt: WorkflowResourcePackagePublicationReceipt,
): WorkflowResourcePackagePublicationIssuance {
  const issuance = session.resourcePackagePublicationIssuances?.find((item) => (
    item.sourceRevision === receipt.sourceRevision
  ))
  if (!issuance
    || issuance.receiptId !== receipt.receiptId
    || issuance.sessionId !== receipt.sessionId
    || issuance.issuedAt !== receipt.createdAt) {
    receiptIssuanceMismatch(
      `Receipt ${receipt.receiptId} is not the exact issued identity for revision ${receipt.sourceRevision}.`,
    )
  }
  return issuance
}

function validateResourcePackagePublicationReceipt(
  value: unknown,
  context: {
    readonly pathReceiptId?: string
    readonly session?: WorkflowAuthoringSession
    readonly expectedSourceRevision?: string
    readonly requireRetainedProof?: boolean
    readonly requireProofProjection?: boolean
  } = {},
): WorkflowResourcePackagePublicationReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return receiptInvalid("Receipt must be one plain object.")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return receiptInvalid("Receipt must be one plain data object.")
  }
  if (Object.getOwnPropertySymbols(value).length > 0) receiptInvalid("Receipt must not contain symbol fields.")
  const names = Object.getOwnPropertyNames(value).sort(compareCodeUnits)
  if (
    names.length !== RESOURCE_PACKAGE_PUBLICATION_RECEIPT_KEYS.length
    || names.some((name, index) => name !== RESOURCE_PACKAGE_PUBLICATION_RECEIPT_KEYS[index])
  ) receiptInvalid("Receipt fields do not match the closed v1 schema.")
  const record: Record<string, unknown> = {}
  for (const name of RESOURCE_PACKAGE_PUBLICATION_RECEIPT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      receiptInvalid(`Receipt ${name} must be one enumerable data field.`)
    }
    record[name] = descriptor.value
  }
  if (record.kind !== "workflow.resourcePackagePublicationReceipt"
    || record.schemaVersion !== "workflow.resource-package-publication-receipt/v1") {
    receiptInvalid("Receipt kind or schemaVersion is not supported.")
  }
  if (record.publicationEffectDispatched !== true || record.runtimeEffectDispatched !== false) {
    receiptInvalid("Receipt effect flags do not match publication-only semantics.")
  }
  const sessionId = exactReceiptString(record.sessionId, "sessionId")
  try {
    safeSessionId(sessionId)
  } catch {
    receiptInvalid("sessionId is not one canonical session identity.")
  }
  const sourceRevision = exactSha256(record.sourceRevision, "sourceRevision")
  const receiptId = exactResourcePackageReceiptId(record.receiptId, "receiptId")
  const createdAt = exactCanonicalTimestamp(record.createdAt, "createdAt")
  const appRefs = exactCanonicalResourceRefs(record.appRefs, "appRefs", { nonEmpty: true })
  const entrypointWorkflowRefs = exactCanonicalResourceRefs(
    record.entrypointWorkflowRefs,
    "entrypointWorkflowRefs",
    { nonEmpty: true },
  )
  const workflowRefs = exactCanonicalResourceRefs(record.workflowRefs, "workflowRefs", { nonEmpty: true })
  const agentRefs = exactCanonicalResourceRefs(record.agentRefs, "agentRefs")
  const materialRefs = exactCanonicalResourceRefs(record.materialRefs, "materialRefs")
  if (entrypointWorkflowRefs.some((ref) => !workflowRefs.includes(ref))) {
    receiptInvalid("entrypointWorkflowRefs must be contained by workflowRefs.")
  }
  const payload: WorkflowResourcePackagePublicationReceiptPayload = Object.freeze({
    kind: "workflow.resourcePackagePublicationReceipt",
    schemaVersion: "workflow.resource-package-publication-receipt/v1",
    sessionId,
    sourceRevision,
    baseArtifactRevision: exactSha256(record.baseArtifactRevision, "baseArtifactRevision"),
    baseRegistryRevision: exactSha256(record.baseRegistryRevision, "baseRegistryRevision"),
    packageId: exactReceiptString(record.packageId, "packageId"),
    packageVersion: exactReceiptString(record.packageVersion, "packageVersion"),
    artifactDigest: exactSha256(record.artifactDigest, "artifactDigest"),
    compositionRevision: exactSha256(record.compositionRevision, "compositionRevision"),
    registryRevision: exactSha256(record.registryRevision, "registryRevision"),
    appRefs: Object.freeze(appRefs) as string[],
    entrypointWorkflowRefs: Object.freeze(entrypointWorkflowRefs) as string[],
    workflowRefs: Object.freeze(workflowRefs) as string[],
    agentRefs: Object.freeze(agentRefs) as string[],
    materialRefs: Object.freeze(materialRefs) as string[],
    proofReceiptIds: Object.freeze(exactProofReceiptIds(record.proofReceiptIds, {
      workflowRefCount: workflowRefs.length,
      agentRefCount: agentRefs.length,
    })) as string[],
    createdAt,
    publicationEffectDispatched: true,
    runtimeEffectDispatched: false,
  })
  const expectedReceiptId = workflowResourcePackagePublicationReceiptId(payload)
  if (receiptId !== expectedReceiptId || context.pathReceiptId && context.pathReceiptId !== receiptId) {
    receiptInvalid("receiptId does not match the canonical receipt payload.")
  }
  const receipt: WorkflowResourcePackagePublicationReceipt = Object.freeze({
    ...payload,
    receiptId,
  })
  if (receipt.artifactDigest !== receipt.sourceRevision) {
    receiptInvalid("artifactDigest must match sourceRevision.")
  }
  const session = context.session
  if (session) {
    if (receipt.sessionId !== session.sessionId
      || session.artifactKind !== "resource-package"
      || session.target.kind !== "workspace-resource-package"
      || receipt.packageId !== session.target.packageId
      || receipt.packageVersion !== session.target.packageVersion) {
      receiptInvalid("Receipt identity does not match the owner session.")
    }
  }
  if (context.expectedSourceRevision && receipt.sourceRevision !== context.expectedSourceRevision) {
    receiptInvalid("Receipt sourceRevision does not match the requested revision.")
  }
  const proofSet = session?.resourcePackageProofSet
  if (proofSet?.revision === receipt.sourceRevision) {
    if (
      receipt.baseArtifactRevision !== proofSet.baseArtifactRevision
      || receipt.baseRegistryRevision !== proofSet.baseRegistryRevision
      || receipt.compositionRevision !== proofSet.registryProjectionReceipt.compositionRevision
      || receipt.registryRevision !== proofSet.registryProjectionReceipt.registryRevision
      || !exactStringArraysEqual(receipt.proofReceiptIds, resourcePackageProofReceiptIds(proofSet))
    ) receiptInvalid("Receipt facts do not match the retained publication proof authority.")
    if (context.requireProofProjection && (
      !exactStringArraysEqual(receipt.appRefs, proofSet.appProjectionReceipt.appRefs)
      || !exactStringArraysEqual(receipt.workflowRefs, proofSet.appProjectionReceipt.workflowRefs)
      || !exactStringArraysEqual(receipt.entrypointWorkflowRefs, proofSet.appProjectionReceipt.entrypointWorkflowRefs)
      || !exactStringArraysEqual(receipt.agentRefs, proofSet.agentMaterialProjectionReceipt.agentRefs)
      || !exactStringArraysEqual(receipt.materialRefs, proofSet.agentMaterialProjectionReceipt.materialRefs)
    )) receiptInvalid("Receipt projections do not match the retained publication proof authority.")
  } else if (context.requireRetainedProof) {
    receiptInvalid("Receipt has no exact retained publication proof authority.")
  }
  return receipt
}

function ownDataValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && "value" in descriptor ? descriptor.value : undefined
}

function ctrlWorkflowNodes(statements: readonly unknown[]): unknown[] {
  const result: unknown[] = []
  const visit = (value: unknown): void => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return
    result.push(value)
    const children = ownDataValue(value, "children")
    if (Array.isArray(children)) for (const child of children) visit(child)
    const sections = ownDataValue(value, "sections")
    if (typeof sections !== "object" || sections === null || Array.isArray(sections)) return
    for (const section of Object.values(sections)) {
      if (Array.isArray(section)) for (const child of section) visit(child)
      else visit(section)
    }
  }
  for (const statement of statements) visit(statement)
  return result
}

function canonicalWorkflowAgentTasks(
  binding: AIWorkflowDefinitionBinding,
  workflowRef: `resource://${string}`,
): AIWorkflowAgentTaskRef[] {
  const nodes: readonly unknown[] = binding.kind === "AICtrlWorkflow"
    ? ctrlWorkflowNodes(binding.definition.statements)
    : binding.definition.nodes
  const tasks: AIWorkflowAgentTaskRef[] = []
  for (const node of nodes) {
    const config = binding.kind === "AICtrlWorkflow"
      ? ownDataValue(ownDataValue(node, "attrs"), "config")
      : ownDataValue(node, "config")
    if (typeof config !== "object" || config === null || Array.isArray(config)) continue
    const agentDescriptor = Object.getOwnPropertyDescriptor(config, "agentDefinitionRef")
    if (!agentDescriptor) continue
    const nodeId = ownDataValue(node, "id")
    const agentDefinitionRef = "value" in agentDescriptor ? agentDescriptor.value : undefined
    if (
      typeof nodeId !== "string"
      || !nodeId
      || nodeId !== nodeId.trim()
      || typeof agentDefinitionRef !== "string"
    ) {
      throw new WorkflowResourcePackageValidationError(
        "Workflow resource package canonical Agent task is invalid",
        [{
          code: "WORKFLOW_CANONICAL_AGENT_TASK_INVALID",
          location: `${workflowRef}#${typeof nodeId === "string" ? nodeId : "<missing>"}`,
          message: "Structured workflow Agent configuration requires one exact node id and resource Agent reference.",
        }],
      )
    }
    let exactAgentRef: `resource://${string}`
    try {
      exactAgentRef = exactResourceRef(agentDefinitionRef) as `resource://${string}`
    } catch {
      throw new WorkflowResourcePackageValidationError(
        "Workflow resource package canonical Agent task is invalid",
        [{
          code: "WORKFLOW_CANONICAL_AGENT_TASK_INVALID",
          location: `${workflowRef}#${nodeId}`,
          message: "Structured workflow Agent configuration requires one exact resource:// Agent identity.",
        }],
      )
    }
    tasks.push(Object.freeze({
      workflowKind: binding.kind,
      workflowRef,
      nodeId,
      agentDefinitionRef: exactAgentRef,
    }))
  }
  return tasks
}

function cloneFiles(files: readonly WorkflowAuthoringFile[] | undefined): WorkflowAuthoringFile[] {
  return (files ?? []).map((file) => ({ path: safeRelative(file.path), content: file.content }))
}

function cloneBinaryFiles(files: readonly WorkflowAuthoringBinaryFile[] | undefined): WorkflowAuthoringBinaryFile[] {
  return (files ?? []).map((file) => ({
    path: safeRelative(file.path),
    bytes: Uint8Array.from(file.bytes),
  }))
}

function decodeUtf8(bytes: Uint8Array, logicalPath: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`Workflow authoring text operation requires valid UTF-8: ${logicalPath}`)
  }
}

function tryDecodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

function bytesEqual(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  if (left === undefined || right === undefined || left.byteLength !== right.byteLength) return left === right
  return left.every((value, index) => value === right[index])
}

function exactResourceRef(value: string): string {
  const prefix = "resource://"
  if (value !== value.trim() || !value.startsWith(prefix)) {
    throw new Error(`Resource selection must use one exact resource:// identity: ${value}`)
  }
  const identity = value.slice(prefix.length)
  if (!identity || identity !== identity.trim() || identity.includes("://")) {
    throw new Error(`Resource selection must use one exact resource:// identity: ${value}`)
  }
  return value
}

function normalizeLegacyTarget(target: unknown): WorkflowLegacyVfsTarget {
  const raw = typeof target === "object" && target !== null ? target as Record<string, unknown> : {}
  if (raw.kind !== undefined && raw.kind !== "legacy-vfs-workflow-bundle") {
    throw new Error(`Workflow authoring legacy target kind is invalid: ${String(raw.kind)}`)
  }
  const pathValue = typeof raw.path === "string"
    ? raw.path
    : typeof raw.id === "string"
      ? raw.id
      : ""
  const normalizedPath = pathValue ? safeRelative(pathValue) : ""
  return {
    kind: "legacy-vfs-workflow-bundle",
    path: normalizedPath,
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    ...(typeof raw.scope === "string" ? { scope: raw.scope } : {}),
  }
}

function assertResourcePackageTarget(target: unknown): WorkflowResourcePackageTarget {
  if (typeof target !== "object" || target === null) {
    throw new Error("Workflow resource-package session requires a typed target")
  }
  const raw = target as Record<string, unknown>
  if (
    raw.kind !== "workspace-resource-package"
    || raw.layerId !== "workspace"
    || typeof raw.rootDir !== "string"
    || !path.isAbsolute(raw.rootDir)
    || typeof raw.packageId !== "string"
    || typeof raw.packageVersion !== "string"
    || typeof raw.baseArtifactRevision !== "string"
    || typeof raw.baseRegistryRevision !== "string"
    || !Array.isArray(raw.selectedResourceRefs)
  ) {
    throw new Error("Workflow resource-package session target facts are invalid")
  }
  return {
    kind: "workspace-resource-package",
    layerId: "workspace",
    rootDir: path.resolve(raw.rootDir),
    packageId: raw.packageId,
    packageVersion: raw.packageVersion,
    baseArtifactRevision: raw.baseArtifactRevision,
    baseRegistryRevision: raw.baseRegistryRevision,
    selectedResourceRefs: raw.selectedResourceRefs.map((value) => exactResourceRef(String(value))),
  }
}

function safeRelative(value: string, allowRoot = false): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "")
  if ((!normalized && !allowRoot) || normalized.startsWith("/") || (normalized !== "" && normalized.split("/").some((part) => part === ".." || part === ""))) {
    throw new Error(`unsafe workflow authoring path: ${value}`)
  }
  return normalized
}

function safeSessionId(value: string): string {
  if (!SESSION_ID.test(value)) throw new Error(`unsafe workflow authoring session id: ${value}`)
  return value
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code
}

function resourceDiagnostics(error: unknown): readonly ResourceDiagnostic[] {
  const diagnostics = (error as { diagnostics?: unknown })?.diagnostics
  if (!Array.isArray(diagnostics)) return []
  return diagnostics.filter((item): item is ResourceDiagnostic => (
    typeof item === "object"
    && item !== null
    && typeof (item as ResourceDiagnostic).code === "string"
    && typeof (item as ResourceDiagnostic).location === "string"
    && typeof (item as ResourceDiagnostic).message === "string"
  ))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function resourceRef(resourceId: string): `resource://${string}` {
  return `resource://${resourceId}`
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodeUnits)
}

function agentTaskKey(task: AIWorkflowAgentTaskRef): string {
  return [task.workflowKind, task.workflowRef, task.nodeId, task.agentDefinitionRef].join("\0")
}

function agentTaskNodeKey(task: Pick<AIWorkflowAgentTaskRef, "workflowKind" | "workflowRef" | "nodeId">): string {
  return [task.workflowKind, task.workflowRef, task.nodeId].join("\0")
}

function proofReceiptId(kind: string, sessionId: string, revision: string, discriminator = ""): string {
  return `${kind}-${createHash("sha256").update(`${sessionId}\0${revision}\0${discriminator}`).digest("hex")}`
}

function functionParameterSource(source: string, exportName: string): string | undefined {
  const name = escapeRegExp(exportName)
  const declarations = [
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`),
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(?:async\\s*)?\\(`),
  ]
  for (const declaration of declarations) {
    const match = declaration.exec(source)
    if (!match) continue
    const open = match.index + match[0].lastIndexOf("(")
    let depth = 0
    let quote: string | undefined
    for (let index = open + 1; index < source.length; index += 1) {
      const char = source[index]!
      if (quote) {
        if (char === "\\") index += 1
        else if (char === quote) quote = undefined
        continue
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char
      } else if (char === "(" || char === "[" || char === "{" || char === "<") {
        depth += 1
      } else if (char === ")") {
        if (depth === 0) return source.slice(open + 1, index)
        depth -= 1
      } else if (char === "]" || char === "}" || char === ">") {
        depth = Math.max(0, depth - 1)
      }
    }
  }
  return undefined
}

function topLevelParameterCount(source: string): number {
  if (!source.trim()) return 0
  let count = 1
  let depth = 0
  let quote: string | undefined
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!
    if (quote) {
      if (char === "\\") index += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === "`") quote = char
    else if (char === "(" || char === "[" || char === "{" || char === "<") depth += 1
    else if (char === ")" || char === "]" || char === "}" || char === ">") depth = Math.max(0, depth - 1)
    else if (char === "," && depth === 0) count += 1
  }
  return count
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) current = current.expression
  return current
}

function propertySegments(expression: ts.Expression): string[] | undefined {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return [current.text]
  if (ts.isPropertyAccessExpression(current)) {
    const parent = propertySegments(current.expression)
    return parent ? [...parent, current.name.text] : undefined
  }
  if (ts.isElementAccessExpression(current)) {
    const argument = current.argumentExpression && unwrapExpression(current.argumentExpression)
    if (!argument || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))) return undefined
    const parent = propertySegments(current.expression)
    return parent ? [...parent, argument.text] : undefined
  }
  return undefined
}

function isDirectPropertyPath(expression: ts.Expression): boolean {
  const current = unwrapExpression(expression)
  return ts.isIdentifier(current)
    || (ts.isPropertyAccessExpression(current) && isDirectPropertyPath(current.expression))
}

function objectPropertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!property.name) return undefined
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)) {
    return property.name.text
  }
  return undefined
}

function isFunctionScope(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node)
}

function enclosingFunctionScope(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (isFunctionScope(current)) return current
    current = current.parent
  }
  return undefined
}

function runtimeParameterName(scope: ts.FunctionLikeDeclaration | undefined): string | undefined {
  const parameter = scope?.parameters[0]
  return parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : undefined
}

function isRuntimeCapabilityPath(segments: readonly string[] | undefined, runtimeParameter: string, leaf: readonly string[]): boolean {
  return segments?.length === leaf.length + 1
    && segments[0] === runtimeParameter
    && segments.slice(1).join(".") === leaf.join(".")
}

function validateEffectInvocationContracts(files: readonly WorkflowAuthoringFile[]): string[] {
  const diagnostics: string[] = []
  for (const file of files.filter((item) => item.path.startsWith("flow-code/") && /\.[cm]?[jt]sx?$/.test(item.path))) {
    const scriptKind = file.path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    const sourceFile = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, scriptKind)
    const effectAliases = new Map<ts.FunctionLikeDeclaration, Map<string, string[]>>()
    const runAuthorityAliases = new Map<ts.FunctionLikeDeclaration, Map<string, string[]>>()
    const memberAliases = new Map<ts.FunctionLikeDeclaration, Map<string, "invoke" | "runAgent" | "runTargetedAgent">>()

    const collectAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const segments = propertySegments(node.initializer)
        const scope = enclosingFunctionScope(node)
        const aliasedOwner = scope && segments?.length && effectAliases.get(scope)?.get(segments[0]!)
        const resolvedSegments = aliasedOwner ? [...aliasedOwner, ...segments!.slice(1)] : segments
        if (scope && ts.isIdentifier(node.name) && resolvedSegments?.slice(-2).join(".") === "ai.effects") {
          const aliases = effectAliases.get(scope) ?? new Map<string, string[]>()
          aliases.set(node.name.text, resolvedSegments)
          effectAliases.set(scope, aliases)
        }
        if (scope && ts.isIdentifier(node.name) && resolvedSegments?.slice(-3).join(".") === "ai.metadata.run") {
          const aliases = runAuthorityAliases.get(scope) ?? new Map<string, string[]>()
          aliases.set(node.name.text, resolvedSegments)
          runAuthorityAliases.set(scope, aliases)
        }
        const member = resolvedSegments?.at(-1)
        if (scope && ts.isIdentifier(node.name)
          && resolvedSegments?.slice(-3, -1).join(".") === "ai.effects"
          && (member === "invoke" || member === "runAgent" || member === "runTargetedAgent")) {
          const aliases = memberAliases.get(scope) ?? new Map<string, "invoke" | "runAgent" | "runTargetedAgent">()
          aliases.set(node.name.text, member)
          memberAliases.set(scope, aliases)
        }
        if (scope && ts.isObjectBindingPattern(node.name)
          && resolvedSegments?.slice(-2).join(".") === "ai.effects") {
          const aliases = memberAliases.get(scope) ?? new Map<string, "invoke" | "runAgent" | "runTargetedAgent">()
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue
            const property = element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
              ? element.propertyName.text
              : element.name.text
            if (property === "invoke" || property === "runAgent" || property === "runTargetedAgent") {
              aliases.set(element.name.text, property)
            }
          }
          memberAliases.set(scope, aliases)
        }
      }
      ts.forEachChild(node, collectAliases)
    }
    collectAliases(sourceFile)

    const inspectCalls = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const member = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : node.argumentExpression && (ts.isStringLiteral(unwrapExpression(node.argumentExpression))
            || ts.isNoSubstitutionTemplateLiteral(unwrapExpression(node.argumentExpression)))
            ? (unwrapExpression(node.argumentExpression) as ts.StringLiteralLike).text
            : undefined
        const isSensitiveMember = member === "invoke" || member === "runAgent" || member === "runTargetedAgent"
          || ts.isElementAccessExpression(node)
        if (isSensitiveMember) {
          const scope = enclosingFunctionScope(node)
          const owner = unwrapExpression(node.expression)
          const ownerSegments = propertySegments(owner)
          const aliasedOwnerSegments = scope && ts.isIdentifier(owner)
            ? effectAliases.get(scope)?.get(owner.text)
            : undefined
          const candidateOwnerSegments = aliasedOwnerSegments ?? ownerSegments
          const isDirectCall = ts.isCallExpression(node.parent)
            && unwrapExpression(node.parent.expression) === node
          if (candidateOwnerSegments?.slice(-2).join(".") === "ai.effects" && !isDirectCall) {
            const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            diagnostics.push(
              `${member === "invoke" ? "data-code-effect-contract" : "data-code-agent-contract"}: ${file.path}:${location.line + 1}:${location.character + 1} ${member ?? "computed effect capability"} must be called directly and cannot be captured, returned, or passed as an alias`,
            )
          }
        }
      }
      if (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression)
        const scope = enclosingFunctionScope(node)
        if (ts.isElementAccessExpression(callee)) {
          const owner = unwrapExpression(callee.expression)
          const ownerSegments = propertySegments(owner)
          const aliasedOwnerSegments = ts.isIdentifier(owner)
            ? effectAliases.get(scope!)?.get(owner.text)
            : undefined
          const candidateOwnerSegments = aliasedOwnerSegments ?? ownerSegments
          if (candidateOwnerSegments?.slice(-2).join(".") === "ai.effects") {
            const argument = callee.argumentExpression && unwrapExpression(callee.argumentExpression)
            const member = argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
              ? argument.text
              : undefined
            const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            diagnostics.push(
              `${member === "invoke" ? "data-code-effect-contract" : "data-code-agent-contract"}: ${file.path}:${location.line + 1}:${location.character + 1} runtime.ai.effects element access is not an authored invocation surface; use a direct named capability`,
            )
            ts.forEachChild(node, inspectCalls)
            return
          }
        }
        const aliasedMember = ts.isIdentifier(callee) ? memberAliases.get(scope!)?.get(callee.text) : undefined
        if (aliasedMember) {
          const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          diagnostics.push(
            `${aliasedMember === "invoke" ? "data-code-effect-contract" : "data-code-agent-contract"}: ${file.path}:${location.line + 1}:${location.character + 1} ${aliasedMember} must be called as a direct runtime.ai.effects capability and cannot be invoked through an alias`,
          )
          ts.forEachChild(node, inspectCalls)
          return
        }
        const directTypedMethod = ts.isPropertyAccessExpression(callee)
          && (callee.name.text === "runAgent" || callee.name.text === "runTargetedAgent")
          ? callee.name.text
          : undefined
        const computedTypedMethod = ts.isElementAccessExpression(callee)
          && callee.argumentExpression !== undefined
          && ts.isStringLiteral(unwrapExpression(callee.argumentExpression))
          && (["runAgent", "runTargetedAgent"] as const).includes(
            (unwrapExpression(callee.argumentExpression) as ts.StringLiteral).text as "runAgent" | "runTargetedAgent",
          )
          ? (unwrapExpression(callee.argumentExpression) as ts.StringLiteral).text as "runAgent" | "runTargetedAgent"
          : undefined
        const typedMethod = directTypedMethod ?? computedTypedMethod
        if (typedMethod) {
          const runtimeParameter = runtimeParameterName(scope)
          const owner = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)
            ? unwrapExpression(callee.expression)
            : undefined
          const ownerSegments = owner ? propertySegments(owner) : undefined
          const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          if (computedTypedMethod || !owner || !isDirectPropertyPath(owner) || !runtimeParameter
            || !isRuntimeCapabilityPath(ownerSegments, runtimeParameter, ["ai", "effects"])) {
            diagnostics.push(
              `data-code-agent-contract: ${file.path}:${location.line + 1}:${location.character + 1} ${typedMethod} must be a direct runtime.ai.effects capability of the first Processor parameter`,
            )
          } else {
            const expectedArguments = typedMethod === "runAgent" ? 2 : 3
            if (node.arguments.length !== expectedArguments) {
              diagnostics.push(
                `data-code-agent-contract: ${file.path}:${location.line + 1}:${location.character + 1} ${typedMethod} requires exactly ${expectedArguments} authored arguments`,
              )
            }
          }
        }
        const isComputedInvoke = ts.isElementAccessExpression(callee)
          && callee.argumentExpression !== undefined
          && ts.isStringLiteral(unwrapExpression(callee.argumentExpression))
          && (unwrapExpression(callee.argumentExpression) as ts.StringLiteral).text === "invoke"
        const invokeOwner = ts.isPropertyAccessExpression(callee) && callee.name.text === "invoke"
          ? callee.expression
          : isComputedInvoke && ts.isElementAccessExpression(callee)
            ? callee.expression
            : undefined
        if (invokeOwner) {
          const runtimeParameter = runtimeParameterName(scope)
          const owner = unwrapExpression(invokeOwner)
          const ownerSegments = propertySegments(owner)
          const aliasedOwnerSegments = scope && ts.isIdentifier(owner)
            ? effectAliases.get(scope)?.get(owner.text)
            : undefined
          const candidateOwnerSegments = aliasedOwnerSegments ?? ownerSegments
          const looksLikeEffectProvider = candidateOwnerSegments?.slice(-2).join(".") === "ai.effects"
          if (looksLikeEffectProvider) {
            const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            const request = node.arguments[0] ? unwrapExpression(node.arguments[0]) : undefined
            const requestProperties = request && ts.isObjectLiteralExpression(request) ? request.properties : undefined
            const requestPropertyNames = requestProperties?.map(objectPropertyName)
            const hasSpread = requestProperties?.some(ts.isSpreadAssignment) ?? false
            const expectedRequestFields = ["operation", "run", "effectId", "input", "config"] as const
            const hasDuplicateCriticalField = ["operation", "run", "effectId", "input", "config"]
              .some((name) => requestPropertyNames?.filter((candidate) => candidate === name).length !== 1)
            const isClosedRequest = node.arguments.length === 1
              && requestProperties?.length === expectedRequestFields.length
              && requestPropertyNames?.every((name) => name !== undefined && expectedRequestFields.includes(name as typeof expectedRequestFields[number]))
            if (hasSpread || hasDuplicateCriticalField || !isClosedRequest) {
              diagnostics.push(
                `data-code-effect-contract: ${file.path}:${location.line + 1}:${location.character + 1} fixed non-Agent effects.invoke requires one closed request object with exactly one direct operation, run, effectId, input, and config field`,
              )
              ts.forEachChild(node, inspectCalls)
              return
            }
            const operationProperty = request && ts.isObjectLiteralExpression(request)
              ? request.properties.find((property) => objectPropertyName(property) === "operation")
              : undefined
            const operation = operationProperty && ts.isPropertyAssignment(operationProperty)
              ? unwrapExpression(operationProperty.initializer)
              : undefined
            const fixedNonAgentOperation = operation && ts.isStringLiteral(operation)
              && operation.text !== "ai.agent"
            if (!fixedNonAgentOperation) {
              diagnostics.push(
                `data-code-agent-contract: ${file.path}:${location.line + 1}:${location.character + 1} effects.invoke is internal-only for fixed non-Agent operations; authored Agent code must use runAgent or runTargetedAgent`,
              )
              ts.forEachChild(node, inspectCalls)
              return
            }
            if (isComputedInvoke || !runtimeParameter || !isDirectPropertyPath(owner)
              || !isRuntimeCapabilityPath(ownerSegments, runtimeParameter, ["ai", "effects"])) {
              diagnostics.push(
                `data-code-effect-contract: ${file.path}:${location.line + 1}:${location.character + 1} fixed non-Agent effects.invoke must be a direct capability of the first Processor runtime parameter`,
              )
              ts.forEachChild(node, inspectCalls)
              return
            }
            const runProperty = request && ts.isObjectLiteralExpression(request)
              ? request.properties.find((property) => objectPropertyName(property) === "run")
              : undefined
            const hasAuthoritativeRun = (() => {
              if (!runProperty || !scope) return false
              const runExpression = ts.isShorthandPropertyAssignment(runProperty)
                ? runProperty.name
                : ts.isPropertyAssignment(runProperty)
                  ? unwrapExpression(runProperty.initializer)
                  : undefined
              if (!runExpression) return false
              const segments = propertySegments(runExpression)
              const aliasedSegments = ts.isIdentifier(runExpression)
                ? runAuthorityAliases.get(scope)?.get(runExpression.text)
                : undefined
              return isRuntimeCapabilityPath(segments, runtimeParameter, ["ai", "metadata", "run"])
                || isRuntimeCapabilityPath(aliasedSegments, runtimeParameter, ["ai", "metadata", "run"])
            })()
            if (!hasAuthoritativeRun) {
              diagnostics.push(
                `data-code-effect-contract: ${file.path}:${location.line + 1}:${location.character + 1} fixed non-Agent effects.invoke run must originate from runtime.ai.metadata.run`,
              )
            }
            ts.forEachChild(node, inspectCalls)
            return
          }
        }
      }
      ts.forEachChild(node, inspectCalls)
    }
    inspectCalls(sourceFile)
  }
  return diagnostics
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
}

type LocalFunctionContract = {
  body: ts.ConciseBody
  parameters: string[]
  exported: boolean
}

function localFunctionContracts(sourceFile: ts.SourceFile): Map<string, LocalFunctionContract> {
  const contracts = new Map<string, LocalFunctionContract>()
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      contracts.set(statement.name.text, {
        body: statement.body,
        parameters: statement.parameters.map((parameter) => ts.isIdentifier(parameter.name) ? parameter.name.text : ""),
        exported: hasExportModifier(statement),
      })
      continue
    }
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
      const initializer = unwrapExpression(declaration.initializer)
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        contracts.set(declaration.name.text, {
          body: initializer.body,
          parameters: initializer.parameters.map((parameter) => ts.isIdentifier(parameter.name) ? parameter.name.text : ""),
          exported: hasExportModifier(statement),
        })
      }
    }
  }
  return contracts
}

function inferredReturnObjectKeys(source: string, path: string, exportName: string): string[][] {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const contracts = localFunctionContracts(sourceFile)
  if (!contracts.get(exportName)?.exported) return []

  const resolveString = (expression: ts.Expression, environment: ReadonlyMap<string, string>): string | undefined => {
    const value = unwrapExpression(expression)
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text
    return ts.isIdentifier(value) ? environment.get(value.text) : undefined
  }

  const inferExpression = (
    expression: ts.Expression,
    environment: ReadonlyMap<string, string>,
    stack: ReadonlySet<string>,
  ): string[][] => {
    const value = unwrapExpression(expression)
    if (ts.isObjectLiteralExpression(value) && !value.properties.some(ts.isSpreadAssignment)) {
      const keys = value.properties.map((property) => {
        if (property.name && ts.isComputedPropertyName(property.name)) {
          return resolveString(property.name.expression, environment)
        }
        return objectPropertyName(property)
      })
      return keys.every((key): key is string => key !== undefined) ? [keys] : []
    }
    if (!ts.isCallExpression(value) || !ts.isIdentifier(unwrapExpression(value.expression))) return []
    const callee = unwrapExpression(value.expression) as ts.Identifier
    if (stack.has(callee.text)) return []
    const contract = contracts.get(callee.text)
    if (!contract) return []
    const nestedEnvironment = new Map<string, string>()
    contract.parameters.forEach((parameter, index) => {
      const argument = value.arguments[index]
      if (!parameter || !argument) return
      const resolved = resolveString(argument, environment)
      if (resolved !== undefined) nestedEnvironment.set(parameter, resolved)
    })
    return inferBody(contract.body, nestedEnvironment, new Set([...stack, callee.text]))
  }

  const inferBody = (
    body: ts.ConciseBody,
    environment: ReadonlyMap<string, string>,
    stack: ReadonlySet<string>,
  ): string[][] => {
    if (!ts.isBlock(body)) return inferExpression(body, environment, stack)
    const returned: string[][] = []
    const visit = (node: ts.Node): void => {
      if (node !== body && ts.isFunctionLike(node)) return
      if (ts.isReturnStatement(node) && node.expression) {
        returned.push(...inferExpression(node.expression, environment, stack))
      }
      ts.forEachChild(node, visit)
    }
    visit(body)
    return returned
  }

  const root = contracts.get(exportName)!
  return inferBody(root.body, new Map(), new Set([exportName]))
}

function validateLocalDataCodeBindings(
  result: WorkflowResourceLoadResult,
  files: readonly WorkflowAuthoringFile[],
): string[] {
  const diagnostics = validateEffectInvocationContracts(files)
  if (result.binding?.kind !== "AIDataWorkflow") return diagnostics
  const sourceByPath = new Map(files.map((file) => [file.path.replace(/^\.\//, ""), file.content]))
  for (const node of result.binding.definition.nodes as any[]) {
    if (node.tag !== "TransformNode" && node.tag !== "SinkNode") continue
    const reference = typeof node.src === "string" ? node.src : undefined
    const match = reference?.match(/^vfs:\/\/\.\/([^#]+)#([A-Za-z_$][\w$]*)$/)
    if (!match) continue
    const [, filePath, exportName] = match
    const source = sourceByPath.get(filePath!)
    if (source === undefined) {
      diagnostics.push(`data-code-binding: ${node.id} source ${filePath} is missing from the workflow bundle`)
      continue
    }
    const parameters = functionParameterSource(source, exportName!)
    if (parameters === undefined) {
      diagnostics.push(`data-code-binding: ${node.id} export ${exportName} was not found in ${filePath}`)
      continue
    }
    if (topLevelParameterCount(parameters) < 2) {
      diagnostics.push(
        `data-code-signature: ${node.id} export ${exportName} must accept (runtime, inputs, config); the first argument is never inputs`,
      )
    }
    const expectedOutputs = [...(node.outputs ?? [])].map(String).sort(compareCodeUnits)
    for (const returnedKeys of inferredReturnObjectKeys(source, filePath!, exportName!)) {
      const actualOutputs = [...returnedKeys].sort(compareCodeUnits)
      if (
        actualOutputs.length !== expectedOutputs.length
        || actualOutputs.some((key, index) => key !== expectedOutputs[index])
      ) {
        diagnostics.push(
          `data-code-output-contract: ${node.id} export ${exportName} must return exact output keys [${expectedOutputs.join(", ")}], got [${actualOutputs.join(", ")}]`,
        )
      }
    }
  }
  return diagnostics
}

export class WorkflowAuthoringSessionStore {
  private readonly resources: WorkflowResourceLoader
  private readonly resourcePackagePublicationRecoveryAuthorities = new WeakMap<object, {
    readonly sessionId: string
    readonly sourceRevision: string
    readonly receiptId: string
  }>()

  constructor(
    readonly store: WorkflowAuthoringStore,
    resources = new WorkflowResourceLoader(),
    private readonly candidateHarness?: WorkflowCandidateAcceptanceHarness,
    private readonly resourcePackages?: WorkflowResourcePackageAuthoringBinding,
  ) {
    this.resources = resources
  }

  private root(sessionId: string): string {
    return `.authoring/sessions/${safeSessionId(sessionId)}`
  }

  private lockPath(sessionId: string): string {
    return `.authoring/locks/${safeSessionId(sessionId)}.lock`
  }

  private metadataPath(sessionId: string): string {
    return `${this.root(sessionId)}/session.json`
  }

  private auditPath(sessionId: string): string {
    return `${this.root(sessionId)}/audit.jsonl`
  }

  private publicationPath(sessionId: string, receiptId: string): string {
    return `${this.root(sessionId)}/publications/${safeSessionId(receiptId)}.json`
  }

  private resourcePackagePublicationPath(sessionId: string, receiptId: string): string {
    return `${this.root(sessionId)}/resource-package-publications/${safeSessionId(receiptId)}.json`
  }

  private authoringReceiptPath(sessionId: string, receiptId: string): string {
    return `${this.root(sessionId)}/authoring-receipts/${safeSessionId(receiptId)}.json`
  }

  private fulfillmentContinuationPath(outerSessionId: string): string {
    return `.fulfillment/continuations/${safeSessionId(outerSessionId)}.json`
  }

  private fulfillmentContinuationLockPath(outerSessionId: string): string {
    return `.fulfillment/locks/${safeSessionId(outerSessionId)}.lock`
  }

  private async writeFulfillmentContinuationUnlocked(
    outerSessionId: string,
    continuation: unknown,
  ): Promise<void> {
    await this.store.writeAtomic(
      this.fulfillmentContinuationPath(outerSessionId),
      `${JSON.stringify(continuation, null, 2)}\n`,
    )
  }

  async writeFulfillmentContinuation(outerSessionId: string, continuation: unknown): Promise<void> {
    await this.store.withExclusiveLock(
      this.fulfillmentContinuationLockPath(outerSessionId),
      () => this.writeFulfillmentContinuationUnlocked(outerSessionId, continuation),
    )
  }

  async transitionFulfillmentContinuation(
    outerSessionId: string,
    expected: unknown,
    continuation: unknown,
  ): Promise<void> {
    await this.store.withExclusiveLock(
      this.fulfillmentContinuationLockPath(outerSessionId),
      async () => {
        const current = await this.readFulfillmentContinuation(outerSessionId)
        const currentJson = JSON.stringify(current)
        const nextJson = JSON.stringify(continuation)
        if (currentJson === nextJson) return
        if (currentJson !== JSON.stringify(expected)) {
          throw new Error(
            "WORKFLOW_FULFILL_CONTINUATION_CONFLICT: durable continuation changed before transition",
          )
        }
        await this.writeFulfillmentContinuationUnlocked(outerSessionId, continuation)
      },
    )
  }

  async readFulfillmentContinuation(outerSessionId: string): Promise<unknown | undefined> {
    try {
      return JSON.parse(await this.store.read(this.fulfillmentContinuationPath(outerSessionId))) as unknown
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined
      throw error
    }
  }

  private resolve(sessionId: string, logicalPath: string): ResolvedLogicalPath {
    const normalized = logicalPath.trim().replace(/\\/g, "/")
    if (!normalized.startsWith("/") || normalized.includes("//")) {
      throw new Error(`unsafe workflow authoring VFS path: ${logicalPath}`)
    }
    const [mountName, ...parts] = normalized.slice(1).split("/")
    const mount = `/${mountName}` as keyof typeof MOUNTS
    if (!(mount in MOUNTS)) throw new Error(`unsupported workflow authoring mount: ${mount}`)
    const relative = safeRelative(parts.join("/"), true)
    return {
      mount,
      relative,
      storePath: `${this.root(sessionId)}/${mountName}${relative ? `/${relative}` : ""}`,
    }
  }

  private deriveSession(
    raw: Partial<WorkflowAuthoringSession> & Pick<WorkflowAuthoringSession, "sessionId" | "form" | "createdAt" | "updatedAt"> & {
      target: unknown
    },
    revisions: { base: string; working: string },
  ): WorkflowAuthoringSession {
    const artifactKind = raw.artifactKind ?? "legacy-vfs-workflow-bundle"
    if (artifactKind !== "resource-package" && artifactKind !== "legacy-vfs-workflow-bundle") {
      throw new Error(`Workflow authoring artifact kind is invalid: ${String(artifactKind)}`)
    }
    const target = artifactKind === "resource-package"
      ? assertResourcePackageTarget(raw.target)
      : normalizeLegacyTarget(raw.target)
    const publishedRevision = raw.publishedRevision
      ?? (raw.status === "published" ? raw.currentRevision : undefined)
    const dirty = publishedRevision === undefined || publishedRevision !== revisions.working
    const proofReady = artifactKind === "resource-package"
      ? raw.resourcePackageProofSet?.revision === revisions.working
        && raw.resourcePackageProofSet.artifactDigest === revisions.working
      : raw.diffRevision === revisions.working
        && raw.validationRevision === revisions.working
        && raw.dryRunRevision === revisions.working
    const lifecycle: WorkflowAuthoringSession["lifecycle"] = publishedRevision
      ? dirty ? "published_dirty" : "published_clean"
      : proofReady ? "ready_for_publication" : "editing"
    const resourcePackagePublicationIssuances = exactResourcePackagePublicationIssuances(
      raw.resourcePackagePublicationIssuances,
      raw.sessionId,
    )
    return {
      ...raw,
      kind: "workflow.authoringSession",
      schemaVersion: 3,
      artifactKind,
      sessionId: raw.sessionId,
      form: raw.form,
      status: publishedRevision ? "published" : "open",
      lifecycle,
      dirty,
      target,
      mounts: MOUNTS,
      baseRevision: revisions.base,
      workingRevision: revisions.working,
      publishedRevision,
      currentRevision: revisions.working,
      resourcePackagePublicationIssuances,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    }
  }

  private async readMetadata(sessionId: string): Promise<WorkflowAuthoringSession> {
    try {
      const raw = JSON.parse(await this.store.read(this.metadataPath(sessionId))) as WorkflowAuthoringSession
      return this.deriveSession(raw, {
        base: hashWorkflowBinaryFiles(await this.mountBinaryFiles(sessionId, "base")),
        working: hashWorkflowBinaryFiles(await this.mountBinaryFiles(sessionId, "work")),
      })
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw new Error(`Workflow authoring session not found: ${sessionId}`)
      throw error
    }
  }

  private async writeMetadata(session: WorkflowAuthoringSession): Promise<void> {
    const normalized = this.deriveSession(session, {
      base: session.baseRevision,
      working: session.workingRevision,
    })
    await this.store.writeAtomic(this.metadataPath(session.sessionId), `${JSON.stringify(normalized, null, 2)}\n`)
  }

  private async appendAudit(
    sessionId: string,
    operation: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const entries = await this.audit(sessionId, false)
    const entry: WorkflowAuthoringAuditEntry = {
      seq: entries.length + 1,
      at: new Date().toISOString(),
      operation,
      detail,
    }
    const source = [...entries, entry].map((item) => JSON.stringify(item)).join("\n")
    await this.store.writeAtomic(this.auditPath(sessionId), `${source}\n`)
  }

  private async mountFiles(sessionId: string, mount: "base" | "refs" | "work" | "out"): Promise<WorkflowAuthoringFile[]> {
    const entries = await this.mountBinaryFiles(sessionId, mount)
    return entries.map((entry) => ({
      path: entry.path,
      content: decodeUtf8(entry.bytes, `/${mount}/${entry.path}`),
    }))
  }

  private async mountBinaryFiles(
    sessionId: string,
    mount: "base" | "refs" | "work" | "out",
  ): Promise<WorkflowAuthoringBinaryFile[]> {
    const prefix = `${this.root(sessionId)}/${mount}`
    const paths = await this.store.tree(prefix)
    return Promise.all(paths.map(async (item) => ({
      path: item.slice(prefix.length + 1),
      bytes: await this.store.readBytes(item),
    })))
  }

  private async requirePathKind(
    resolved: ResolvedLogicalPath,
    operation: WorkflowAuthoringVfsDiagnostic["operation"],
    expected: WorkflowAuthoringVfsDiagnostic["expected"],
  ): Promise<void> {
    const actual = await this.store.kind(resolved.storePath)
    if (actual === expected) return
    throw new WorkflowAuthoringVfsError({
      kind: "workflow.authoringVfsDiagnostic",
      code: actual === "missing" ? "not_found" : "operation_mismatch",
      operation,
      path: `${resolved.mount}${resolved.relative ? `/${resolved.relative}` : ""}`,
      expected,
      actual,
      mounts: MOUNTS,
    })
  }

  private async workRevision(sessionId: string): Promise<string> {
    return hashWorkflowBinaryFiles(await this.mountBinaryFiles(sessionId, "work"))
  }

  private async invalidate(sessionId: string): Promise<WorkflowAuthoringSession> {
    const current = await this.readMetadata(sessionId)
    const workingRevision = await this.workRevision(sessionId)
    const updated: WorkflowAuthoringSession = {
      ...current,
      workingRevision,
      currentRevision: workingRevision,
      diffRevision: undefined,
      validationRevision: undefined,
      dryRunRevision: undefined,
      diffResult: undefined,
      validationResult: undefined,
      dryRunProjection: undefined,
      proofSet: undefined,
      resourcePackageProofSet: undefined,
      updatedAt: new Date().toISOString(),
    }
    const derived = this.deriveSession(updated, { base: current.baseRevision, working: workingRevision })
    await this.writeMetadata(derived)
    return derived
  }

  private async replaceSessionRoot(
    sessionId: string,
    session: WorkflowAuthoringSession,
    workFiles: readonly WorkflowAuthoringBinaryFile[],
  ): Promise<void> {
    const root = this.root(sessionId)
    const existingPaths = await this.store.tree(root)
    const retained = await Promise.all(existingPaths
      .filter((item) => item !== this.metadataPath(sessionId) && !item.startsWith(`${root}/work/`))
      .map(async (item) => ({ path: item.slice(root.length + 1), bytes: await this.store.readBytes(item) })))
    await this.store.replaceTreeBytesAtomic(root, [
      ...retained,
      ...workFiles.map((file) => ({ path: `work/${file.path}`, bytes: file.bytes })),
      { path: "session.json", bytes: new TextEncoder().encode(`${JSON.stringify(session, null, 2)}\n`) },
    ])
  }

  async open(input: {
    sessionId?: string
    form: AiWorkflowForm
    source?: readonly WorkflowAuthoringFile[]
    refs?: readonly WorkflowAuthoringFile[]
    template?: readonly WorkflowAuthoringFile[]
    target?: Record<string, unknown>
  }): Promise<WorkflowAuthoringSession> {
    const sessionId = safeSessionId(input.sessionId?.trim() || `workflow-${randomUUID()}`)
    try {
      await this.store.read(this.metadataPath(sessionId))
      throw new Error(`Workflow authoring session already exists: ${sessionId}`)
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
    if (input.source && input.template) throw new Error("Authoring session accepts source or template, not both")
    for (const mount of Object.keys(MOUNTS)) {
      await this.store.ensureDirectory(`${this.root(sessionId)}/${mount.slice(1)}`)
    }
    const base = cloneFiles(input.source)
    const work = cloneFiles(input.source ?? input.template)
    for (const file of base) await this.store.writeAtomic(`${this.root(sessionId)}/base/${file.path}`, file.content)
    for (const file of cloneFiles(input.refs)) await this.store.writeAtomic(`${this.root(sessionId)}/refs/${file.path}`, file.content)
    for (const file of work) await this.store.writeAtomic(`${this.root(sessionId)}/work/${file.path}`, file.content)
    const now = new Date().toISOString()
    const baseRevision = hashWorkflowSources(base)
    const workingRevision = hashWorkflowSources(work)
    const session: WorkflowAuthoringSession = {
      kind: "workflow.authoringSession",
      schemaVersion: 3,
      artifactKind: "legacy-vfs-workflow-bundle",
      sessionId,
      form: input.form,
      status: "open",
      lifecycle: "editing",
      dirty: true,
      target: normalizeLegacyTarget(input.target),
      mounts: MOUNTS,
      baseRevision,
      workingRevision,
      currentRevision: workingRevision,
      createdAt: now,
      updatedAt: now,
    }
    await this.writeMetadata(session)
    await this.appendAudit(sessionId, "open", { form: input.form, target: session.target })
    return session
  }

  private resourcePackageBinding(): WorkflowResourcePackageAuthoringBinding {
    if (!this.resourcePackages) {
      throw new Error("Workflow resource-package authoring requires an injected registry and layer binding")
    }
    const workspace = this.resourcePackages.layers.find((layer) => layer.id === "workspace")
    if (!workspace) throw new Error("Workflow resource-package authoring requires one injected workspace layer")
    return this.resourcePackages
  }

  private workspaceResourceLayer(): ResourcePackageLayerBinding & { id: "workspace" } {
    const binding = this.resourcePackageBinding().layers.find((layer) => layer.id === "workspace")
    if (!binding) throw new Error("Workflow resource-package authoring requires one injected workspace layer")
    return binding as ResourcePackageLayerBinding & { id: "workspace" }
  }

  private candidateLayers(candidateRoot: string): readonly ResourcePackageLayerBinding[] {
    return Object.freeze(this.resourcePackageBinding().layers.map((layer) => Object.freeze(
      layer.id === "workspace" ? { id: "workspace" as const, rootDir: candidateRoot } : layer,
    )))
  }

  private async physicalTree(rootDir: string): Promise<WorkflowAuthoringBinaryFile[]> {
    const source = new NodeWorkflowAuthoringStore(rootDir)
    const paths = await source.tree()
    return Promise.all(paths.map(async (item) => ({ path: item, bytes: await source.readBytes(item) })))
  }

  private candidateRoot(sessionId: string): string {
    return path.join(this.store.rootPath, ...`${this.root(sessionId)}/work`.split("/"))
  }

  async openResourcePackage(input: {
    sessionId?: string
    source: WorkflowResourcePackageSource
    selectedResourceRefs?: readonly string[]
    includeSelection?: boolean
  }): Promise<WorkflowAuthoringSession & {
    artifactKind: "resource-package"
    target: WorkflowResourcePackageTarget
    selection?: WorkflowResourcePackageSelectionRead
  }> {
    const sessionId = safeSessionId(input.sessionId?.trim() || `resource-package-${randomUUID()}`)
    try {
      await this.store.read(this.metadataPath(sessionId))
      throw new Error(`Workflow authoring session already exists: ${sessionId}`)
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
    const authority = this.resourcePackageBinding()
    const workspace = this.workspaceResourceLayer()
    let selectedResourceRefs = (input.selectedResourceRefs ?? []).map(exactResourceRef)
    if (new Set(selectedResourceRefs).size !== selectedResourceRefs.length) {
      throw new Error("Workflow resource-package selection contains duplicate exact refs")
    }
    const liveFiles = await this.physicalTree(workspace.rootDir)
    const liveBaseArtifactRevision = hashWorkflowBinaryFiles(liveFiles)
    const liveSnapshot = await authority.registry.snapshot()
    const sourceFiles = input.source.kind === "workspace-layer"
      ? liveFiles
      : cloneBinaryFiles(input.source.files)
    if (sourceFiles.length === 0) {
      throw new Error("Workflow resource-package authoring requires one complete non-empty package")
    }
    const sourcePaths = new Set(sourceFiles.map((file) => file.path))
    if (sourcePaths.size !== sourceFiles.length) {
      throw new Error("Workflow resource-package input contains duplicate paths")
    }

    for (const mount of Object.keys(MOUNTS)) {
      await this.store.ensureDirectory(`${this.root(sessionId)}/${mount.slice(1)}`)
    }
    try {
      for (const file of sourceFiles) {
        await this.store.writeBytesAtomic(`${this.root(sessionId)}/base/${file.path}`, file.bytes)
        await this.store.writeBytesAtomic(`${this.root(sessionId)}/work/${file.path}`, file.bytes)
      }
      const candidateRoot = this.candidateRoot(sessionId)
      const loaded = await loadResourceTree({ rootDir: candidateRoot })
      const candidateSnapshot = await authority.registry.loadIsolatedSnapshot({
        layers: this.candidateLayers(candidateRoot),
      })
      if (selectedResourceRefs.length === 0) {
        selectedResourceRefs = sortedUnique([
          ...candidateSnapshot.appBundles
            .filter((item) => candidateSnapshot.registry.byId.get(item.resource.resourceId)?.effectiveOrigin?.layerId === "workspace")
            .map((item) => resourceRef(item.resource.resourceId)),
          ...candidateSnapshot.agentResources.agentDefinitions
            .filter((item) => candidateSnapshot.registry.byId.get(item.resource.resourceId)?.effectiveOrigin?.layerId === "workspace")
            .map((item) => resourceRef(item.resource.resourceId)),
        ])
      }
      for (const ref of selectedResourceRefs) {
        const id = ref.slice("resource://".length)
        const selected = candidateSnapshot.registry.byId.get(id)
        if (!selected?.resource || selected.effectiveOrigin?.layerId !== "workspace") {
          throw new Error(`Selected resource is not owned by the candidate workspace package: ${ref}`)
        }
      }
      const form = selectedResourceRefs
        .map((ref) => candidateSnapshot.registry.byId.get(ref.slice("resource://".length))?.resource?.kind)
        .find((kind): kind is AiWorkflowForm => kind === "AICtrlWorkflow" || kind === "AIDataWorkflow")
        ?? (candidateSnapshot.registry.byKind.get("AICtrlWorkflow")?.length ? "AICtrlWorkflow" : "AIDataWorkflow")
      const now = new Date().toISOString()
      const revision = hashWorkflowBinaryFiles(sourceFiles)
      const packageVersion = loaded.manifest.metadata.version
      if (!packageVersion) throw new Error("Workflow resource package manifest requires an exact version")
      const target: WorkflowResourcePackageTarget = {
        kind: "workspace-resource-package",
        layerId: "workspace",
        rootDir: workspace.rootDir,
        packageId: loaded.manifest.resourceId,
        packageVersion,
        baseArtifactRevision: liveBaseArtifactRevision,
        baseRegistryRevision: liveSnapshot.registryRevision,
        selectedResourceRefs,
      }
      const session: WorkflowAuthoringSession & {
        artifactKind: "resource-package"
        target: WorkflowResourcePackageTarget
      } = {
        kind: "workflow.authoringSession",
        schemaVersion: 3,
        artifactKind: "resource-package",
        sessionId,
        form,
        status: "open",
        lifecycle: "editing",
        dirty: true,
        target,
        mounts: MOUNTS,
        baseRevision: revision,
        workingRevision: revision,
        currentRevision: revision,
        createdAt: now,
        updatedAt: now,
      }
      await this.writeMetadata(session)
      await this.appendAudit(sessionId, "open-resource-package", {
        sourceKind: input.source.kind,
        packageId: target.packageId,
        packageVersion: target.packageVersion,
        baseArtifactRevision: target.baseArtifactRevision,
        baseRegistryRevision: target.baseRegistryRevision,
        selectedResourceRefs,
      })
      const selection = input.includeSelection
        ? await this.readResourcePackageSelection(sessionId)
        : undefined
      return selection ? { ...session, selection } : session
    } catch (error) {
      await this.store.delete(this.root(sessionId))
      throw error
    }
  }

  async describe(sessionId: string): Promise<WorkflowAuthoringSession> {
    return this.readMetadata(sessionId)
  }

  async list(): Promise<WorkflowAuthoringSession[]> {
    const paths = await this.store.tree(".authoring/sessions")
    const metadata = paths.filter((item) => item.endsWith("/session.json"))
    return Promise.all(metadata.map(async (item) => {
      const sessionId = item.slice(".authoring/sessions/".length, -"/session.json".length)
      return this.readMetadata(sessionId)
    }))
  }

  async tree(sessionId: string, logicalPath = "/work"): Promise<string[]> {
    await this.readMetadata(sessionId)
    const resolved = this.resolve(sessionId, logicalPath)
    await this.requirePathKind(resolved, "tree", "directory")
    const paths = await this.store.tree(resolved.storePath)
    const base = `${this.root(sessionId)}/${resolved.mount.slice(1)}`
    const result = paths.map((item) => `/${resolved.mount.slice(1)}/${item.slice(base.length + 1)}`)
    await this.appendAudit(sessionId, "tree", { path: logicalPath, count: result.length })
    return result
  }

  async read(sessionId: string, logicalPath: string): Promise<string> {
    await this.readMetadata(sessionId)
    const resolved = this.resolve(sessionId, logicalPath)
    await this.requirePathKind(resolved, "read", "file")
    const content = await this.store.read(resolved.storePath)
    await this.appendAudit(sessionId, "read", { path: logicalPath })
    return content
  }

  async readBytes(sessionId: string, logicalPath: string): Promise<Uint8Array> {
    await this.readMetadata(sessionId)
    const resolved = this.resolve(sessionId, logicalPath)
    await this.requirePathKind(resolved, "read", "file")
    const bytes = await this.store.readBytes(resolved.storePath)
    await this.appendAudit(sessionId, "read-bytes", { path: logicalPath, byteLength: bytes.byteLength })
    return bytes
  }

  async readResourcePackageSelection(
    sessionId: string,
    limit = 24,
  ): Promise<WorkflowResourcePackageSelectionRead> {
    const session = await this.readMetadata(sessionId)
    if (session.artifactKind !== "resource-package" || session.target.kind !== "workspace-resource-package") {
      throw new Error("Workflow resource selection read requires a ResourcePackage authoring session")
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 24) {
      throw new Error("Workflow resource selection read limit must be between 1 and 24")
    }
    const snapshot = await this.resourcePackageBinding().registry.loadIsolatedSnapshot({
      layers: this.candidateLayers(this.candidateRoot(sessionId)),
    })
    const resourceIds = this.resourcePackageSelectionClosure(snapshot, session.target.selectedResourceRefs)
    const logicalPaths = resourceIds
      .map((resourceId) => snapshot.registry.byId.get(resourceId))
      .filter((entry) => entry?.resource && entry.effectiveOrigin?.layerId === "workspace")
      .map((entry) => entry!.resource!.logicalPath)
    const kindDefinitionPaths = this.resourcePackageSelectionKindDefinitionPaths(snapshot, resourceIds)
    const dependencyPaths = this.resourcePackageSelectionDependencyPaths(snapshot, new Set(resourceIds))
    const allPaths = sortedUnique(["manifest.xnl", ...logicalPaths, ...kindDefinitionPaths, ...dependencyPaths])
    const selectedPaths = allPaths.slice(0, limit)
    const files = await Promise.all(selectedPaths.map(async (logicalPath) => ({
      path: `/work/${logicalPath}`,
      content: await this.read(sessionId, `/work/${logicalPath}`),
    })))
    await this.appendAudit(sessionId, "read-resource-selection", {
      selectedResourceRefs: session.target.selectedResourceRefs,
      resourceCount: resourceIds.length,
      fileCount: files.length,
      total: allPaths.length,
      truncated: allPaths.length > selectedPaths.length,
    })
    return {
      kind: "workflow.resourcePackageSelectionRead",
      sessionId,
      revision: session.workingRevision,
      selectedResourceRefs: [...session.target.selectedResourceRefs],
      resourceRefs: resourceIds.map(resourceRef),
      files,
      total: allPaths.length,
      truncated: allPaths.length > selectedPaths.length,
    }
  }

  private resourcePackageSelectionKindDefinitionPaths(
    snapshot: EidolonResourceRegistrySnapshot,
    includedResourceIds: readonly string[],
  ): string[] {
    const kinds = sortedUnique(includedResourceIds.flatMap((resourceId) => {
      const resource = snapshot.registry.byId.get(resourceId)?.resource
      return resource ? [resource.kind] : []
    }))
    const paths: string[] = []
    for (const kind of kinds) {
      const effective = snapshot.registry.kindDefinitions.get(kind)
      if (!effective) continue
      const documentUri = effective.definition.documentUri
      const workspaceOrigin = effective.origins.find((origin) => (
        origin.layerId === "workspace" && origin.documentUri === documentUri
      ))
      if (!workspaceOrigin || !documentUri.startsWith("vfs://@/")) continue
      const relative = documentUri.slice("vfs://@/".length)
      if (!relative || relative.includes("#") || relative.includes("?")) continue
      paths.push(safeRelative(relative))
    }
    return sortedUnique(paths)
  }

  private resourcePackageSelectionClosure(
    snapshot: EidolonResourceRegistrySnapshot,
    selectedResourceRefs: readonly string[],
  ): string[] {
    const included = new Set(selectedResourceRefs.map((ref) => exactResourceRef(ref).slice("resource://".length)))
    let changed = true
    while (changed) {
      const sizeBefore = included.size
      for (const app of snapshot.appBundles) {
        const appId = app.resource.resourceId
        const workflowIds = app.workflowBindings.map((binding) => binding.resource.resourceId)
        if (included.has(appId) || workflowIds.some((resourceId) => included.has(resourceId))) {
          included.add(appId)
          for (const resourceId of workflowIds) included.add(resourceId)
        }
      }
      for (const binding of snapshot.agentResources.materialBindings) {
        const relatedIds = [
          binding.resource.resourceId,
          binding.task.workflowRef.slice("resource://".length),
          binding.task.agentDefinitionRef.slice("resource://".length),
          binding.port.resource.resourceId,
          binding.material.resource.resourceId,
        ]
        if (relatedIds.some((resourceId) => included.has(resourceId))) {
          for (const resourceId of relatedIds) included.add(resourceId)
        }
      }
      for (const agent of snapshot.agentResources.agentDefinitions) {
        if (!included.has(agent.resource.resourceId)) continue
        for (const message of agent.messages) included.add(message.prompt.resource.resourceId)
        for (const tool of agent.tools) included.add(tool.resource.resourceId)
        for (const port of agent.materialPorts) included.add(port.resource.resourceId)
      }
      changed = included.size !== sizeBefore
    }
    return [...included].sort(compareCodeUnits)
  }

  private resourcePackageSelectionDependencyPaths(
    snapshot: EidolonResourceRegistrySnapshot,
    includedResourceIds: ReadonlySet<string>,
  ): string[] {
    const dependencyPaths: string[] = []
    const add = (value: unknown, ownerLogicalPath: string): void => {
      if (typeof value !== "string" || !value.startsWith("vfs://./")) return
      const relative = value.slice("vfs://./".length).split("#", 1)[0]
      if (!relative) return
      const ownerDirectory = path.posix.dirname(ownerLogicalPath)
      dependencyPaths.push(safeRelative(ownerDirectory === "." ? relative : `${ownerDirectory}/${relative}`))
    }
    const visitNode = (value: unknown, ownerLogicalPath: string): void => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return
      const properties = ownDataValue(value, "properties")
      add(ownDataValue(properties, "src"), ownerLogicalPath)
      const body = ownDataValue(value, "body")
      if (Array.isArray(body)) for (const child of body) visitNode(child, ownerLogicalPath)
      const subdomains = ownDataValue(value, "subdomains")
      if (typeof subdomains === "object" && subdomains !== null && !Array.isArray(subdomains)) {
        for (const child of Object.values(subdomains)) visitNode(child, ownerLogicalPath)
      }
    }
    for (const app of snapshot.appBundles) {
      for (const binding of app.workflowBindings) {
        if (!includedResourceIds.has(binding.resource.resourceId)) continue
        const ownerLogicalPath = binding.resource.logicalPath
        const contract = binding.resource.node.subdomains.FlowContract
        add(contract?.properties.input, ownerLogicalPath)
        add(contract?.properties.output, ownerLogicalPath)
        visitNode(binding.resource.node, ownerLogicalPath)
      }
    }
    return sortedUnique(dependencyPaths)
  }

  async write(sessionId: string, logicalPath: string, content: string): Promise<{ path: string; revision: string }> {
    const active = await this.readMetadata(sessionId)
    const resolved = this.resolve(sessionId, logicalPath)
    if (MOUNTS[resolved.mount] === "read_only") throw new Error(`${resolved.mount} is read-only`)
    if (!resolved.relative) throw new Error("Workflow authoring writes require a file path")
    const actual = await this.store.kind(resolved.storePath)
    if (actual === "directory") {
      throw new WorkflowAuthoringVfsError({
        kind: "workflow.authoringVfsDiagnostic",
        code: "operation_mismatch",
        operation: "write",
        path: logicalPath,
        expected: "file",
        actual,
        mounts: MOUNTS,
      })
    }
    if (active.artifactKind === "resource-package" && actual === "file") {
      decodeUtf8(await this.store.readBytes(resolved.storePath), logicalPath)
    }
    await this.store.writeAtomic(resolved.storePath, content)
    const session = await this.invalidate(sessionId)
    await this.appendAudit(sessionId, "write", { path: logicalPath, revision: session.currentRevision })
    return { path: logicalPath, revision: session.currentRevision }
  }

  async edit(sessionId: string, logicalPath: string, oldText: string, newText: string): Promise<{ path: string; revision: string }> {
    const content = await this.read(sessionId, logicalPath)
    if (!content.includes(oldText)) throw new Error("oldText not found in workflow authoring file")
    const result = await this.write(sessionId, logicalPath, content.replace(oldText, newText))
    await this.appendAudit(sessionId, "edit", { path: logicalPath })
    return result
  }

  async patch(sessionId: string, patchSource: string): Promise<{ paths: string[]; revision: string }> {
    const commands = parsePatch(patchSource)
    const session = await this.readMetadata(sessionId)
    const work = new Map((await this.mountBinaryFiles(sessionId, "work")).map((file) => [file.path, file.bytes]))
    const operations: WorkflowStructuredPatchOperation[] = []
    for (const command of commands) {
      const logicalPath = command.path.startsWith("/") ? command.path : `/work/${command.path}`
      const resolved = this.resolve(sessionId, logicalPath)
      if (resolved.mount !== "/work" || !resolved.relative) {
        throw new Error("Workflow authoring patch operations are restricted to /work files")
      }
      if (command.kind === "add") {
        operations.push({ kind: "add", path: logicalPath, content: patchAddedText(command.body) })
      } else if (command.kind === "delete") {
        operations.push({ kind: "delete", path: logicalPath })
      } else {
        const current = work.get(resolved.relative)
        if (current === undefined) throw new Error(`Workflow authoring patch path does not exist: ${logicalPath}`)
        operations.push({
          kind: "update",
          path: logicalPath,
          content: applyUpdateHunks(decodeUtf8(current, logicalPath), command.body),
        })
      }
    }
    return this.applyPatch({
      sessionId,
      expectedWorkingRevision: session.workingRevision,
      operations,
      auditOperation: "patch",
    })
  }

  async applyPatch(input: {
    sessionId: string
    expectedWorkingRevision: string
    operations: readonly WorkflowStructuredPatchOperation[]
    auditOperation?: "patch" | "structured-patch"
  }): Promise<{ paths: string[]; revision: string }> {
    return this.store.withExclusiveLock(this.lockPath(input.sessionId), () => this.applyPatchUnlocked(input))
  }

  private async applyPatchUnlocked(input: {
    sessionId: string
    expectedWorkingRevision: string
    operations: readonly WorkflowStructuredPatchOperation[]
    auditOperation?: "patch" | "structured-patch"
  }): Promise<{ paths: string[]; revision: string }> {
    if (input.operations.length === 0) throw new Error("Workflow authoring structured patch is empty")
    const session = await this.readMetadata(input.sessionId)
    const actualRevision = await this.workRevision(input.sessionId)
    if (input.expectedWorkingRevision !== actualRevision) {
      throw new Error(`Workflow authoring revision conflict: expected ${input.expectedWorkingRevision}, current ${actualRevision}`)
    }
    const work = new Map((await this.mountBinaryFiles(input.sessionId, "work")).map((file) => [file.path, file.bytes]))
    const normalized = input.operations.map((operation) => {
      const resolved = this.resolve(input.sessionId, operation.path.startsWith("/") ? operation.path : `/work/${operation.path}`)
      if (resolved.mount !== "/work" || !resolved.relative) {
        throw new Error("Workflow authoring structured patch operations are restricted to /work files")
      }
      return { operation, relative: resolved.relative, logicalPath: `/work/${resolved.relative}` }
    })
    const unique = new Set(normalized.map((item) => item.relative))
    if (unique.size !== normalized.length) throw new Error("Workflow authoring structured patch contains duplicate paths")
    for (const item of normalized) {
      const exists = work.has(item.relative)
      if (item.operation.kind === "add") {
        if (exists) throw new Error(`Workflow authoring patch path already exists: ${item.logicalPath}`)
        work.set(item.relative, new TextEncoder().encode(item.operation.content))
      } else if (item.operation.kind === "update") {
        if (!exists) throw new Error(`Workflow authoring patch path does not exist: ${item.logicalPath}`)
        decodeUtf8(work.get(item.relative)!, item.logicalPath)
        work.set(item.relative, new TextEncoder().encode(item.operation.content))
      } else {
        if (!exists) throw new Error(`Workflow authoring patch path does not exist: ${item.logicalPath}`)
        work.delete(item.relative)
      }
    }
    const workFiles = [...work].map(([filePath, bytes]) => ({ path: filePath, bytes }))
    const revision = hashWorkflowBinaryFiles(workFiles)
    const updated = this.deriveSession({
      ...session,
      workingRevision: revision,
      currentRevision: revision,
      diffRevision: undefined,
      validationRevision: undefined,
      dryRunRevision: undefined,
      diffResult: undefined,
      validationResult: undefined,
      dryRunProjection: undefined,
      proofSet: undefined,
      resourcePackageProofSet: undefined,
      updatedAt: new Date().toISOString(),
    }, { base: session.baseRevision, working: revision })

    // Re-check immediately before the one authoritative tree swap. All operation
    // validation above is side-effect free, so a failure cannot expose a prefix.
    if (await this.workRevision(input.sessionId) !== actualRevision) {
      throw new Error(`Workflow authoring revision conflict: current revision changed during patch`)
    }
    await this.replaceSessionRoot(input.sessionId, updated, workFiles)
    const paths = normalized.map((item) => item.logicalPath)
    await this.appendAudit(input.sessionId, input.auditOperation ?? "structured-patch", { paths, revision })
    return { paths, revision }
  }

  async delete(sessionId: string, logicalPath: string): Promise<{ path: string; deleted: true }> {
    const resolved = this.resolve(sessionId, logicalPath)
    if (MOUNTS[resolved.mount] === "read_only") throw new Error(`${resolved.mount} is read-only`)
    if (!resolved.relative) throw new Error("Workflow authoring delete requires a nested path")
    await this.store.delete(resolved.storePath)
    await this.invalidate(sessionId)
    await this.appendAudit(sessionId, "delete", { path: logicalPath })
    return { path: logicalPath, deleted: true }
  }

  async search(sessionId: string, query: string, logicalPath = "/work"): Promise<Array<{ path: string; line: number; text: string }>> {
    if (!query) return []
    const session = await this.readMetadata(sessionId)
    const paths = await this.tree(sessionId, logicalPath)
    const matches: Array<{ path: string; line: number; text: string }> = []
    for (const item of paths) {
      const resolved = this.resolve(sessionId, item)
      const content = session.artifactKind === "resource-package"
        ? tryDecodeUtf8(await this.store.readBytes(resolved.storePath))
        : await this.store.read(resolved.storePath)
      if (content === undefined) continue
      content.split(/\r?\n/).forEach((line, index) => {
        if (line.includes(query)) matches.push({ path: item, line: index + 1, text: line })
      })
    }
    await this.appendAudit(sessionId, "search", { path: logicalPath, query, matches: matches.length })
    return matches
  }

  async diff(sessionId: string): Promise<WorkflowAuthoringDiffResult> {
    const base = new Map((await this.mountBinaryFiles(sessionId, "base")).map((file) => [file.path, file.bytes]))
    const work = new Map((await this.mountBinaryFiles(sessionId, "work")).map((file) => [file.path, file.bytes]))
    const paths = [...new Set([...base.keys(), ...work.keys()])].sort(compareCodeUnits)
    const summary = { created: 0, modified: 0, deleted: 0, unchanged: 0 }
    const changes: WorkflowAuthoringDiffResult["changes"] = paths.map((item) => {
      const kind: WorkflowAuthoringDiffResult["changes"][number]["kind"] = !base.has(item) ? "created"
        : !work.has(item) ? "deleted"
          : bytesEqual(base.get(item), work.get(item)) ? "unchanged"
            : "modified"
      summary[kind] += 1
      return { path: `/work/${item}`, kind }
    })
    const result: WorkflowAuthoringDiffResult = { summary, changes }
    const session = await this.readMetadata(sessionId)
    const revision = await this.workRevision(sessionId)
    await this.writeMetadata({
      ...session,
      currentRevision: revision,
      diffRevision: revision,
      diffResult: result,
      updatedAt: new Date().toISOString(),
    })
    await this.appendAudit(sessionId, "diff", { summary, revision })
    return result
  }

  async audit(sessionId: string, requireSession = true): Promise<WorkflowAuthoringAuditEntry[]> {
    if (requireSession) await this.readMetadata(sessionId)
    try {
      return (await this.store.read(this.auditPath(sessionId)))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as WorkflowAuthoringAuditEntry)
    } catch (error) {
      if (errorCode(error) === "ENOENT") return []
      throw error
    }
  }

  async listPublicationReceipts(sessionId: string): Promise<WorkflowPublicationReceipt[]> {
    await this.readMetadata(sessionId)
    const prefix = `${this.root(sessionId)}/publications`
    const paths = (await this.store.tree(prefix)).filter((item) => item.endsWith(".json"))
    const receipts = await Promise.all(paths.map(async (item) => (
      JSON.parse(await this.store.read(item)) as WorkflowPublicationReceipt
    )))
    return receipts.sort((left, right) => left.sequence - right.sequence || compareCodeUnits(left.receiptId, right.receiptId))
  }

  private async readResourcePackagePublicationReceiptFiles(
    session: WorkflowAuthoringSession,
  ): Promise<WorkflowResourcePackagePublicationReceipt[]> {
    const prefix = `${this.root(session.sessionId)}/resource-package-publications`
    const paths = (await this.store.tree(prefix)).filter((item) => item.endsWith(".json"))
    return Promise.all(paths.map(async (item) => {
      let value: unknown
      try {
        value = JSON.parse(await this.store.read(item))
      } catch {
        return receiptInvalid("Durable receipt must contain valid JSON.")
      }
      const filename = path.posix.basename(item)
      const pathReceiptId = filename.slice(0, -".json".length)
      return validateResourcePackagePublicationReceipt(value, {
        pathReceiptId,
        session,
      })
    }))
  }

  async listResourcePackagePublicationReceipts(
    sessionId: string,
  ): Promise<WorkflowResourcePackagePublicationReceipt[]> {
    const session = await this.readMetadata(sessionId)
    const receipts = await this.readResourcePackagePublicationReceiptFiles(session)
    for (const receipt of receipts) requireResourcePackagePublicationIssuance(session, receipt)
    const issuances = session.resourcePackagePublicationIssuances ?? []
    if (receipts.length !== issuances.length || issuances.some((issuance) => (
      !receipts.some((receipt) => receipt.receiptId === issuance.receiptId
        && receipt.sourceRevision === issuance.sourceRevision)
    ))) {
      receiptIssuanceMismatch("Durable receipts do not exactly match the owner session issuance ledger.")
    }
    return receipts.sort((left, right) => (
      compareCodeUnits(left.createdAt, right.createdAt)
      || compareCodeUnits(left.receiptId, right.receiptId)
    ))
  }

  async findResourcePackagePublicationReceipt(
    sessionId: string,
    sourceRevision: string,
  ): Promise<WorkflowResourcePackagePublicationReceipt | undefined> {
    const receipt = (await this.listResourcePackagePublicationReceipts(sessionId))
      .find((receipt) => receipt.sourceRevision === sourceRevision)
    if (!receipt) return undefined
    if (receipt.sourceRevision !== sourceRevision) {
      receiptIssuanceMismatch("Durable receipt revision does not match the requested issuance.")
    }
    return receipt
  }

  async findRecoverableResourcePackagePublicationReceipt(input: {
    sessionId: string
    sourceRevision: string
    baseArtifactRevision: string
    baseRegistryRevision: string
    createdAt: string
  }): Promise<WorkflowResourcePackagePublicationRecovery | undefined> {
    const session = await this.readMetadata(input.sessionId)
    if (session.artifactKind !== "resource-package" || session.target.kind !== "workspace-resource-package") {
      receiptIssuanceMismatch("Receipt recovery requires one ResourcePackage owner session.")
    }
    const proofSet = session.resourcePackageProofSet
    if (!proofSet
      || session.workingRevision !== input.sourceRevision
      || proofSet.revision !== input.sourceRevision
      || proofSet.artifactDigest !== input.sourceRevision
      || proofSet.baseArtifactRevision !== input.baseArtifactRevision
      || proofSet.baseRegistryRevision !== input.baseRegistryRevision
      || session.target.baseArtifactRevision !== input.baseArtifactRevision
      || session.target.baseRegistryRevision !== input.baseRegistryRevision) {
      receiptIssuanceMismatch("Unissued receipt does not have one exact current candidate proof authority.")
    }
    const receipts = await this.readResourcePackagePublicationReceiptFiles(session)
    const issuances = session.resourcePackagePublicationIssuances ?? []
    for (const receipt of receipts) {
      const issuance = issuances.find((item) => item.sourceRevision === receipt.sourceRevision)
      if (issuance) requireResourcePackagePublicationIssuance(session, receipt)
    }
    if (issuances.some((issuance) => !receipts.some((receipt) => (
      receipt.receiptId === issuance.receiptId && receipt.sourceRevision === issuance.sourceRevision
    )))) {
      receiptIssuanceMismatch("Issued receipt history is incomplete during publication recovery.")
    }
    const unissued = receipts.filter((receipt) => !issuances.some((issuance) => (
      issuance.receiptId === receipt.receiptId && issuance.sourceRevision === receipt.sourceRevision
    )))
    if (unissued.length === 0) return undefined
    if (unissued.length !== 1 || unissued[0]!.sourceRevision !== input.sourceRevision) {
      receiptIssuanceMismatch("Publication recovery found an unexpected unissued receipt set.")
    }
    const receipt = validateResourcePackagePublicationReceipt(unissued[0], {
      pathReceiptId: unissued[0]!.receiptId,
      session,
      expectedSourceRevision: input.sourceRevision,
      requireRetainedProof: true,
      requireProofProjection: true,
    })
    if (receipt.baseArtifactRevision !== input.baseArtifactRevision
      || receipt.baseRegistryRevision !== input.baseRegistryRevision
      || receipt.createdAt !== input.createdAt
      || hashWorkflowBinaryFiles(await this.mountBinaryFiles(input.sessionId, "work")) !== input.sourceRevision) {
      receiptIssuanceMismatch("Unissued receipt facts do not match the exact recoverable publication attempt.")
    }
    const authority = Object.freeze({})
    this.resourcePackagePublicationRecoveryAuthorities.set(authority, {
      sessionId: input.sessionId,
      sourceRevision: input.sourceRevision,
      receiptId: receipt.receiptId,
    })
    return Object.freeze({ receipt, authority })
  }

  async resourcePackagePublicationCandidate(input: {
    sessionId: string
    expectedRevision: string
  }): Promise<WorkflowResourcePackagePublicationCandidate> {
    const session = await this.readMetadata(input.sessionId)
    if (session.artifactKind !== "resource-package" || session.target.kind !== "workspace-resource-package") {
      throw new Error("Workflow ResourcePackage publication requires a resource-package session")
    }
    if (session.workingRevision !== input.expectedRevision) {
      throw new Error(`Workflow ResourcePackage publication revision conflict: expected ${input.expectedRevision}, current ${session.workingRevision}`)
    }
    const proofSet = session.resourcePackageProofSet
    if (
      !proofSet
      || proofSet.revision !== session.workingRevision
      || proofSet.artifactDigest !== session.workingRevision
      || proofSet.baseArtifactRevision !== session.target.baseArtifactRevision
      || proofSet.baseRegistryRevision !== session.target.baseRegistryRevision
    ) {
      throw new Error("Workflow ResourcePackage publication requires one complete current proof receipt set")
    }
    const files = await this.mountBinaryFiles(input.sessionId, "work")
    const artifactDigest = hashWorkflowBinaryFiles(files)
    if (artifactDigest !== session.workingRevision) {
      throw new Error(`Workflow ResourcePackage publication candidate drifted: expected ${session.workingRevision}, current ${artifactDigest}`)
    }
    return {
      session: session as WorkflowResourcePackagePublicationCandidate["session"],
      revision: session.workingRevision,
      proofSet,
      files: cloneBinaryFiles(files),
    }
  }

  async recordResourcePackagePublication(input: {
    sessionId: string
    expectedRevision: string
    receipt: WorkflowResourcePackagePublicationReceipt
    files: readonly WorkflowAuthoringBinaryFile[]
    recoveryAuthority?: object
  }): Promise<WorkflowResourcePackagePublicationReceipt> {
    return this.store.withExclusiveLock(this.lockPath(input.sessionId), async () => {
      const session = await this.readMetadata(input.sessionId)
      if (session.artifactKind !== "resource-package" || session.target.kind !== "workspace-resource-package") {
        throw new Error("Workflow ResourcePackage receipt requires a resource-package session")
      }
      const receipt = validateResourcePackagePublicationReceipt(input.receipt, {
        pathReceiptId: input.receipt && typeof input.receipt === "object"
          ? ownDataValue(input.receipt, "receiptId") as string | undefined
          : undefined,
        session,
        expectedSourceRevision: input.expectedRevision,
        requireRetainedProof: true,
        requireProofProjection: true,
      })
      if (
        receipt.sessionId !== input.sessionId
        || receipt.sourceRevision !== input.expectedRevision
        || receipt.packageId !== session.target.packageId
        || receipt.packageVersion !== session.target.packageVersion
      ) {
        throw new Error("Workflow ResourcePackage receipt identity does not match the authoring session")
      }
      const artifactDigest = hashWorkflowBinaryFiles(input.files)
      if (artifactDigest !== input.expectedRevision || receipt.artifactDigest !== artifactDigest) {
        throw new Error("Workflow ResourcePackage receipt artifact digest does not match the published bytes")
      }
      const issuances = session.resourcePackagePublicationIssuances ?? []
      const issuance = issuances.find((item) => item.sourceRevision === input.expectedRevision)
      if (issuance && (
        issuance.receiptId !== receipt.receiptId
        || issuance.sessionId !== receipt.sessionId
        || issuance.issuedAt !== receipt.createdAt
      )) {
        receiptIssuanceMismatch(
          `Revision ${input.expectedRevision} already has a different exact publication issuance.`,
        )
      }
      const recovery = input.recoveryAuthority
        ? this.resourcePackagePublicationRecoveryAuthorities.get(input.recoveryAuthority)
        : undefined
      if (input.recoveryAuthority && (
        !recovery
        || recovery.sessionId !== input.sessionId
        || recovery.sourceRevision !== input.expectedRevision
        || recovery.receiptId !== receipt.receiptId
      )) {
        receiptIssuanceMismatch("Receipt recovery authority is missing or does not match the exact issuance.")
      }
      let existing: WorkflowResourcePackagePublicationReceipt | undefined
      if (recovery && !issuance) {
        const durable = await this.readResourcePackagePublicationReceiptFiles(session)
        const unissued = durable.filter((item) => !issuances.some((issued) => (
          issued.receiptId === item.receiptId && issued.sourceRevision === item.sourceRevision
        )))
        if (unissued.length !== 1
          || unissued[0]!.receiptId !== receipt.receiptId
          || JSON.stringify(unissued[0]) !== JSON.stringify(receipt)) {
          receiptIssuanceMismatch("Recoverable receipt changed before its issuance was recorded.")
        }
        for (const item of durable) {
          if (item !== unissued[0]) requireResourcePackagePublicationIssuance(session, item)
        }
        existing = unissued[0]
      } else {
        existing = await this.findResourcePackagePublicationReceipt(input.sessionId, input.expectedRevision)
      }
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(receipt)) {
          throw new Error("Workflow ResourcePackage publication already has a different receipt for this revision")
        }
        if (
          session.latestPublicationReceiptId === existing.receiptId
          && session.publishedRevision === input.expectedRevision
          && session.baseRevision === input.expectedRevision
          && session.target.baseArtifactRevision === existing.artifactDigest
          && session.target.baseRegistryRevision === existing.registryRevision
        ) {
          if (input.recoveryAuthority) {
            this.resourcePackagePublicationRecoveryAuthorities.delete(input.recoveryAuthority)
          }
          return existing
        }
      }
      if (session.workingRevision !== input.expectedRevision) {
        throw new Error(`Workflow ResourcePackage receipt revision conflict: expected ${input.expectedRevision}, current ${session.workingRevision}`)
      }
      if (!existing) {
        await this.store.writeAtomic(
          this.resourcePackagePublicationPath(input.sessionId, receipt.receiptId),
          `${JSON.stringify(receipt, null, 2)}\n`,
        )
      }
      await this.store.replaceTreeBytesAtomic(`${this.root(input.sessionId)}/base`, input.files)
      const updatedTarget: WorkflowResourcePackageTarget = {
        ...session.target,
        baseArtifactRevision: receipt.artifactDigest,
        baseRegistryRevision: receipt.registryRevision,
      }
      const updated = this.deriveSession({
        ...session,
        target: updatedTarget,
        status: "published",
        baseRevision: input.expectedRevision,
        workingRevision: input.expectedRevision,
        publishedRevision: input.expectedRevision,
        latestPublicationReceiptId: receipt.receiptId,
        resourcePackagePublicationIssuances: issuance ? issuances : [
          ...issuances,
          {
            kind: "workflow.resourcePackagePublicationIssuance",
            schemaVersion: "workflow.resource-package-publication-issuance/v1",
            sequence: issuances.length + 1,
            sessionId: receipt.sessionId,
            sourceRevision: receipt.sourceRevision,
            receiptId: receipt.receiptId,
            issuedAt: receipt.createdAt,
          },
        ],
        pendingPublication: undefined,
        currentRevision: input.expectedRevision,
        updatedAt: new Date().toISOString(),
      }, { base: input.expectedRevision, working: input.expectedRevision })
      await this.writeMetadata(updated)
      await this.appendAudit(input.sessionId, "publish-resource-package", {
        sourceRevision: input.expectedRevision,
        receiptId: receipt.receiptId,
        packageId: receipt.packageId,
        registryRevision: receipt.registryRevision,
        publicationEffectDispatched: true,
        runtimeEffectDispatched: false,
      })
      if (input.recoveryAuthority) {
        this.resourcePackagePublicationRecoveryAuthorities.delete(input.recoveryAuthority)
      }
      return existing ?? receipt
    })
  }

  async createAuthoringReceipt(input: {
    sessionId: string
    expectedWorkingRevision: string
    stage: WorkflowAuthoringReceipt["stage"]
    outcome: WorkflowAuthoringReceipt["outcome"]
  }): Promise<WorkflowAuthoringReceipt> {
    const session = await this.readMetadata(input.sessionId)
    if (session.workingRevision !== input.expectedWorkingRevision) {
      throw new Error(`Workflow authoring receipt revision conflict: expected ${input.expectedWorkingRevision}, current ${session.workingRevision}`)
    }
    const currentProofReady = session.artifactKind === "resource-package"
      ? session.resourcePackageProofSet?.revision === session.workingRevision
      : session.proofSet?.revision === session.workingRevision
    if (input.outcome === "ready" && !currentProofReady) {
      throw new Error("Workflow ready receipt requires a complete current proof receipt set")
    }
    if (input.outcome === "published" && (
      session.publishedRevision !== session.workingRevision
      || session.dirty
      || !session.latestPublicationReceiptId
    )) {
      throw new Error("Workflow published receipt requires a clean current publication receipt")
    }
    const diagnosticCodes = (session.validationResult?.diagnostics ?? [])
      .map((item) => item.code)
    const boundedDiagnostics = diagnosticCodes.slice(0, 20)
    const receipt: WorkflowAuthoringReceipt = {
      kind: "workflow.authoringReceipt",
      receiptId: randomUUID(),
      authoringSessionId: session.sessionId,
      stage: input.stage,
      outcome: input.outcome,
      workingRevision: session.workingRevision,
      publishedRevision: session.publishedRevision,
      dirty: session.dirty,
      changedPaths: (session.diffResult?.changes ?? [])
        .filter((change) => change.kind !== "unchanged")
        .map((change) => change.path),
      proofReceiptIds: session.artifactKind === "resource-package"
        ? session.resourcePackageProofSet ? resourcePackageProofReceiptIds(session.resourcePackageProofSet) : []
        : session.proofSet ? proofReceiptIds(session.proofSet) : [],
      publicationReceiptId: session.latestPublicationReceiptId,
      diagnosticCodes: boundedDiagnostics,
      diagnosticsTruncated: diagnosticCodes.length > boundedDiagnostics.length,
      nextAction: input.outcome === "published"
        ? "request_execution_authorization_or_finish"
        : input.outcome === "ready"
          ? "request_publication_authorization_or_finish"
          : input.outcome === "waiting"
            ? "await_user_decision"
            : "inspect_bounded_diagnostics",
      createdAt: new Date().toISOString(),
    }
    await this.store.writeAtomic(
      this.authoringReceiptPath(session.sessionId, receipt.receiptId),
      `${JSON.stringify(receipt, null, 2)}\n`,
    )
    await this.appendAudit(session.sessionId, "authoring-receipt", {
      receiptId: receipt.receiptId,
      stage: receipt.stage,
      outcome: receipt.outcome,
      revision: receipt.workingRevision,
    })
    return receipt
  }

  async validate(sessionId: string): Promise<{ valid: true; revision: string; result: WorkflowResourceLoadResult }> {
    const session = await this.readMetadata(sessionId)
    if (session.artifactKind === "resource-package") {
      throw new Error(
        "WORKFLOW_RESOURCE_PACKAGE_VALIDATE_REQUIRES_PREPARE: ResourcePackage sessions use WorkflowPreparePublication as the single Halfcode/depa validation and proof authority",
      )
    }
    const files = await this.mountFiles(sessionId, "work")
    const sources = Object.fromEntries(files.filter((file) => file.path.endsWith(".xnl")).map((file) => [file.path, file.content]))
    const result = this.resources.load({ form: session.form, sources })
    const codeDiagnostics = validateLocalDataCodeBindings(result, files)
    if (!result.binding || result.diagnostics.length > 0 || codeDiagnostics.length > 0) {
      const details = [
        ...result.diagnostics.map((item) => `${item.code}: ${item.message}`),
        ...codeDiagnostics,
      ].join("; ")
      throw new Error(`Workflow authoring validation failed${details ? `: ${details}` : ""}`)
    }
    const revision = await this.workRevision(sessionId)
    await this.writeMetadata({
      ...session,
      currentRevision: revision,
      validationRevision: revision,
      dryRunRevision: undefined,
      validationResult: result,
      dryRunProjection: undefined,
      proofSet: undefined,
      updatedAt: new Date().toISOString(),
    })
    await this.appendAudit(sessionId, "validate", { revision })
    return { valid: true, revision, result }
  }

  async dryRun(sessionId: string, acceptancePolicy?: WorkflowAcceptancePolicy): Promise<{
    valid: true
    revision: string
    substrate: string
    projection: WorkflowStaticProjection
  }> {
    const session = await this.readMetadata(sessionId)
    const revision = await this.workRevision(sessionId)
    if (session.validationRevision !== revision || !session.validationResult?.binding) {
      throw new Error("Workflow dry-run requires current validation")
    }
    const files = await this.mountFiles(sessionId, "work")
    const sources = Object.fromEntries(files.filter((file) => file.path.endsWith(".xnl")).map((file) => [file.path, file.content]))
    const projection = this.resources.projectStatic({ form: session.form, sources })
    const now = new Date().toISOString()
    let proofSet: WorkflowPublicationProofSet | undefined
    if (session.diffRevision === revision && session.diffResult && session.validationResult.binding) {
      const definitionFqn = session.validationResult.binding.definition.fqn
      const policy: WorkflowAcceptancePolicy = acceptancePolicy ?? {
        requirement: "not_required",
        source: "canonical-profile:explicit-acceptance-policy-default",
      }
      if (!/^(?:canonical-profile|definition-policy):[A-Za-z0-9_.:/-]+$/.test(policy.source)) {
        throw new Error("Workflow acceptance policy source must be canonical-profile or definition-policy authority")
      }
      const common = { revision, bundleDigest: revision, createdAt: now }
      const acceptanceDispositionReceipt: WorkflowPublicationProofSet["acceptanceDispositionReceipt"] = {
        ...common,
        kind: "workflow.acceptanceDispositionReceipt",
        receiptId: proofReceiptId("acceptance", sessionId, revision, `${policy.requirement}:${policy.source}`),
        disposition: policy.requirement,
        policySource: policy.source,
      }
      let candidateAcceptanceReceipt: WorkflowPublicationProofSet["candidateAcceptanceReceipt"]
      if (policy.requirement === "required") {
        if (!policy.fixtureId) throw new Error("Required workflow candidate acceptance needs an explicit fixture id")
        if (!this.candidateHarness) throw new Error("Required workflow candidate acceptance needs an installed isolated fixture harness")
        const candidate = await this.candidateHarness.run({ session, files, projection, fixtureId: policy.fixtureId })
        if (
          candidate.isolated !== true
          || candidate.realEffectDispatched !== false
          || candidate.runtime !== "canonical-depa-flows"
          || candidate.effectProvider !== "isolated-fixture"
        ) {
          throw new Error("Workflow candidate harness violated isolated effect contract")
        }
        candidateAcceptanceReceipt = {
          ...common,
          kind: "workflow.candidateAcceptanceReceipt",
          receiptId: proofReceiptId("candidate", sessionId, revision, policy.fixtureId),
          fixtureId: policy.fixtureId,
          outcome: candidate.outcome,
          evidenceDigest: digestJson(candidate.evidence),
          isolated: true,
          realEffectDispatched: false,
          runtime: "canonical-depa-flows",
          effectProvider: "isolated-fixture",
        }
        if (candidate.outcome !== "passed") {
          throw new Error(`Workflow isolated candidate acceptance did not pass: ${candidate.outcome}`)
        }
      }
      proofSet = {
        revision,
        bundleDigest: revision,
        diffReceipt: {
          ...common,
          kind: "workflow.diffReceipt",
          receiptId: proofReceiptId("diff", sessionId, revision, session.baseRevision),
          baseRevision: session.baseRevision,
          summary: session.diffResult.summary,
        },
        validationReceipt: {
          ...common,
          kind: "workflow.validationReceipt",
          receiptId: proofReceiptId("validation", sessionId, revision, definitionFqn),
          definitionFqn,
          diagnosticCount: session.validationResult.diagnostics.length,
        },
        staticProjectionReceipt: {
          ...common,
          kind: "workflow.staticProjectionReceipt",
          receiptId: proofReceiptId("static-projection", sessionId, revision, digestJson(projection)),
          projectionDigest: digestJson(projection),
          effectDispatched: false,
          acceptanceClaimed: false,
        },
        buildReceipt: {
          ...common,
          kind: "workflow.buildReceipt",
          receiptId: proofReceiptId("build", sessionId, revision, definitionFqn),
          definitionFqn,
          assemblyDigest: digestJson({ revision, definitionFqn, paths: files.map((file) => file.path).sort(compareCodeUnits) }),
        },
        acceptanceDispositionReceipt,
        candidateAcceptanceReceipt,
      }
    }
    const updated = {
      ...session,
      currentRevision: revision,
      dryRunRevision: revision,
      dryRunProjection: projection,
      proofSet,
      updatedAt: now,
    }
    await this.writeMetadata(updated)
    await this.appendAudit(sessionId, "dry-run", { revision, projection })
    return { valid: true, revision, substrate: String(session.validationResult.substrate), projection }
  }

  async preparePublication(input: {
    sessionId: string
    acceptancePolicy?: WorkflowAcceptancePolicy
  }): Promise<{ revision: string; proofSet: WorkflowPublicationProofSet }> {
    await this.diff(input.sessionId)
    await this.validate(input.sessionId)
    await this.dryRun(input.sessionId, input.acceptancePolicy)
    const prepared = await this.readMetadata(input.sessionId)
    if (!prepared.proofSet) throw new Error("Workflow preparation did not produce a complete proof receipt set")
    await this.appendAudit(input.sessionId, "prepare-publication", {
      revision: prepared.workingRevision,
      proofReceiptIds: proofReceiptIds(prepared.proofSet),
    })
    return { revision: prepared.workingRevision, proofSet: prepared.proofSet }
  }

  async prepareResourcePackagePublication(input: {
    sessionId: string
  }): Promise<{ revision: string; proofSet: WorkflowResourcePackagePublicationProofSet }> {
    return this.store.withExclusiveLock(
      this.lockPath(input.sessionId),
      () => this.prepareResourcePackagePublicationUnlocked(input),
    )
  }

  private async prepareResourcePackagePublicationUnlocked(input: {
    sessionId: string
  }): Promise<{ revision: string; proofSet: WorkflowResourcePackagePublicationProofSet }> {
    let session = await this.readMetadata(input.sessionId)
    if (session.artifactKind !== "resource-package" || session.target.kind !== "workspace-resource-package") {
      throw new Error("Workflow resource-package preparation requires a resource-package session")
    }
    const target = session.target
    const authority = this.resourcePackageBinding()
    const liveFiles = await this.physicalTree(target.rootDir)
    const liveArtifactRevision = hashWorkflowBinaryFiles(liveFiles)
    if (liveArtifactRevision !== target.baseArtifactRevision) {
      throw new Error(`Workflow resource package live base revision conflict: expected ${target.baseArtifactRevision}, current ${liveArtifactRevision}`)
    }
    let liveSnapshot
    try {
      liveSnapshot = await authority.registry.loadIsolatedSnapshot({ layers: authority.layers })
    } catch (error) {
      throw new WorkflowResourcePackageValidationError(
        "Workflow resource package live base validation failed",
        resourceDiagnostics(error),
      )
    }
    if (liveSnapshot.registryRevision !== target.baseRegistryRevision) {
      throw new Error(`Workflow resource package live base registry revision conflict: expected ${target.baseRegistryRevision}, current ${liveSnapshot.registryRevision}`)
    }
    const revision = await this.workRevision(input.sessionId)
    if (
      session.resourcePackageProofSet?.revision === revision
      && session.resourcePackageProofSet.baseArtifactRevision === target.baseArtifactRevision
      && session.resourcePackageProofSet.baseRegistryRevision === target.baseRegistryRevision
      && session.resourcePackageProofSet.artifactDigest === revision
    ) {
      return { revision, proofSet: session.resourcePackageProofSet }
    }

    const candidateRoot = this.candidateRoot(input.sessionId)
    let loaded
    let snapshot
    try {
      loaded = await loadResourceTree({ rootDir: candidateRoot })
      snapshot = await authority.registry.loadIsolatedSnapshot({
        layers: this.candidateLayers(candidateRoot),
      })
    } catch (error) {
      throw new WorkflowResourcePackageValidationError(
        "Workflow resource package candidate validation failed",
        resourceDiagnostics(error),
      )
    }
    const packageVersion = loaded.manifest.metadata.version
    if (
      loaded.manifest.resourceId !== target.packageId
      || packageVersion !== target.packageVersion
    ) {
      throw new WorkflowResourcePackageValidationError(
        "Workflow resource package candidate changed package identity",
      )
    }
    const candidateFiles = await this.mountBinaryFiles(input.sessionId, "work")
    const artifactDigest = hashWorkflowBinaryFiles(candidateFiles)
    if (artifactDigest !== revision) {
      throw new Error(`Workflow resource package candidate revision changed during preparation: expected ${revision}, current ${artifactDigest}`)
    }
    const now = new Date().toISOString()
    const common: Omit<WorkflowResourcePackageProofReceiptBase, "receiptId"> = {
      workingRevision: revision,
      baseArtifactRevision: target.baseArtifactRevision,
      baseRegistryRevision: target.baseRegistryRevision,
      artifactDigest,
      createdAt: now,
    }
    const receipt = (kind: string, discriminator: unknown): WorkflowResourcePackageProofReceiptBase => ({
      ...common,
      receiptId: proofReceiptId(kind, input.sessionId, revision, digestJson({
        baseArtifactRevision: target.baseArtifactRevision,
        baseRegistryRevision: target.baseRegistryRevision,
        discriminator,
      })),
    })
    const contentTree = [...loaded.contentIdentities.values()]
      .sort((left, right) => compareCodeUnits(left.resourceId, right.resourceId))
      .map((identity) => ({
        resourceId: identity.resourceId,
        authorityDigest: identity.authorityDigest,
        contentDigest: identity.contentDigest,
      }))
    const packageLoadReceipt: WorkflowResourcePackagePublicationProofSet["packageLoadReceipt"] = {
      ...receipt("resource-package-load", contentTree),
      kind: "workflow.resourcePackageLoadReceipt",
      packageId: loaded.manifest.resourceId,
      packageVersion: packageVersion!,
      manifestResourceId: loaded.manifest.resourceId,
      contentTreeDigest: digestJson(contentTree),
      diagnosticCount: 0,
    }
    const workspaceResourceIds = new Set(
      [...snapshot.registry.byId.values()]
        .filter((entry) => entry.resource !== undefined && entry.effectiveOrigin?.layerId === "workspace")
        .map((entry) => entry.resourceId),
    )
    const effectiveResources = [...snapshot.registry.byId.values()]
      .filter((entry) => entry.resource !== undefined && workspaceResourceIds.has(entry.resourceId))
    const registryProjectionReceipt: WorkflowResourcePackagePublicationProofSet["registryProjectionReceipt"] = {
      ...receipt("resource-registry-projection", {
        compositionRevision: snapshot.registry.compositionRevision,
        registryRevision: snapshot.registryRevision,
      }),
      kind: "workflow.resourceRegistryProjectionReceipt",
      compositionRevision: snapshot.registry.compositionRevision,
      registryRevision: snapshot.registryRevision,
      resourceCount: effectiveResources.length,
      contentIdentityCount: [...snapshot.contentIdentities.keys()]
        .filter((resourceId) => workspaceResourceIds.has(resourceId)).length,
    }
    const workspaceApps = snapshot.appBundles
      .filter((app) => workspaceResourceIds.has(app.resource.resourceId))
    const appRefs = sortedUnique(workspaceApps.map((app) => resourceRef(app.resource.resourceId)))
    const workflowRefs = sortedUnique(workspaceApps.flatMap((app) => (
      app.workflowBindings.map((binding) => binding.ref)
    )))
    const entrypointWorkflowRefs = sortedUnique(workspaceApps.flatMap((app) => (
      app.entrypoints.map((binding) => binding.ref)
    )))
    if (appRefs.length === 0 || workflowRefs.length === 0 || entrypointWorkflowRefs.length === 0) {
      throw new WorkflowResourcePackageValidationError(
        "Workflow resource package candidate requires at least one exact App, workflow and entrypoint projection",
      )
    }
    const appProjectionReceipt: WorkflowResourcePackagePublicationProofSet["appProjectionReceipt"] = {
      ...receipt("resource-app-projection", { appRefs, workflowRefs, entrypointWorkflowRefs }),
      kind: "workflow.resourceAppProjectionReceipt",
      appRefs,
      workflowRefs,
      entrypointWorkflowRefs,
    }
    const workspaceAgents = snapshot.agentResources.agentDefinitions
      .filter((agent) => workspaceResourceIds.has(agent.resource.resourceId))
    const agentRefs = sortedUnique(workspaceAgents.map((agent) => (
      resourceRef(agent.resource.resourceId)
    )))
    const promptRefs = sortedUnique(workspaceAgents.flatMap((agent) => (
      agent.messages
        .filter((message) => workspaceResourceIds.has(message.prompt.resource.resourceId))
        .map((message) => resourceRef(message.prompt.resource.resourceId))
    )))
    const toolRefs = sortedUnique(workspaceAgents.flatMap((agent) => (
      agent.tools
        .filter((tool) => workspaceResourceIds.has(tool.resource.resourceId))
        .map((tool) => resourceRef(tool.resource.resourceId))
    )))
    const materialPortRefs = sortedUnique(snapshot.agentResources.materialPorts
      .filter((port) => workspaceResourceIds.has(port.resource.resourceId))
      .map((port) => (
        resourceRef(port.resource.resourceId)
      )))
    const materialBindingRefs = sortedUnique(snapshot.agentResources.materialBindings
      .filter((binding) => workspaceResourceIds.has(binding.resource.resourceId))
      .map((binding) => (
        resourceRef(binding.resource.resourceId)
      )))
    const materialRefs = sortedUnique(snapshot.agentResources.materialBindings
      .filter((binding) => workspaceResourceIds.has(binding.material.resource.resourceId))
      .map((binding) => (
        resourceRef(binding.material.resource.resourceId)
      )))
    const agentMaterialProjectionReceipt: WorkflowResourcePackagePublicationProofSet["agentMaterialProjectionReceipt"] = {
      ...receipt("resource-agent-material-projection", {
        agentRefs,
        promptRefs,
        toolRefs,
        materialPortRefs,
        materialBindingRefs,
        materialRefs,
      }),
      kind: "workflow.resourceAgentMaterialProjectionReceipt",
      agentRefs,
      promptRefs,
      toolRefs,
      materialPortRefs,
      materialBindingRefs,
      materialRefs,
      dependencyEdgeCount: snapshot.agentResources.dependencyEdges.filter((edge) => (
        workspaceResourceIds.has(edge.fromResourceId)
        || workspaceResourceIds.has(edge.declaredBy)
      )).length,
    }
    const workflowProfileReceipts: WorkflowResourcePackagePublicationProofSet["workflowProfileReceipts"] = []
    const workflowForms = new Map<string, AiWorkflowForm>()
    for (const app of workspaceApps) {
      for (const binding of app.workflowBindings) {
        const previous = workflowForms.get(binding.ref)
        if (previous && previous !== binding.kind) {
          throw new WorkflowResourcePackageValidationError(
            `Workflow resource package App bindings disagree on workflow kind for ${binding.ref}`,
          )
        }
        workflowForms.set(binding.ref, binding.kind)
      }
    }
    for (const binding of snapshot.agentResources.materialBindings) {
      if (!workspaceResourceIds.has(binding.resource.resourceId)) continue
      const previous = workflowForms.get(binding.task.workflowRef)
      if (previous && previous !== binding.task.workflowKind) {
        throw new WorkflowResourcePackageValidationError(
          `Workflow resource package bindings disagree on workflow kind for ${binding.task.workflowRef}`,
        )
      }
      workflowForms.set(binding.task.workflowRef, binding.task.workflowKind)
    }
    const canonicalTasks = new Map<string, AIWorkflowAgentTaskRef>()
    const canonicalTasksByNode = new Map<string, AIWorkflowAgentTaskRef>()
    for (const [workflowRef, workflowKind] of [...workflowForms].sort(([left], [right]) => compareCodeUnits(left, right))) {
      const resourceId = workflowRef.slice("resource://".length)
      const source = await authority.registry.readEffectiveSource(resourceId, snapshot)
      const loadedWorkflow = (await authority.registry.loadEffectiveProfile(
        source,
        ({ sources, stepSources }) => this.resources.load({
          form: workflowKind,
          sources,
          stepSources,
          baseUri: source.baseUri,
        }),
        snapshot,
      )).result
      if (
        !loadedWorkflow.binding
        || loadedWorkflow.diagnostics.length > 0
        || loadedWorkflow.binding.kind !== workflowKind
        || loadedWorkflow.binding.definition.fqn !== resourceId
      ) {
        throw new WorkflowResourcePackageValidationError(
          `Workflow resource package canonical workflow profile failed for ${workflowRef}`,
          loadedWorkflow.diagnostics.map((item) => ({
            code: item.code,
            location: item.source ?? workflowRef,
            message: item.message,
          })),
        )
      }
      for (const task of canonicalWorkflowAgentTasks(
        loadedWorkflow.binding,
        workflowRef as `resource://${string}`,
      )) {
        const nodeKey = agentTaskNodeKey(task)
        const previous = canonicalTasksByNode.get(nodeKey)
        if (previous && agentTaskKey(previous) !== agentTaskKey(task)) {
          throw new WorkflowResourcePackageValidationError(
            "Workflow resource package canonical Agent task is ambiguous",
            [{
              code: "WORKFLOW_CANONICAL_AGENT_TASK_AMBIGUOUS",
              location: `${task.workflowRef}#${task.nodeId}`,
              message: "One canonical workflow node cannot declare multiple Agent identities.",
            }],
          )
        }
        canonicalTasksByNode.set(nodeKey, task)
        canonicalTasks.set(agentTaskKey(task), task)
      }
      const profileDigest = digestJson({
        workflowRef,
        workflowKind,
        definitionFqn: loadedWorkflow.binding.definition.fqn,
        authorityDigest: source.authorityDigest,
        contentDigest: source.contentDigest,
      })
      workflowProfileReceipts.push({
        ...receipt("resource-workflow-profile", { workflowRef, workflowKind, profileDigest }),
        kind: "workflow.resourceWorkflowProfileReceipt",
        workflowRef,
        workflowKind,
        definitionFqn: loadedWorkflow.binding.definition.fqn,
        profileDigest,
      })
    }
    for (const binding of snapshot.agentResources.materialBindings) {
      const candidateBinding = workspaceResourceIds.has(binding.resource.resourceId)
      const provedWorkflow = workflowForms.has(binding.task.workflowRef)
      if (!candidateBinding && !provedWorkflow) continue
      const canonicalTask = canonicalTasksByNode.get(agentTaskNodeKey(binding.task))
      if (!canonicalTask || agentTaskKey(canonicalTask) !== agentTaskKey(binding.task)) {
        throw new WorkflowResourcePackageValidationError(
          "WORKFLOW_AGENT_TASK_BINDING_MISMATCH",
          [{
            code: "WORKFLOW_AGENT_TASK_BINDING_MISMATCH",
            location: resourceRef(binding.resource.resourceId),
            message: "MaterialBinding.task must match the exact canonical workflow kind, ref, node id and Agent definition.",
          }],
        )
      }
    }
    const runResourceReceipts: WorkflowResourcePackagePublicationProofSet["runResourceReceipts"] = []
    for (const task of [...canonicalTasks.values()].sort((left, right) => (
      compareCodeUnits(agentTaskKey(left), agentTaskKey(right))
    ))) {
      const frozen = freezeAIWorkflowRunResources({
        registry: snapshot.registry,
        projection: snapshot.agentResources,
        task,
        contentIdentities: snapshot.contentIdentities,
      })
      const closureResourceRefs = frozen.dependencySnapshot.closure.map((item) => resourceRef(item.resourceId))
      runResourceReceipts.push({
        ...receipt("resource-run-freeze", {
          task,
          snapshotRevision: frozen.dependencySnapshot.snapshotRevision,
          semanticFingerprint: frozen.semanticFingerprint,
        }),
        kind: "workflow.resourceRunFreezeReceipt",
        task,
        bindingResourceIds: [...frozen.bindingResourceIds],
        closureResourceRefs,
        dependencySnapshotRevision: frozen.dependencySnapshot.snapshotRevision,
        semanticFingerprint: frozen.semanticFingerprint,
      })
    }
    const proofReceiptIds = [
      packageLoadReceipt.receiptId,
      registryProjectionReceipt.receiptId,
      appProjectionReceipt.receiptId,
      agentMaterialProjectionReceipt.receiptId,
      ...workflowProfileReceipts.map((item) => item.receiptId),
      ...runResourceReceipts.map((item) => item.receiptId),
    ]
    const assemblyDigest = digestJson({
      artifactDigest,
      files: candidateFiles
        .map((file) => ({ path: file.path, digest: digestBytes(file.bytes) }))
        .sort((left, right) => compareCodeUnits(left.path, right.path)),
      proofReceiptIds,
    })
    const buildReceipt: WorkflowResourcePackagePublicationProofSet["buildReceipt"] = {
      ...receipt("resource-package-build", { assemblyDigest, proofReceiptIds }),
      kind: "workflow.resourcePackageBuildReceipt",
      fileCount: candidateFiles.length,
      assemblyDigest,
      proofReceiptIds,
      effectDispatched: false,
    }
    const proofSet: WorkflowResourcePackagePublicationProofSet = {
      kind: "workflow.resourcePackagePublicationProofSet",
      revision,
      baseArtifactRevision: target.baseArtifactRevision,
      baseRegistryRevision: target.baseRegistryRevision,
      artifactDigest,
      packageLoadReceipt,
      registryProjectionReceipt,
      appProjectionReceipt,
      agentMaterialProjectionReceipt,
      workflowProfileReceipts,
      runResourceReceipts,
      buildReceipt,
    }
    session = this.deriveSession({
      ...session,
      workingRevision: revision,
      currentRevision: revision,
      resourcePackageProofSet: proofSet,
      updatedAt: now,
    }, { base: session.baseRevision, working: revision })
    await this.writeMetadata(session)
    await this.appendAudit(input.sessionId, "prepare-resource-package-publication", {
      revision,
      baseArtifactRevision: proofSet.baseArtifactRevision,
      baseRegistryRevision: proofSet.baseRegistryRevision,
      proofReceiptIds: [...proofReceiptIds, buildReceipt.receiptId],
    })
    return { revision, proofSet }
  }

  async publish(input: { sessionId: string; confirmed: boolean; targetPath?: string }): Promise<Record<string, unknown>> {
    return this.store.withExclusiveLock(this.lockPath(input.sessionId), () => this.publishUnlocked(input))
  }

  private async publishUnlocked(input: { sessionId: string; confirmed: boolean; targetPath?: string }): Promise<Record<string, unknown>> {
    let session = await this.readMetadata(input.sessionId)
    if (session.artifactKind === "resource-package") {
      throw new Error("Workflow resource-package publication requires the workspace ResourcePackage publisher")
    }
    if (session.target.kind !== "legacy-vfs-workflow-bundle") {
      throw new Error("Workflow legacy publication requires a typed VFS target")
    }
    const legacyTarget = session.target
    if (!input.confirmed) {
      await this.appendAudit(input.sessionId, "publication-confirmation-required")
      return { status: "confirmation_required", sessionId: input.sessionId, effectDispatched: false }
    }
    const revision = await this.workRevision(input.sessionId)
    if (session.diffRevision !== revision || session.validationRevision !== revision || session.dryRunRevision !== revision) {
      const staleProofs = [
        session.diffRevision === revision ? null : "diff",
        session.validationRevision === revision ? null : "validation",
        session.dryRunRevision === revision ? null : "dry-run",
      ].filter(Boolean)
      throw new Error(`Workflow publication requires current diff, validation and dry-run revisions: ${JSON.stringify({
        currentRevision: revision,
        diffRevision: session.diffRevision ?? null,
        validationRevision: session.validationRevision ?? null,
        dryRunRevision: session.dryRunRevision ?? null,
        staleProofs,
        repairOrder: ["diff", "validate", "dry-run", "publish"],
      })}`)
    }
    const proofSet = session.proofSet
    const receipts = proofSet ? [
      proofSet.diffReceipt,
      proofSet.validationReceipt,
      proofSet.staticProjectionReceipt,
      proofSet.buildReceipt,
      proofSet.acceptanceDispositionReceipt,
      proofSet.candidateAcceptanceReceipt,
    ].filter(Boolean) as WorkflowProofReceiptBase[] : []
    const completeAndCurrent = proofSet?.revision === revision
      && proofSet.bundleDigest === revision
      && receipts.slice(0, 5).every((receipt) => receipt.revision === revision && receipt.bundleDigest === revision)
      && proofSet.staticProjectionReceipt.effectDispatched === false
      && proofSet.staticProjectionReceipt.acceptanceClaimed === false
      && (
        proofSet.acceptanceDispositionReceipt.disposition === "not_required"
          ? /^(?:canonical-profile|definition-policy):/.test(proofSet.acceptanceDispositionReceipt.policySource)
          : proofSet.candidateAcceptanceReceipt?.outcome === "passed"
            && proofSet.candidateAcceptanceReceipt.isolated === true
            && proofSet.candidateAcceptanceReceipt.realEffectDispatched === false
            && proofSet.candidateAcceptanceReceipt.runtime === "canonical-depa-flows"
            && proofSet.candidateAcceptanceReceipt.effectProvider === "isolated-fixture"
      )
    if (!completeAndCurrent) {
      throw new Error("Workflow publication requires a complete current proof receipt set")
    }
    const targetPath = safeRelative(
      input.targetPath?.trim()
        || legacyTarget.path
        || legacyTarget.id
        || "",
    )
    const pending = session.pendingPublication
    if (pending && (pending.revision !== revision || pending.targetPath !== targetPath)) {
      throw new Error(`Workflow publication has an unfinished attempt for another revision or target: ${pending.attemptId}`)
    }
    const attempt: WorkflowPendingPublication = pending ?? {
      attemptId: randomUUID(),
      revision,
      targetPath,
      startedAt: new Date().toISOString(),
    }
    if (!pending) {
      session = { ...session, pendingPublication: attempt, updatedAt: new Date().toISOString() }
      await this.writeMetadata(session)
    }
    const files = await this.mountFiles(input.sessionId, "work")
    await this.store.replaceTreeAtomic(targetPath, files)
    const publishedFiles = await Promise.all(files.map(async (file) => ({
      path: file.path,
      content: await this.store.read(`${targetPath}/${file.path}`),
    })))
    const publishedSources = Object.fromEntries(
      publishedFiles.filter((file) => file.path.endsWith(".xnl")).map((file) => [file.path, file.content]),
    )
    const artifactDigest = hashWorkflowSources(publishedFiles)
    if (artifactDigest !== revision) {
      throw new Error(`Published workflow readback digest mismatch: expected ${revision}, received ${artifactDigest}`)
    }
    const readback = this.resources.load({ form: session.form, sources: publishedSources })
    if (!readback.binding || readback.diagnostics.length > 0) {
      const details = readback.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ")
      throw new Error(`Published workflow failed canonical readback${details ? `: ${details}` : ""}`)
    }
    if (readback.binding.definition.fqn !== session.validationResult?.binding?.definition.fqn) {
      throw new Error("Published workflow canonical readback changed definition identity")
    }
    await this.store.replaceTreeAtomic(`${this.root(input.sessionId)}/base`, publishedFiles)
    const existingReceipts = await this.listPublicationReceipts(input.sessionId)
    const recoveredReceipt = existingReceipts.find((item) => item.receiptId === attempt.attemptId)
    if (recoveredReceipt && (
      recoveredReceipt.revision !== revision
      || recoveredReceipt.targetPath !== targetPath
      || recoveredReceipt.artifactDigest !== artifactDigest
    )) {
      throw new Error(`Workflow publication recovery receipt does not match pending attempt: ${attempt.attemptId}`)
    }
    const receipt: WorkflowPublicationReceipt = recoveredReceipt ?? {
      kind: "workflow.publicationReceipt",
      receiptId: attempt.attemptId,
      sequence: existingReceipts.length + 1,
      sessionId: input.sessionId,
      revision,
      targetPath,
      definitionFqn: readback.binding.definition.fqn,
      workflowRef: `vfs://./${targetPath}/manifest.xnl`,
      contract: {
        inputPorts: [...((readback.binding.definition as any).contract?.inputPorts ?? [])],
        outputPorts: [...((readback.binding.definition as any).contract?.outputPorts ?? [])],
      },
      artifactDigest,
      proofReceiptIds: proofReceiptIds(proofSet),
      createdAt: new Date().toISOString(),
    }
    if (!recoveredReceipt) {
      await this.store.writeAtomic(
        this.publicationPath(input.sessionId, receipt.receiptId),
        `${JSON.stringify(receipt, null, 2)}\n`,
      )
    }
    const updated: WorkflowAuthoringSession = this.deriveSession({
      ...session,
      status: "published",
      baseRevision: revision,
      workingRevision: revision,
      publishedRevision: revision,
      latestPublicationReceiptId: receipt.receiptId,
      pendingPublication: undefined,
      currentRevision: revision,
      updatedAt: new Date().toISOString(),
    }, { base: revision, working: revision })
    await this.writeMetadata(updated)
    await this.appendAudit(input.sessionId, "publish", {
      revision,
      targetPath,
      readbackFqn: readback.binding.definition.fqn,
      receiptId: receipt.receiptId,
      artifactDigest,
    })
    return {
      status: "published",
      sessionId: input.sessionId,
      revision,
      receipt,
      targetPath,
      canonicalReadback: {
        form: session.form,
        definitionFqn: readback.binding.definition.fqn,
        diagnostics: readback.diagnostics,
      },
      effectDispatched: false,
    }
  }
}

type PatchCommand = { kind: "add" | "delete" | "update"; path: string; body: string[] }

function parsePatch(source: string): PatchCommand[] {
  const lines = source.split(/\r?\n/)
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    throw new Error("Workflow authoring patch requires Begin Patch and End Patch markers")
  }
  const commands: PatchCommand[] = []
  let current: PatchCommand | undefined
  for (const line of lines.slice(1, -1)) {
    const match = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(line)
    if (match) {
      if (current) commands.push(current)
      current = {
        kind: match[1]!.toLowerCase() as PatchCommand["kind"],
        path: match[2]!.trim(),
        body: [],
      }
    } else if (current) {
      current.body.push(line)
    } else {
      throw new Error("Workflow authoring patch must declare a file operation")
    }
  }
  if (current) commands.push(current)
  if (commands.length === 0) throw new Error("Workflow authoring patch is empty")
  return commands
}

function patchAddedText(body: readonly string[]): string {
  if (body.some((line) => !line.startsWith("+"))) {
    throw new Error("Workflow authoring add patch content must use + lines")
  }
  return `${body.map((line) => line.slice(1)).join("\n")}${body.length ? "\n" : ""}`
}

function applyUpdateHunks(source: string, body: readonly string[]): string {
  const hunks: string[][] = []
  let current: string[] = []
  for (const line of body) {
    if (line.startsWith("@@")) {
      if (current.length) hunks.push(current)
      current = []
    } else {
      if (line !== "" && ![" ", "+", "-"].includes(line[0]!)) {
        throw new Error("Workflow authoring update patch has an invalid hunk line")
      }
      current.push(line)
    }
  }
  if (current.length) hunks.push(current)
  if (hunks.length === 0) throw new Error("Workflow authoring update patch requires a hunk")
  let result = source
  for (const hunk of hunks) {
    const oldLines = hunk.filter((line) => line.startsWith(" ") || line.startsWith("-")).map((line) => line.slice(1))
    const newLines = hunk.filter((line) => line.startsWith(" ") || line.startsWith("+")).map((line) => line.slice(1))
    let oldText = oldLines.join("\n")
    let newText = newLines.join("\n")
    if (source.endsWith("\n")) {
      oldText += "\n"
      newText += "\n"
    }
    if (!result.includes(oldText)) throw new Error("Workflow authoring update patch context was not found")
    result = result.replace(oldText, newText)
  }
  return result
}
