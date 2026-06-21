import type {
  RuntimeAgentLoader,
  RuntimeModelConfigResolverParams,
  RuntimeSupportDescriptor,
} from "@cell/ai-core-contract";
import {
  createLocalFileOrchestrationHistoryEffects,
  LocalFileAgentLoader,
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFilePermissionConfigStore,
  LocalFileRuntimeDerivedIndexesStore,
  LocalFileRuntimeSnapshotRepositoryFactory,
  resolveActorModelConfigFromLocalFiles,
} from "@cell/ai-support";

export function createKernelRuntimeSupportDescriptor(): RuntimeSupportDescriptor {
  return {
    createAgentLoader: (agentsDir): RuntimeAgentLoader => new LocalFileAgentLoader(agentsDir),
    resolveActorModelConfig: (params: RuntimeModelConfigResolverParams) =>
      resolveActorModelConfigFromLocalFiles(params),
    createOrchestrationHistoryEffects: (params) => createLocalFileOrchestrationHistoryEffects(params),
    permissionConfigStore: LocalFilePermissionConfigStore,
    persistence: {
      snapshotRepositoryFactory: LocalFileRuntimeSnapshotRepositoryFactory,
      derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore,
      conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
    },
  };
}
