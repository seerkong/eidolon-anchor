import { createHash } from "node:crypto"

import {
  parseActorRegistrationReceipt,
  type ActorRegistrationReceipt,
} from "depa-actor"
import { normalizeAIAgentSelector } from "ai-workflow-logic"
import type { AIAgentSelector } from "ai-workflow-contract"
import {
  assertHolonExecutionBindingFreezeReceipt,
  type EidolonHolonExecutionBindingFreezeReceipt,
  type HolonGenericSessionRef,
  type HolonMemberRuntimeIsolation,
  type HolonMemberRuntimeLifecycleFact,
} from "holarchy-eidolon-adapter"

import {
  FileHolonDeploymentRuntimeStore,
  normalizeHolonDeploymentRuntimeSnapshot,
} from "./HolonDeploymentRuntimeStore"

export interface HolonTaskAttemptIdentity {
  readonly taskSpaceId: string
  readonly taskId: string
  readonly claimId: string
  readonly attempt: number
  readonly workflowInstanceId?: string
  readonly runId?: string
}

export type HolonMemberSessionPolicy =
  | Readonly<{ readonly mode: "task-attempt" }>
  | Readonly<{ readonly mode: "targeted-agent-instance"; readonly selector: AIAgentSelector }>

export interface EnsureHolonMemberRuntimeInput {
  readonly deploymentId: string
  readonly bindingRef: `resource://${string}`
  readonly holonRef: string
  readonly memberRef: string
  readonly runtime?: HolonMemberRuntimeIsolation
  readonly taskAttempt: HolonTaskAttemptIdentity
  readonly session: HolonMemberSessionPolicy
}

export interface HolonMemberActorOwnerPort {
  ensureMemberActor(input: Readonly<{
    readonly deploymentId: string
    readonly holonRef: string
    readonly memberRef: string
    readonly runtimeRef: string
    readonly bindingReceipt: EidolonHolonExecutionBindingFreezeReceipt
  }>): Readonly<{
    readonly actorRef: string
    readonly registrationReceipt: ActorRegistrationReceipt
  }> | Promise<Readonly<{
    readonly actorRef: string
    readonly registrationReceipt: ActorRegistrationReceipt
  }>>
}

export interface HolonMemberSessionOwnerPort {
  ensureTaskAttemptSession(input: Readonly<{
    readonly deploymentId: string
    readonly runtimeRef: string
    readonly scopeRef: string
    readonly taskAttempt: HolonTaskAttemptIdentity
  }>): Readonly<{ readonly sessionRef: string }> | Promise<Readonly<{ readonly sessionRef: string }>>
  resolveTargetedAgentSession(input: Readonly<{
    readonly deploymentId: string
    readonly runtimeRef: string
    readonly selector: AIAgentSelector
    readonly bindingReceipt: EidolonHolonExecutionBindingFreezeReceipt
  }>): Readonly<{
    readonly sessionRef: string
    readonly agentDefinitionRef: `resource://${string}`
  }> | Promise<Readonly<{
    readonly sessionRef: string
    readonly agentDefinitionRef: `resource://${string}`
  }>>
}

export interface HolonMemberRuntimeProcessorRuntime {
  readonly store: FileHolonDeploymentRuntimeStore
  readonly actorOwner: HolonMemberActorOwnerPort
  readonly sessions: HolonMemberSessionOwnerPort
}

export type HolonMemberRuntimeProcessorConfig = Readonly<Record<string, never>>

export interface EnsuredHolonMemberRuntime {
  readonly runtimeRef: string
  readonly actorRef: string
  readonly sessionRef: string
  readonly registrationReceipt: ActorRegistrationReceipt
  readonly reusedRuntime: boolean
}

export class HolonMemberRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "HolonMemberRuntimeError"
  }
}

const invalid = (code: string, message: string): never => {
  throw new HolonMemberRuntimeError(code, message)
}

