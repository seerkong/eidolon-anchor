import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
export type WorkflowFulfillOuterRuntime = AiAgentOneActorRuntime

export type WorkflowAuthoringContinuation = {
  readonly kind: "authoring"
  readonly authoring_session_id: string
  readonly expected_revision: string
  readonly proof_receipt_ids: readonly string[]
}

export type WorkflowPublicationContinuation = {
  readonly kind: "publication"
  readonly authoring_session_id: string
  readonly publication_receipt_id: string
  readonly registry_revision: string
  readonly app_ref: `resource://${string}`
  readonly workflow_ref: `resource://${string}`
}

export type WorkflowExecutionContinuation = Omit<WorkflowPublicationContinuation, "kind"> & {
  readonly kind: "execution"
  readonly instance_id?: string
  readonly run_id?: string
}

export type WorkflowFulfillmentContinuation =
  | WorkflowAuthoringContinuation
  | WorkflowPublicationContinuation
  | WorkflowExecutionContinuation

export type WorkflowFulfillOuterInput = {
  request: string
  operation?: "auto" | "create" | "edit" | "run" | "continue"
  workflow_ref?: string
  publish?: boolean
  execute?: boolean
  continuation?: WorkflowFulfillmentContinuation
}
export type WorkflowFulfillOuterConfig = Record<string, never>
export type WorkflowFulfillOuterDerived = null
export type WorkflowFulfillOuterOutput = string

const CONTINUATION_FIELDS = Object.freeze({
  authoring: Object.freeze(["kind", "authoring_session_id", "expected_revision", "proof_receipt_ids"]),
  publication: Object.freeze([
    "kind",
    "authoring_session_id",
    "publication_receipt_id",
    "registry_revision",
    "app_ref",
    "workflow_ref",
  ]),
  execution: Object.freeze([
    "kind",
    "authoring_session_id",
    "publication_receipt_id",
    "registry_revision",
    "app_ref",
    "workflow_ref",
    "instance_id",
    "run_id",
  ]),
} as const)

function continuationError(code: string, message: string): Error {
  return new Error(`${code}: ${message}`)
}

function dataRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw continuationError("WORKFLOW_FULFILL_CONTINUATION_INVALID", "continuation must be an object")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw continuationError(
      "WORKFLOW_FULFILL_CONTINUATION_INVALID",
      "continuation must be one ordinary or null-prototype plain data object",
    )
  }
  const result = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw continuationError("WORKFLOW_FULFILL_CONTINUATION_FIELD_UNSUPPORTED", "symbol fields are not supported")
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw continuationError(
        "WORKFLOW_FULFILL_CONTINUATION_FIELD_INVALID",
        `continuation field '${key}' must be an own enumerable data property`,
      )
    }
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      value: descriptor.value,
      writable: false,
    })
  }
  return result
}

function exactText(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw continuationError(
      "WORKFLOW_FULFILL_CONTINUATION_FIELD_INVALID",
      `continuation field '${field}' must be an exact non-empty string`,
    )
  }
  return value
}

function exactResourceRef(record: Record<string, unknown>, field: string): `resource://${string}` {
  const value = exactText(record, field)
  if (!value.startsWith("resource://") || value.length === "resource://".length) {
    throw continuationError(
      "WORKFLOW_FULFILL_CONTINUATION_FIELD_INVALID",
      `continuation field '${field}' must be an exact resource ref`,
    )
  }
  return value as `resource://${string}`
}

function assertFields(record: Record<string, unknown>, kind: keyof typeof CONTINUATION_FIELDS): void {
  const allowed = new Set<string>(CONTINUATION_FIELDS[kind])
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) {
      throw continuationError(
        "WORKFLOW_FULFILL_CONTINUATION_FIELD_UNSUPPORTED",
        `continuation kind '${kind}' does not support field '${field}'`,
      )
    }
  }
}

function exactDataArray(record: Record<string, unknown>, field: string): readonly unknown[] {
  const value = record[field]
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw continuationError(
      "WORKFLOW_FULFILL_CONTINUATION_FIELD_INVALID",
      `continuation field '${field}' must be one plain dense array`,
    )
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw continuationError(
      "WORKFLOW_FULFILL_CONTINUATION_FIELD_INVALID",
      `continuation field '${field}' must not contain symbol fields`,
    )
  }
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== value.length + 1 || names[value.length] !== "length") {
    throw continuationError(
      "WORKFLOW_FULFILL_CONTINUATION_FIELD_INVALID",
      `continuation field '${field}' must be dense without extra fields`,
    )
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw continuationError(
        "WORKFLOW_FULFILL_CONTINUATION_FIELD_INVALID",
        `continuation field '${field}[${index}]' must be an own enumerable data property`,
      )
    }
  }
  return value
}

function proofIds(record: Record<string, unknown>): readonly string[] {
  const value = exactDataArray(record, "proof_receipt_ids")
  if (value.length === 0) {
    throw continuationError(
      "WORKFLOW_FULFILL_CONTINUATION_FIELD_INVALID",
      "authoring continuation requires proof_receipt_ids",
    )
  }
  const ids: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index))!.value
    if (typeof item !== "string" || !item || item !== item.trim()) {
      throw continuationError(
        "WORKFLOW_FULFILL_CONTINUATION_FIELD_INVALID",
        `proof_receipt_ids[${index}] must be an exact non-empty string`,
      )
    }
    ids.push(item)
  }
  if (new Set(ids).size !== ids.length) {
    throw continuationError(
      "WORKFLOW_FULFILL_CONTINUATION_FIELD_INVALID",
      "proof_receipt_ids must not contain duplicates",
    )
  }
  return Object.freeze(ids)
}

export function normalizeWorkflowFulfillmentContinuation(
  value: unknown,
): WorkflowFulfillmentContinuation | undefined {
  if (value === undefined) return undefined
  const record = dataRecord(value)
  const kind = exactText(record, "kind")
  if (kind !== "authoring" && kind !== "publication" && kind !== "execution") {
    throw continuationError(
      "WORKFLOW_FULFILL_CONTINUATION_KIND_INVALID",
      "continuation kind must be authoring, publication or execution",
    )
  }
  assertFields(record, kind)
  if (kind === "authoring") {
    return Object.freeze({
      kind,
      authoring_session_id: exactText(record, "authoring_session_id"),
      expected_revision: exactText(record, "expected_revision"),
      proof_receipt_ids: proofIds(record),
    })
  }
  const publication = {
    authoring_session_id: exactText(record, "authoring_session_id"),
    publication_receipt_id: exactText(record, "publication_receipt_id"),
    registry_revision: exactText(record, "registry_revision"),
    app_ref: exactResourceRef(record, "app_ref"),
    workflow_ref: exactResourceRef(record, "workflow_ref"),
  }
  if (kind === "publication") return Object.freeze({ kind, ...publication })
  const instanceId = record.instance_id === undefined ? undefined : exactText(record, "instance_id")
  const runId = record.run_id === undefined ? undefined : exactText(record, "run_id")
  if ((instanceId === undefined) !== (runId === undefined)) {
    throw continuationError(
      "WORKFLOW_FULFILL_CONTINUATION_FIELD_INVALID",
      "execution continuation must provide both instance_id and run_id, or neither",
    )
  }
  return Object.freeze({
    kind,
    ...publication,
    ...(instanceId === undefined ? {} : { instance_id: instanceId, run_id: runId! }),
  })
}
