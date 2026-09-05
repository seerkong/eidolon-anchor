import {
  HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_FQN,
  HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SPEC_VERSION,
  HOLON_TASK_RUNTIME_DEFINITION_KIND_SPEC_REVISION_V1,
  HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION,
  HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
  HOLON_TASK_SNAPSHOT_RECEIPT_SCHEMA_VERSION,
  type FrozenHolonTaskRuntimeAdmission,
  type HolonTaskDigest,
  type HolonTaskExecutionTarget,
  type HolonTaskResourceRef,
  type HolonTaskRuntimeDefinition,
  type HolonTaskRuntimeInvocation,
  type HolonTaskRuntimeOrigin,
  type HolonTaskRequest,
  type HolonTaskRuntimeSnapshotAuthority,
  type HolonTaskSelector,
  type HolonTaskSnapshotReceipt,
} from "@cell/ai-organ-contract"
import type { ClosedValue } from "holarchy-eidolon-adapter"
import {
  digestCanonical,
  type KindReaderRegistration,
  type PortableSpec,
} from "halfcode-compiler.xnl/resource-core"

export class HolonTaskRuntimeContractError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = "HolonTaskRuntimeContractError"
  }
}

const invalid = (path: string, message: string): never => {
  throw new HolonTaskRuntimeContractError(path, message)
}

const compareUtf16 = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

function closedObject(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(path, "Expected a plain object")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(path, "Expected a plain object")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some((key) => typeof key !== "string")) {
    return invalid(path, "Symbol properties are not allowed")
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const key of (keys as string[]).sort(compareUtf16)) {
    const descriptor = descriptors[key]
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      return invalid(`${path}.${key}`, "Expected one enumerable own-data property")
    }
    result[key] = descriptor.value
  }
  return result
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  path: string,
): void {
  const allowed = new Set(expected)
  const extra = Object.keys(value).find((key) => !allowed.has(key))
  if (extra !== undefined) invalid(`${path}.${extra}`, "Unsupported field")
  const missing = expected.find((key) => !Object.prototype.hasOwnProperty.call(value, key))
  if (missing !== undefined) invalid(`${path}.${missing}`, "Required field is missing")
}

function exactString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/.test(value)) {
    return invalid(path, "Expected one canonical non-empty string")
  }
  return value
}

function exactBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path, "Expected one boolean")
  return value as boolean
}

function literal<const Value extends string>(value: unknown, expected: Value, path: string): Value {
  if (value !== expected) invalid(path, `Expected '${expected}'`)
  return expected
}

function union<const Values extends readonly string[]>(
  value: unknown,
  expected: Values,
  path: string,
): Values[number] {
  const exact = exactString(value, path)
  if (!(expected as readonly string[]).includes(exact)) {
    invalid(path, `Expected ${expected.join(" | ")}`)
  }
  return exact as Values[number]
}

function resourceRef(value: unknown, path: string): HolonTaskResourceRef {
  const exact = exactString(value, path)
  if (!/^resource:\/\/[^/\s][^\s]*$/.test(exact) || exact.includes("://", "resource://".length)) {
    return invalid(path, "Expected one canonical resource:// identity")
  }
  return exact as HolonTaskResourceRef
}

function digest(value: unknown, path: string): HolonTaskDigest {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    return invalid(path, "Expected one canonical sha256 digest")
  }
  return value as HolonTaskDigest
}

function utcInstant(value: unknown, path: string): string {
  const exact = exactString(value, path)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(exact)
    || Number.isNaN(Date.parse(exact)) || new Date(Date.parse(exact)).toISOString() !== exact) {
    return invalid(path, "Expected one canonical UTC instant")
  }
  return exact
}

function denseArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return invalid(path, "Expected a plain dense array")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      return invalid(`${path}[${index}]`, "Expected one dense enumerable own-data entry")
    }
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      return invalid(path, "Symbol and extra array properties are not allowed")
    }
  }
  return value
}

function uniqueStrings(value: unknown, path: string): readonly string[] {
  const values = denseArray(value, path).map((entry, index) => exactString(entry, `${path}[${index}]`))
  if (new Set(values).size !== values.length) invalid(path, "Duplicate values are not allowed")
  return Object.freeze(values)
}

