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
import {
  createWriteBehindPersistenceWritePort,
  type PersistenceWriteBehindPort,
} from "../persistence/WriteBehindPersistencePort";

export type ShellRuntimePaths = {
  WORKDIR: string;
  EIDOLON_DIR: string;
  AGENTS_DIR: string;
  MCP_DIR: string;
};

export type ShellRuntimeEffects = {
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
  /** Storage capability flags from the runtime binding; defaults to enabled. */
  storage?: { logs?: boolean; files?: boolean };
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
    snapshotRepositoryFactory: runtimeSupport.persistence.snapshotRepositoryFactory,
    derivedIndexesStore: runtimeSupport.persistence.derivedIndexesStore,
    conversationPersistenceRepositoryFactory: runtimeSupport.persistence.conversationPersistenceRepositoryFactory,
  });

  return {
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

  // P3 (refactor-persistent-session-backplane / `explicit-injection`): build the
  // typed write-behind persistence port + repository factory once and thread
  // them through `outerCtx` as EXPLICIT typed fields. The prior implicit
  // `metadata.conversationPersistenceRepositoryFactory` untyped channel is gone.
  const persistenceWritePort: PersistenceWriteBehindPort = createWriteBehindPersistenceWritePort();
  const conversationPersistenceRepositoryFactory =
    params.runtimeSupport.persistence.conversationPersistenceRepositoryFactory;
  const buildOuterCtx = () => ({
    workDir: params.workDir,
    metadata: {
      ...(params.outerCtxMetadata ?? {}),
      sessionId: params.sessionKey,
      sessionDir: params.sessionDir,
    },
    persistenceWritePort,
    conversationPersistenceRepositoryFactory,
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
          outerCtx: buildOuterCtx(),
          mcpManager: params.mcpManager as any,
          effects: {
            log: () => {},
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
    if (actor.systemPrompts.length === 0 && params.systemPrompt.trim()) {
      actor.systemPrompts = [params.systemPrompt];
    }
    vm = recovered.vm;
    if (params.storage) {
      vm.options = { ...vm.options, storage: { ...params.storage } };
    }
    driver = recovered.driver as ReturnType<typeof createAiAgentOrchestratorDriverWithCooperative>;
  } else {
    actor = createActor({
      key: "main",
      llmClient: params.llmClient as any,
      modelConfig: params.modelConfig,
      systemPrompts: params.systemPrompt.trim() ? [params.systemPrompt] : [],
      messages: [],
      callbacks: params.actorCallbacks as any,
    });

    vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: params.registries as any,
      options: params.storage ? { storage: { ...params.storage } } : undefined,
      callbacks: { buildSystemMessages: params.buildSystemMessages },
      eventBus: params.eventBus,
      outerCtx: buildOuterCtx(),
      mcpManager: params.mcpManager as any,
      effects: {
        log: () => {},
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
    return await saveAiAgentRuntimeSnapshot({
      sessionDir: params.sessionDir,
      sessionId: params.sessionKey,
      vm,
      driver,
    });
  };
  // P3 (requirement `timed-out-turn-progress-persisted`): production does NOT
  // bind a real `sealCompletedProgress` callback. The seal MECHANISM
  // (`sealCompletedConversationProgress`) and the coordinator's optional
  // `sealCompletedProgress` param are retained (unit-tested via direct
  // injection), but live timeout-sealing is DEFERRED to the follow-up that also
  // teaches the recovery gate a forward-only conversation head. Enabling the
  // seal ahead of that gate relay would advance the conversation head past the
  // checkpoint marker and make a settled-then-timed-out session recover `dirty`
  // (regression). The coordinator's default no-op leaves on-disk state
  // recoverable exactly as before this track. See analysis/findings.md "P3".

  return {
    actor,
    vm,
    driver,
    mainFiberId,
    saveSnapshot,
    effects,
  };
}
