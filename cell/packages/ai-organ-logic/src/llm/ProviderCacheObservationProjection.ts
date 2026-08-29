import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime"
import type { ProviderCacheCostObservation } from "@cell/ai-organ-contract/llm/ProviderCacheCostObservation"

const OBSERVATIONS = new WeakMap<AiAgentVm, ProviderCacheCostObservation[]>()

function projectedObservation(value: unknown): ProviderCacheCostObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const observation = (value as Record<string, unknown>).provider_cache_cost_observation
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) return null
  if ((observation as Record<string, unknown>).identity === undefined) return null
  if ((observation as Record<string, unknown>).tokenBreakdown === undefined) return null
  return structuredClone(observation) as ProviderCacheCostObservation
}

/** Records the redacted canonical final-wire/cache observation for one completed provider call. */
export function recordProviderCacheObservationProjection(vm: AiAgentVm, providerOutput: unknown): void {
  const observation = projectedObservation(providerOutput)
  if (!observation) return
  const entries = OBSERVATIONS.get(vm) ?? []
  entries.push(Object.freeze(observation))
  OBSERVATIONS.set(vm, entries)
}

/** Public, read-only observation projection; request contents are never present. */
export function readProviderCacheObservationProjection(vm: AiAgentVm): readonly ProviderCacheCostObservation[] {
  return Object.freeze([...(OBSERVATIONS.get(vm) ?? [])])
}
