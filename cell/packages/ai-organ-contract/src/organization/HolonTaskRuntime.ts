import type { ClosedValue, HolonExecutionInvocation } from "holarchy-eidolon-adapter"
import {
  digestCanonical,
  type JsonSchema,
  type KindSemanticContract,
} from "halfcode-compiler.xnl/resource-core"
import {
  createKindSpecRevision,
  createKindSubjectOwner,
} from "halfcode-compiler.xnl/kind-definition"

export const HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION =
  "eidolon.holon-task-runtime-definition/v1" as const
export const HOLON_TASK_RUNTIME_DEFINITION_KIND = "HolonTaskRuntimeDefinition" as const
export const HOLON_TASK_RUNTIME_DEFINITION_API_VERSION = "eidolon.ai/v1" as const
export const HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_FQN =
  "Eidolon.AI.KindDefinition.HolonTaskRuntimeDefinition" as const
export const HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SPEC_VERSION = 1 as const
export const HOLON_TASK_RUNTIME_DEFINITION_KIND_OWNER_PACKAGE_ID =
  "@cell/ai-organ-contract" as const
export const HOLON_TASK_RUNTIME_DEFINITION_KIND_OWNER_PACKAGE_FINGERPRINT = digestCanonical(Object.freeze({
  authority: "@cell/ai-organ-contract/holon-task-runtime-definition-kind/v1",
  ownerPackageId: HOLON_TASK_RUNTIME_DEFINITION_KIND_OWNER_PACKAGE_ID,
  subjects: Object.freeze([HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_FQN]),
  semanticContractVersion: HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
}))

export const HOLON_TASK_RUNTIME_DEFINITION_KIND_OWNER = createKindSubjectOwner({
  kind: HOLON_TASK_RUNTIME_DEFINITION_KIND,
  subjectFqn: HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_FQN,
  ownerPackageId: HOLON_TASK_RUNTIME_DEFINITION_KIND_OWNER_PACKAGE_ID,
  ownerPackageFingerprint: HOLON_TASK_RUNTIME_DEFINITION_KIND_OWNER_PACKAGE_FINGERPRINT,
  sourceShapes: Object.freeze(["single-file"]),
  documentCardinality: "one",
})

export const HOLON_TASK_RUNTIME_DEFINITION_SPEC_SCHEMA_V1: JsonSchema = Object.freeze({
  type: "object",
  required: Object.freeze(["properties", "body", "subdomains"]),
  properties: Object.freeze({
    properties: Object.freeze({
      type: "object",
      required: Object.freeze(["definitionBytesBase64"]),
      properties: Object.freeze({
        definitionBytesBase64: Object.freeze({ type: "string", minLength: 1 }),
      }),
      additionalProperties: false,
    }),
    body: Object.freeze({ type: "array", maxItems: 0 }),
    subdomains: Object.freeze({ type: "object", maxProperties: 0 }),
  }),
  additionalProperties: false,
})

export const HOLON_TASK_RUNTIME_DEFINITION_SEMANTIC_CONTRACT_V1: KindSemanticContract = Object.freeze({
  semanticValidatorFingerprint: digestCanonical(Object.freeze({
    authority: "@cell/ai-organ-contract/holon-task-runtime-definition-kind/v1",
    role: "canonical-runtime-definition-validation",
    schemaVersion: HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
    validator: "normalizeHolonTaskRuntimeDefinition",
  })),
  referenceProjectionFingerprint: digestCanonical(Object.freeze({
    authority: "@cell/ai-organ-contract/holon-task-runtime-definition-kind/v1",
    role: "closed-runtime-definition-reference-projection",
    fields: Object.freeze([
      "executionBinding.ref",
      "taskSpace.profileRef",
      "taskSpace.policyRef",
      "taskSpace.requiredCapabilityRefs",
      "input.schemaRef",
      "output.schemaRef",
      "output.materialPortRefs",
    ]),
  })),
  compilerInputFingerprint: digestCanonical(Object.freeze({
    authority: "@cell/ai-organ-contract/holon-task-runtime-definition-kind/v1",
    role: "authored-resource-to-canonical-definition-input",
    fields: Object.freeze(["properties.definitionBytesBase64"]),
    encoding: "canonical-base64",
  })),
})

export const HOLON_TASK_RUNTIME_DEFINITION_KIND_SPEC_REVISION_V1 = createKindSpecRevision({
  kind: HOLON_TASK_RUNTIME_DEFINITION_KIND_OWNER.kind,
  subjectFqn: HOLON_TASK_RUNTIME_DEFINITION_KIND_OWNER.subjectFqn,
  specVersion: HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SPEC_VERSION,
  specSchema: HOLON_TASK_RUNTIME_DEFINITION_SPEC_SCHEMA_V1,
  semanticContract: HOLON_TASK_RUNTIME_DEFINITION_SEMANTIC_CONTRACT_V1,
  sourceContractFingerprint: HOLON_TASK_RUNTIME_DEFINITION_KIND_OWNER.sourceContract.sourceContractFingerprint,
  stability: "stable",
})

