/**
 * RuntimePersistenceIo — the pure-I/O persistence routing for the
 * persistent-session-backplane (track refactor-persistent-session-backplane,
 * P2 seam / decision D1).
 *
 * THE P2 SEAM
 * -----------
 * `ai-organ-logic/src/persistence/RuntimeSnapshots.ts` co-located two concerns
 * that have opposite dependency directions:
 *
 *   1. pure persistence I/O — "where do the bytes come from / go to": the
 *      snapshot repository, the derived-index store and the conversation
 *      persistence repository. These only touch *contracts*
 *      (@cell/ai-core-contract, @cell/ai-organ-contract), never the live
 *      runtime.
 *
 *   2. runtime orchestration — gather-the-durable-subset-from-the-live-runtime
 *      (save) and reconstruct-the-live-runtime-from-a-payload (recover). These
 *      deeply import ai-organ-logic internals (executor, orchestrator driver,
 *      coordination/member/detached registries, conversation domain runtime).
 *
 * A wholesale move of RuntimeSnapshots.ts would create a cycle
 * (new-package -> ai-organ-logic -> new-package). So the seam is cut at the
 * pure-I/O routing layer: this module owns the {@link RuntimePersistenceSupport}
 * registry plus every thin accessor that resolves an injected factory into a
 * concrete repository / store / repo handle. The runtime-orchestration
 * functions stay in ai-organ-logic and CONSUME this module.
 *
 * This module has NO dependency on @cell/ai-organ-logic.
 */
import type { RuntimeSnapshotRepositoryFactory } from "@cell/ai-core-contract/runtime/RuntimeSnapshotStore";
import type {
  RuntimeSnapshotLoadResult,
  RuntimeSnapshotManifest,
  RuntimeSnapshotPersistedState,
} from "@cell/ai-core-contract/runtime/RuntimeSnapshotTypes";
import type { ConversationPersistenceRepositoryFactory } from "@cell/ai-organ-contract/persistence/conversation/ConversationPersistence";
import type {
  RuntimeDerivedIndexes,
  RuntimeDerivedIndexesStore,
} from "@cell/ai-organ-contract/persistence/RuntimeDerivedIndexes";

/**
 * The injected persistence capability set. Holds the concrete byte-level I/O
 * factories (file-backed in production, supplied by the runtime composition /
 * tests). The backplane never constructs these itself — they are explicitly
 * configured via {@link configureRuntimePersistenceSupport}.
 */
export type RuntimePersistenceSupport = {
  snapshotRepositoryFactory: RuntimeSnapshotRepositoryFactory<
    RuntimeSnapshotPersistedState,
    RuntimeSnapshotManifest,
    RuntimeSnapshotLoadResult
  >;
  derivedIndexesStore: RuntimeDerivedIndexesStore;
  conversationPersistenceRepositoryFactory?: ConversationPersistenceRepositoryFactory;
};

let configuredRuntimePersistenceSupport: RuntimePersistenceSupport | null = null;

/**
 * Resolve the configured persistence support, or throw if the runtime has not
 * injected one yet. This is the single read point for every I/O accessor below.
 */
export function getRuntimePersistenceSupport(): RuntimePersistenceSupport {
  if (configuredRuntimePersistenceSupport) {
    return configuredRuntimePersistenceSupport;
  }
  throw new Error("runtime persistence support is not configured");
}

/** Explicitly inject the persistence capability set (runtime composition / tests). */
export function configureRuntimePersistenceSupport(support: RuntimePersistenceSupport): void {
  configuredRuntimePersistenceSupport = support;
}

/** Derived-projection-cache files written alongside a checkpoint snapshot. */
export const DERIVED_INDEX_FILES = [
  "indexes/memberRoster.json",
  "indexes/detachedActors.json",
  "indexes/coordinationRecords.json",
] as const;

/** Resolve the snapshot repository for a session directory (pure I/O handle). */
export function getRuntimeSnapshotRepository(sessionDir: string) {
  return getRuntimePersistenceSupport().snapshotRepositoryFactory.createRuntimeSnapshotRepository(
    sessionDir,
  );
}

/**
 * Pure file-existence check: whether a session directory has a recoverable
 * checkpoint snapshot manifest. Does not touch the live runtime.
 */
export async function hasRuntimeSnapshot(sessionDir: string): Promise<boolean> {
  const manifest = await getRuntimeSnapshotRepository(sessionDir).readManifest();
  return !!manifest;
}

/** Write the derived-projection-cache indexes for a session (pure I/O). */
export async function writeDerivedIndexes(
  sessionDir: string,
  indexes: RuntimeDerivedIndexes,
): Promise<void> {
  await getRuntimePersistenceSupport().derivedIndexesStore.write({
    sessionDir,
    indexes,
  });
}

/** Load the derived-projection-cache indexes for a session (pure I/O). */
export async function loadDerivedIndexes(sessionDir: string): Promise<RuntimeDerivedIndexes> {
  return await getRuntimePersistenceSupport().derivedIndexesStore.load({ sessionDir });
}

/**
 * Resolve the file-backed conversation-persistence repository for a session, or
 * `null` when no factory was injected (memory-only profile). Pure I/O handle —
 * the runtime drives reads/writes through it.
 */
export function getConversationPersistenceRepository(sessionDir: string) {
  return (
    getRuntimePersistenceSupport().conversationPersistenceRepositoryFactory?.createRepository(
      sessionDir,
    ) ?? null
  );
}

/**
 * Structural guard on a deserialized snapshot payload: a recovered manifest +
 * vm must both declare a control-actor key. This is the byte-level
 * deserialize-side shape assertion (no live-runtime knowledge), so it lives
 * with the reader I/O.
 */
export function assertSupportedSnapshotShape(loaded: {
  manifest: Record<string, unknown>;
  vm: Record<string, unknown>;
}): void {
  if (typeof loaded.manifest.controlActorKey !== "string" || !loaded.manifest.controlActorKey) {
    throw new Error("invalid_runtime_snapshot: manifest is missing controlActorKey");
  }
  if (typeof loaded.vm.controlActorKey !== "string" || !loaded.vm.controlActorKey) {
    throw new Error("invalid_runtime_snapshot: vm is missing controlActorKey");
  }
}
