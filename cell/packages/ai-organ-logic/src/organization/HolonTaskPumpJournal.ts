import {
  canonicalOwnDataDigest,
  deepFrozenCanonicalOwnDataClone,
} from "task-manager-contract"
import type { ClosedValue } from "holarchy-eidolon-adapter"
import type { HolonTaskRuntimeOrigin, HolonTaskRuntimeProcessorConfig } from "@cell/ai-organ-contract"
import {
  HOLON_TASK_PUMP_JOURNAL_SCHEMA_VERSION,
  HOLON_TASK_PUMP_SUBSCRIPTION_SCHEMA_VERSION,
  LEGACY_HOLON_TASK_PUMP_SUBSCRIPTION_SCHEMA_VERSION,
  HolonTaskPumpJournalError,
  type HolonTaskPumpDispatchIntent,
  type HolonTaskPumpJournalPort,
  type HolonTaskPumpJournalRuntime,
  type HolonTaskPumpRecoveryScope,
  type HolonTaskPumpResultReceipt,
  type HolonTaskPumpSubscription,
} from "@cell/ai-organ-contract/organization/HolonTaskPumpJournal"
import { normalizeHolonTaskRuntimeOrigin } from "./HolonTaskRuntimeContract"

export * from "@cell/ai-organ-contract/organization/HolonTaskPumpJournal"

interface LegacyHolonTaskPumpSubscription {
  readonly schemaVersion: typeof LEGACY_HOLON_TASK_PUMP_SUBSCRIPTION_SCHEMA_VERSION
  readonly subscriptionId: `sha256:${string}`
  readonly deploymentId: string
  readonly bindingRef: `resource://${string}`
  readonly holonRef: string
  readonly snapshotReceiptId: string
  readonly taskSpaceId: string
  readonly taskId: string
  readonly workflowInstanceId: string
  readonly runId: string
  readonly nodeId: string
  readonly origin?: HolonTaskRuntimeOrigin
  readonly input: ClosedValue
  readonly inputDigest: `sha256:${string}`
  readonly createdAt: string
}

const fail = (code: string, message: string): never => {
  throw new HolonTaskPumpJournalError(code, message)
}

function exactText(value: unknown, location: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/u.test(value)) {
    return fail("EIDOLON_HOLON_PUMP_JOURNAL_INVALID", `${location} must be one exact canonical string.`)
  }
  return value
}

function exactTimestamp(value: unknown, location: string): string {
  const text = exactText(value, location)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(text)
    || new Date(text).toISOString() !== text) {
    return fail("EIDOLON_HOLON_PUMP_JOURNAL_INVALID", `${location} must be one canonical ISO timestamp.`)
  }
  return text
}

function digest(value: unknown): `sha256:${string}` {
  return canonicalOwnDataDigest(value)
}

function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
}

function processorConfig(value: HolonTaskRuntimeProcessorConfig): HolonTaskRuntimeProcessorConfig {
  if (!Number.isSafeInteger(value?.leaseDurationMs) || value.leaseDurationMs <= 0
    || !Number.isSafeInteger(value?.maxSteps) || value.maxSteps <= 0) {
    return fail(
      "EIDOLON_HOLON_PUMP_JOURNAL_INVALID",
      "subscription.processorConfig requires positive integer limits.",
    )
  }
  return Object.freeze({
    leaseDurationMs: value.leaseDurationMs,
    maxSteps: value.maxSteps,
  })
}

function recoveryScope(value: HolonTaskPumpRecoveryScope): HolonTaskPumpRecoveryScope {
  if (value?.kind === "standalone") {
    return Object.freeze({ kind: value.kind, scopeRef: exactText(value.scopeRef, "recoveryScope.scopeRef") })
  }
  if (value?.kind === "workflow") {
    return Object.freeze({
      kind: value.kind,
      workflowInstanceId: exactText(value.workflowInstanceId, "recoveryScope.workflowInstanceId"),
      runId: exactText(value.runId, "recoveryScope.runId"),
      nodeId: exactText(value.nodeId, "recoveryScope.nodeId"),
    })
  }
  return fail(
    "EIDOLON_HOLON_PUMP_JOURNAL_INVALID",
    "subscription.recoveryScope must be standalone or workflow.",
  )
}

