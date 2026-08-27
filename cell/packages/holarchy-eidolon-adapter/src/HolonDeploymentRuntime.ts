import {
  parseActorRegistrationReceipt,
  type ActorRegistrationReceipt,
} from "depa-actor"
import type { AIAgentSelector } from "ai-workflow-contract"

import { HolarchyEidolonAdapterError } from "./HolarchyEidolonAdapterError"

export const HOLON_DEPLOYMENT_RUNTIME_SCHEMA_VERSION =
  "eidolon.holon-deployment-runtime/v1" as const

export type HolonCoordinatorLifecycleStatus = "registered" | "ready" | "stopped"
export type HolonMemberRuntimeLifecycleStatus = "registered" | "ready" | "stopped"
export type HolonTaskSpaceSubscriptionStatus = "observing" | "paused" | "closed"

export type HolonMemberRuntimeIsolation =
  | Readonly<{ readonly mode: "shared" }>
  | Readonly<{
      readonly mode: "isolated"
      readonly scope: "task-space" | "workflow-run"
      readonly isolationKey: string
    }>

export type HolonGenericSessionRef =
  | Readonly<{
      readonly mode: "task-attempt"
      readonly taskSpaceId: string
      readonly taskId: string
      readonly claimId: string
      readonly attempt: number
      readonly workflowInstanceId?: string
      readonly runId?: string
      readonly sessionRef: string
    }>
  | Readonly<{
      readonly mode: "targeted-agent-instance"
      readonly selector: AIAgentSelector
      readonly sessionRef: string
    }>

export interface HolonCoordinatorLifecycleFact {
  readonly holonRef: string
  readonly status: HolonCoordinatorLifecycleStatus
  readonly actorRef: string
  readonly registrationReceipt: ActorRegistrationReceipt
}

export interface HolonMemberRuntimeLifecycleFact {
  readonly runtimeRef: string
  readonly holonRef: string
  readonly memberRef: string
  readonly isolation: HolonMemberRuntimeIsolation
  readonly status: HolonMemberRuntimeLifecycleStatus
  readonly actorRef: string
  readonly registrationReceipt: ActorRegistrationReceipt
  readonly sessions: readonly HolonGenericSessionRef[]
}

export interface HolonTaskSpaceSubscriptionFact {
  readonly taskSpaceId: string
  readonly holonRef: string
  readonly cursor: string
  readonly status: HolonTaskSpaceSubscriptionStatus
}

export interface HolonDeploymentRuntimeSnapshot {
  readonly schemaVersion: typeof HOLON_DEPLOYMENT_RUNTIME_SCHEMA_VERSION
  readonly deploymentId: string
  readonly definitionSemanticFingerprint: `sha256:${string}`
  readonly revision: number
  readonly coordinators: readonly HolonCoordinatorLifecycleFact[]
  readonly members: readonly HolonMemberRuntimeLifecycleFact[]
  readonly subscriptions: readonly HolonTaskSpaceSubscriptionFact[]
}

const compareUtf16 = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const invalid = (location: string, message: string): never => {
  throw new HolarchyEidolonAdapterError(
    "EIDOLON_HOLON_DEPLOYMENT_RUNTIME_INVALID",
    `${location}: ${message}`,
  )
}

function closedObject(value: unknown, location: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(location, "Expected a plain object")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(location, "Expected a plain object")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some((key) => typeof key !== "string")) {
    return invalid(location, "Symbol properties are not allowed")
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      return invalid(`${location}.${key}`, "Expected one enumerable own-data property")
    }
    result[key] = descriptor.value
  }
  return result
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[], location: string): void {
  const allowed = new Set(expected)
  const extra = Object.keys(value).find((key) => !allowed.has(key))
  if (extra !== undefined) invalid(`${location}.${extra}`, "Unsupported field")
  const missing = expected.find((key) => !Object.prototype.hasOwnProperty.call(value, key))
  if (missing !== undefined) invalid(`${location}.${missing}`, "Required field is missing")
}

function denseArray(value: unknown, location: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return invalid(location, "Expected a plain dense array")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      return invalid(`${location}[${index}]`, "Expected a dense enumerable own-data entry")
    }
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      return invalid(location, "Symbol and extra array properties are not allowed")
    }
  }
  return value
}

function exactString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()
    || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/.test(value)) {
    return invalid(location, "Expected one exact canonical non-empty string")
  }
  return value
}

function exactLiteral<T extends string>(value: unknown, expected: T, location: string): T {
  if (value !== expected) invalid(location, `Expected '${expected}'`)
  return expected
}

function exactUnion<T extends string>(value: unknown, expected: readonly T[], location: string): T {
  const exact = exactString(value, location)
  if (!expected.includes(exact as T)) invalid(location, `Expected ${expected.join(" | ")}`)
  return exact as T
}

function digest(value: unknown, location: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    return invalid(location, "Expected one canonical sha256 digest")
  }
  return value as `sha256:${string}`
}