function renderHolonTaskRuntimeDefinitionKindDefinition(): string {
  const owner = HOLON_TASK_RUNTIME_DEFINITION_KIND_OWNER
  const revision = HOLON_TASK_RUNTIME_DEFINITION_KIND_SPEC_REVISION_V1
  return [
    `<KindDefinition #${HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_FQN} envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {`,
    '  lifecycle = "Stable"',
    `  resourceKind = "${owner.kind}"`,
    `  subjectFqn = "${owner.subjectFqn}"`,
    '  sourceShapes = ["single-file"]',
    `  documentCardinality = "${owner.sourceContract.documentCardinality}"`,
    '  description = "Binds one reusable Holon task contract to an exact frozen execution binding."',
    '} (',
    '  <SpecRevisions [',
    `    <SpecRevision #v${revision.specVersion} {`,
    `      specVersion = ${revision.specVersion}`,
    '      schemaRef = "vfs://./spec-v1.schema.json"',
    `      schemaFingerprint = "${revision.schemaFingerprint}"`,
    `      contractFingerprint = "${revision.contractFingerprint}"`,
    `      semanticValidatorFingerprint = "${revision.semanticContract.semanticValidatorFingerprint}"`,
    `      referenceProjectionFingerprint = "${revision.semanticContract.referenceProjectionFingerprint}"`,
    `      compilerInputFingerprint = "${revision.semanticContract.compilerInputFingerprint}"`,
    `      stability = "${revision.stability}"`,
    '    }>',
    '  ]>',
    ')>',
    '',
  ].join("\n")
}

export const HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SOURCE =
  renderHolonTaskRuntimeDefinitionKindDefinition()
export const HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_BYTES: Readonly<Uint8Array> =
  new TextEncoder().encode(HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SOURCE)
export const HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION =
  "eidolon.frozen-holon-task-runtime-admission/v1" as const
export const HOLON_TASK_SNAPSHOT_RECEIPT_SCHEMA_VERSION =
  "eidolon.holon-task-snapshot-receipt/v1" as const
export const HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION =
  "eidolon.holon-task-runtime-snapshot-authority/v1" as const
export const HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION =
  "eidolon.holon-task-runtime-invocation/v1" as const
export const HOLON_TASK_RUNTIME_ASSIGNMENT_RECEIPT_SCHEMA_VERSION =
  "eidolon.holon-task-runtime-assignment-receipt/v1" as const
export const HOLON_TASK_COORDINATOR_WAKE_SCHEMA_VERSION =
  "eidolon.holon-task-coordinator-wake/v1" as const
export const EIDOLON_HOLON_TASK_PROFILE_KIND = "eidolon.ai.holon-task" as const

export type HolonTaskResourceRef = `resource://${string}`
export type HolonTaskDigest = `sha256:${string}`

export interface HolonTaskRuntimeDefinition {
  readonly kind: "holon-task-runtime-definition"
  readonly schemaVersion: typeof HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION
  readonly definitionRef: HolonTaskResourceRef
  readonly version: string
  readonly rootHolonRef: string
  readonly executionBinding: Readonly<{
    readonly ref: HolonTaskResourceRef
    readonly digest: HolonTaskDigest
  }>
  readonly taskSpace: Readonly<{
    readonly profileRef: HolonTaskResourceRef
    readonly policyRef: HolonTaskResourceRef
    readonly requiredRoleRefs: readonly string[]
    readonly requiredCapabilityRefs: readonly HolonTaskResourceRef[]
  }>
  readonly input: Readonly<{ readonly schemaRef: HolonTaskResourceRef }>
  readonly output: Readonly<{
    readonly schemaRef: HolonTaskResourceRef
    readonly materialPortRefs: readonly HolonTaskResourceRef[]
  }>
  readonly defaultForHolon: boolean
}

export type HolonTaskExecutionTarget =
  | Readonly<{ readonly kind: "member"; readonly memberRef: string }>
  | Readonly<{ readonly kind: "role"; readonly roleRef: string }>

export interface HolonTaskSnapshotReceipt {
  readonly kind: "holon-task-snapshot-receipt"
  readonly schemaVersion: typeof HOLON_TASK_SNAPSHOT_RECEIPT_SCHEMA_VERSION
  readonly taskSpaceId: string
  readonly holonRef: string
  readonly effectiveAt: string
  readonly holonSnapshotRef: string
  readonly holonSnapshotDigest: HolonTaskDigest
  readonly snapshotArtifactDigest: HolonTaskDigest
  readonly issuerReceiptId: HolonTaskDigest
  readonly issuerReceiptArtifactDigest: HolonTaskDigest
  readonly executionBindingRef: HolonTaskResourceRef
  readonly executionBindingDigest: HolonTaskDigest
  readonly eligibleMemberRefs: readonly string[]
  readonly eligibleRoleRefs: readonly string[]
}

