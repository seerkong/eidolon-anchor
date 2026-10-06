import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime"
import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import type { RuntimeEffects } from "@cell/ai-core-contract/runtime/AiAgentVm"
import type { ActorSummary } from "@cell/ai-runtime-host-contract"
import { HostProtocolFailure } from "@cell/ai-runtime-host-logic"
import { retireObservationActors, type ObservationRuntime } from "@cell/ai-runtime-host-logic"

function failure(status: number, code: string): never {
  throw new HostProtocolFailure(status, { code, requestId: "actor-registration", retryable: false })
}
/** Identity never changes the execution kind, including a restored control actor. */
export function hostActorExecutionKind(actor: Pick<AiAgentActor, "type">): ActorSummary["executionKind"] {
  switch (actor.type) {
    case "primary": case "interactive": case "delegate": case "detached": return actor.type
    default: return failure(422, "unsupported_actor_kind")
  }
}

export function createHostActorLifecycle(options: {
  vm: AiAgentVm; observations: ObservationRuntime; actorViews: Map<string, ActorSummary>; maxActors?: number
}) {
  const reconcile = (): string[] => {
    const live = new Set(Object.values(options.vm.actors).map(actor => actor.id))
    const retired = retireObservationActors(options.observations, live)
    for (const id of retired) options.actorViews.delete(id)
    return retired
  }
  const beforeRegister: NonNullable<RuntimeEffects["actorRegistration"]>["beforeRegister"] = candidate => {
    if (candidate.identity) return failure(403, "organization_creation_unsupported")
    if (!["primary", "interactive", "delegate", "detached"].includes(candidate.actorType)) return failure(422, "unsupported_actor_kind")
    reconcile()
    const live = Object.values(options.vm.actors)
    if (options.vm.actors[candidate.actorKey] || options.vm.actorRuntime.has(candidate.actorKey) || live.some(actor => actor.id === candidate.actorId)) return failure(409, "actor_identity_conflict")
    const retained = new Set([...live.map(actor => actor.id), ...options.observations.state.projection.actors.keys()])
    if (retained.size >= (options.maxActors ?? 64)) return failure(429, "actor_capacity")
  }
  return { beforeRegister, reconcile }
}