function receipt(value: unknown, location: string): ActorRegistrationReceipt {
  try {
    return parseActorRegistrationReceipt(value)
  } catch (error) {
    return invalid(location, error instanceof Error ? error.message : "Invalid depa-actor registration receipt")
  }
}

function isolation(value: unknown, location: string): HolonMemberRuntimeIsolation {
  const record = closedObject(value, location)
  const mode = exactString(record.mode, `${location}.mode`)
  if (mode === "shared") {
    exactKeys(record, ["mode"], location)
    return Object.freeze({ mode })
  }
  if (mode === "isolated") {
    exactKeys(record, ["mode", "scope", "isolationKey"], location)
    return Object.freeze({
      mode,
      scope: exactUnion(record.scope, ["task-space", "workflow-run"] as const, `${location}.scope`),
      isolationKey: exactString(record.isolationKey, `${location}.isolationKey`),
    })
  }
  return invalid(`${location}.mode`, "Expected shared | isolated")
}

function coordinator(value: unknown, index: number): HolonCoordinatorLifecycleFact {
  const location = `$.coordinators[${index}]`
  const record = closedObject(value, location)
  exactKeys(record, ["holonRef", "status", "actorRef", "registrationReceipt"], location)
  const registrationReceipt = receipt(record.registrationReceipt, `${location}.registrationReceipt`)
  if (registrationReceipt.address.actorKind !== "coordinator") {
    invalid(`${location}.registrationReceipt.address.actorKind`, "Expected coordinator")
  }
  return Object.freeze({
    holonRef: exactString(record.holonRef, `${location}.holonRef`),
    status: exactUnion(record.status, ["registered", "ready", "stopped"] as const, `${location}.status`),
    actorRef: exactString(record.actorRef, `${location}.actorRef`),
    registrationReceipt,
  })
}

function session(value: unknown, location: string): HolonGenericSessionRef {
  const record = closedObject(value, location)
  const mode = exactString(record.mode, `${location}.mode`)
  if (mode === "task-attempt") {
    const optional = ["workflowInstanceId", "runId"].filter((key) => (
      Object.prototype.hasOwnProperty.call(record, key)
    ))
    exactKeys(record, [
      "mode", "taskSpaceId", "taskId", "claimId", "attempt", "sessionRef", ...optional,
    ], location)
    if (!Number.isSafeInteger(record.attempt) || (record.attempt as number) <= 0) {
      invalid(`${location}.attempt`, "Expected one positive safe integer")
    }
    return Object.freeze({
      mode,
      taskSpaceId: exactString(record.taskSpaceId, `${location}.taskSpaceId`),
      taskId: exactString(record.taskId, `${location}.taskId`),
      claimId: exactString(record.claimId, `${location}.claimId`),
      attempt: record.attempt as number,
      ...(record.workflowInstanceId === undefined
        ? {}
        : { workflowInstanceId: exactString(record.workflowInstanceId, `${location}.workflowInstanceId`) }),
      ...(record.runId === undefined ? {} : { runId: exactString(record.runId, `${location}.runId`) }),
      sessionRef: exactString(record.sessionRef, `${location}.sessionRef`),
    })
  }
  if (mode === "targeted-agent-instance") {
    exactKeys(record, ["mode", "selector", "sessionRef"], location)
    const selectorRecord = closedObject(record.selector, `${location}.selector`)
    const hasId = Object.prototype.hasOwnProperty.call(selectorRecord, "byId")
    const hasName = Object.prototype.hasOwnProperty.call(selectorRecord, "byName")
    if (hasId === hasName) invalid(`${location}.selector`, "Expected exactly one targeted Agent selector")
    exactKeys(selectorRecord, [hasId ? "byId" : "byName"], `${location}.selector`)
    const selector = (hasId
      ? Object.freeze({ byId: exactString(selectorRecord.byId, `${location}.selector.byId`) })
      : Object.freeze({ byName: exactString(selectorRecord.byName, `${location}.selector.byName`) })) as unknown as AIAgentSelector
    return Object.freeze({
      mode,
      selector,
      sessionRef: exactString(record.sessionRef, `${location}.sessionRef`),
    })
  }
  return invalid(`${location}.mode`, "Expected task-attempt | targeted-agent-instance")
}

function sessionIdentity(value: HolonGenericSessionRef): string {
  return value.mode === "task-attempt"
    ? JSON.stringify([value.mode, value.taskSpaceId, value.taskId, value.claimId, value.attempt])
    : JSON.stringify([value.mode, value.selector])
}

