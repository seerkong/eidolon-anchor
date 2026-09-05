import { createHash, randomUUID } from "node:crypto"
import process from "node:process"
import path from "node:path"
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  unlink,
} from "node:fs/promises"

import {
  canonicalOwnDataDigest,
  deepFrozenCanonicalOwnDataClone,
} from "task-manager-contract"
import type { ClosedValue } from "holarchy-eidolon-adapter"
import type {
  HolonTaskRuntimeOrigin,
  HolonTaskRuntimeProcessorConfig,
} from "@cell/ai-organ-contract"
import { normalizeHolonTaskRuntimeOrigin } from "./HolonTaskRuntimeContract"

/** Accepted-effect intent/result bytes stay on v1; only subscriptions evolved. */
export const HOLON_TASK_PUMP_JOURNAL_SCHEMA_VERSION = "eidolon.holon-task-pump/v1" as const
export const LEGACY_HOLON_TASK_PUMP_SUBSCRIPTION_SCHEMA_VERSION =
  HOLON_TASK_PUMP_JOURNAL_SCHEMA_VERSION
export const HOLON_TASK_PUMP_SUBSCRIPTION_SCHEMA_VERSION = "eidolon.holon-task-pump/v2" as const

export type HolonTaskPumpRecoveryScope =
  | Readonly<{ readonly kind: "standalone"; readonly scopeRef: string }>
  | Readonly<{
      readonly kind: "workflow"
      readonly workflowInstanceId: string
      readonly runId: string
      readonly nodeId: string
    }>

export interface HolonTaskPumpSubscription {
  readonly schemaVersion: typeof HOLON_TASK_PUMP_SUBSCRIPTION_SCHEMA_VERSION
  readonly subscriptionId: `sha256:${string}`
  readonly admissionId: string
  readonly deploymentId: string
  readonly bindingRef: `resource://${string}`
  readonly holonRef: string
  readonly snapshotReceiptId: string
  readonly taskSpaceId: string
  readonly taskId: string
  readonly origin: HolonTaskRuntimeOrigin
  readonly recoveryScope: HolonTaskPumpRecoveryScope
  readonly processorConfig: HolonTaskRuntimeProcessorConfig
  readonly input: ClosedValue
  readonly inputDigest: `sha256:${string}`
  readonly createdAt: string
}

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

export interface HolonTaskPumpDispatchIntent {
  readonly schemaVersion: typeof HOLON_TASK_PUMP_JOURNAL_SCHEMA_VERSION
  readonly intentId: `sha256:${string}`
  readonly deploymentId: string
  readonly taskSpaceId: string
  readonly taskId: string
  readonly claimId: string
  readonly attempt: number
  readonly leaseEpoch: number
  readonly invocationRef: string
  readonly input: ClosedValue
  readonly inputDigest: `sha256:${string}`
  readonly preparedAt: string
}

export interface HolonTaskPumpResultReceipt {
  readonly schemaVersion: typeof HOLON_TASK_PUMP_JOURNAL_SCHEMA_VERSION
  readonly intentId: `sha256:${string}`
  readonly invocationRef: string
  readonly output: ClosedValue
  readonly outputDigest: `sha256:${string}`
  readonly acceptedAt: string
  readonly receiptDigest: `sha256:${string}`
}

export interface HolonTaskPumpJournalPort {
  subscribe(input: Omit<HolonTaskPumpSubscription, "schemaVersion" | "subscriptionId" | "inputDigest">): Promise<HolonTaskPumpSubscription>
  listSubscriptions(runId?: string): Promise<readonly HolonTaskPumpSubscription[]>
  dispatch(
    intent: HolonTaskPumpDispatchIntent,
    effect: (idempotencyKey: string) => Promise<ClosedValue>,
  ): Promise<Readonly<{ readonly receipt: HolonTaskPumpResultReceipt; readonly replayed: boolean }>>
  readResult(intentId: string): Promise<HolonTaskPumpResultReceipt | undefined>
}

export class HolonTaskPumpJournalError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "HolonTaskPumpJournalError"
  }
}

const fail = (code: string, message: string): never => {
  throw new HolonTaskPumpJournalError(code, message)
}

const compareUtf16 = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

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

function fileKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
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

async function writeImmutable(directory: string, target: string, bytes: Uint8Array): Promise<void> {
  const candidate = path.join(directory, `.${path.basename(target)}.${randomUUID()}.candidate`)
  const handle = await open(candidate, "wx", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await link(candidate, target)
    const directoryHandle = await open(directory, "r")
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if (!sameBytes(await readFile(target), bytes)) {
      return fail("EIDOLON_HOLON_PUMP_JOURNAL_CONFLICT", `Immutable fact '${path.basename(target)}' conflicts.`)
    }
  } finally {
    await unlink(candidate).catch(() => undefined)
  }
}

type Lock = Readonly<{ readonly file: string; readonly token: string }>

export type HolonTaskPumpJournalFaultObserver = Readonly<{
  afterEffect?(intent: HolonTaskPumpDispatchIntent, output: ClosedValue): void | Promise<void>
}>

export class FileHolonTaskPumpJournal implements HolonTaskPumpJournalPort {
  private readonly root: string
  private readonly lockTimeoutMs: number
  private readonly now: () => number
  private readonly faults?: HolonTaskPumpJournalFaultObserver

