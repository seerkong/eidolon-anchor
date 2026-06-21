import type {
  AiRuntimeEnginePortAdapterId,
  EnginePortAdapter,
} from "@cell/ai-runtime-control-contract"

/**
 * Engine port adapters are wired by enum id. Support/composer packages
 * register their implementations at composition time; the core logic only
 * resolves by the id carried in the capsule config.
 */

const ENGINE_PORT_ADAPTERS = new Map<AiRuntimeEnginePortAdapterId, EnginePortAdapter>()

export function registerEnginePortAdapter(
  adapterId: AiRuntimeEnginePortAdapterId,
  adapter: EnginePortAdapter,
): void {
  ENGINE_PORT_ADAPTERS.set(adapterId, adapter)
}

export function resolveEnginePortAdapter(adapterId: AiRuntimeEnginePortAdapterId): EnginePortAdapter {
  const adapter = ENGINE_PORT_ADAPTERS.get(adapterId)
  if (!adapter) {
    const registered = [...ENGINE_PORT_ADAPTERS.keys()].join(", ") || "none"
    throw new Error(`unknown engine port adapter: ${adapterId} (registered: ${registered})`)
  }
  return adapter
}