function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  location: string,
): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return invalid("EIDOLON_HOLON_MEMBER_INPUT_INVALID", `${location} must be one plain object.`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const allowed = new Set([...required, ...optional])
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))
    || required.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key))) {
    return invalid("EIDOLON_HOLON_MEMBER_INPUT_INVALID", `${location} has missing or unsupported fields.`)
  }
  const output: Record<string, unknown> = Object.create(null)
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      return invalid("EIDOLON_HOLON_MEMBER_INPUT_INVALID", `${location}.${key} must be enumerable own data.`)
    }
    output[key] = descriptor.value
  }
  return output
}

function text(value: unknown, location: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/.test(value)) {
    return invalid("EIDOLON_HOLON_MEMBER_INPUT_INVALID", `${location} must be one exact string.`)
  }
  return value
}

function resourceRef(value: unknown, location: string): `resource://${string}` {
  const exact = text(value, location)
  if (!exact.startsWith("resource://") || !exact.slice("resource://".length)
    || exact.slice("resource://".length).includes("://")) {
    return invalid("EIDOLON_HOLON_MEMBER_INPUT_INVALID", `${location} must be one exact resource:// identity.`)
  }
  return exact as `resource://${string}`
}

function emptyConfig(value: unknown): void {
  record(value, [], [], "config")
}

function taskAttempt(value: unknown): HolonTaskAttemptIdentity {
  const input = record(
    value,
    ["taskSpaceId", "taskId", "claimId", "attempt"],
    ["workflowInstanceId", "runId"],
    "taskAttempt",
  )
  if (!Number.isSafeInteger(input.attempt) || (input.attempt as number) <= 0) {
    return invalid("EIDOLON_HOLON_MEMBER_INPUT_INVALID", "taskAttempt.attempt must be one positive safe integer.")
  }
  return Object.freeze({
    taskSpaceId: text(input.taskSpaceId, "taskAttempt.taskSpaceId"),
    taskId: text(input.taskId, "taskAttempt.taskId"),
    claimId: text(input.claimId, "taskAttempt.claimId"),
    attempt: input.attempt as number,
    ...(input.workflowInstanceId === undefined
      ? {}
      : { workflowInstanceId: text(input.workflowInstanceId, "taskAttempt.workflowInstanceId") }),
    ...(input.runId === undefined ? {} : { runId: text(input.runId, "taskAttempt.runId") }),
  })
}

function runtimePolicy(value: unknown): HolonMemberRuntimeIsolation {
  const input = record(value, ["mode"], ["scope", "isolationKey"], "runtime")
  if (input.mode === "shared") {
    if (Reflect.ownKeys(input).length !== 1) {
      return invalid("EIDOLON_HOLON_MEMBER_INPUT_INVALID", "Shared runtime policy has no additional fields.")
    }
    return Object.freeze({ mode: "shared" })
  }
  if (input.mode === "isolated") {
    if (Reflect.ownKeys(input).length !== 3
      || (input.scope !== "task-space" && input.scope !== "workflow-run")) {
      return invalid("EIDOLON_HOLON_MEMBER_INPUT_INVALID", "Isolated runtime requires exact scope and isolationKey.")
    }
    return Object.freeze({
      mode: "isolated",
      scope: input.scope,
      isolationKey: text(input.isolationKey, "runtime.isolationKey"),
    })
  }
  return invalid("EIDOLON_HOLON_MEMBER_INPUT_INVALID", "runtime.mode must be shared | isolated.")
}

