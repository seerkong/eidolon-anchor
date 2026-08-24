import { canonicalOwnDataDigest, type TaskSpaceOwnerPort } from "task-manager-contract"
import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"

import { writeHolonGovernance } from "./OrganizationManager"

export interface RetireLegacyHolonTaskAuthorityRuntime {
  readonly actor: AiAgentActor
  readonly taskSpaces: TaskSpaceOwnerPort
}

export interface RetireLegacyHolonTaskAuthorityInput {
  readonly holonRef: string
  readonly taskSpaceId: string
}

export type RetireLegacyHolonTaskAuthorityConfig = Readonly<Record<string, never>>

export interface LegacyHolonTaskRetirementReceipt {
  readonly schemaVersion: "eidolon.legacy-holon-task-retirement/v1"
  readonly holonRef: string
  readonly taskSpaceId: string
  readonly acceptedTaskSpaceRevision: number
  readonly legacyInventoryDigest: `sha256:${string}`
  readonly retiredTaskIds: readonly string[]
}

interface CanonicalAuthorityBinding {
  readonly taskSpaceId: string
  readonly taskSpaces: TaskSpaceOwnerPort
  readonly receipt: LegacyHolonTaskRetirementReceipt
}

const bindings = new WeakMap<AiAgentActor, CanonicalAuthorityBinding>()

export class HolonLegacyTaskAuthorityError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "HolonLegacyTaskAuthorityError"
  }
}

const invalid = (code: string, message: string): never => {
  throw new HolonLegacyTaskAuthorityError(code, message)
}

function exactInput(value: unknown): RetireLegacyHolonTaskAuthorityInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return invalid("EIDOLON_LEGACY_HOLON_TASK_INPUT_INVALID", "Input must be one plain object.")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== 2
    || !descriptors.holonRef || !descriptors.taskSpaceId
    || [descriptors.holonRef, descriptors.taskSpaceId].some(
      (descriptor) => !("value" in descriptor!) || !descriptor!.enumerable,
    )) {
    return invalid("EIDOLON_LEGACY_HOLON_TASK_INPUT_INVALID", "Input requires exact holonRef and taskSpaceId fields.")
  }
  const text = (entry: unknown, field: string): string => {
    if (typeof entry !== "string" || !entry || entry !== entry.trim()) {
      return invalid("EIDOLON_LEGACY_HOLON_TASK_INPUT_INVALID", `${field} must be one exact string.`)
    }
    return entry
  }
  return Object.freeze({
    holonRef: text(descriptors.holonRef.value, "holonRef"),
    taskSpaceId: text(descriptors.taskSpaceId.value, "taskSpaceId"),
  })
}

function emptyConfig(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Reflect.ownKeys(value).length !== 0) {
    invalid("EIDOLON_LEGACY_HOLON_TASK_CONFIG_INVALID", "Config must be one closed empty object.")
  }
}

function legacyInventory(actor: AiAgentActor): Readonly<{
  readonly taskIds: readonly string[]
  readonly facts: unknown
}> {
  const state = actor.holonState
  if (state?.governance === "autonomous") {
    const taskIds = Object.keys(state.tasks ?? {}).sort()
    return Object.freeze({
      taskIds: Object.freeze(taskIds),
      facts: Object.freeze({ tasks: state.tasks ?? {}, taskOwnership: state.taskOwnership ?? {} }),
    })
  }
  if (state?.governance === "leader_led") {
    const taskIds = Object.keys(state.routes ?? {}).sort()
    return Object.freeze({ taskIds: Object.freeze(taskIds), facts: Object.freeze({ routes: state.routes ?? {} }) })
  }
  return invalid("EIDOLON_LEGACY_HOLON_ACTOR_INVALID", "Actor is not a legacy Holon actor.")
}

export function isCanonicalHolonTaskAuthority(actor: AiAgentActor | undefined): boolean {
  return actor !== undefined && bindings.has(actor)
}

