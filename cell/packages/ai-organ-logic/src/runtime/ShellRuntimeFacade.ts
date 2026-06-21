import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic"
import type {
  DomainRuntimeVm,
  RuntimeHookDefinition,
} from "@cell/ai-core-contract"
import type { AiAgentOrchestratorDriver as DomainRuntimeDriver } from "../OrchestratorDriver"
import type { RuntimeHookHandlerComponent } from "../hooks/RuntimeHookDispatcher"
import {
  createAiAgentRuntimeCoordinator,
  type AiAgentRuntimeCoordinator as DomainRuntimeCoordinator,
} from "./AiAgentRuntimeCoordinator"
import type {
  ActorWorkContextData,
  ContinuationBaselineData,
} from "@cell/ai-core-contract/runtime/ContextControl"
import { getCoordinationEngine } from "../coordination/CoordinationEngine"
import { getMemberManager } from "../organization/MemberManager"
import { getOrganizationManager } from "../organization/OrganizationManager"
import {
  getActorContinuationBaselineFromVm,
  getActorWorkContextFromVm,
} from "./ContextControlPlane"

export type ShellRuntimeActorIdentity = {
  key: string
  id: string
}

export type ShellRuntimeEventRouting = {
  visibleInTurn: boolean
  notifyAsync: boolean
}

export type ShellRuntimeCoordinationPayload = {
  from?: string
  coordination: string
  kind: string
  requestId: string
  status: string
  decision?: string
}

export type ShellRuntimeDetachedActorDonePayload = {
  taskId: string
  kind: "delegate" | "bash" | "tool_call"
  status: "completed" | "failed" | "cancelled"
  toolCallId?: string
  childFiberId?: string
  childActorKey?: string
  childActorId?: string
  outputText?: string
  error?: string
}

type ShellRuntimeEventBus = {
  emitCoordinationEvent: (
    actor: ShellRuntimeActorIdentity,
    payload: ShellRuntimeCoordinationPayload,
  ) => void
  emitDetachedActorDone: (
    actor: ShellRuntimeActorIdentity,
    payload: ShellRuntimeDetachedActorDonePayload,
  ) => void
}

function getSemanticEventActorIdentity(event: SemanticEvent): ShellRuntimeActorIdentity {
  return {
    key: event.actor.actor_name || event.actor.actor_id,
    id: event.actor.actor_id,
  }
}

function isSemanticEventForActor(event: SemanticEvent, actor: ShellRuntimeActorIdentity): boolean {
  const target = getSemanticEventActorIdentity(event)
  return target.key === actor.key && target.id === actor.id
}

function isDirectWatchedActorEvent(vm: DomainRuntimeVm, event: SemanticEvent): boolean {
  const target = getSemanticEventActorIdentity(event)
  const actor = vm.actors[target.key]
  return !!actor && actor.id === target.id && actor.watchState === "watched"
}

function isWatchedOrganizationProjectionEvent(vm: DomainRuntimeVm, event: SemanticEvent): boolean {
  const target = getSemanticEventActorIdentity(event)
  const holon = getOrganizationManager().resolveHolon(vm, target.key)
  return !!holon && holon.holonId === target.id && holon.watchState === "watched"
}

function isWatchedMemberEventViaOrganization(vm: DomainRuntimeVm, event: SemanticEvent): boolean {
  const target = getSemanticEventActorIdentity(event)
  const member = getMemberManager().findByActor({ vm, actorKey: target.key, actorId: target.id })
  if (!member) return false

  return getOrganizationManager()
    .listHolons(vm)
    .some((holon) => (
      holon.watchState === "watched"
      && (
        holon.governance === "autonomous"
          ? holon.memberIds.includes(member.memberId)
          : holon.leaderMemberId === member.memberId
      )
    ))
}

export type ShellRuntimeFacade = {
  buildCoordinationOutbound: (params: {
    coordination: "plan_approval" | "shutdown"
    kind: string
    payload: Record<string, unknown>
    requestId?: string
  }) => { request_id: string; text: string }
  emitCoordinationEvent: (params: {
    eventBus: ShellRuntimeEventBus
    controlActor: ShellRuntimeActorIdentity
    payload: ShellRuntimeCoordinationPayload
  }) => void
  emitDetachedActorDone: (params: {
    eventBus: ShellRuntimeEventBus
    controlActor: ShellRuntimeActorIdentity
    payload: ShellRuntimeDetachedActorDonePayload
  }) => void
  createRuntimeCoordinator: (params: {
    vm: DomainRuntimeVm
    driver: DomainRuntimeDriver
    saveSnapshot?: () => Promise<void>
    /**
     * P3 (requirement `timed-out-turn-progress-persisted`): pure passthrough of
     * the coordinator's optional seal callback. Production leaves it unset (the
     * coordinator default no-op performs NO timeout seal); live wiring is
     * deferred to the follow-up that also ships the recovery-gate forward-only
     * relay. Retained as the injection seam so the mechanism stays callable.
     */
    sealCompletedProgress?: () => Promise<void>
    hookDefinitions?: readonly RuntimeHookDefinition[]
    hookHandlers?: Readonly<Record<string, RuntimeHookHandlerComponent | undefined>>
  }) => DomainRuntimeCoordinator
  getActorContextControl: (params: {
    vm: DomainRuntimeVm
    actorKey: string
  }) => {
    workContext: ActorWorkContextData | null
    continuationBaseline: ContinuationBaselineData | null
  }
  routeProjectionEvent: (params: {
    vm: DomainRuntimeVm
    controlActor: ShellRuntimeActorIdentity
    event: SemanticEvent
  }) => ShellRuntimeEventRouting
}

export function createShellRuntimeFacade(): ShellRuntimeFacade {
  return {
    buildCoordinationOutbound(params) {
      return params.requestId
        ? getCoordinationEngine().makeOutbound({
            coordination: params.coordination,
            kind: params.kind as any,
            request_id: params.requestId,
            payload: params.payload,
          })
        : getCoordinationEngine().makeOutbound({
            coordination: params.coordination,
            kind: params.kind as any,
            payload: params.payload,
          })
    },
    emitCoordinationEvent(params) {
      params.eventBus.emitCoordinationEvent(params.controlActor, params.payload)
    },
    emitDetachedActorDone(params) {
      params.eventBus.emitDetachedActorDone(params.controlActor, params.payload)
    },
    createRuntimeCoordinator(params) {
      return createAiAgentRuntimeCoordinator(params)
    },
    getActorContextControl(params) {
      return {
        workContext: getActorWorkContextFromVm({
          vm: params.vm as any,
          actorKey: params.actorKey,
        }),
        continuationBaseline: getActorContinuationBaselineFromVm({
          vm: params.vm as any,
          actorKey: params.actorKey,
        }),
      }
    },
    routeProjectionEvent(params) {
      const forControlActor = isSemanticEventForActor(params.event, params.controlActor)
      const forWatchedTarget =
        isDirectWatchedActorEvent(params.vm, params.event)
        || isWatchedOrganizationProjectionEvent(params.vm, params.event)
        || isWatchedMemberEventViaOrganization(params.vm, params.event)

      return {
        visibleInTurn: forControlActor || forWatchedTarget,
        notifyAsync: !forControlActor && forWatchedTarget,
      }
    },
  }
}