function uniqueResourceRefs(value: unknown, path: string): readonly HolonTaskResourceRef[] {
  const values = denseArray(value, path).map((entry, index) => resourceRef(entry, `${path}[${index}]`))
  if (new Set(values).size !== values.length) invalid(path, "Duplicate values are not allowed")
  return Object.freeze(values)
}

function normalizeClosedValue(value: unknown, path: string): ClosedValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(path, "Expected one finite number")
    return value
  }
  if (Array.isArray(value)) {
    return Object.freeze(denseArray(value, path).map((entry, index) => (
      normalizeClosedValue(entry, `${path}[${index}]`)
    )))
  }
  const record = closedObject(value, path)
  const result: Record<string, ClosedValue> = Object.create(null)
  for (const key of Object.keys(record).sort(compareUtf16)) {
    result[key] = normalizeClosedValue(record[key], `${path}.${key}`)
  }
  return Object.freeze(result)
}

function normalizeExecutionTarget(value: unknown): HolonTaskExecutionTarget {
  const root = closedObject(value, "$admission.executionTarget")
  const kind = exactString(root.kind, "$admission.executionTarget.kind")
  if (kind === "member") {
    exactKeys(root, ["kind", "memberRef"], "$admission.executionTarget")
    return Object.freeze({
      kind,
      memberRef: exactString(root.memberRef, "$admission.executionTarget.memberRef"),
    })
  }
  if (kind === "role") {
    exactKeys(root, ["kind", "roleRef"], "$admission.executionTarget")
    return Object.freeze({
      kind,
      roleRef: exactString(root.roleRef, "$admission.executionTarget.roleRef"),
    })
  }
  return invalid("$admission.executionTarget.kind", "Expected member | role")
}

export function normalizeHolonTaskRuntimeDefinition(value: unknown): HolonTaskRuntimeDefinition {
  const root = closedObject(value, "$definition")
  exactKeys(root, [
    "kind", "schemaVersion", "definitionRef", "version", "rootHolonRef",
    "executionBinding", "taskSpace", "input", "output", "defaultForHolon",
  ], "$definition")
  const binding = closedObject(root.executionBinding, "$definition.executionBinding")
  exactKeys(binding, ["ref", "digest"], "$definition.executionBinding")
  const taskSpace = closedObject(root.taskSpace, "$definition.taskSpace")
  exactKeys(taskSpace, [
    "profileRef", "policyRef", "requiredRoleRefs", "requiredCapabilityRefs",
  ], "$definition.taskSpace")
  const input = closedObject(root.input, "$definition.input")
  exactKeys(input, ["schemaRef"], "$definition.input")
  const output = closedObject(root.output, "$definition.output")
  exactKeys(output, ["schemaRef", "materialPortRefs"], "$definition.output")
  const defaultForHolon = exactBoolean(root.defaultForHolon, "$definition.defaultForHolon")
  return Object.freeze({
    kind: literal(root.kind, "holon-task-runtime-definition", "$definition.kind"),
    schemaVersion: literal(
      root.schemaVersion,
      HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,
      "$definition.schemaVersion",
    ),
    definitionRef: resourceRef(root.definitionRef, "$definition.definitionRef"),
    version: exactString(root.version, "$definition.version"),
    rootHolonRef: exactString(root.rootHolonRef, "$definition.rootHolonRef"),
    executionBinding: Object.freeze({
      ref: resourceRef(binding.ref, "$definition.executionBinding.ref"),
      digest: digest(binding.digest, "$definition.executionBinding.digest"),
    }),
    taskSpace: Object.freeze({
      profileRef: resourceRef(taskSpace.profileRef, "$definition.taskSpace.profileRef"),
      policyRef: resourceRef(taskSpace.policyRef, "$definition.taskSpace.policyRef"),
      requiredRoleRefs: uniqueStrings(taskSpace.requiredRoleRefs, "$definition.taskSpace.requiredRoleRefs"),
      requiredCapabilityRefs: uniqueResourceRefs(
        taskSpace.requiredCapabilityRefs,
        "$definition.taskSpace.requiredCapabilityRefs",
      ),
    }),
    input: Object.freeze({ schemaRef: resourceRef(input.schemaRef, "$definition.input.schemaRef") }),
    output: Object.freeze({
      schemaRef: resourceRef(output.schemaRef, "$definition.output.schemaRef"),
      materialPortRefs: uniqueResourceRefs(output.materialPortRefs, "$definition.output.materialPortRefs"),
    }),
    defaultForHolon,
  })
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength
    && left.every((value, index) => value === right[index])
}

