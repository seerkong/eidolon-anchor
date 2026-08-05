import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { AgentEventGraph, createActor, createVM, ensureVmRuntimeContext } from "@cell/ai-core-logic";
import type { ActorModelConfig } from "@cell/ai-core-logic/runtime/actor";
import type {
  AiAgentActorContract,
  ProfileSystemPromptProvenance,
} from "@cell/ai-core-contract/runtime/AiAgentActor";
import type {
  DomainRuntimeVm,
  LlmProcessStreamOptions,
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
  sealCompletedConversationProgress,
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
    options?: LlmProcessStreamOptions,
  ) => Promise<unknown>;
};

export type RecoverOrCreateShellRuntimeParams = {
  workDir: string;
  sessionDir: string;
  sessionKey: string;
  llmClient: unknown;
  profileSystemPrompt: ProfileSystemPromptAssembly;
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
  sealCompletedProgress: () => Promise<void>;
  effects: ShellRuntimeEffects;
  profilePromptRecovery: ProfileSystemPromptReconciliation;
};

export type ProfileSystemPromptAssembly = {
  profileId: string;
  systemPrompt: string;
};

export type ProfileSystemPromptRecoveryDiagnostic =
  | {
      code: "profile_prompt_provenance_invalid";
      actorKey: string;
    }
  | {
      code: "profile_prompt_index_mismatch";
      actorKey: string;
      promptIndex: number;
      promptCount: number;
    }
  | {
      code: "profile_prompt_digest_mismatch";
      actorKey: string;
      promptIndex: number;
      expectedDigest: string;
      actualDigest: string;
    }
  | {
      code: "legacy_profile_prompt_ambiguous";
      actorKey: string;
      promptCount: number;
    };

export type ProfileSystemPromptReconciliation = {
  status: "refreshed" | "legacy_inserted" | "legacy_replaced" | "preserved";
  diagnostics: ProfileSystemPromptRecoveryDiagnostic[];
};

export function digestProfileSystemPrompt(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function buildProfileSystemPromptProvenance(
  assembly: ProfileSystemPromptAssembly,
  promptIndex: number,
): ProfileSystemPromptProvenance {
  return {
    owner: "runtime_profile" as const,
    profileId: assembly.profileId,
    promptIndex,
    contentDigest: digestProfileSystemPrompt(assembly.systemPrompt),
  };
}

export function reconcileProfileSystemPrompt(
  actor: Pick<AiAgentActorContract, "key" | "systemPrompts" | "profileSystemPromptProvenance">,
  assembly: ProfileSystemPromptAssembly,
): ProfileSystemPromptReconciliation {
  const provenance = actor.profileSystemPromptProvenance;
  if (provenance) {
    if (
      provenance.owner !== "runtime_profile"
      || typeof provenance.profileId !== "string"
      || provenance.profileId.length === 0
      || typeof provenance.contentDigest !== "string"
      || !/^[a-f0-9]{64}$/.test(provenance.contentDigest)
    ) {
      return {
        status: "preserved",
        diagnostics: [{
          code: "profile_prompt_provenance_invalid",
          actorKey: actor.key,
        }],
      };
    }
    const promptIndex = provenance.promptIndex;
    if (!Number.isInteger(promptIndex) || promptIndex < 0 || promptIndex >= actor.systemPrompts.length) {
      return {
        status: "preserved",
        diagnostics: [{
          code: "profile_prompt_index_mismatch",
          actorKey: actor.key,
          promptIndex,
          promptCount: actor.systemPrompts.length,
        }],
      };
    }

    const actualDigest = digestProfileSystemPrompt(actor.systemPrompts[promptIndex] ?? "");
    if (actualDigest !== provenance.contentDigest) {
      return {
        status: "preserved",
        diagnostics: [{
          code: "profile_prompt_digest_mismatch",
          actorKey: actor.key,
          promptIndex,
          expectedDigest: provenance.contentDigest,
          actualDigest,
        }],
      };
    }

    actor.systemPrompts[promptIndex] = assembly.systemPrompt;
    actor.profileSystemPromptProvenance = buildProfileSystemPromptProvenance(assembly, promptIndex);
    return { status: "refreshed", diagnostics: [] };
  }

  if (actor.systemPrompts.length === 0) {
    actor.systemPrompts.push(assembly.systemPrompt);
    actor.profileSystemPromptProvenance = buildProfileSystemPromptProvenance(assembly, 0);
    return { status: "legacy_inserted", diagnostics: [] };
  }

  if (actor.systemPrompts.length === 1) {
    actor.systemPrompts[0] = assembly.systemPrompt;
    actor.profileSystemPromptProvenance = buildProfileSystemPromptProvenance(assembly, 0);
    return { status: "legacy_replaced", diagnostics: [] };
  }

  return {
    status: "preserved",
    diagnostics: [{
      code: "legacy_profile_prompt_ambiguous",
      actorKey: actor.key,
      promptCount: actor.systemPrompts.length,
    }],
  };
}

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
  let profilePromptRecovery!: ProfileSystemPromptReconciliation;

  if (recovered) {
    actor = recovered.controlActor;
    profilePromptRecovery = reconcileProfileSystemPrompt(actor, params.profileSystemPrompt);
    for (const diagnostic of profilePromptRecovery.diagnostics) {
      effects.orchestrationHistoryEffect.appendEvent({
        stream: "runtime_recovery",
        kind: "profile_prompt_recovery_diagnostic",
        payload: diagnostic,
      });
    }
    vm = recovered.vm;
    if (params.storage) {
      vm.options = { ...vm.options, storage: { ...params.storage } };
    }
    driver = recovered.driver as ReturnType<typeof createAiAgentOrchestratorDriverWithCooperative>;
  } else {
    const profileSystemPromptProvenance = buildProfileSystemPromptProvenance(params.profileSystemPrompt, 0);
    actor = createActor({
      key: "main",
      llmClient: params.llmClient as any,
      modelConfig: params.modelConfig,
      systemPrompts: [params.profileSystemPrompt.systemPrompt],
      profileSystemPromptProvenance,
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
    profilePromptRecovery = { status: "refreshed", diagnostics: [] };
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
  const sealCompletedProgress = async () => {
    await sealCompletedConversationProgress({
      sessionDir: params.sessionDir,
      sessionId: params.sessionKey,
      vm,
    });
  };

  return {
    actor,
    vm,
    driver,
    mainFiberId,
    saveSnapshot,
    sealCompletedProgress,
    effects,
    profilePromptRecovery,
  };
}
