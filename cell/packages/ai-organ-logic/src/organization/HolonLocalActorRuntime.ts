import {
  createLocalActorAddressingRuntime,
  dispatchActor,
  registerActor,
  resolveActor,
  type ActorAddress,
  type ActorRegistrationReceipt,
  type LocalActorAddressingRuntime,
} from "depa-actor"
import {
  assertHolonExecutionBindingFreezeReceipt,
  normalizeHolonExecutionInvocation,
  type ClosedValue,
  type EidolonHolonExecutionBindingFreezeReceipt,
  type EidolonHolonExecutionBindingProjection,
  type HolonExecutionInvocation,
  type HolonMemberExecutionAdapter,
} from "holarchy-eidolon-adapter"
import type { AIAgentSelector } from "ai-workflow-contract"

import type {
  HolonMemberActorOwnerPort,
  HolonMemberSessionOwnerPort,
  HolonTaskAttemptIdentity,
} from "./HolonMemberRuntime"
import type { HolonCoordinatorActorOwnerPort } from "./HolonCoordinator"
import { FileHolonDeploymentRuntimeStore } from "./HolonDeploymentRuntimeStore"

export interface HolonGenericActorOwnerPort {
  ensureActor(input: Readonly<{
    readonly address: ActorAddress
    readonly bindingReceipt: EidolonHolonExecutionBindingFreezeReceipt
  }>): Readonly<{ readonly actorRef: string }> | Promise<Readonly<{ readonly actorRef: string }>>
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

export interface HolonExecutionAdapterInput {
  readonly invocation: HolonExecutionInvocation
  readonly binding: EidolonHolonExecutionBindingProjection
  readonly runtimeRef: string
  readonly sessionRef: string
  readonly taskAttempt: HolonTaskAttemptIdentity
}

export interface HolonExecutionAdapterPort {
  execute(input: HolonExecutionAdapterInput): ClosedValue | Promise<ClosedValue>
}

export interface HolonExecutionAdapterPorts {
  readonly aiAgent: HolonExecutionAdapterPort
  readonly humanEndpoint: HolonExecutionAdapterPort
  readonly service: HolonExecutionAdapterPort
  readonly hybrid: HolonExecutionAdapterPort
}

export interface HolonMemberDispatchResult {
  readonly kind: "holon-member-dispatch-result"
  readonly invocationRef: string
  readonly targetBindingRef: `resource://${string}`
  readonly output: ClosedValue
}

type AddressedInvocation = Readonly<{
  readonly runtimeRef: string
  readonly invocation: HolonExecutionInvocation
}>

export class HolonLocalActorRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "HolonLocalActorRuntimeError"
  }
}

const invalid = (code: string, message: string): never => {
  throw new HolonLocalActorRuntimeError(code, message)
}

function exactString(value: unknown, location: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/.test(value)) {
    return invalid("EIDOLON_HOLON_GENERIC_OWNER_INVALID", `${location} must be one exact string.`)
  }
  return value
}

function address(deploymentId: string, actorKind: "coordinator" | "member", logicalKey: string): ActorAddress {
  return Object.freeze({
    schemaVersion: "depa-actor-address/v1",
    namespace: "eidolon-holon",
    deploymentId,
    actorKind,
    logicalKey,
  })
}

function adapterPort(
  ports: HolonExecutionAdapterPorts,
  adapter: HolonMemberExecutionAdapter,
): HolonExecutionAdapterPort {
  if (adapter.kind === "ai-agent") return ports.aiAgent
  if (adapter.kind === "human-endpoint") return ports.humanEndpoint
  if (adapter.kind === "service") return ports.service
  return ports.hybrid
}

