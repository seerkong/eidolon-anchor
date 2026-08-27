import type {
  RuntimeSnapshotLoadResult,
  RuntimeSnapshotPersistedState,
} from "./RuntimeSnapshotTypes";

export type RuntimeSnapshotMigrationSource = Readonly<{
  sourceVersion: number;
  manifestDigest: string;
  treeDigest: string;
  snapshot: RuntimeSnapshotLoadResult;
}>;

export type RuntimeSnapshotImporter = Readonly<{
  migrationId: string;
  sourceVersion: number;
  targetVersion: number;
  importSnapshot: (
    source: RuntimeSnapshotMigrationSource,
  ) => RuntimeSnapshotPersistedState;
}>;

export type RuntimeSnapshotRepositoryLike<TPersistedState, TManifest, TLoadResult> = {
  readManifest: () => Promise<TManifest | null>;
  writeManifest: (manifest: TManifest) => Promise<void>;
  writeSnapshot: (input: TPersistedState) => Promise<TManifest>;
  loadSnapshot: () => Promise<TLoadResult | null>;
};

export type RuntimeSnapshotRepositoryFactory<TPersistedState, TManifest, TLoadResult> = {
  createRuntimeSnapshotRepository: (
    sessionDir: string,
  ) => RuntimeSnapshotRepositoryLike<TPersistedState, TManifest, TLoadResult>;
};
