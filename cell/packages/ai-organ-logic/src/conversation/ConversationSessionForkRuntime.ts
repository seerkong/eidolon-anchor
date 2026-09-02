import type {
  ActorHistoryGenerationData,
  ConversationPersistenceRepositoryFactory,
  ConversationSessionForkCommand,
  ConversationSessionForkPort,
  ConversationSessionForkRejectionCode,
  ConversationSessionForkResult,
  ConversationSessionRepairCommand,
  ConversationForkAuthoritySnapshot,
  ConversationForkInitializationGeneration,
} from "@cell/ai-organ-contract";
import {
  digestConversationForkSourceAuthority,
  planConversationSessionFork,
  planConversationSessionRepair,
} from "./ConversationSessionFork";

export type ConversationSessionForkRuntimeEffects = Readonly<{
  /** The Conversation Actor whose synchronous command lane owns this port. */
  owner: Readonly<{ sessionId: string; actorKey: string; actorId: string }>;
  repositoryFactory: ConversationPersistenceRepositoryFactory;
  resolveSessionDir: (sessionId: string) => string;
  createChildActorId: (input: Readonly<{
    command: ConversationSessionForkCommand;
    actorKey: string;
    actorId: string;
  }>) => string;
  runExclusive: <T>(sourceSessionId: string, action: () => Promise<T>) => Promise<T>;
  beforeSourceRead?: (sourceSessionId: string) => Promise<void>;
  /** Optional observation barrier used by deterministic race/fault harnesses. */
  beforeSourceCompareAndSwap?: (sourceSessionId: string) => Promise<void>;
  /** Observation point after the final compare while the authority lease remains held. */
  afterSourceCompareAndSwap?: (sourceSessionId: string) => Promise<void>;
}>;

function rejected(
  code: ConversationSessionForkRejectionCode,
  message: string,
): ConversationSessionForkResult {
  return { status: "rejected", rejection: { code, message } };
}

function repairReceiptFromGeneration(
  generation: ConversationForkInitializationGeneration,
) {
  return {
    schemaVersion: "conversation.session-fork-receipt/v1" as const,
    mode: "repair" as const,
    sourceSessionId: generation.proof.sourceSessionId,
    targetSessionId: generation.sessionIndex.sessionId,
    childActorKey: generation.providerEpoch.childActorKey,
    childActorId: generation.providerEpoch.childActorId,
    proof: generation.proof,
    providerEpoch: generation.providerEpoch,
    transactionId: generation.transactionId,
    targetAuthorityDigest: generation.targetAuthorityDigest,
    preservedTargetTailMessageCount: generation.preservedTargetTailMessageCount,
    repairEvidence: generation.repairEvidence,
    committedAt: generation.createdAt,
  };
}

async function loadAuthoritySnapshot(input: {
  sessionId: string;
  actorKey?: string | null;
  repository: ReturnType<ConversationPersistenceRepositoryFactory["createRepository"]>;
}): Promise<
  | Readonly<{ status: "loaded"; actorKey: string; snapshot: ConversationForkAuthoritySnapshot }>
  | Readonly<{ status: "rejected"; result: ConversationSessionForkResult }>
