import type {
  CoordinatorWriterAdapter,
  CoordinatorWriterAdapterId,
} from "@cell/ai-core-contract"

/**
 * Coordinator writer adapters are wired by enum id. The file-store writer is
 * registered by the composer at composition time; tests may register an
 * in-memory writer. Core logic only resolves by the id carried in config.
 */

const COORDINATOR_WRITER_ADAPTERS = new Map<CoordinatorWriterAdapterId, CoordinatorWriterAdapter>()

export function registerCoordinatorWriterAdapter(
  adapterId: CoordinatorWriterAdapterId,
  adapter: CoordinatorWriterAdapter,
): void {
  COORDINATOR_WRITER_ADAPTERS.set(adapterId, adapter)
}

export function resolveCoordinatorWriterAdapter(
  adapterId: CoordinatorWriterAdapterId,
): CoordinatorWriterAdapter {
  const adapter = COORDINATOR_WRITER_ADAPTERS.get(adapterId)
  if (!adapter) {
    const registered = [...COORDINATOR_WRITER_ADAPTERS.keys()].join(", ") || "none"
    throw new Error(`unknown coordinator writer adapter: ${adapterId} (registered: ${registered})`)
  }
  return adapter
}