function taskSession(
  sessions: readonly Readonly<Record<string, unknown>>[],
  invocation: HolonExecutionInvocation,
): Readonly<{ readonly sessionRef: string; readonly taskAttempt: HolonTaskAttemptIdentity }> {
  const matches = sessions.filter((session) => session.mode === "task-attempt"
    && session.taskSpaceId === invocation.taskSpaceRef
    && session.taskId === invocation.taskRef
    && session.claimId === invocation.claimRef)
  if (matches.length !== 1) {
    return invalid("EIDOLON_HOLON_TASK_SESSION_UNRESOLVED", "Invocation must resolve one exact generic task-attempt session.")
  }
  const match = matches[0]!
  if (!Number.isSafeInteger(match.attempt) || (match.attempt as number) <= 0) {
    return invalid("EIDOLON_HOLON_TASK_SESSION_UNRESOLVED", "Invocation task-attempt session has no exact attempt identity.")
  }
  return Object.freeze({
    sessionRef: exactString(match.sessionRef, "sessionRef"),
    taskAttempt: Object.freeze({
      taskSpaceId: exactString(match.taskSpaceId, "taskSpaceId"),
      taskId: exactString(match.taskId, "taskId"),
      claimId: exactString(match.claimId, "claimId"),
      attempt: match.attempt as number,
      ...(typeof match.workflowInstanceId === "string"
        ? { workflowInstanceId: exactString(match.workflowInstanceId, "workflowInstanceId") }
        : {}),
      ...(typeof match.runId === "string" ? { runId: exactString(match.runId, "runId") } : {}),
    }),
  })
}

