import {
  EIDOLON_HOLON_TASK_PROFILE_KIND,
  type HolonTaskExecutionProfile,
} from "@cell/ai-organ-contract"

import {
  normalizeFrozenHolonTaskRuntimeAdmission,
  normalizeHolonTaskSnapshotReceiptForAdmission,
  HolonTaskRuntimeContractError,
} from "./HolonTaskRuntimeContract"

const invalid = (path: string, message: string): never => {
  throw new HolonTaskRuntimeContractError(path, message)
}

function closedObject(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(path, "Expected a plain object")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(path, "Expected a plain object")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
    return invalid(path, "Symbol properties are not allowed")
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const key of Object.keys(descriptors)) {
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

function emptyDenseArray(value: unknown, path: string): readonly [] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 0
    || Reflect.ownKeys(Object.getOwnPropertyDescriptors(value)).some((key) => key !== "length")) {
    return invalid(path, "Expected one empty plain dense array")
  }
  return Object.freeze([])
}

export function createHolonTaskExecutionProfile(
  admission: unknown,
  snapshotReceipt: unknown,
): HolonTaskExecutionProfile {
  const normalizedAdmission = normalizeFrozenHolonTaskRuntimeAdmission(admission)
  const normalizedSnapshotReceipt = normalizeHolonTaskSnapshotReceiptForAdmission(
    normalizedAdmission,
    snapshotReceipt,
  )
  return Object.freeze({
    kind: "task-profile",
    profileKind: EIDOLON_HOLON_TASK_PROFILE_KIND,
    schemaVersion: 1,
    facts: Object.freeze({
      admission: normalizedAdmission,
      snapshotReceipt: normalizedSnapshotReceipt,
      assignmentReceipt: null,
      memberRuntimeRef: null,
      settlementReceipt: null,
      snapshotAdoptions: Object.freeze([]) as readonly [],
    }),
  })
}

export function normalizeHolonTaskExecutionProfile(value: unknown): HolonTaskExecutionProfile {
  const root = closedObject(value, "$profile")
  exactKeys(root, ["kind", "profileKind", "schemaVersion", "facts"], "$profile")
  if (root.kind !== "task-profile") invalid("$profile.kind", "Expected 'task-profile'")
  if (root.profileKind !== EIDOLON_HOLON_TASK_PROFILE_KIND) {
    invalid("$profile.profileKind", `Expected '${EIDOLON_HOLON_TASK_PROFILE_KIND}'`)
  }
  if (root.schemaVersion !== 1) invalid("$profile.schemaVersion", "Expected 1")
  const facts = closedObject(root.facts, "$profile.facts")
  exactKeys(facts, [
    "admission", "snapshotReceipt", "assignmentReceipt", "memberRuntimeRef",
    "settlementReceipt", "snapshotAdoptions",
  ], "$profile.facts")
  if (facts.assignmentReceipt !== null || facts.memberRuntimeRef !== null
    || facts.settlementReceipt !== null) {
    invalid("$profile.facts", "Runtime projection facts must start as null")
  }
  const admission = normalizeFrozenHolonTaskRuntimeAdmission(facts.admission)
  const snapshotReceipt = normalizeHolonTaskSnapshotReceiptForAdmission(admission, facts.snapshotReceipt)
  return Object.freeze({
    kind: "task-profile",
    profileKind: EIDOLON_HOLON_TASK_PROFILE_KIND,
    schemaVersion: 1,
    facts: Object.freeze({
      admission,
      snapshotReceipt,
      assignmentReceipt: null,
      memberRuntimeRef: null,
      settlementReceipt: null,
      snapshotAdoptions: emptyDenseArray(facts.snapshotAdoptions, "$profile.facts.snapshotAdoptions"),
    }),
  })
}