  constructor(options: Readonly<{
    readonly supportRoot: string
    readonly lockTimeoutMs?: number
    readonly now?: () => number
    readonly faults?: HolonTaskPumpJournalFaultObserver
  }>) {
    this.root = path.join(options.supportRoot, "holon-task-pump")
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000
    this.now = options.now ?? Date.now
    this.faults = options.faults
  }

  async subscribe(input: Omit<HolonTaskPumpSubscription, "schemaVersion" | "subscriptionId" | "inputDigest">): Promise<HolonTaskPumpSubscription> {
    const value = subscription(input)
    const directory = await this.directory("subscriptions")
    const target = path.join(directory, `${fileKey(value.subscriptionId)}.json`)
    try {
      await writeImmutable(directory, target, canonicalBytes(value))
    } catch (error) {
      if (!(error instanceof HolonTaskPumpJournalError)
        || error.code !== "EIDOLON_HOLON_PUMP_JOURNAL_CONFLICT") throw error
      return retainFirstSubscriptionObservation(
        parseSubscription(await readFile(target)),
        value,
      )
    }
    return parseSubscription(await readFile(target))
  }

  async listSubscriptions(runIdValue?: string): Promise<readonly HolonTaskPumpSubscription[]> {
    const runId = runIdValue === undefined ? undefined : exactText(runIdValue, "runId")
    const directory = await this.directory("subscriptions")
    const values = await Promise.all((await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .sort(compareUtf16)
      .map((name) => readFile(path.join(directory, name)).then(parseSubscription)))
    return Object.freeze(values.filter((value) => runId === undefined
      || (value.recoveryScope.kind === "workflow" && value.recoveryScope.runId === runId)))
  }

  async dispatch(
    intentValue: HolonTaskPumpDispatchIntent,
    effect: (idempotencyKey: string) => Promise<ClosedValue>,
  ): Promise<Readonly<{ readonly receipt: HolonTaskPumpResultReceipt; readonly replayed: boolean }>> {
    const intent = createHolonTaskPumpDispatchIntent(intentValue)
    if (intent.intentId !== intentValue.intentId || intent.inputDigest !== intentValue.inputDigest) {
      return fail("EIDOLON_HOLON_PUMP_JOURNAL_TAMPERED", "Dispatch intent identity is forged.")
    }
    const intents = await this.directory("intents")
    const results = await this.directory("results")
    const intentFile = path.join(intents, `${fileKey(intent.intentId)}.json`)
    const resultFile = path.join(results, `${fileKey(intent.intentId)}.json`)
    await writeImmutable(intents, intentFile, canonicalBytes(intent))
    parseIntent(await readFile(intentFile))
    const existing = await this.readResult(intent.intentId)
    if (existing) return Object.freeze({ receipt: existing, replayed: true })
    const lock = await this.acquire(intent.intentId)
    try {
      const raced = await this.readResult(intent.intentId)
      if (raced) return Object.freeze({ receipt: raced, replayed: true })
      const output = await effect(intent.invocationRef)
      await this.faults?.afterEffect?.(intent, output)
      const receipt = resultReceipt(intent, output, new Date(this.now()).toISOString())
      await writeImmutable(results, resultFile, canonicalBytes(receipt))
      return Object.freeze({ receipt: parseResult(await readFile(resultFile)), replayed: false })
    } finally {
      await this.release(lock)
    }
  }

  async readResult(intentIdValue: string): Promise<HolonTaskPumpResultReceipt | undefined> {
    const intentId = exactText(intentIdValue, "intentId")
    const target = path.join(await this.directory("results"), `${fileKey(intentId)}.json`)
    try {
      const receipt = parseResult(await readFile(target))
      if (receipt.intentId !== intentId) return fail("EIDOLON_HOLON_PUMP_JOURNAL_TAMPERED", "Result belongs to another intent.")
      return receipt
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  private async directory(name: string): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const directory = path.join(this.root, name)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    return directory
  }

  private async acquire(identity: string): Promise<Lock> {
    const directory = await this.directory("locks")
    const file = path.join(directory, `${fileKey(identity)}.lock`)
    const deadline = this.now() + this.lockTimeoutMs
    while (true) {
      const token = randomUUID()
      try {
        const handle = await open(file, "wx", 0o600)
        await handle.writeFile(JSON.stringify({ token, pid: process.pid, createdAt: this.now() }))
        await handle.close()
        return Object.freeze({ file, token })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        const facts = await stat(file).catch(() => undefined)
        if (facts && this.now() - facts.mtimeMs > this.lockTimeoutMs) {
          const owner = JSON.parse(await readFile(file, "utf8")) as { readonly pid?: unknown }
          if (typeof owner.pid !== "number" || !this.pidAlive(owner.pid)) {
            await unlink(file).catch(() => undefined)
            continue
          }
        }
        if (this.now() >= deadline) return fail("EIDOLON_HOLON_PUMP_JOURNAL_LOCK_TIMEOUT", "Dispatch result lock did not become available.")
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    }
  }

  private async release(lock: Lock): Promise<void> {
    const owner = JSON.parse(await readFile(lock.file, "utf8")) as { readonly token?: unknown }
    if (owner.token !== lock.token) return fail("EIDOLON_HOLON_PUMP_JOURNAL_LOCK_CONFLICT", "Dispatch lock ownership changed.")
    await unlink(lock.file)
  }

  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }
}