function sessionPolicy(value: unknown): HolonMemberSessionPolicy {
  const input = record(value, ["mode"], ["selector"], "session")
  if (input.mode === "task-attempt") {
    if (Reflect.ownKeys(input).length !== 1) {
      return invalid("EIDOLON_HOLON_MEMBER_INPUT_INVALID", "Task-attempt session has no selector.")
    }
    return Object.freeze({ mode: "task-attempt" })
  }
  if (input.mode === "targeted-agent-instance") {
    if (Reflect.ownKeys(input).length !== 2) {
      return invalid("EIDOLON_HOLON_MEMBER_INPUT_INVALID", "Targeted Agent session requires one selector.")
    }
    try {
      return Object.freeze({ mode: "targeted-agent-instance", selector: normalizeAIAgentSelector(input.selector) })
    } catch (error) {
      return invalid(
        "EIDOLON_HOLON_MEMBER_SELECTOR_INVALID",
        error instanceof Error ? error.message : "Invalid targeted Agent selector.",
      )
    }
  }
  return invalid("EIDOLON_HOLON_MEMBER_INPUT_INVALID", "session.mode is invalid.")
}

function normalizeInput(value: unknown): Required<Omit<EnsureHolonMemberRuntimeInput, "runtime">> & {
  readonly runtime: HolonMemberRuntimeIsolation
} {
  const input = record(
    value,
    ["deploymentId", "bindingRef", "holonRef", "memberRef", "taskAttempt", "session"],
    ["runtime"],
    "input",
  )
  return Object.freeze({
    deploymentId: text(input.deploymentId, "input.deploymentId"),
    bindingRef: resourceRef(input.bindingRef, "input.bindingRef"),
    holonRef: text(input.holonRef, "input.holonRef"),
    memberRef: text(input.memberRef, "input.memberRef"),
    runtime: input.runtime === undefined ? Object.freeze({ mode: "shared" as const }) : runtimePolicy(input.runtime),
    taskAttempt: taskAttempt(input.taskAttempt),
    session: sessionPolicy(input.session),
  })
}

function stableRuntimeRef(input: {
  readonly deploymentId: string
  readonly memberRef: string
  readonly runtime: HolonMemberRuntimeIsolation
}): string {
  const fingerprint = createHash("sha256").update(JSON.stringify([
    input.deploymentId,
    input.memberRef,
    input.runtime,
  ])).digest("hex").slice(0, 32)
  return `member-${fingerprint}`
}

export function holonMemberRuntimeRef(inputValue: Readonly<{
  readonly deploymentId: string
  readonly memberRef: string
  readonly runtime?: HolonMemberRuntimeIsolation
}>): string {
  const input = record(inputValue, ["deploymentId", "memberRef"], ["runtime"], "input")
  return stableRuntimeRef({
    deploymentId: text(input.deploymentId, "input.deploymentId"),
    memberRef: text(input.memberRef, "input.memberRef"),
    runtime: input.runtime === undefined
      ? Object.freeze({ mode: "shared" as const })
      : runtimePolicy(input.runtime),
  })
}

function taskSessionIdentity(value: HolonTaskAttemptIdentity): string {
  return JSON.stringify([value.taskSpaceId, value.taskId, value.claimId, value.attempt])
}

function sessionIdentity(value: HolonGenericSessionRef): string {
  return value.mode === "task-attempt"
    ? taskSessionIdentity(value)
    : JSON.stringify(value.selector)
}

function scopeRef(value: HolonTaskAttemptIdentity): string {
  return `task-attempt-${createHash("sha256").update(taskSessionIdentity(value)).digest("hex")}`
}

function memberBelongsToHolon(snapshot: { readonly records: readonly unknown[] }, memberRef: string, holonRef: string): boolean {
  const records = snapshot.records as readonly Record<string, unknown>[]
  const member = records.find((entry) => entry.kind === "Member" && entry.id === memberRef)
  const holon = records.find((entry) => entry.kind === "Holon" && entry.id === holonRef)
  if (!member || !holon || typeof member.subjectId !== "string") return false
  return records.some((entry) => entry.kind === "HolonMembershipVersion"
    && entry.subjectId === member.subjectId
    && entry.parentHolonId === holonRef
    && entry.effectiveState === true)
}