/** Reusable frozen organization/binding authority; no per-TaskSpace facts live here. */
export interface HolonTaskRuntimeSnapshotAuthority {
  readonly kind: "holon-task-runtime-snapshot-authority"
  readonly schemaVersion: typeof HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION
  readonly holonRef: string
  readonly effectiveAt: string
  readonly holonSnapshotRef: string
  readonly holonSnapshotDigest: HolonTaskDigest
  readonly snapshotArtifactDigest: HolonTaskDigest
  readonly executionBindingRef: HolonTaskResourceRef
  readonly executionBindingDigest: HolonTaskDigest
  readonly eligibleMemberRefs: readonly string[]
  readonly eligibleRoleRefs: readonly string[]
}

export interface FrozenHolonTaskRuntimeAdmission {
  readonly kind: "frozen-holon-task-runtime-admission"
  readonly schemaVersion: typeof HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION
  readonly admissionId: string
  readonly registryRevision: string
  readonly definitionDigest: HolonTaskDigest
  readonly definition: HolonTaskRuntimeDefinition
  readonly executionTarget: HolonTaskExecutionTarget
  readonly snapshotAuthority: HolonTaskRuntimeSnapshotAuthority
}

export interface HolonTaskExecutionProfile {
  readonly kind: "task-profile"
  readonly profileKind: typeof EIDOLON_HOLON_TASK_PROFILE_KIND
  readonly schemaVersion: 1
  readonly facts: Readonly<{
    readonly admission: FrozenHolonTaskRuntimeAdmission
    readonly snapshotReceipt: HolonTaskSnapshotReceipt
    readonly assignmentReceipt: null
    readonly memberRuntimeRef: null
    readonly settlementReceipt: null
    readonly snapshotAdoptions: readonly []
  }>
}

export type HolonTaskSelector =
  | Readonly<{ readonly kind: "holon"; readonly holonRef: string }>
  | Readonly<{ readonly kind: "member"; readonly holonRef: string; readonly memberRef: string }>
  | Readonly<{ readonly kind: "admission"; readonly admissionId: string }>

export type HolonTaskRuntimeOrigin =
  | Readonly<{ readonly kind: "product"; readonly surface: string; readonly requestRef: string }>
  | Readonly<{
      readonly kind: "workflow"
      readonly workflowKind: "AICtrlWorkflow" | "AIDataWorkflow"
      readonly workflowRef: HolonTaskResourceRef
      readonly runId: string
      readonly nodeId: string
      readonly invocationId: string
    }>
  | Readonly<{
      readonly kind: "service"
      readonly serviceRef: HolonTaskResourceRef
      readonly requestRef: string
    }>

export type HolonTaskReplyMode = "final" | "none" | "stream"

export interface HolonTaskExactIdentity {
  readonly taskSpaceId: string
  readonly taskId: string
  readonly commandId: string
}

export type HolonTaskRequest =
  | Readonly<{
      readonly kind: "derive"
      readonly name: string
    }>
  | Readonly<{
      readonly kind: "exact"
      readonly identity: HolonTaskExactIdentity
      readonly name: string
    }>

export interface HolonTaskRuntimeInvocation {
  readonly kind: "holon-task-runtime-invocation"
  readonly schemaVersion: typeof HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION
  readonly requestId: string
  readonly idempotencyKey: string
  readonly replyMode: HolonTaskReplyMode
  readonly occurredAt: string
  readonly origin: HolonTaskRuntimeOrigin
  readonly taskRequest: HolonTaskRequest
  readonly input: ClosedValue
}

export interface HolonTaskRuntimeProcessorConfig {
  readonly leaseDurationMs: number
  readonly maxSteps: number
}

export interface HolonTaskRuntimeCatalogSnapshot {
  readonly revision: number
  readonly admissions: readonly FrozenHolonTaskRuntimeAdmission[]
}

export interface HolonTaskRuntimeTaskReceipt {
  readonly taskSpaceId: string
  readonly taskId: string
  readonly commandId: string
  readonly submissionFingerprint: HolonTaskDigest
  readonly replayed: boolean
  readonly snapshotReceipt: HolonTaskSnapshotReceipt
}

export interface HolonTaskRuntimeCoordinatorWakeReceipt {
  readonly coordinatorActorRef: string
  readonly messageId: string
  readonly replayed: boolean
}