export function canonicalHolonTaskRuntimeDefinitionBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(normalizeHolonTaskRuntimeDefinition(value)))
}

export function parseHolonTaskRuntimeDefinitionBytes(bytes: Uint8Array): HolonTaskRuntimeDefinition {
  let decoded: string
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return invalid("$definitionBytes", "Expected canonical UTF-8 definition bytes")
  }
  let value: unknown
  try {
    value = JSON.parse(decoded)
  } catch {
    return invalid("$definitionBytes", "Expected canonical JSON definition bytes")
  }
  const definition = normalizeHolonTaskRuntimeDefinition(value)
  if (!sameBytes(bytes, canonicalHolonTaskRuntimeDefinitionBytes(definition))) {
    return invalid("$definitionBytes", "Definition bytes are not canonical")
  }
  return definition
}

function canonicalBase64DefinitionSpecBytes(spec: PortableSpec): Uint8Array {
  const properties = closedObject(spec.properties, "$.properties")
  exactKeys(properties, ["definitionBytesBase64"], "$.properties")
  const value = exactString(
    properties.definitionBytesBase64,
    "$.properties.definitionBytesBase64",
  )
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(Buffer.from(value, "base64"))
  } catch {
    return invalid("$.properties.definitionBytesBase64", "Expected canonical base64")
  }
  if (bytes.byteLength === 0 || Buffer.from(bytes).toString("base64") !== value) {
    return invalid(
      "$.properties.definitionBytesBase64",
      "Expected canonical non-empty base64",
    )
  }
  return bytes
}

export const HOLON_TASK_RUNTIME_DEFINITION_KIND_READER_REGISTRATION_V1:
KindReaderRegistration<HolonTaskRuntimeDefinition> = Object.freeze({
  readerId: "eidolon.ai-organ-logic.holon-task-runtime-definition.v1",
  subjectFqn: HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_FQN,
  readerSpecVersion: HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SPEC_VERSION,
  contractFingerprint: HOLON_TASK_RUNTIME_DEFINITION_KIND_SPEC_REVISION_V1.contractFingerprint,
  readerImplementationFingerprint: digestCanonical(Object.freeze({
    authority: "eidolon.ai-organ-logic/holon-task-runtime-definition-reader/v1",
    implementation: Object.freeze([
      "canonicalBase64DefinitionSpecBytes",
      "parseHolonTaskRuntimeDefinitionBytes",
    ]),
  })),
  compatibilityPolicy: "exact",
  read: (spec: PortableSpec) => parseHolonTaskRuntimeDefinitionBytes(
    canonicalBase64DefinitionSpecBytes(spec),
  ),
})