async function exactActor(
  owner: HolonMemberActorOwnerPort,
  input: Parameters<HolonMemberActorOwnerPort["ensureMemberActor"]>[0],
): Promise<Readonly<{ readonly actorRef: string; readonly registrationReceipt: ActorRegistrationReceipt }>> {
  const output = await owner.ensureMemberActor(input)
  const parsed = record(output, ["actorRef", "registrationReceipt"], [], "actorOwner.output")
  const actorRef = text(parsed.actorRef, "actorOwner.output.actorRef")
  const registrationReceipt = parseActorRegistrationReceipt(parsed.registrationReceipt)
  if (registrationReceipt.address.deploymentId !== input.deploymentId
    || registrationReceipt.address.actorKind !== "member"
    || registrationReceipt.address.logicalKey !== input.runtimeRef) {
    return invalid("EIDOLON_HOLON_MEMBER_ACTOR_RECEIPT_MISMATCH", "Actor registration receipt does not match the requested MemberRuntime.")
  }
  return Object.freeze({ actorRef, registrationReceipt })
}

function exactSessionOutput(value: unknown, targeted: boolean): {
  readonly sessionRef: string
  readonly agentDefinitionRef?: `resource://${string}`
} {
  const output = record(
    value,
    targeted ? ["sessionRef", "agentDefinitionRef"] : ["sessionRef"],
    [],
    "sessionOwner.output",
  )
  return Object.freeze({
    sessionRef: text(output.sessionRef, "sessionOwner.output.sessionRef"),
    ...(targeted ? { agentDefinitionRef: resourceRef(output.agentDefinitionRef, "sessionOwner.output.agentDefinitionRef") } : {}),
  })
}