> {
  const [historyIndex, promptIndex, sessionIndex, artifactRefs] = await Promise.all([
    input.repository.loadHistoryIndex(),
    input.repository.loadPromptIndex(),
    input.repository.loadSessionIndex(),
    input.repository.loadArtifactRefs(),
  ]);
  if (sessionIndex.sessionId !== input.sessionId
    || historyIndex.sessionId !== input.sessionId
    || promptIndex.sessionId !== input.sessionId) {
    return { status: "rejected", result: rejected("SOURCE_SESSION_NOT_FOUND", `Conversation authority is unavailable: ${input.sessionId}`) };
  }
  const actorKey = input.actorKey
    ?? sessionIndex.session.activeActorKey
    ?? Object.keys(sessionIndex.session.actorBindings)[0]
    ?? null;
  if (!actorKey) {
    return { status: "rejected", result: rejected("SOURCE_ACTOR_NOT_FOUND", `Conversation actor is unavailable: ${input.sessionId}`) };
  }
  const binding = sessionIndex.session.actorBindings[actorKey];
  if (!binding) {
    return { status: "rejected", result: rejected("SOURCE_ACTOR_NOT_FOUND", `Conversation actor is unavailable: ${actorKey}`) };
  }
  const historyHeadGenerationId = binding.historyHeadGenerationId
    ?? historyIndex.heads[actorKey]?.activeGenerationId
    ?? null;
  const promptHeadGenerationId = binding.promptHeadGenerationId
    ?? promptIndex.heads[actorKey]?.activePromptGenerationId
    ?? null;
  if (!historyHeadGenerationId) {
    return { status: "rejected", result: rejected("SOURCE_HISTORY_HEAD_MISSING", `Conversation History head is unavailable: ${input.sessionId}`) };
  }
  if (!promptHeadGenerationId) {
    return { status: "rejected", result: rejected("SOURCE_PROMPT_HEAD_MISSING", `Conversation Prompt head is unavailable: ${input.sessionId}`) };
  }
  const visibleGenerationIds = [...new Set([
    ...(historyIndex.heads[actorKey]?.visibleGenerationIds ?? []),
    historyHeadGenerationId,
  ])];
  const historyGenerations = (await Promise.all(
    visibleGenerationIds.map((generationId) => input.repository.loadHistoryGeneration(generationId)),
  )).filter((generation): generation is ActorHistoryGenerationData => !!generation);
  const promptGeneration = await input.repository.loadPromptGeneration(promptHeadGenerationId);
  if (!promptGeneration) {
    return { status: "rejected", result: rejected("SOURCE_PROMPT_HEAD_MISSING", `Conversation Prompt generation is unavailable: ${promptHeadGenerationId}`) };
  }
  return {
    status: "loaded",
    actorKey,
    snapshot: {
      historyIndex,
      promptIndex,
      sessionIndex,
      artifactRefs,
      historyGenerations,
      promptGenerations: [promptGeneration],
    },
  };
}

type ConversationRepository = ReturnType<ConversationPersistenceRepositoryFactory["createRepository"]>;

export async function withOrderedConversationAuthorityLeases<T>(
  entries: readonly Readonly<{ sessionId: string; repository: ConversationRepository }>[],
  action: () => Promise<T>,
): Promise<T> {
  const ordered = [...entries].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  const acquire = async (index: number): Promise<T> => {
    const entry = ordered[index];
    if (!entry) return await action();
    if (!entry.repository.withConversationAuthorityLease) {
      throw new Error("conversation_authority_lease_unavailable");
    }
    return await entry.repository.withConversationAuthorityLease(
      async () => await acquire(index + 1),
    );
  };
  return await acquire(0);
}