export function normalizeHolonTaskSnapshotReceipt(value: unknown): HolonTaskSnapshotReceipt {
  const root = closedObject(value, "$snapshotReceipt")
  exactKeys(root, [
    "kind", "schemaVersion", "taskSpaceId", "holonRef", "effectiveAt", "holonSnapshotRef",
    "holonSnapshotDigest", "snapshotArtifactDigest", "issuerReceiptId",
    "issuerReceiptArtifactDigest", "executionBindingRef", "executionBindingDigest",
    "eligibleMemberRefs", "eligibleRoleRefs",
  ], "$snapshotReceipt")
  return Object.freeze({
    kind: literal(root.kind, "holon-task-snapshot-receipt", "$snapshotReceipt.kind"),
    schemaVersion: literal(
      root.schemaVersion,
      HOLON_TASK_SNAPSHOT_RECEIPT_SCHEMA_VERSION,
      "$snapshotReceipt.schemaVersion",
    ),
    taskSpaceId: exactString(root.taskSpaceId, "$snapshotReceipt.taskSpaceId"),
    holonRef: exactString(root.holonRef, "$snapshotReceipt.holonRef"),
    effectiveAt: utcInstant(root.effectiveAt, "$snapshotReceipt.effectiveAt"),
    holonSnapshotRef: exactString(root.holonSnapshotRef, "$snapshotReceipt.holonSnapshotRef"),
    holonSnapshotDigest: digest(root.holonSnapshotDigest, "$snapshotReceipt.holonSnapshotDigest"),
    snapshotArtifactDigest: digest(root.snapshotArtifactDigest, "$snapshotReceipt.snapshotArtifactDigest"),
    issuerReceiptId: digest(root.issuerReceiptId, "$snapshotReceipt.issuerReceiptId"),
    issuerReceiptArtifactDigest: digest(
      root.issuerReceiptArtifactDigest,
      "$snapshotReceipt.issuerReceiptArtifactDigest",
    ),
    executionBindingRef: resourceRef(root.executionBindingRef, "$snapshotReceipt.executionBindingRef"),
    executionBindingDigest: digest(root.executionBindingDigest, "$snapshotReceipt.executionBindingDigest"),
    eligibleMemberRefs: uniqueStrings(root.eligibleMemberRefs, "$snapshotReceipt.eligibleMemberRefs"),
    eligibleRoleRefs: uniqueStrings(root.eligibleRoleRefs, "$snapshotReceipt.eligibleRoleRefs"),
  })
}

export function normalizeHolonTaskRuntimeSnapshotAuthority(
  value: unknown,
): HolonTaskRuntimeSnapshotAuthority {
  const root = closedObject(value, "$snapshotAuthority")
  exactKeys(root, [
    "kind", "schemaVersion", "holonRef", "effectiveAt", "holonSnapshotRef",
    "holonSnapshotDigest", "snapshotArtifactDigest", "executionBindingRef",
    "executionBindingDigest", "eligibleMemberRefs", "eligibleRoleRefs",
  ], "$snapshotAuthority")
  return Object.freeze({
    kind: literal(
      root.kind,
      "holon-task-runtime-snapshot-authority",
      "$snapshotAuthority.kind",
    ),
    schemaVersion: literal(
      root.schemaVersion,
      HOLON_TASK_RUNTIME_SNAPSHOT_AUTHORITY_SCHEMA_VERSION,
      "$snapshotAuthority.schemaVersion",
    ),
    holonRef: exactString(root.holonRef, "$snapshotAuthority.holonRef"),
    effectiveAt: utcInstant(root.effectiveAt, "$snapshotAuthority.effectiveAt"),
    holonSnapshotRef: exactString(root.holonSnapshotRef, "$snapshotAuthority.holonSnapshotRef"),
    holonSnapshotDigest: digest(root.holonSnapshotDigest, "$snapshotAuthority.holonSnapshotDigest"),
    snapshotArtifactDigest: digest(root.snapshotArtifactDigest, "$snapshotAuthority.snapshotArtifactDigest"),
    executionBindingRef: resourceRef(root.executionBindingRef, "$snapshotAuthority.executionBindingRef"),
    executionBindingDigest: digest(root.executionBindingDigest, "$snapshotAuthority.executionBindingDigest"),
    eligibleMemberRefs: uniqueStrings(root.eligibleMemberRefs, "$snapshotAuthority.eligibleMemberRefs"),
    eligibleRoleRefs: uniqueStrings(root.eligibleRoleRefs, "$snapshotAuthority.eligibleRoleRefs"),
  })
}