function subscription(input: Omit<HolonTaskPumpSubscription, "schemaVersion" | "subscriptionId" | "inputDigest">): HolonTaskPumpSubscription {
  const bindingRef = exactText(input.bindingRef, "subscription.bindingRef")
  if (!bindingRef.startsWith("resource://") || !bindingRef.slice("resource://".length)) {
    return fail("EIDOLON_HOLON_PUMP_JOURNAL_INVALID", "subscription.bindingRef must be one resource identity.")
  }
  const closedInput = deepFrozenCanonicalOwnDataClone(input.input) as ClosedValue
  const scope = recoveryScope(input.recoveryScope)
  const identity = {
    admissionId: exactText(input.admissionId, "subscription.admissionId"),
    deploymentId: exactText(input.deploymentId, "subscription.deploymentId"),
    snapshotReceiptId: exactText(input.snapshotReceiptId, "subscription.snapshotReceiptId"),
    taskSpaceId: exactText(input.taskSpaceId, "subscription.taskSpaceId"),
    taskId: exactText(input.taskId, "subscription.taskId"),
    recoveryScope: scope,
  }
  return Object.freeze({
    schemaVersion: HOLON_TASK_PUMP_SUBSCRIPTION_SCHEMA_VERSION,
    subscriptionId: digest(identity),
    ...identity,
    bindingRef: bindingRef as `resource://${string}`,
    holonRef: exactText(input.holonRef, "subscription.holonRef"),
    origin: normalizeHolonTaskRuntimeOrigin(input.origin),
    processorConfig: processorConfig(input.processorConfig),
    input: closedInput,
    inputDigest: digest(closedInput),
    createdAt: exactTimestamp(input.createdAt, "subscription.createdAt"),
  })
}

function legacySubscription(
  input: Omit<LegacyHolonTaskPumpSubscription, "schemaVersion" | "subscriptionId" | "inputDigest">,
): LegacyHolonTaskPumpSubscription {
  const bindingRef = exactText(input.bindingRef, "legacySubscription.bindingRef")
  if (!bindingRef.startsWith("resource://") || !bindingRef.slice("resource://".length)) {
    return fail("EIDOLON_HOLON_PUMP_JOURNAL_INVALID", "legacySubscription.bindingRef must be one resource identity.")
  }
  const closedInput = deepFrozenCanonicalOwnDataClone(input.input) as ClosedValue
  const identity = {
    deploymentId: exactText(input.deploymentId, "legacySubscription.deploymentId"),
    snapshotReceiptId: exactText(input.snapshotReceiptId, "legacySubscription.snapshotReceiptId"),
    taskSpaceId: exactText(input.taskSpaceId, "legacySubscription.taskSpaceId"),
    taskId: exactText(input.taskId, "legacySubscription.taskId"),
    runId: exactText(input.runId, "legacySubscription.runId"),
    nodeId: exactText(input.nodeId, "legacySubscription.nodeId"),
  }
  return Object.freeze({
    schemaVersion: LEGACY_HOLON_TASK_PUMP_SUBSCRIPTION_SCHEMA_VERSION,
    subscriptionId: digest(identity),
    ...identity,
    bindingRef: bindingRef as `resource://${string}`,
    holonRef: exactText(input.holonRef, "legacySubscription.holonRef"),
    workflowInstanceId: exactText(input.workflowInstanceId, "legacySubscription.workflowInstanceId"),
    ...(input.origin === undefined ? {} : { origin: normalizeHolonTaskRuntimeOrigin(input.origin) }),
    input: closedInput,
    inputDigest: digest(closedInput),
    createdAt: exactTimestamp(input.createdAt, "legacySubscription.createdAt"),
  })
}

export function createHolonTaskPumpDispatchIntent(input: Omit<HolonTaskPumpDispatchIntent, "schemaVersion" | "intentId" | "inputDigest">): HolonTaskPumpDispatchIntent {
  if (!Number.isSafeInteger(input.attempt) || input.attempt <= 0
    || !Number.isSafeInteger(input.leaseEpoch) || input.leaseEpoch <= 0) {
    return fail("EIDOLON_HOLON_PUMP_JOURNAL_INVALID", "Attempt and lease epoch must be positive safe integers.")
  }
  const closedInput = deepFrozenCanonicalOwnDataClone(input.input) as ClosedValue
  const identity = Object.freeze({
    deploymentId: exactText(input.deploymentId, "intent.deploymentId"),
    taskSpaceId: exactText(input.taskSpaceId, "intent.taskSpaceId"),
    taskId: exactText(input.taskId, "intent.taskId"),
    claimId: exactText(input.claimId, "intent.claimId"),
    attempt: input.attempt,
    leaseEpoch: input.leaseEpoch,
    invocationRef: exactText(input.invocationRef, "intent.invocationRef"),
  })
  return Object.freeze({
    schemaVersion: HOLON_TASK_PUMP_JOURNAL_SCHEMA_VERSION,
    intentId: digest(identity),
    ...identity,
    input: closedInput,
    inputDigest: digest(closedInput),
    preparedAt: exactTimestamp(input.preparedAt, "intent.preparedAt"),
  })
}

