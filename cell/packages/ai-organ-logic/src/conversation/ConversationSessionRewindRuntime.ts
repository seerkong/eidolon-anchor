import type {
  ActorHistoryGenerationData,
  ConversationForkAuthoritySnapshot,
  ConversationPersistenceRepository,
  ConversationPersistenceRepositoryFactory,
  ConversationSessionRewindCommand,
  ConversationSessionRewindPort,
  ConversationSessionRewindResult,
} from "@cell/ai-organ-contract";
import { planConversationSessionRewind } from "./ConversationSessionRewind";

export type ConversationSessionRewindRuntimeEffects = Readonly<{
  owner: Readonly<{ sessionId: string; actorKey: string; actorId: string }>;
  repositoryFactory: ConversationPersistenceRepositoryFactory;
  resolveSessionDir: (sessionId: string) => string;
  runExclusive: <T>(sessionId: string, action: () => Promise<T>) => Promise<T>;
  beforeSourceRead?: (sessionId: string) => Promise<void>;
  afterCommit?: (input: Readonly<{
    command: ConversationSessionRewindCommand;
    repository: ConversationPersistenceRepository;
  }>) => Promise<void>;
}>;

function rejected(
  code: "SESSION_NOT_FOUND" | "ACTOR_NOT_FOUND" | "REWIND_TRANSACTION_CONFLICT",
  message: string,
): ConversationSessionRewindResult {
  return { status: "rejected", rejection: { code, message } };
}

async function loadSnapshot(input: {
  sessionId: string;
  actorKey?: string | null;
  repository: ConversationPersistenceRepository;
}): Promise<Readonly<{
  actorKey: string;
  actorId: string;
  snapshot: ConversationForkAuthoritySnapshot;
}> | null> {
  const [historyIndex, promptIndex, sessionIndex, artifactRefs] = await Promise.all([
    input.repository.loadHistoryIndex(),
    input.repository.loadPromptIndex(),
    input.repository.loadSessionIndex(),
    input.repository.loadArtifactRefs(),
  ]);
  if (historyIndex.sessionId !== input.sessionId
    || promptIndex.sessionId !== input.sessionId
    || sessionIndex.sessionId !== input.sessionId) return null;
  const actorKey = input.actorKey
    ?? sessionIndex.session.activeActorKey
    ?? Object.keys(sessionIndex.session.actorBindings)[0]
    ?? null;
  if (!actorKey) return null;
  const binding = sessionIndex.session.actorBindings[actorKey];
  if (!binding) return null;
  const historyHeadGenerationId = binding.historyHeadGenerationId
    ?? historyIndex.heads[actorKey]?.activeGenerationId
    ?? null;
  const promptHeadGenerationId = binding.promptHeadGenerationId
    ?? promptIndex.heads[actorKey]?.activePromptGenerationId
    ?? null;
  if (!historyHeadGenerationId || !promptHeadGenerationId) return null;
  const generationIds = [...new Set([
    ...(historyIndex.heads[actorKey]?.visibleGenerationIds ?? []),
    historyHeadGenerationId,
  ])];
  const historyGenerations = (await Promise.all(
    generationIds.map((generationId) => input.repository.loadHistoryGeneration(generationId)),
  )).filter((generation): generation is ActorHistoryGenerationData => Boolean(generation));
  const promptGeneration = await input.repository.loadPromptGeneration(promptHeadGenerationId);
  if (!promptGeneration) return null;
  return {
    actorKey,
    actorId: binding.actorId,
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

async function execute(
  command: ConversationSessionRewindCommand,
  effects: ConversationSessionRewindRuntimeEffects,
): Promise<ConversationSessionRewindResult> {
  if (!command.sessionId || command.sessionId.includes("/") || command.sessionId.includes("\\")) {
    return rejected("SESSION_NOT_FOUND", "rewind session id is invalid");
  }
  const repository = effects.repositoryFactory.createRepository(effects.resolveSessionDir(command.sessionId));
  const commitTransition = repository.commitProviderContextTransitionGeneration;
  if (!repository.withConversationAuthorityLease || !commitTransition) {
    return rejected("REWIND_TRANSACTION_CONFLICT", "Conversation transition persistence capability is unavailable");
  }
  try {
    return await repository.withConversationAuthorityLease(async () => {
      const loaded = await loadSnapshot({
        sessionId: command.sessionId,
        actorKey: command.actorKey,
        repository,
      });
      if (!loaded) return rejected("SESSION_NOT_FOUND", `Conversation authority is unavailable: ${command.sessionId}`);
      if (loaded.actorKey !== effects.owner.actorKey || loaded.actorId !== effects.owner.actorId) {
        return rejected("ACTOR_NOT_FOUND", "rewind command is not owned by this Conversation Actor");
      }
      const planned = planConversationSessionRewind({
        command: { ...command, actorKey: loaded.actorKey },
        source: loaded.snapshot,
      });
      if (planned.status === "rejected") return planned;
      await commitTransition.call(repository, planned.transition);
      const committed = await repository.loadSessionIndex();
      if (committed.session.actorBindings[loaded.actorKey]?.providerEpochReceiptV2?.receiptDigest
        !== planned.receipt.nextProviderEpochReceiptDigest) {
        return rejected("REWIND_TRANSACTION_CONFLICT", "rewind transaction did not publish its provider epoch head");
      }
      await effects.afterCommit?.({ command, repository });
      return { status: "committed", receipt: planned.receipt };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "rejected",
      rejection: {
        code: message.includes("cas") || message.includes("authority")
          ? "SOURCE_AUTHORITY_CHANGED"
          : "REWIND_TRANSACTION_CONFLICT",
        message,
      },
    };
  }
}

export function createConversationSessionRewindPort(
  effects: ConversationSessionRewindRuntimeEffects,
): ConversationSessionRewindPort {
  return {
    rewind: async (command) => {
      if (command.sessionId !== effects.owner.sessionId
        || (command.actorKey != null && command.actorKey !== effects.owner.actorKey)) {
        return rejected("ACTOR_NOT_FOUND", "rewind command must be dispatched to its owning Conversation Actor");
      }
      await effects.beforeSourceRead?.(command.sessionId);
      return await effects.runExclusive(command.sessionId, async () => await execute({
        ...command,
        actorKey: effects.owner.actorKey,
      }, effects));
    },
  };
}