export interface HolonTaskCoordinatorWakeMessage {
  readonly kind: "holon-task.coordinator-wake"
  readonly schemaVersion: typeof HOLON_TASK_COORDINATOR_WAKE_SCHEMA_VERSION
  readonly deploymentId: string
  readonly holonRef: string
  readonly taskSpaceId: string
  readonly taskId: string
  readonly messageId: string
}

export interface HolonTaskRuntimeSettlementObservation {
  readonly status: "succeeded" | "failed"
  readonly settlementCommandId: string
  readonly result: ClosedValue
  readonly outputArtifactRefs: readonly string[]
  readonly replayed: boolean
}

export interface HolonTaskRuntimeAssignmentReceipt {
  readonly kind: "holon-task-runtime-assignment-receipt"
  readonly schemaVersion: typeof HOLON_TASK_RUNTIME_ASSIGNMENT_RECEIPT_SCHEMA_VERSION
  readonly requestId: string
  readonly admissionId: string
  readonly definitionRef: HolonTaskResourceRef
  readonly replyMode: HolonTaskReplyMode
  readonly task: HolonTaskRuntimeTaskReceipt
  readonly coordinatorWake: HolonTaskRuntimeCoordinatorWakeReceipt
  readonly settlement: HolonTaskRuntimeSettlementObservation | null
}

/** Explicit effect boundary. Concrete file and actor implementations live outside ai-organ-logic. */
export interface HolonTaskRuntimeCatalogPort {
  read(): Promise<HolonTaskRuntimeCatalogSnapshot>
  compareAndSet(input: Readonly<{
    readonly expectedRevision: number
    readonly next: HolonTaskRuntimeCatalogSnapshot
  }>): Promise<HolonTaskRuntimeCatalogSnapshot>
}

export interface HolonTaskRuntimeTaskSpacePort {
  submit(input: Readonly<{
    readonly admission: FrozenHolonTaskRuntimeAdmission
    readonly invocation: HolonTaskRuntimeInvocation
    readonly commandId: string
    readonly taskId: string
    readonly submissionFingerprint: HolonTaskDigest
    readonly config: HolonTaskRuntimeProcessorConfig
  }>): Promise<HolonTaskRuntimeTaskReceipt>
}

export interface HolonTaskRuntimeCoordinatorMailboxPort {
  sendWake(message: HolonTaskCoordinatorWakeMessage): Promise<HolonTaskRuntimeCoordinatorWakeReceipt>
}

export interface HolonTaskRuntimeSettlementPort {
  observe(input: Readonly<{
    readonly taskSpaceId: string
    readonly taskId: string
    readonly requestId: string
  }>): Promise<HolonTaskRuntimeSettlementObservation>
}

export interface HolonTaskRuntimeDeploymentPort {
  ensure(input: Readonly<{
    readonly admission: FrozenHolonTaskRuntimeAdmission
  }>): Promise<Readonly<{ readonly deploymentId: string }>>
}

export interface HolonTaskRuntimeJournalPort {
  readAcceptedEffect(idempotencyKey: string): Promise<ClosedValue | undefined>
}

export interface HolonTaskRuntimeActorDispatchPort {
  dispatch(input: Readonly<{
    readonly memberRuntimeRef: string
    readonly invocation: HolonExecutionInvocation
    readonly idempotencyKey: string
  }>): Promise<Readonly<{ readonly output: ClosedValue; readonly replayed: boolean }>>
}

export interface HolonTaskRuntimeClockPort {
  nowEpochMs(): number
}

export interface HolonTaskRuntimeTimerPort {
  wait(delayMs: number, signal: AbortSignal): Promise<boolean>
}

export interface HolonTaskRuntimeSchedulerPort {
  schedule(input: Readonly<{
    readonly messageId: string
    readonly notBefore: string
    readonly payload: ClosedValue
  }>): Promise<Readonly<{ readonly scheduled: boolean; readonly replayed: boolean }>>
}

export interface HolonTaskRuntimeEffectPorts {
  readonly catalog: HolonTaskRuntimeCatalogPort
  readonly taskSpace: HolonTaskRuntimeTaskSpacePort
  readonly coordinatorMailbox: HolonTaskRuntimeCoordinatorMailboxPort
  readonly settlement: HolonTaskRuntimeSettlementPort
  readonly deployment: HolonTaskRuntimeDeploymentPort
  readonly journal: HolonTaskRuntimeJournalPort
  readonly actorDispatch: HolonTaskRuntimeActorDispatchPort
  readonly clock: HolonTaskRuntimeClockPort
  readonly timer: HolonTaskRuntimeTimerPort
  readonly scheduler: HolonTaskRuntimeSchedulerPort
}

export interface HolonTaskRuntimeService {
  assign(
    selector: HolonTaskSelector,
    invocation: HolonTaskRuntimeInvocation,
    config: HolonTaskRuntimeProcessorConfig,
  ): Promise<HolonTaskRuntimeAssignmentReceipt>
}