function resultReceipt(intent: HolonTaskPumpDispatchIntent, outputValue: ClosedValue, acceptedAt: string): HolonTaskPumpResultReceipt {
  const output = deepFrozenCanonicalOwnDataClone(outputValue) as ClosedValue
  const body = Object.freeze({
    schemaVersion: HOLON_TASK_PUMP_JOURNAL_SCHEMA_VERSION,
    intentId: intent.intentId,
    invocationRef: intent.invocationRef,
    output,
    outputDigest: digest(output),
    acceptedAt: exactTimestamp(acceptedAt, "result.acceptedAt"),
  })
  return Object.freeze({ ...body, receiptDigest: digest(body) })
}

function parseSubscription(bytes: Uint8Array): HolonTaskPumpSubscription {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as
    | HolonTaskPumpSubscription
    | LegacyHolonTaskPumpSubscription
  if (value.schemaVersion === LEGACY_HOLON_TASK_PUMP_SUBSCRIPTION_SCHEMA_VERSION) {
    const normalized = legacySubscription(value)
    if (normalized.subscriptionId !== value.subscriptionId
      || normalized.inputDigest !== value.inputDigest
      || !sameBytes(bytes, canonicalBytes(normalized))) {
      return fail("EIDOLON_HOLON_PUMP_JOURNAL_TAMPERED", "Legacy subscription bytes do not match their canonical identity.")
    }
    const origin = normalized.origin ?? Object.freeze({
      kind: "service" as const,
      serviceRef: "resource://eidolon.legacy-workflow-holon-task-pump" as const,
      requestRef: normalized.subscriptionId,
    })
    return Object.freeze({
      schemaVersion: HOLON_TASK_PUMP_SUBSCRIPTION_SCHEMA_VERSION,
      subscriptionId: normalized.subscriptionId,
      admissionId: `legacy-workflow:${digest({
        deploymentId: normalized.deploymentId,
        bindingRef: normalized.bindingRef,
        snapshotReceiptId: normalized.snapshotReceiptId,
        nodeId: normalized.nodeId,
      })}`,
      deploymentId: normalized.deploymentId,
      bindingRef: normalized.bindingRef,
      holonRef: normalized.holonRef,
      snapshotReceiptId: normalized.snapshotReceiptId,
      taskSpaceId: normalized.taskSpaceId,
      taskId: normalized.taskId,
      origin,
      recoveryScope: Object.freeze({
        kind: "workflow" as const,
        workflowInstanceId: normalized.workflowInstanceId,
        runId: normalized.runId,
        nodeId: normalized.nodeId,
      }),
      processorConfig: Object.freeze({ leaseDurationMs: 30_000, maxSteps: 1_024 }),
      input: normalized.input,
      inputDigest: normalized.inputDigest,
      createdAt: normalized.createdAt,
    })
  }
  const normalized = subscription(value)
  if (normalized.subscriptionId !== value.subscriptionId || normalized.inputDigest !== value.inputDigest
    || !sameBytes(bytes, canonicalBytes(normalized))) {
    return fail("EIDOLON_HOLON_PUMP_JOURNAL_TAMPERED", "Subscription bytes do not match their canonical identity.")
  }
  return normalized
}

function retainFirstSubscriptionObservation(
  existing: HolonTaskPumpSubscription,
  candidate: HolonTaskPumpSubscription,
): HolonTaskPumpSubscription {
  const replayAtFirstObservation = Object.freeze({
    ...candidate,
    createdAt: existing.createdAt,
  })
  if (!sameBytes(canonicalBytes(existing), canonicalBytes(replayAtFirstObservation))) {
    return fail(
      "EIDOLON_HOLON_PUMP_JOURNAL_CONFLICT",
      `Subscription '${candidate.subscriptionId}' conflicts with its first accepted facts.`,
    )
  }
  return existing
}

function parseIntent(bytes: Uint8Array): HolonTaskPumpDispatchIntent {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as HolonTaskPumpDispatchIntent
  const normalized = createHolonTaskPumpDispatchIntent(value)
  if (normalized.intentId !== value.intentId || normalized.inputDigest !== value.inputDigest
    || !sameBytes(bytes, canonicalBytes(normalized))) {
    return fail("EIDOLON_HOLON_PUMP_JOURNAL_TAMPERED", "Intent bytes do not match their canonical identity.")
  }
  return normalized
}

