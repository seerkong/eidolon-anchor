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