export class EidolonHolonLocalActorRuntime
implements HolonCoordinatorActorOwnerPort, HolonMemberActorOwnerPort, HolonMemberSessionOwnerPort {
  readonly addressing: LocalActorAddressingRuntime<AddressedInvocation, HolonMemberDispatchResult>
  private readonly receipts = new Map<string, ActorRegistrationReceipt>()

  constructor(
    readonly store: FileHolonDeploymentRuntimeStore,
    private readonly genericOwner: HolonGenericActorOwnerPort,
    private readonly adapters: HolonExecutionAdapterPorts,
    runtimeInstanceId = "eidolon-holon-local",
  ) {
    this.addressing = createLocalActorAddressingRuntime({ runtimeInstanceId })
  }

  async ensureCoordinatorActor(input: Parameters<HolonCoordinatorActorOwnerPort["ensureCoordinatorActor"]>[0]) {
    return this.ensureActor(input.deploymentId, "coordinator", input.coordinatorRef, input.bindingReceipt)
  }

  async ensureMemberActor(input: Parameters<HolonMemberActorOwnerPort["ensureMemberActor"]>[0]) {
    return this.ensureActor(input.deploymentId, "member", input.runtimeRef, input.bindingReceipt)
  }

  ensureTaskAttemptSession(input: Parameters<HolonMemberSessionOwnerPort["ensureTaskAttemptSession"]>[0]) {
    return this.genericOwner.ensureTaskAttemptSession(input)
  }

  resolveTargetedAgentSession(input: Parameters<HolonMemberSessionOwnerPort["resolveTargetedAgentSession"]>[0]) {
    return this.genericOwner.resolveTargetedAgentSession(input)
  }

  async recover(deploymentId: string): Promise<void> {
    const snapshot = await this.store.load(deploymentId)
    const definition = await this.store.loadDefinition(deploymentId)
    for (const coordinator of snapshot.coordinators) {
      await this.ensureActor(
        deploymentId,
        "coordinator",
        coordinator.registrationReceipt.address.logicalKey,
        definition.bindingFreezeReceipt,
      )
    }
    for (const member of snapshot.members) {
      await this.ensureActor(deploymentId, "member", member.runtimeRef, definition.bindingFreezeReceipt)
    }
  }

  async dispatchMember(runtimeRef: string, invocationValue: HolonExecutionInvocation): Promise<HolonMemberDispatchResult> {
    const invocation = normalizeHolonExecutionInvocation(invocationValue)
    const deploymentId = this.deploymentFor(runtimeRef)
    const actorAddress = address(deploymentId, "member", exactString(runtimeRef, "runtimeRef"))
    const registration = resolveActor(this.addressing, { byAddress: actorAddress }, {}, {})
    return dispatchActor(this.addressing, { byAddress: actorAddress }, {
      expectedRegistrationId: registration.receipt.registrationId,
      input: Object.freeze({ runtimeRef, invocation }),
    }, {})
  }

  private deploymentFor(runtimeRef: string): string {
    for (const [key, receipt] of this.receipts) {
      if (key.endsWith(`:member:${runtimeRef}`)) return receipt.address.deploymentId
    }
    return invalid("EIDOLON_HOLON_MEMBER_ADDRESS_UNRESOLVED", "MemberRuntime is not registered in this local actor runtime.")
  }

  private async ensureActor(
    deploymentId: string,
    actorKind: "coordinator" | "member",
    logicalKey: string,
    receiptValue: EidolonHolonExecutionBindingFreezeReceipt,
  ): Promise<Readonly<{ readonly actorRef: string; readonly registrationReceipt: ActorRegistrationReceipt }>> {
    const bindingReceipt = assertHolonExecutionBindingFreezeReceipt(receiptValue)
    const actorAddress = address(deploymentId, actorKind, logicalKey)
    const key = `${deploymentId}:${actorKind}:${logicalKey}`
    const existing = this.receipts.get(key)
    const generic = await this.genericOwner.ensureActor({ address: actorAddress, bindingReceipt })
    const actorRef = exactString(generic.actorRef, "genericOwner.actorRef")
    if (existing) return Object.freeze({ actorRef, registrationReceipt: existing })
    const handlerIdentity = actorKind === "member"
      ? "eidolon-holon-member-v1"
      : "eidolon-holon-coordinator-v1"
    const registrationReceipt = registerActor(this.addressing, {
      address: actorAddress,
      ownerSnapshot: Object.freeze({
        schemaVersion: "depa-actor-owner-snapshot/v1" as const,
        ownerRevision: bindingReceipt.registryRevision,
        snapshotReceipt: bindingReceipt.semanticFingerprint,
        registrations: Object.freeze([Object.freeze({ address: actorAddress, handlerIdentity })]),
      }),
      endpoint: Object.freeze({
        handlerIdentity,
        dispatch: async (request: AddressedInvocation) => this.dispatchEndpoint(actorKind, request),
      }),
    }, {})
    this.receipts.set(key, registrationReceipt)
    return Object.freeze({ actorRef, registrationReceipt })
  }

  private async dispatchEndpoint(
    actorKind: "coordinator" | "member",
    request: AddressedInvocation,
  ): Promise<HolonMemberDispatchResult> {
    if (actorKind !== "member") {
      return invalid("EIDOLON_HOLON_COORDINATOR_NOT_EXECUTABLE", "Coordinator actors do not execute Member invocations.")
    }
    const invocation = normalizeHolonExecutionInvocation(request.invocation)
    const deploymentId = this.deploymentFor(request.runtimeRef)
    const runtime = await this.store.load(deploymentId)
    const member = runtime.members.find((value) => value.runtimeRef === request.runtimeRef)
    if (!member) return invalid("EIDOLON_HOLON_MEMBER_RUNTIME_UNRESOLVED", "Deployment has no matching MemberRuntime fact.")
    const definition = await this.store.loadDefinition(deploymentId)
    if (invocation.targetBindingRef !== definition.definition.bindingRef) {
      return invalid("EIDOLON_HOLON_INVOCATION_BINDING_MISMATCH", "Invocation does not target the frozen deployment binding.")
    }
    const allowedMaterials = new Set(definition.bindingProjection.binding.policy.materialRefs)
    if (invocation.materialRefs.some((ref) => !allowedMaterials.has(ref))) {
      return invalid("EIDOLON_HOLON_INVOCATION_MATERIAL_UNAUTHORIZED", "Invocation contains material outside the frozen binding.")
    }
    const session = taskSession(member.sessions as readonly Readonly<Record<string, unknown>>[], invocation)
    const output = await adapterPort(this.adapters, definition.bindingProjection.binding.adapter).execute({
      invocation,
      binding: definition.bindingProjection,
      runtimeRef: request.runtimeRef,
      sessionRef: session.sessionRef,
      taskAttempt: session.taskAttempt,
    })
    return Object.freeze({
      kind: "holon-member-dispatch-result",
      invocationRef: invocation.invocationRef,
      targetBindingRef: invocation.targetBindingRef,
      output,
    })
  }
}