function member(value: unknown, index: number): HolonMemberRuntimeLifecycleFact {
  const location = `$.members[${index}]`
  const record = closedObject(value, location)
  exactKeys(record, [
    "runtimeRef",
    "holonRef",
    "memberRef",
    "isolation",
    "status",
    "actorRef",
    "registrationReceipt",
    "sessions",
  ], location)
  const registrationReceipt = receipt(record.registrationReceipt, `${location}.registrationReceipt`)
  if (registrationReceipt.address.actorKind !== "member") {
    invalid(`${location}.registrationReceipt.address.actorKind`, "Expected member")
  }
  const sessions = denseArray(record.sessions, `${location}.sessions`)
    .map((entry, sessionIndex) => session(entry, `${location}.sessions[${sessionIndex}]`))
    .sort((left, right) => compareUtf16(sessionIdentity(left), sessionIdentity(right)))
  if (new Set(sessions.map(sessionIdentity)).size !== sessions.length) {
    invalid(`${location}.sessions`, "Session scope identities must be unique")
  }
  return Object.freeze({
    runtimeRef: exactString(record.runtimeRef, `${location}.runtimeRef`),
    holonRef: exactString(record.holonRef, `${location}.holonRef`),
    memberRef: exactString(record.memberRef, `${location}.memberRef`),
    isolation: isolation(record.isolation, `${location}.isolation`),
    status: exactUnion(record.status, ["registered", "ready", "stopped"] as const, `${location}.status`),
    actorRef: exactString(record.actorRef, `${location}.actorRef`),
    registrationReceipt,
    sessions: Object.freeze(sessions),
  })
}

function subscription(value: unknown, index: number): HolonTaskSpaceSubscriptionFact {
  const location = `$.subscriptions[${index}]`
  const record = closedObject(value, location)
  exactKeys(record, ["taskSpaceId", "holonRef", "cursor", "status"], location)
  return Object.freeze({
    taskSpaceId: exactString(record.taskSpaceId, `${location}.taskSpaceId`),
    holonRef: exactString(record.holonRef, `${location}.holonRef`),
    cursor: exactString(record.cursor, `${location}.cursor`),
    status: exactUnion(record.status, ["observing", "paused", "closed"] as const, `${location}.status`),
  })
}

function unique<T>(values: readonly T[], identity: (value: T) => string, location: string): void {
  if (new Set(values.map(identity)).size !== values.length) invalid(location, "Contains a duplicate identity")
}

export function normalizeHolonDeploymentRuntimeSnapshot(value: unknown): HolonDeploymentRuntimeSnapshot {
  const record = closedObject(value, "$")
  exactKeys(record, [
    "schemaVersion",
    "deploymentId",
    "definitionSemanticFingerprint",
    "revision",
    "coordinators",
    "members",
    "subscriptions",
  ], "$")
  if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 0) {
    invalid("$.revision", "Expected one non-negative safe integer")
  }
  const coordinators = denseArray(record.coordinators, "$.coordinators")
    .map(coordinator)
    .sort((left, right) => compareUtf16(left.holonRef, right.holonRef))
  const members = denseArray(record.members, "$.members")
    .map(member)
    .sort((left, right) => compareUtf16(left.runtimeRef, right.runtimeRef))
  const subscriptions = denseArray(record.subscriptions, "$.subscriptions")
    .map(subscription)
    .sort((left, right) => compareUtf16(left.taskSpaceId, right.taskSpaceId))
  unique(coordinators, (entry) => entry.holonRef, "$.coordinators")
  unique(members, (entry) => entry.runtimeRef, "$.members")
  unique(subscriptions, (entry) => entry.taskSpaceId, "$.subscriptions")
  const deploymentId = exactString(record.deploymentId, "$.deploymentId")
  for (const entry of [...coordinators, ...members]) {
    if (entry.registrationReceipt.address.deploymentId !== deploymentId) {
      invalid("$.deploymentId", "All actor registration receipts must belong to this deployment")
    }
  }
  return Object.freeze({
    schemaVersion: exactLiteral(
      record.schemaVersion,
      HOLON_DEPLOYMENT_RUNTIME_SCHEMA_VERSION,
      "$.schemaVersion",
    ),
    deploymentId,
    definitionSemanticFingerprint: digest(
      record.definitionSemanticFingerprint,
      "$.definitionSemanticFingerprint",
    ),
    revision: record.revision as number,
    coordinators: Object.freeze(coordinators),
    members: Object.freeze(members),
    subscriptions: Object.freeze(subscriptions),
  })
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export function canonicalHolonDeploymentRuntimeSnapshotBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(normalizeHolonDeploymentRuntimeSnapshot(value)))
}

export function parseHolonDeploymentRuntimeSnapshotBytes(bytes: Uint8Array): HolonDeploymentRuntimeSnapshot {
  let decoded: string
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return invalid("$bytes", "Runtime bytes are not valid UTF-8")
  }
  let value: unknown
  try {
    value = JSON.parse(decoded)
  } catch {
    return invalid("$bytes", "Runtime bytes are not valid JSON")
  }
  const snapshot = normalizeHolonDeploymentRuntimeSnapshot(value)
  if (!sameBytes(bytes, canonicalHolonDeploymentRuntimeSnapshotBytes(snapshot))) {
    return invalid("$bytes", "Runtime bytes are not canonical")
  }
  return snapshot
}