function parseResult(bytes: Uint8Array): HolonTaskPumpResultReceipt {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as HolonTaskPumpResultReceipt
  const body = {
    schemaVersion: value.schemaVersion,
    intentId: value.intentId,
    invocationRef: value.invocationRef,
    output: deepFrozenCanonicalOwnDataClone(value.output) as ClosedValue,
    outputDigest: value.outputDigest,
    acceptedAt: value.acceptedAt,
  }
  const expected = Object.freeze({ ...body, receiptDigest: digest(body) })
  if (value.schemaVersion !== HOLON_TASK_PUMP_JOURNAL_SCHEMA_VERSION
    || value.outputDigest !== digest(value.output) || value.receiptDigest !== expected.receiptDigest
    || !sameBytes(bytes, canonicalBytes(expected))) {
    return fail("EIDOLON_HOLON_PUMP_JOURNAL_TAMPERED", "Result receipt failed canonical digest verification.")
  }
  return expected
}

async function subscribe(
  runtime: HolonTaskPumpJournalRuntime,
  input: Omit<HolonTaskPumpSubscription, "schemaVersion" | "subscriptionId" | "inputDigest">,
): Promise<HolonTaskPumpSubscription> {
  const value = subscription(input)
  try {
    await runtime.store.writeImmutable("subscriptions", value.subscriptionId, canonicalBytes(value))
  } catch (error) {
    if (!(error instanceof HolonTaskPumpJournalError)
      || error.code !== "EIDOLON_HOLON_PUMP_JOURNAL_CONFLICT") throw error
    return retainFirstSubscriptionObservation(
      parseSubscription(await runtime.store.read("subscriptions", value.subscriptionId)),
      value,
    )
  }
  return parseSubscription(await runtime.store.read("subscriptions", value.subscriptionId))
}

async function listSubscriptions(
  runtime: HolonTaskPumpJournalRuntime,
  runIdValue?: string,
): Promise<readonly HolonTaskPumpSubscription[]> {
  const runId = runIdValue === undefined ? undefined : exactText(runIdValue, "runId")
  const values = (await runtime.store.list("subscriptions")).map(parseSubscription)
  return Object.freeze(values.filter((value) => runId === undefined
    || (value.recoveryScope.kind === "workflow" && value.recoveryScope.runId === runId)))
}

async function dispatch(
  runtime: HolonTaskPumpJournalRuntime,
  intentValue: HolonTaskPumpDispatchIntent,
  effect: (idempotencyKey: string) => Promise<ClosedValue>,
): Promise<Readonly<{ readonly receipt: HolonTaskPumpResultReceipt; readonly replayed: boolean }>> {
  const intent = createHolonTaskPumpDispatchIntent(intentValue)
  if (intent.intentId !== intentValue.intentId || intent.inputDigest !== intentValue.inputDigest) {
    return fail("EIDOLON_HOLON_PUMP_JOURNAL_TAMPERED", "Dispatch intent identity is forged.")
  }
  await runtime.store.writeImmutable("intents", intent.intentId, canonicalBytes(intent))
  parseIntent(await runtime.store.read("intents", intent.intentId))
  const existing = await readResult(runtime, intent.intentId)
  if (existing) return Object.freeze({ receipt: existing, replayed: true })
  return runtime.store.withExclusive(intent.intentId, async () => {
    const raced = await readResult(runtime, intent.intentId)
    if (raced) return Object.freeze({ receipt: raced, replayed: true })
    const output = await effect(intent.invocationRef)
    await runtime.faults?.afterEffect?.(intent, output)
    const receipt = resultReceipt(intent, output, new Date(runtime.now()).toISOString())
    await runtime.store.writeImmutable("results", intent.intentId, canonicalBytes(receipt))
    return Object.freeze({
      receipt: parseResult(await runtime.store.read("results", intent.intentId)),
      replayed: false,
    })
  })
}

async function readResult(
  runtime: HolonTaskPumpJournalRuntime,
  intentIdValue: string,
): Promise<HolonTaskPumpResultReceipt | undefined> {
  const intentId = exactText(intentIdValue, "intentId")
  try {
    const receipt = parseResult(await runtime.store.read("results", intentId))
    if (receipt.intentId !== intentId) return fail("EIDOLON_HOLON_PUMP_JOURNAL_TAMPERED", "Result belongs to another intent.")
    return receipt
  } catch (error) {
    if ((error as { readonly code?: string }).code === "ENOENT") return undefined
    throw error
  }
}

/** Bind explicitly supplied effects to the journal rules; importing creates no runtime. */
export function createHolonTaskPumpJournal(runtime: HolonTaskPumpJournalRuntime): HolonTaskPumpJournalPort {
  return Object.freeze({
    subscribe: (input) => subscribe(runtime, input),
    listSubscriptions: (runId) => listSubscriptions(runtime, runId),
    dispatch: (intent, effect) => dispatch(runtime, intent, effect),
    readResult: (intentId) => readResult(runtime, intentId),
  } satisfies HolonTaskPumpJournalPort)
}