export function normalizeFrozenHolonTaskRuntimeAdmission(
  value: unknown,
): FrozenHolonTaskRuntimeAdmission {
  const root = closedObject(value, "$admission")
  exactKeys(root, [
    "kind", "schemaVersion", "admissionId", "registryRevision", "definitionDigest",
    "definition", "executionTarget", "snapshotAuthority",
  ], "$admission")
  const definition = normalizeHolonTaskRuntimeDefinition(root.definition)
  const target = normalizeExecutionTarget(root.executionTarget)
  const snapshotAuthority = normalizeHolonTaskRuntimeSnapshotAuthority(root.snapshotAuthority)
  if (snapshotAuthority.holonRef !== definition.rootHolonRef
    || snapshotAuthority.executionBindingRef !== definition.executionBinding.ref
    || snapshotAuthority.executionBindingDigest !== definition.executionBinding.digest) {
    invalid("$admission.snapshotAuthority", "Snapshot authority must bind the exact definition facts")
  }
  if (target.kind === "member" && !snapshotAuthority.eligibleMemberRefs.includes(target.memberRef)) {
    invalid("$admission.executionTarget.memberRef", "Target must be one eligible member")
  }
  if (target.kind === "role" && !snapshotAuthority.eligibleRoleRefs.includes(target.roleRef)) {
    invalid("$admission.executionTarget.roleRef", "Target must be one eligible role")
  }
  return Object.freeze({
    kind: literal(root.kind, "frozen-holon-task-runtime-admission", "$admission.kind"),
    schemaVersion: literal(
      root.schemaVersion,
      HOLON_TASK_RUNTIME_ADMISSION_SCHEMA_VERSION,
      "$admission.schemaVersion",
    ),
    admissionId: exactString(root.admissionId, "$admission.admissionId"),
    registryRevision: exactString(root.registryRevision, "$admission.registryRevision"),
    definitionDigest: digest(root.definitionDigest, "$admission.definitionDigest"),
    definition,
    executionTarget: target,
    snapshotAuthority,
  })
}

export function normalizeHolonTaskSnapshotReceiptForAdmission(
  admissionValue: unknown,
  receiptValue: unknown,
  expectedTaskSpaceId?: string,
): HolonTaskSnapshotReceipt {
  const admission = normalizeFrozenHolonTaskRuntimeAdmission(admissionValue)
  const receipt = normalizeHolonTaskSnapshotReceipt(receiptValue)
  const authority = admission.snapshotAuthority
  if (expectedTaskSpaceId !== undefined
    && receipt.taskSpaceId !== exactString(expectedTaskSpaceId, "$expectedTaskSpaceId")) {
    invalid("$snapshotReceipt.taskSpaceId", "Snapshot receipt must bind the submitted TaskSpace")
  }
  if (receipt.holonRef !== authority.holonRef
    || receipt.effectiveAt !== authority.effectiveAt
    || receipt.holonSnapshotRef !== authority.holonSnapshotRef
    || receipt.holonSnapshotDigest !== authority.holonSnapshotDigest
    || receipt.snapshotArtifactDigest !== authority.snapshotArtifactDigest
    || receipt.executionBindingRef !== authority.executionBindingRef
    || receipt.executionBindingDigest !== authority.executionBindingDigest
    || JSON.stringify(receipt.eligibleMemberRefs) !== JSON.stringify(authority.eligibleMemberRefs)
    || JSON.stringify(receipt.eligibleRoleRefs) !== JSON.stringify(authority.eligibleRoleRefs)) {
    invalid("$snapshotReceipt", "Snapshot receipt must derive from the exact admission authority")
  }
  return receipt
}

export function normalizeHolonTaskSelector(value: unknown): HolonTaskSelector {
  const root = closedObject(value, "$selector")
  const kind = exactString(root.kind, "$selector.kind")
  if (kind === "holon") {
    exactKeys(root, ["kind", "holonRef"], "$selector")
    return Object.freeze({ kind, holonRef: exactString(root.holonRef, "$selector.holonRef") })
  }
  if (kind === "member") {
    exactKeys(root, ["kind", "holonRef", "memberRef"], "$selector")
    return Object.freeze({
      kind,
      holonRef: exactString(root.holonRef, "$selector.holonRef"),
      memberRef: exactString(root.memberRef, "$selector.memberRef"),
    })
  }
  if (kind === "admission") {
    exactKeys(root, ["kind", "admissionId"], "$selector")
    return Object.freeze({
      kind,
      admissionId: exactString(root.admissionId, "$selector.admissionId"),
    })
  }
  return invalid("$selector.kind", "Expected holon | member | admission")
}

