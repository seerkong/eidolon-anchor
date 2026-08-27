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
  resolveActorModelConfigFromLocalFiles,
} from "@cell/ai-support";
import path from "node:path";
import { createWorkflowLifecycleSnapshotImporter } from "@cell/ai-organ-logic/workflow/runtime/WorkflowLifecycleFacet";
import { LocalFileRuntimeSnapshotRepository } from "@cell/ai-support";

export function createKernelRuntimeSupportDescriptor(): RuntimeSupportDescriptor {
  return {
    createAgentLoader: (agentsDir): RuntimeAgentLoader => new LocalFileAgentLoader(agentsDir),
    resolveActorModelConfig: (params: RuntimeModelConfigResolverParams) =>
      resolveActorModelConfigFromLocalFiles(params),
    createOrchestrationHistoryEffects: (params) => createLocalFileOrchestrationHistoryEffects(params),
    permissionConfigStore: LocalFilePermissionConfigStore,
    persistence: {
      snapshotRepositoryFactory: {
        createRuntimeSnapshotRepository(sessionDir) {
          return new LocalFileRuntimeSnapshotRepository(path.join(sessionDir, "runtime_state"), {
            importers: [createWorkflowLifecycleSnapshotImporter()],
          });
        },
      },
      derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore,
      conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
    },
  };
}