export function assertLegacyHolonTaskWriteAllowed(actor: AiAgentActor, next: unknown): void {
  if (!bindings.has(actor)) return
  const state = next as { readonly governance?: unknown; readonly tasks?: unknown; readonly taskOwnership?: unknown; readonly routes?: unknown }
  const nonEmpty = (value: unknown): boolean => value !== null && typeof value === "object" && Object.keys(value).length > 0
  if ((state.governance === "autonomous" && (nonEmpty(state.tasks) || nonEmpty(state.taskOwnership)))
    || (state.governance === "leader_led" && nonEmpty(state.routes))) {
    invalid("EIDOLON_LEGACY_HOLON_TASK_AUTHORITY_RETIRED", "Legacy Holon task facts are read-only after canonical TaskSpace adoption.")
  }
}

export async function retireLegacyHolonTaskAuthority(
  runtime: RetireLegacyHolonTaskAuthorityRuntime,
  inputValue: RetireLegacyHolonTaskAuthorityInput,
  config: RetireLegacyHolonTaskAuthorityConfig,
): Promise<LegacyHolonTaskRetirementReceipt> {
  emptyConfig(config)
  const input = exactInput(inputValue)
  if (!runtime || typeof runtime !== "object" || typeof runtime.taskSpaces?.readSnapshot !== "function") {
    return invalid("EIDOLON_LEGACY_HOLON_TASK_RUNTIME_INVALID", "TaskSpace owner port is required.")
  }
  if (runtime.actor.identity?.kind !== "holon" || runtime.actor.identity.holonId !== input.holonRef) {
    return invalid("EIDOLON_LEGACY_HOLON_ACTOR_INVALID", "Actor identity does not match holonRef.")
  }
  const existing = bindings.get(runtime.actor)
  if (existing) {
    if (existing.taskSpaceId !== input.taskSpaceId) {
      return invalid("EIDOLON_LEGACY_HOLON_TASK_RETIREMENT_CONFLICT", "Holon is already bound to another TaskSpace.")
    }
    return existing.receipt
  }
  const snapshot = await runtime.taskSpaces.readSnapshot(input.taskSpaceId)
  if (!snapshot) return invalid("EIDOLON_LEGACY_HOLON_TASK_SPACE_MISSING", "Canonical TaskSpace does not exist.")
  const inventory = legacyInventory(runtime.actor)
  const canonicalTaskIds = new Set(snapshot.tasks.map((task) => task.taskId))
  if (inventory.taskIds.some((taskId) => !canonicalTaskIds.has(taskId))) {
    return invalid("EIDOLON_LEGACY_HOLON_TASK_IMPORT_INCOMPLETE", "Every legacy task must be admitted by TaskSpace before retirement.")
  }
  const receipt = Object.freeze({
    schemaVersion: "eidolon.legacy-holon-task-retirement/v1" as const,
    holonRef: input.holonRef,
    taskSpaceId: input.taskSpaceId,
    acceptedTaskSpaceRevision: snapshot.revision,
    legacyInventoryDigest: canonicalOwnDataDigest(inventory.facts),
    retiredTaskIds: inventory.taskIds,
  })
  const state = runtime.actor.holonState!
  writeHolonGovernance(runtime.actor, state.governance === "autonomous"
    ? { ...state, tasks: {}, taskOwnership: {} }
    : { ...state, routes: {} })
  bindings.set(runtime.actor, Object.freeze({ taskSpaceId: input.taskSpaceId, taskSpaces: runtime.taskSpaces, receipt }))
  return receipt
}

export async function readLegacyHolonTaskCompatibilityView(actor: AiAgentActor): Promise<Readonly<{
  readonly source: "legacy" | "task-space-derived"
  readonly tasks: readonly Readonly<{ readonly taskId: string; readonly status: string; readonly assigneeRef: string | null }>[]
}>> {
  const binding = bindings.get(actor)
  if (!binding) {
    const inventory = legacyInventory(actor)
    return Object.freeze({
      source: "legacy",
      tasks: Object.freeze(inventory.taskIds.map((taskId) => Object.freeze({ taskId, status: "legacy", assigneeRef: null }))),
    })
  }
  const snapshot = await binding.taskSpaces.readSnapshot(binding.taskSpaceId)
  if (!snapshot) return invalid("EIDOLON_LEGACY_HOLON_TASK_SPACE_MISSING", "Retired TaskSpace is no longer readable.")
  return Object.freeze({
    source: "task-space-derived",
    tasks: Object.freeze(snapshot.tasks.map((task) => Object.freeze({
      taskId: task.taskId,
      status: task.status,
      assigneeRef: task.activeClaim?.assigneeRef ?? null,
    }))),
  })
}