async function executeForkUnderAuthorityLeases(
  command: ConversationSessionForkCommand,
  effects: ConversationSessionForkRuntimeEffects,
  sourceRepository: ConversationRepository,
  targetRepository: ConversationRepository,
): Promise<ConversationSessionForkResult> {
  const loaded = await loadAuthoritySnapshot({
    sessionId: command.sourceSessionId,
    actorKey: command.actorKey,
    repository: sourceRepository,
  });
  if (loaded.status === "rejected") return loaded.result;
  const actorKey = loaded.actorKey;
  const binding = loaded.snapshot.sessionIndex.session.actorBindings[actorKey]!;
  if (actorKey !== effects.owner.actorKey || binding.actorId !== effects.owner.actorId) {
    return rejected(
      "SOURCE_ACTOR_NOT_FOUND",
      "fork command is not owned by this Conversation Actor; cross-Actor dispatch must use the runtime mailbox",
    );
  }

  const planned = planConversationSessionFork({
    command: { ...command, actorKey },
    childActorId: effects.createChildActorId({ command, actorKey, actorId: binding.actorId }),
    source: {
      ...loaded.snapshot,
    },
  });
  if (planned.status === "rejected") return planned;
  if (!targetRepository.commitConversationForkInitialization) {
    return rejected("FORK_TRANSACTION_CONFLICT", "Conversation fork persistence capability is unavailable");
  }
  await effects.beforeSourceCompareAndSwap?.(command.sourceSessionId);
  const currentSource = await loadAuthoritySnapshot({
    sessionId: command.sourceSessionId,
    actorKey,
    repository: sourceRepository,
  });
  if (currentSource.status === "rejected"
    || digestConversationForkSourceAuthority(currentSource.snapshot)
      !== planned.generation.proof.sourceAuthorityDigest) {
    return rejected(
      "SOURCE_AUTHORITY_CHANGED",
      "source Conversation authority changed before fork commit",
    );
  }
  await effects.afterSourceCompareAndSwap?.(command.sourceSessionId);
  try {
    await targetRepository.commitConversationForkInitialization(planned.generation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return rejected(
      message.includes("target_authority") || message.includes("head_cas")
        ? "TARGET_SESSION_ALREADY_EXISTS"
        : "FORK_TRANSACTION_CONFLICT",
      message,
    );
  }
  return {
    status: "committed",
    receipt: {
      schemaVersion: "conversation.session-fork-receipt/v1",
      mode: "create",
      sourceSessionId: command.sourceSessionId,
      targetSessionId: command.targetSessionId,
      childActorKey: planned.generation.providerEpoch.childActorKey,
      childActorId: planned.generation.providerEpoch.childActorId,
      proof: planned.generation.proof,
      providerEpoch: planned.generation.providerEpoch,
      transactionId: planned.generation.transactionId,
      targetAuthorityDigest: planned.generation.targetAuthorityDigest,
      preservedTargetTailMessageCount: 0,
      committedAt: command.occurredAt,
    },
  };
}

async function executeFork(
  command: ConversationSessionForkCommand,
  effects: ConversationSessionForkRuntimeEffects,
): Promise<ConversationSessionForkResult> {
  if (!command.targetSessionId
    || command.targetSessionId === command.sourceSessionId
    || command.targetSessionId.includes("/")
    || command.targetSessionId.includes("\\")) {
    return rejected("FORK_TRANSACTION_CONFLICT", "fork target session id is invalid");
  }
  await effects.beforeSourceRead?.(command.sourceSessionId);
  const sourceRepository = effects.repositoryFactory.createRepository(
    effects.resolveSessionDir(command.sourceSessionId),
  );
  const targetRepository = effects.repositoryFactory.createRepository(
    effects.resolveSessionDir(command.targetSessionId),
  );
  if (!sourceRepository.withConversationAuthorityLease
    || !targetRepository.withConversationAuthorityLease) {
    return rejected(
      "FORK_TRANSACTION_CONFLICT",
      "Conversation authority lease capability is unavailable",
    );
  }
  try {
    return await withOrderedConversationAuthorityLeases([
      { sessionId: command.sourceSessionId, repository: sourceRepository },
      { sessionId: command.targetSessionId, repository: targetRepository },
    ], async () => await executeForkUnderAuthorityLeases(
      command,
      effects,
      sourceRepository,
      targetRepository,
    ));
  } catch (error) {
    return rejected(
      "FORK_TRANSACTION_CONFLICT",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function executeRepairUnderAuthorityLeases(
  command: ConversationSessionRepairCommand,
  effects: ConversationSessionForkRuntimeEffects,
  sourceRepository: ConversationRepository,
  targetRepository: ConversationRepository,
): Promise<ConversationSessionForkResult> {
  const existingHead = await targetRepository.loadConversationForkHead?.();
  if (existingHead) {
    const existing = await targetRepository.loadConversationForkInitializationGeneration?.(existingHead.transactionId);
    const sameSelector = existing
      && JSON.stringify(existing.proof.selector) === JSON.stringify(command.selector);
    const sameProof = existing?.mode === "repair"
      && existing.proof.sourceSessionId === command.sourceSessionId
      && existing.sessionIndex.sessionId === command.targetSessionId
      && existing.expectedTargetAuthorityDigest === command.expectedTargetAuthorityDigest
      && (!command.expectedSourceAuthorityDigest
        || existing.proof.sourceAuthorityDigest === command.expectedSourceAuthorityDigest)
      && (!command.actorKey || existing.providerEpoch.childActorKey === command.actorKey)
      && sameSelector;
    if (existing && sameProof) {
      return {
        status: command.dryRun ? "dry_run" : "committed",
        receipt: repairReceiptFromGeneration(existing),
      };
    }
    return rejected("TARGET_AUTHORITY_CHANGED", "repair target is already governed by a conflicting fork transaction");
  }
  const [source, target] = await Promise.all([
    loadAuthoritySnapshot({ sessionId: command.sourceSessionId, actorKey: command.actorKey, repository: sourceRepository }),
    loadAuthoritySnapshot({ sessionId: command.targetSessionId, actorKey: command.actorKey, repository: targetRepository }),
  ]);
  if (source.status === "rejected") return source.result;
  if (target.status === "rejected") {
    return target.result.status === "rejected"
      ? rejected("REPAIR_TAIL_UNPROVABLE", target.result.rejection.message)
      : target.result;
  }
  const sourceBinding = source.snapshot.sessionIndex.session.actorBindings[source.actorKey];
  if (source.actorKey !== effects.owner.actorKey || sourceBinding?.actorId !== effects.owner.actorId) {
    return rejected(
      "SOURCE_ACTOR_NOT_FOUND",
      "repair command is not owned by this Conversation Actor; cross-Actor dispatch must use the runtime mailbox",
    );
  }
  const planned = planConversationSessionRepair({
    command: { ...command, actorKey: source.actorKey },
    source: source.snapshot,
    target: target.snapshot,
  });
  if (planned.status === "rejected") return planned;
  const receipt = repairReceiptFromGeneration(planned.generation);
  if (command.dryRun) return { status: "dry_run", receipt };
  if (!targetRepository.commitConversationForkInitialization) {
    return rejected("FORK_TRANSACTION_CONFLICT", "Conversation repair persistence capability is unavailable");
  }
  await effects.beforeSourceCompareAndSwap?.(command.sourceSessionId);
  const currentSource = await loadAuthoritySnapshot({
    sessionId: command.sourceSessionId,
    actorKey: source.actorKey,
    repository: sourceRepository,
  });
  if (currentSource.status === "rejected"
    || digestConversationForkSourceAuthority(currentSource.snapshot)
      !== planned.generation.proof.sourceAuthorityDigest) {
    return rejected(
      "SOURCE_AUTHORITY_CHANGED",
      "source Conversation authority changed before repair commit",
    );
  }
  await effects.afterSourceCompareAndSwap?.(command.sourceSessionId);
  try {
    await targetRepository.commitConversationForkInitialization(planned.generation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return rejected(
      message.includes("authority") || message.includes("cas")
        ? "TARGET_AUTHORITY_CHANGED"
        : "FORK_TRANSACTION_CONFLICT",
      message,
    );
  }
  return { status: "committed", receipt };
}

async function executeRepair(
  command: ConversationSessionRepairCommand,
  effects: ConversationSessionForkRuntimeEffects,
): Promise<ConversationSessionForkResult> {
  if (!command.sourceSessionId
    || !command.targetSessionId
    || command.sourceSessionId === command.targetSessionId
    || command.sourceSessionId.includes("/")
    || command.sourceSessionId.includes("\\")
    || command.targetSessionId.includes("/")
    || command.targetSessionId.includes("\\")) {
    return rejected("FORK_TRANSACTION_CONFLICT", "repair source or target session id is invalid");
  }
  await effects.beforeSourceRead?.(command.sourceSessionId);
  const sourceRepository = effects.repositoryFactory.createRepository(effects.resolveSessionDir(command.sourceSessionId));
  const targetRepository = effects.repositoryFactory.createRepository(effects.resolveSessionDir(command.targetSessionId));
  if (!sourceRepository.withConversationAuthorityLease
    || !targetRepository.withConversationAuthorityLease) {
    return rejected(
      "FORK_TRANSACTION_CONFLICT",
      "Conversation authority lease capability is unavailable",
    );
  }
  try {
    return await withOrderedConversationAuthorityLeases([
      { sessionId: command.sourceSessionId, repository: sourceRepository },
      { sessionId: command.targetSessionId, repository: targetRepository },
    ], async () => await executeRepairUnderAuthorityLeases(
      command,
      effects,
      sourceRepository,
      targetRepository,
    ));
  } catch (error) {
    return rejected(
      "FORK_TRANSACTION_CONFLICT",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Conversation-owned capability. Runtime hosts inject serialization and all
 * filesystem/id effects; TUI/CLI/headless surfaces only hold this port.
 */
export function createConversationSessionForkPort(
  effects: ConversationSessionForkRuntimeEffects,
): ConversationSessionForkPort {
  return {
    fork: async (command) => {
      if (command.sourceSessionId !== effects.owner.sessionId
        || (command.actorKey !== undefined
          && command.actorKey !== null
          && command.actorKey !== effects.owner.actorKey)) {
        return rejected(
          "SOURCE_ACTOR_NOT_FOUND",
          "fork command must be dispatched to its owning Conversation Actor mailbox",
        );
      }
      return await effects.runExclusive(
        command.sourceSessionId,
        async () => await executeFork({ ...command, actorKey: effects.owner.actorKey }, effects),
      );
    },
    repair: async (command) => {
      if (command.sourceSessionId !== effects.owner.sessionId
        || (command.actorKey !== undefined
          && command.actorKey !== null
          && command.actorKey !== effects.owner.actorKey)) {
        return rejected(
          "SOURCE_ACTOR_NOT_FOUND",
          "repair command must be dispatched to its owning Conversation Actor mailbox",
        );
      }
      return await effects.runExclusive(
        command.targetSessionId,
        async () => await executeRepair({ ...command, actorKey: effects.owner.actorKey }, effects),
      );
    },
  };
}