export function normalizeHolonTaskRuntimeOrigin(value: unknown): HolonTaskRuntimeOrigin {
  const root = closedObject(value, "$invocation.origin")
  const kind = exactString(root.kind, "$invocation.origin.kind")
  if (kind === "product") {
    exactKeys(root, ["kind", "surface", "requestRef"], "$invocation.origin")
    return Object.freeze({
      kind,
      surface: exactString(root.surface, "$invocation.origin.surface"),
      requestRef: exactString(root.requestRef, "$invocation.origin.requestRef"),
    })
  }
  if (kind === "workflow") {
    exactKeys(root, [
      "kind", "workflowKind", "workflowRef", "runId", "nodeId", "invocationId",
    ], "$invocation.origin")
    return Object.freeze({
      kind,
      workflowKind: union(
        root.workflowKind,
        ["AICtrlWorkflow", "AIDataWorkflow"] as const,
        "$invocation.origin.workflowKind",
      ),
      workflowRef: resourceRef(root.workflowRef, "$invocation.origin.workflowRef"),
      runId: exactString(root.runId, "$invocation.origin.runId"),
      nodeId: exactString(root.nodeId, "$invocation.origin.nodeId"),
      invocationId: exactString(root.invocationId, "$invocation.origin.invocationId"),
    })
  }
  if (kind === "service") {
    exactKeys(root, ["kind", "serviceRef", "requestRef"], "$invocation.origin")
    return Object.freeze({
      kind,
      serviceRef: resourceRef(root.serviceRef, "$invocation.origin.serviceRef"),
      requestRef: exactString(root.requestRef, "$invocation.origin.requestRef"),
    })
  }
  return invalid("$invocation.origin.kind", "Expected product | workflow | service")
}

function normalizeTaskRequest(value: unknown): HolonTaskRequest {
  const root = closedObject(value, "$invocation.taskRequest")
  const kind = exactString(root.kind, "$invocation.taskRequest.kind")
  if (kind === "derive") {
    exactKeys(root, ["kind", "name"], "$invocation.taskRequest")
    return Object.freeze({
      kind,
      name: exactString(root.name, "$invocation.taskRequest.name"),
    })
  }
  if (kind === "exact") {
    exactKeys(root, ["kind", "identity", "name"], "$invocation.taskRequest")
    const identity = closedObject(root.identity, "$invocation.taskRequest.identity")
    exactKeys(identity, ["taskSpaceId", "taskId", "commandId"], "$invocation.taskRequest.identity")
    return Object.freeze({
      kind,
      identity: Object.freeze({
        taskSpaceId: exactString(identity.taskSpaceId, "$invocation.taskRequest.identity.taskSpaceId"),
        taskId: exactString(identity.taskId, "$invocation.taskRequest.identity.taskId"),
        commandId: exactString(identity.commandId, "$invocation.taskRequest.identity.commandId"),
      }),
      name: exactString(root.name, "$invocation.taskRequest.name"),
    })
  }
  return invalid("$invocation.taskRequest.kind", "Expected derive | exact")
}

export function normalizeHolonTaskRuntimeInvocation(value: unknown): HolonTaskRuntimeInvocation {
  const root = closedObject(value, "$invocation")
  exactKeys(root, [
    "kind", "schemaVersion", "requestId", "idempotencyKey", "replyMode",
    "occurredAt", "origin", "taskRequest", "input",
  ], "$invocation")
  const origin = normalizeHolonTaskRuntimeOrigin(root.origin)
  const taskRequest = normalizeTaskRequest(root.taskRequest)
  if (origin.kind === "product" && taskRequest.kind !== "derive") {
    invalid("$invocation.taskRequest.kind", "Product assignment must derive its TaskSpace identity")
  }
  if (origin.kind === "workflow" && taskRequest.kind !== "exact") {
    invalid("$invocation.taskRequest.kind", "Workflow assignment must preserve its exact TaskSpace identity")
  }
  return Object.freeze({
    kind: literal(root.kind, "holon-task-runtime-invocation", "$invocation.kind"),
    schemaVersion: literal(
      root.schemaVersion,
      HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION,
      "$invocation.schemaVersion",
    ),
    requestId: exactString(root.requestId, "$invocation.requestId"),
    idempotencyKey: exactString(root.idempotencyKey, "$invocation.idempotencyKey"),
    replyMode: union(root.replyMode, ["final", "none", "stream"] as const, "$invocation.replyMode"),
    occurredAt: utcInstant(root.occurredAt, "$invocation.occurredAt"),
    origin,
    taskRequest,
    input: normalizeClosedValue(root.input, "$invocation.input"),
  })
}
