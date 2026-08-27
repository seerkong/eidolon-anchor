import type { ProviderCacheActorClass } from "@cell/ai-organ-contract/llm/ProviderCacheCostObservation"
import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"

import { readWorkflowLifecycleFacet } from "../workflow/runtime/WorkflowLifecycleFacet"
import { hasExactWorkflowNodeActorOrigin } from "../workflow/runtime/WorkflowNodeActorAdmission"

/** Domain-owned attribution; generic Actor identity and names have no authority. */
export function resolveProviderCacheActorClass(
  actor: Pick<AiAgentActor, "origin" | "runtimeFacets">,
): ProviderCacheActorClass {
  const lifecycle = readWorkflowLifecycleFacet(actor)
  const node = hasExactWorkflowNodeActorOrigin(actor)
  if (lifecycle && node) {
    throw new Error("PROVIDER_CACHE_ACTOR_ATTRIBUTION_CONFLICT: lifecycle capability and node origin overlap")
  }
  if (lifecycle) return "workflow_lifecycle"
  if (node) return "workflow_node"
  if (actor.origin) {
    throw new Error("PROVIDER_CACHE_ACTOR_ATTRIBUTION_UNKNOWN: unrecognized Actor origin")
  }
  return "ordinary"
}
