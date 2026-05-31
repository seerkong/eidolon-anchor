import fs from "node:fs";
import path from "node:path";

import { AgentEventGraph, createActor, createVM, ensureVmRuntimeContext } from "@cell/ai-core-logic";
import type { ActorModelConfig } from "@cell/ai-core-logic/runtime/actor";
import type {
  DomainRuntimeVm,
  RuntimeRegistries,
  RuntimeSupportDescriptor,
} from "@cell/ai-core-contract";
import {
  createAiAgentOrchestratorDriverWithCooperative,
} from "../OrchestratorDriver";
import { configureLocalPermissionConfigStore } from "../permissions/LocalPermissionConfig";
import {
  configureRuntimePersistenceSupport,
  hasRuntimeSnapshot,
  recoverAiAgentRuntime,
  saveAiAgentRuntimeSnapshot,
} from "../persistence/RuntimeSnapshots";

export type ShellRuntimePaths = {
  WORKDIR: string;
  EIDOLON_DIR: string;
  AGENTS_DIR: string;
  MCP_DIR: string;
};

export type ShellRuntimeEffects = {
  messageHistoryEffect: ReturnType<RuntimeSupportDescriptor["createMessageHistoryEffects"]>;
  orchestrationHistoryEffect: ReturnType<RuntimeSupportDescriptor["createOrchestrationHistoryEffects"]>;
};

export type ShellRuntimeActorCallbacks = {
  buildToolset: (currentVm: DomainRuntimeVm) => unknown[];
  processStream: (
    _runtime: unknown,
    streamActor: { key: string; id: string },
    stream: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>;
};

export type RecoverOrCreateShellRuntimeParams = {
  workDir: string;
  sessionDir: string;
  sessionKey: string;
  llmClient: unknown;
  systemPrompt: string;
  modelConfig: ActorModelConfig;
  eventBus: AgentEventGraph;
  registries: RuntimeRegistries;
  runtimeSupport: RuntimeSupportDescriptor;
  actorCallbacks: ShellRuntimeActorCallbacks;
  buildSystemMessages: (prompt: string[]) => Array<{ role: string; content: string }>;
  mcpManager?: unknown;
  outerCtxMetadata?: Record<string, unknown>;
};

export type RecoverOrCreateShellRuntimeResult = {
  actor: ReturnType<typeof createActor>;
  vm: DomainRuntimeVm;
  driver: ReturnType<typeof createAiAgentOrchestratorDriverWithCooperative>;
  mainFiberId: string;
  saveSnapshot: () => Promise<void>;
  effects: ShellRuntimeEffects;
};

export function createShellRuntimePaths(workDir: string): ShellRuntimePaths {
  const eidolonDir = path.join(workDir, ".eidolon");
  return {
    WORKDIR: workDir,
    EIDOLON_DIR: eidolonDir,
    AGENTS_DIR: path.join(eidolonDir, "agents"),
    MCP_DIR: path.join(eidolonDir, "mcp"),
  };
}

export function ensureShellRuntimeSessionDir(workDir: string, sessionKey: string): string {
  const sessionDir = path.join(workDir, ".eidolon", "sessions", sessionKey);
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

export function configureShellRuntimeEffects(params: {
  runtimeSupport: RuntimeSupportDescriptor;
  sessionDir: string;
}): ShellRuntimeEffects {
  const { runtimeSupport, sessionDir } = params;

  configureLocalPermissionConfigStore(runtimeSupport.permissionConfigStore);
  configureRuntimePersistenceSupport({
    actorTranscriptStore: runtimeSupport.persistence.actorTranscriptStore,
    snapshotRepositoryFactory: runtimeSupport.persistence.snapshotRepositoryFactory,
    derivedIndexesStore: runtimeSupport.persistence.derivedIndexesStore,
    conversationPersistenceRepositoryFactory: runtimeSupport.persistence.conversationPersistenceRepositoryFactory,
  });

  return {
    messageHistoryEffect: runtimeSupport.createMessageHistoryEffects({
      sessionPathProvider: () => sessionDir,
      log: () => {},
    }),
    orchestrationHistoryEffect: runtimeSupport.createOrchestrationHistoryEffects({
      sessionPathProvider: () => sessionDir,
      log: () => {},
    }),
  };
}

export async function recoverOrCreateShellRuntime(
  params: RecoverOrCreateShellRuntimeParams,
): Promise<RecoverOrCreateShellRuntimeResult> {
  const effects = configureShellRuntimeEffects({
    runtimeSupport: params.runtimeSupport,
    sessionDir: params.sessionDir,
  });

  const recovered =
    (await hasRuntimeSnapshot(params.sessionDir))
      ? await recoverAiAgentRuntime({
          sessionDir: params.sessionDir,
          sessionId: params.sessionKey,
          llmClient: params.llmClient as any,
          eventBus: params.eventBus,
          registries: params.registries as any,
          callbacks: { buildSystemMessages: params.buildSystemMessages },
          outerCtx: {
            workDir: params.workDir,
            metadata: {
              ...(params.outerCtxMetadata ?? {}),
              sessionId: params.sessionKey,
              sessionDir: params.sessionDir,
              conversationPersistenceRepositoryFactory: params.runtimeSupport.persistence.conversationPersistenceRepositoryFactory,
            },
          },
          mcpManager: params.mcpManager as any,
          effects: {
            log: () => {},
            messageHistory: effects.messageHistoryEffect,
            orchestrationHistory: effects.orchestrationHistoryEffect,
          },
          actorCallbacks: params.actorCallbacks as any,
        })
      : null;

  let actor!: ReturnType<typeof createActor>;
  let vm!: DomainRuntimeVm;
  let driver!: ReturnType<typeof createAiAgentOrchestratorDriverWithCooperative>;

  if (recovered) {
    actor = recovered.controlActor;
    vm = recovered.vm;
    driver = recovered.driver as ReturnType<typeof createAiAgentOrchestratorDriverWithCooperative>;
  } else {
    actor = createActor({
      key: "main",
      llmClient: params.llmClient as any,
      modelConfig: params.modelConfig,
      messages: [{ role: "system", content: params.systemPrompt }],
      callbacks: params.actorCallbacks as any,
    });

    vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: params.registries as any,
      callbacks: { buildSystemMessages: params.buildSystemMessages },
      eventBus: params.eventBus,
      outerCtx: {
        workDir: params.workDir,
        metadata: {
          ...(params.outerCtxMetadata ?? {}),
          sessionId: params.sessionKey,
          sessionDir: params.sessionDir,
          conversationPersistenceRepositoryFactory: params.runtimeSupport.persistence.conversationPersistenceRepositoryFactory,
        },
      },
      mcpManager: params.mcpManager as any,
      effects: {
        log: () => {},
        messageHistory: effects.messageHistoryEffect,
        orchestrationHistory: effects.orchestrationHistoryEffect,
      },
    });

    const history = actor.messages;
    const mainFiberId = `${actor.key}:${actor.id}`;
    driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: mainFiberId, vm, actor, messages: history, basePriority: 1 }],
      options: {
        agingStep: 0,
        defaultSuspendPolicy: "continue_others",
      },
    });

    const runtimeContext = ensureVmRuntimeContext(vm);
    runtimeContext.driver = driver;
  }

  const mainFiberId = `${actor.key}:${actor.id}`;
  const saveSnapshot = async () => {
    await saveAiAgentRuntimeSnapshot({
      sessionDir: params.sessionDir,
      sessionId: params.sessionKey,
      vm,
      driver,
    });
  };

  return {
    actor,
    vm,
    driver,
    mainFiberId,
    saveSnapshot,
    effects,
  };
}