export async function ensureHolonMemberRuntime(
  runtime: HolonMemberRuntimeProcessorRuntime,
  inputValue: EnsureHolonMemberRuntimeInput,
  config: HolonMemberRuntimeProcessorConfig,
): Promise<EnsuredHolonMemberRuntime> {
  emptyConfig(config)
  const input = normalizeInput(inputValue)
  if (!runtime || typeof runtime !== "object" || !(runtime.store instanceof FileHolonDeploymentRuntimeStore)
    || typeof runtime.actorOwner?.ensureMemberActor !== "function"
    || typeof runtime.sessions?.ensureTaskAttemptSession !== "function"
    || typeof runtime.sessions?.resolveTargetedAgentSession !== "function") {
    return invalid("EIDOLON_HOLON_MEMBER_RUNTIME_INVALID", "MemberRuntime processor ports are incomplete.")
  }
  const deployment = await runtime.store.loadDefinition(input.deploymentId)
  if (deployment.definition.bindingRef !== input.bindingRef) {
    return invalid("EIDOLON_HOLON_MEMBER_BINDING_MISMATCH", "Invocation binding is not the deployment's frozen binding.")
  }
  const bindingReceipt = assertHolonExecutionBindingFreezeReceipt(deployment.bindingFreezeReceipt)
  if (!memberBelongsToHolon(deployment.bindingProjection.snapshot, input.memberRef, input.holonRef)) {
    return invalid("EIDOLON_HOLON_MEMBER_NOT_IN_SNAPSHOT", "Member is not an effective member of the requested frozen Holon.")
  }
  if (deployment.bindingProjection.binding.target.kind === "member"
    && deployment.bindingProjection.binding.target.memberRef !== input.memberRef) {
    return invalid("EIDOLON_HOLON_MEMBER_BINDING_TARGET_MISMATCH", "Member binding cannot select a different Member.")
  }
  const authorizedRuntime = deployment.bindingProjection.binding.policy.runtime.mode
  if (input.runtime.mode === "isolated" && authorizedRuntime !== "isolated-task-runtime") {
    return invalid("EIDOLON_HOLON_MEMBER_ISOLATION_UNAUTHORIZED", "Frozen binding does not authorize isolation.")
  }
  if (input.runtime.mode === "shared" && authorizedRuntime === "isolated-task-runtime") {
    return invalid("EIDOLON_HOLON_MEMBER_ISOLATION_REQUIRED", "Frozen binding requires an explicit isolated runtime policy.")
  }
  if (input.session.mode === "targeted-agent-instance" && bindingReceipt.agentProofs.length === 0) {
    return invalid("EIDOLON_HOLON_MEMBER_TARGETED_AGENT_UNAUTHORIZED", "Frozen binding has no Agent proof for targeted continuity.")
  }
  const runtimeRef = stableRuntimeRef(input)

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await runtime.store.load(input.deploymentId)
    const existing = current.members.find((candidate) => candidate.runtimeRef === runtimeRef)
    const actor = existing ?? await exactActor(runtime.actorOwner, {
      deploymentId: input.deploymentId,
      holonRef: input.holonRef,
      memberRef: input.memberRef,
      runtimeRef,
      bindingReceipt,
    })
    const desiredSessionIdentity = input.session.mode === "task-attempt"
      ? taskSessionIdentity(input.taskAttempt)
      : JSON.stringify(input.session.selector)
    const existingSession = existing?.sessions.find(
      (candidate) => sessionIdentity(candidate) === desiredSessionIdentity,
    )
    let sessionFact: HolonGenericSessionRef
    if (existingSession) {
      sessionFact = existingSession
    } else if (input.session.mode === "task-attempt") {
      const created = exactSessionOutput(await runtime.sessions.ensureTaskAttemptSession({
        deploymentId: input.deploymentId,
        runtimeRef,
        scopeRef: scopeRef(input.taskAttempt),
        taskAttempt: input.taskAttempt,
      }), false)
      sessionFact = Object.freeze({
        mode: "task-attempt",
        ...input.taskAttempt,
        sessionRef: created.sessionRef,
      })
    } else {
      const created = exactSessionOutput(await runtime.sessions.resolveTargetedAgentSession({
        deploymentId: input.deploymentId,
        runtimeRef,
        selector: input.session.selector,
        bindingReceipt,
      }), true)
      if (!bindingReceipt.agentProofs.some(
        (proof) => proof.agentDefinitionRef === created.agentDefinitionRef,
      )) {
        return invalid("EIDOLON_HOLON_MEMBER_TARGETED_AGENT_UNAUTHORIZED", "Resolved Agent is outside the frozen binding proof.")
      }
      sessionFact = Object.freeze({
        mode: "targeted-agent-instance",
        selector: input.session.selector,
        sessionRef: created.sessionRef,
      })
    }
    if (existingSession) {
      return Object.freeze({
        runtimeRef,
        actorRef: existing!.actorRef,
        sessionRef: existingSession.sessionRef,
        registrationReceipt: existing!.registrationReceipt,
        reusedRuntime: true,
      })
    }
    const member: HolonMemberRuntimeLifecycleFact = existing
      ? Object.freeze({ ...existing, sessions: Object.freeze([...existing.sessions, sessionFact]) })
      : Object.freeze({
          runtimeRef,
          holonRef: input.holonRef,
          memberRef: input.memberRef,
          isolation: input.runtime,
          status: "ready",
          actorRef: actor.actorRef,
          registrationReceipt: actor.registrationReceipt,
          sessions: Object.freeze([sessionFact]),
        })
    const members = existing
      ? current.members.map((candidate) => candidate.runtimeRef === runtimeRef ? member : candidate)
      : [...current.members, member]
    const next = normalizeHolonDeploymentRuntimeSnapshot({
      ...current,
      revision: current.revision + 1,
      members,
    })
    try {
      await runtime.store.commit({
        deploymentId: input.deploymentId,
        expectedRevision: current.revision,
        next,
      })
      return Object.freeze({
        runtimeRef,
        actorRef: member.actorRef,
        sessionRef: sessionFact.sessionRef,
        registrationReceipt: member.registrationReceipt,
        reusedRuntime: existing !== undefined,
      })
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("CAS_CONFLICT")) throw error
    }
  }
  return invalid("EIDOLON_HOLON_MEMBER_CAS_EXHAUSTED", "MemberRuntime admission did not converge.")
}
