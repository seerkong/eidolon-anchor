import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
  type ActorHistoryGenerationData,
  type ActorPromptGenerationData,
} from "@cell/ai-organ-contract";
import {
  createProviderEpochReceiptV2,
  createConversationSessionForkPort,
  digestConversationForkSourceAuthority,
  digestProviderContextClosedValue,
  digestProviderContextHistoryFrontier,
  planConversationSessionFork,
  planConversationSessionRepair,
  type ConversationForkSourceSnapshot,
  withOrderedConversationAuthorityLeases,
} from "@cell/ai-organ-logic";
import {
  LocalFileConversationPersistenceRepository,
  type LocalConversationForkInitializationFaultPoint,
} from "@cell/ai-support";

const occurredAt = "2026-09-01T01:00:00.000Z";

function fixture(): ConversationForkSourceSnapshot {
  const messages: ActorHistoryGenerationData["messages"] = [{
    recordId: "parent-record-0",
    actorKey: "main",
    actorId: "parent-actor",
    committedAt: 1,
    message: { messageId: "message-0", role: "user", content: "remember ~/.depa-si/" },
  }, {
    recordId: "parent-record-1",
    actorKey: "main",
    actorId: "parent-actor",
    committedAt: 2,
    message: { messageId: "message-1", role: "assistant", content: "I will inspect it." },
  }];
  const history: ActorHistoryGenerationData = {
    version: 1,
    generationId: "parent-history",
    sessionId: "parent",
    actorKey: "main",
    actorId: "parent-actor",
    parentGenerationId: null,
    predecessorGenerationIds: [],
    createdReason: "append",
    sealed: false,
    messageCount: messages.length,
    messages,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  const prompt: ActorPromptGenerationData = {
    version: 1,
    promptGenerationId: "parent-prompt",
    sessionId: "parent",
    actorKey: "main",
    actorId: "parent-actor",
    basedOnPromptGenerationId: null,
    basis: {
      version: 1,
      basisHistoryGenerationIds: [history.generationId],
      basisMessageRecordIds: messages.map((message) => message.recordId),
      basisRefs: [{ refKind: "history_generation", refId: history.generationId }],
    },
    transforms: [],
    createdReason: "request_build",
    materializedContext: null,
    sealed: false,
    createdAt: occurredAt,
    sealedAt: null,
    updatedAt: occurredAt,
    metadata: { systemPrompts: ["stable prefix"] },
  };
  const emptyDigest = digestProviderContextClosedValue([]);
  const receipt = createProviderEpochReceiptV2({
    sessionId: "parent",
    actorKey: "main",
    actorId: "parent-actor",
    epoch: 2,
    previousReceiptDigest: emptyDigest,
    targetProviderId: "deepseek-iqingwa",
    targetModelId: "deepseek-v4-pro",
    targetProfileId: "deepseek-chat@1",
    baselineHeads: {
      historyHeadGenerationId: history.generationId,
      promptHeadGenerationId: prompt.promptGenerationId,
      factHeadDigest: null,
    },
    sourceHistoryMessageCount: messages.length,
    sourceFrontierDigest: digestProviderContextHistoryFrontier(messages),
    pendingDeliveryDigest: emptyDigest,
    handoffDigest: emptyDigest,
    frozenResourceDigest: emptyDigest,
    providerSurfaceDigest: emptyDigest,
    retentionPolicy: { maxRevisionsPerNamespace: 8, maxCanonicalFactBytesPerEpoch: 262_144 },
    reason: "initial_projection",
    compactionProofDigest: null,
    createdAt: occurredAt,
  });
  return {
    historyIndex: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId: "parent",
      heads: { main: { version: 1, sessionId: "parent", actorKey: "main", actorId: "parent-actor", activeGenerationId: history.generationId, visibleGenerationIds: [history.generationId], updatedAt: occurredAt } },
      lineages: { [history.generationId]: { version: 1, sessionId: "parent", actorKey: "main", actorId: "parent-actor", generationId: history.generationId, parentGenerationId: null, rolledBackFromGenerationId: null, predecessorGenerationIds: [], successorGenerationIds: [], forkGenerationIds: [], branchLabel: null, updatedAt: occurredAt } },
      generations: { [history.generationId]: { generationId: history.generationId, actorKey: "main", actorId: "parent-actor", sealed: false, createdAt: occurredAt, updatedAt: occurredAt } },
      updatedAt: occurredAt,
    },
    promptIndex: {
      version: 1,
      sessionId: "parent",
      heads: { main: { version: 1, sessionId: "parent", actorKey: "main", actorId: "parent-actor", activePromptGenerationId: prompt.promptGenerationId, updatedAt: occurredAt } },
      generations: { [prompt.promptGenerationId]: { promptGenerationId: prompt.promptGenerationId, actorKey: "main", actorId: "parent-actor", sealed: false, createdAt: occurredAt, updatedAt: occurredAt } },
      updatedAt: occurredAt,
    },
    sessionIndex: {
      version: 1,
      sessionId: "parent",
      session: {
        version: 1,
        sessionId: "parent",
        activeActorKey: "main",
        actorBindings: { main: { actorKey: "main", actorId: "parent-actor", historyHeadGenerationId: history.generationId, promptHeadGenerationId: prompt.promptGenerationId, providerEpochReceiptV2: receipt } },
        contextAssetRegistry: null,
        contextAssets: [],
        activeSelection: { sessionId: "parent", activeActorKey: "main", historyHeadGenerationId: history.generationId, promptHeadGenerationId: prompt.promptGenerationId, selectedAt: occurredAt },
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
      lineage: null,
      updatedAt: occurredAt,
    },
    artifactRefs: { version: 1, sessionId: "parent", refs: [], updatedAt: occurredAt },
    historyGenerations: [history],
    promptGenerations: [prompt],
  };
}

function plannedGeneration(forkedAt = occurredAt) {
  const planned = planConversationSessionFork({
    command: {
      schemaVersion: "conversation.session-fork-command/v1",
      sourceSessionId: "parent",
      targetSessionId: "child",
      actorKey: "main",
      selector: { kind: "current_head" },
      occurredAt: forkedAt,
    },
    source: fixture(),
    childActorId: "child-actor",
  });
  if (planned.status !== "planned") throw new Error(planned.rejection.message);
  return planned.generation;
}

function brokenChildFixture(): ConversationForkSourceSnapshot {
  const parent = fixture();
  const childMessage = {
    recordId: "child-tail-record-0",
    actorKey: "main",
    actorId: "child-actor",
    committedAt: 0,
    message: { messageId: "child-tail-message-0", role: "user", content: "analyze the database" },
  };
  const history: ActorHistoryGenerationData = {
    version: 1,
    generationId: "main__active",
    sessionId: "child",
    actorKey: "main",
    actorId: "child-actor",
    parentGenerationId: null,
    predecessorGenerationIds: [],
    createdReason: "append",
    sealed: false,
    messageCount: 1,
    messages: [childMessage],
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
  const prompt: ActorPromptGenerationData = {
    version: 1,
    promptGenerationId: "child-prompt",
    sessionId: "child",
    actorKey: "main",
    actorId: "child-actor",
    basedOnPromptGenerationId: null,
    basis: {
      version: 1,
      basisHistoryGenerationIds: [history.generationId],
      basisMessageRecordIds: [],
    },
    transforms: [],
    createdReason: "request_build",
    materializedContext: null,
    sealed: false,
    createdAt: occurredAt,
    sealedAt: null,
    updatedAt: occurredAt,
    metadata: { systemPrompts: ["stable prefix"] },
  };
  const previousDigest = parent.sessionIndex.session.actorBindings.main!.providerEpochReceiptV2!.receiptDigest;
  const emptyDigest = digestProviderContextClosedValue([]);
  const receipt = createProviderEpochReceiptV2({
    sessionId: "child",
    actorKey: "main",
    actorId: "child-actor",
    epoch: 1,
    previousReceiptDigest: previousDigest,
    targetProviderId: "deepseek-iqingwa",
    targetModelId: "deepseek-v4-pro",
    targetProfileId: "deepseek-chat@1",
    baselineHeads: {
      historyHeadGenerationId: history.generationId,
      promptHeadGenerationId: prompt.promptGenerationId,
      factHeadDigest: null,
    },
    sourceHistoryMessageCount: 1,
    sourceFrontierDigest: digestProviderContextHistoryFrontier(history.messages),
    pendingDeliveryDigest: emptyDigest,
    handoffDigest: emptyDigest,
    frozenResourceDigest: emptyDigest,
    providerSurfaceDigest: emptyDigest,
    retentionPolicy: { maxRevisionsPerNamespace: 8, maxCanonicalFactBytesPerEpoch: 262_144 },
    reason: "recovery_rebuild",
    compactionProofDigest: null,
    createdAt: occurredAt,
  });
  return {
    historyIndex: {
      version: 1,
      sessionId: "child",
      heads: {},
      lineages: {},
      generations: {},
      updatedAt: occurredAt,
    },
    promptIndex: {
      version: 1,
      sessionId: "child",
      heads: {
        main: {
          version: 1,
          sessionId: "child",
          actorKey: "main",
          actorId: "child-actor",
          activePromptGenerationId: prompt.promptGenerationId,
          updatedAt: occurredAt,
        },
      },
      generations: {},
      updatedAt: occurredAt,
    },
    sessionIndex: {
      version: 1,
      sessionId: "child",
      session: {
        version: 1,
        sessionId: "child",
        activeActorKey: "main",
        actorBindings: {
          main: {
            actorKey: "main",
            actorId: "child-actor",
            historyHeadGenerationId: history.generationId,
            promptHeadGenerationId: prompt.promptGenerationId,
            providerEpochReceiptV2: receipt,
          },
        },
        contextAssetRegistry: null,
        contextAssets: [],
        activeSelection: {
          sessionId: "child",
          activeActorKey: "main",
          historyHeadGenerationId: history.generationId,
          promptHeadGenerationId: prompt.promptGenerationId,
          selectedAt: occurredAt,
        },
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
      lineage: null,
      updatedAt: occurredAt,
    },
    artifactRefs: { version: 1, sessionId: "child", refs: [], updatedAt: occurredAt },
    historyGenerations: [history],
    promptGenerations: [prompt],
  };
}

async function persistSnapshot(
  root: string,
  sessionId: string,
  snapshot: ConversationForkSourceSnapshot,
): Promise<void> {
  const repository = new LocalFileConversationPersistenceRepository(path.join(root, sessionId));
  for (const generation of snapshot.historyGenerations) await repository.writeHistoryGeneration(generation);
  for (const generation of snapshot.promptGenerations) await repository.writePromptGeneration(generation);
  await repository.writeHistoryIndex(snapshot.historyIndex);
  await repository.writePromptIndex(snapshot.promptIndex);
  await repository.writeSessionIndex(snapshot.sessionIndex);
  await repository.writeArtifactRefs(snapshot.artifactRefs);
}

describe("local Conversation fork initialization transaction", () => {
  it("publishes XNL History/Prompt, Session and child provider head as one recoverable authority", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-fork-init-"));
    try {
      const generation = plannedGeneration();
      const repository = new LocalFileConversationPersistenceRepository(sessionDir);
      await repository.commitConversationForkInitialization(generation);
      await repository.commitConversationForkInitialization(generation);

      const fresh = new LocalFileConversationPersistenceRepository(sessionDir);
      const history = await fresh.loadHistoryIndex();
      const prompt = await fresh.loadPromptIndex();
      const session = await fresh.loadSessionIndex();
      const head = await fresh.loadConversationForkHead();
      expect(history).toEqual(generation.historyIndex);
      expect(prompt).toEqual(generation.promptIndex);
      expect(session).toEqual(generation.sessionIndex);
      expect(head).toMatchObject({
        transactionId: generation.transactionId,
        targetAuthorityDigest: generation.targetAuthorityDigest,
        childProviderEpochReceiptDigest: generation.childProviderEpochReceipt.receiptDigest,
      });
      expect(await fresh.loadHistoryGeneration(history.heads.main!.activeGenerationId!))
        .toEqual(generation.historyGenerations.at(-1));
      expect(await fresh.loadPromptGeneration(prompt.heads.main!.activePromptGenerationId!))
        .toEqual(generation.promptGenerations[0]);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("recovers every staged/publication fault to absent-or-complete child authority", async () => {
    const faultPoints: LocalConversationForkInitializationFaultPoint[] = [
      "after-stage-create",
      "after-stage-write",
      "after-stage-fsync",
      "after-stage-publish",
      "after-claim-cas",
      "after-journal-publish",
      "before-authority-publish",
      "after-authority-publish",
      "after-head-cas",
    ];
    for (const faultPoint of faultPoints) {
      const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-fork-fault-"));
      try {
        const generation = plannedGeneration();
        let injected = false;
        const interrupted = new LocalFileConversationPersistenceRepository(sessionDir, {
          conversationForkInitializationFault(point) {
            if (!injected && point === faultPoint) {
              injected = true;
              throw new Error(`fault:${point}`);
            }
          },
        });
        await expect(interrupted.commitConversationForkInitialization(generation))
          .rejects.toThrow(`fault:${faultPoint}`);

        const fresh = new LocalFileConversationPersistenceRepository(sessionDir);
        const session = await fresh.loadSessionIndex();
        const binding = session.session.actorBindings.main;
        if (!binding) {
          expect(session.session.activeActorKey).toBeNull();
          await fresh.commitConversationForkInitialization(generation);
        }
        const recoveredSession = await fresh.loadSessionIndex();
        const recoveredHead = await fresh.loadConversationForkHead();
        expect(recoveredSession).toEqual(generation.sessionIndex);
        expect((await fresh.loadHistoryIndex()).heads.main?.activeGenerationId)
          .toBe(generation.historyIndex.heads.main?.activeGenerationId);
        expect((await fresh.loadPromptIndex()).heads.main?.activePromptGenerationId)
          .toBe(generation.promptIndex.heads.main?.activePromptGenerationId);
        expect(recoveredHead?.childProviderEpochReceiptDigest)
          .toBe(generation.childProviderEpochReceipt.receiptDigest);
      } finally {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }
  });

  it("exposes one path-neutral write port for local and headless runtime hosts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-fork-port-"));
    try {
      const source = fixture();
      const sourceDir = path.join(root, "parent");
      const sourceRepository = new LocalFileConversationPersistenceRepository(sourceDir);
      for (const generation of source.historyGenerations) await sourceRepository.writeHistoryGeneration(generation);
      for (const generation of source.promptGenerations) await sourceRepository.writePromptGeneration(generation);
      await sourceRepository.writeHistoryIndex(source.historyIndex);
      await sourceRepository.writePromptIndex(source.promptIndex);
      await sourceRepository.writeSessionIndex(source.sessionIndex);
      await sourceRepository.writeArtifactRefs(source.artifactRefs);

      let exclusiveCalls = 0;
      let beforeReads = 0;
      const port = createConversationSessionForkPort({
        owner: { sessionId: "parent", actorKey: "main", actorId: "parent-actor" },
        repositoryFactory: { createRepository: (sessionDir) => new LocalFileConversationPersistenceRepository(sessionDir) },
        resolveSessionDir: (sessionId) => path.join(root, sessionId),
        createChildActorId: ({ command }) => `actor-${command.targetSessionId}`,
        runExclusive: async (_sourceSessionId, action) => {
          exclusiveCalls += 1;
          return await action();
        },
        beforeSourceRead: async () => {
          beforeReads += 1;
        },
      });
      const result = await port.fork({
        schemaVersion: "conversation.session-fork-command/v1",
        sourceSessionId: "parent",
        targetSessionId: "child",
        actorKey: "main",
        selector: { kind: "current_head" },
        occurredAt,
      });
      expect(result.status).toBe("committed");
      expect(exclusiveCalls).toBe(1);
      expect(beforeReads).toBe(1);
      const child = new LocalFileConversationPersistenceRepository(path.join(root, "child"));
      const session = await child.loadSessionIndex();
      expect(session.session.actorBindings.main?.actorId).toBe("actor-child");
      expect((await child.loadHistoryGeneration(session.session.actorBindings.main!.historyHeadGenerationId!))
        ?.messages.map((entry) => entry.message.content)).toEqual([
          "remember ~/.depa-si/",
          "I will inspect it.",
        ]);

      const crossActor = await port.fork({
        schemaVersion: "conversation.session-fork-command/v1",
        sourceSessionId: "parent",
        targetSessionId: "foreign-child",
        actorKey: "other",
        selector: { kind: "current_head" },
        occurredAt,
      });
      expect(crossActor).toMatchObject({
        status: "rejected",
        rejection: { code: "SOURCE_ACTOR_NOT_FOUND" },
      });
      expect((await new LocalFileConversationPersistenceRepository(path.join(root, "foreign-child"))
        .loadSessionIndex()).session.activeActorKey).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a fork when source authority changes between planning and target commit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-fork-source-cas-"));
    try {
      const source = fixture();
      await persistSnapshot(root, "parent", source);
      const sourceRepository = new LocalFileConversationPersistenceRepository(path.join(root, "parent"));
      const port = createConversationSessionForkPort({
        owner: { sessionId: "parent", actorKey: "main", actorId: "parent-actor" },
        repositoryFactory: {
          createRepository: (sessionDir) => sessionDir === path.join(root, "parent")
            ? sourceRepository
            : new LocalFileConversationPersistenceRepository(sessionDir),
        },
        resolveSessionDir: (sessionId) => path.join(root, sessionId),
        createChildActorId: () => "child-actor",
        runExclusive: async (_sessionId, action) => await action(),
        beforeSourceCompareAndSwap: async () => {
          await sourceRepository.writeArtifactRefs({
            ...source.artifactRefs,
            updatedAt: "2026-09-01T01:00:01.000Z",
          });
        },
      });

      const result = await port.fork({
        schemaVersion: "conversation.session-fork-command/v1",
        sourceSessionId: "parent",
        targetSessionId: "child",
        actorKey: "main",
        selector: { kind: "current_head" },
        occurredAt,
      });
      expect(result).toMatchObject({
        status: "rejected",
        rejection: { code: "SOURCE_AUTHORITY_CHANGED" },
      });
      const child = new LocalFileConversationPersistenceRepository(path.join(root, "child"));
      expect((await child.loadSessionIndex()).session.activeActorKey).toBeNull();
      expect(await child.loadConversationForkHead()).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("holds the durable source authority lease through target publication", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-fork-source-lease-"));
    try {
      const source = fixture();
      await persistSnapshot(root, "parent", source);
      const sourceRepository = new LocalFileConversationPersistenceRepository(path.join(root, "parent"));
      let writerCompleted = false;
      let reachedFinalCompare!: () => void;
      let releaseFinalCompare!: () => void;
      const finalCompareReached = new Promise<void>((resolve) => {
        reachedFinalCompare = resolve;
      });
      const finalCompareRelease = new Promise<void>((resolve) => {
        releaseFinalCompare = resolve;
      });
      const port = createConversationSessionForkPort({
        owner: { sessionId: "parent", actorKey: "main", actorId: "parent-actor" },
        repositoryFactory: {
          createRepository: (sessionDir) => sessionDir === path.join(root, "parent")
            ? sourceRepository
            : new LocalFileConversationPersistenceRepository(sessionDir),
        },
        resolveSessionDir: (sessionId) => path.join(root, sessionId),
        createChildActorId: () => "child-actor",
        runExclusive: async (_sessionId, action) => await action(),
        afterSourceCompareAndSwap: async () => {
          reachedFinalCompare();
          await finalCompareRelease;
        },
      });

      const fork = port.fork({
        schemaVersion: "conversation.session-fork-command/v1",
        sourceSessionId: "parent",
        targetSessionId: "child",
        actorKey: "main",
        selector: { kind: "current_head" },
        occurredAt,
      });
      await finalCompareReached;
      // Start outside the fork's AsyncLocalStorage scope, but deliberately use
      // the exact same repository instance. Instance-local reentrancy must not
      // let this competing Conversation writer bypass the authority lease.
      const writer = sourceRepository.writeArtifactRefs({
        ...source.artifactRefs,
        updatedAt: "2026-09-01T01:00:02.000Z",
      }).then(() => {
        writerCompleted = true;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(writerCompleted).toBe(false);
      releaseFinalCompare();
      const result = await fork;
      expect(result.status).toBe("committed");
      await writer;
      expect(writerCompleted).toBe(true);
      expect((await new LocalFileConversationPersistenceRepository(path.join(root, "child"))
        .loadConversationForkHead())?.transactionId).toBe(
          result.status === "committed" ? result.receipt.transactionId : null,
        );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("orders reciprocal source and target authority leases without deadlock", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-fork-lock-order-"));
    try {
      const repositoryA = new LocalFileConversationPersistenceRepository(path.join(root, "a"));
      const repositoryB = new LocalFileConversationPersistenceRepository(path.join(root, "b"));
      const completed: string[] = [];
      const first = withOrderedConversationAuthorityLeases([
        { sessionId: "b", repository: repositoryB },
        { sessionId: "a", repository: repositoryA },
      ], async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        completed.push("first");
      });
      const reciprocal = withOrderedConversationAuthorityLeases([
        { sessionId: "a", repository: repositoryA },
        { sessionId: "b", repository: repositoryB },
      ], async () => {
        completed.push("reciprocal");
      });

      await Promise.race([
        Promise.all([first, reciprocal]),
        new Promise<never>((_resolve, reject) => setTimeout(
          () => reject(new Error("reciprocal_conversation_authority_lease_deadlock")),
          1_000,
        )),
      ]);
      expect(completed.sort()).toEqual(["first", "reciprocal"]);
      expect(fs.existsSync(path.join(root, "a"))).toBe(false);
      expect(fs.existsSync(path.join(root, "b"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses a durable target claim to reject a conflicting transaction before journal or head publication", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-fork-claim-cas-"));
    try {
      const first = plannedGeneration();
      const conflicting = plannedGeneration("2026-09-01T01:00:01.000Z");
      let interrupted = false;
      const firstProcess = new LocalFileConversationPersistenceRepository(sessionDir, {
        conversationForkInitializationFault(point) {
          if (!interrupted && point === "after-claim-cas") {
            interrupted = true;
            throw new Error("simulated_process_exit_after_claim");
          }
        },
      });
      await expect(firstProcess.commitConversationForkInitialization(first))
        .rejects.toThrow("simulated_process_exit_after_claim");

      const competingProcess = new LocalFileConversationPersistenceRepository(sessionDir);
      await expect(competingProcess.commitConversationForkInitialization(conflicting))
        .rejects.toThrow("conversation_fork_initialization_claim_cas_conflict");
      expect(await competingProcess.loadConversationForkHead()).toBeNull();

      await competingProcess.commitConversationForkInitialization(first);
      expect((await competingProcess.loadConversationForkHead())?.transactionId).toBe(first.transactionId);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});

describe("Conversation repair evidence and dry-run", () => {
  it("binds explicit parent/child authority, planned heads and every child tail mapping without writing", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-repair-dry-run-"));
    try {
      const source = fixture();
      const target = brokenChildFixture();
      await persistSnapshot(root, "parent", source);
      await persistSnapshot(root, "child", target);
      const port = createConversationSessionForkPort({
        owner: { sessionId: "parent", actorKey: "main", actorId: "parent-actor" },
        repositoryFactory: { createRepository: (sessionDir) => new LocalFileConversationPersistenceRepository(sessionDir) },
        resolveSessionDir: (sessionId) => path.join(root, sessionId),
        createChildActorId: () => "unused",
        runExclusive: async (_sessionId, action) => await action(),
      });
      const before = JSON.stringify(target);
      const result = await port.repair({
        schemaVersion: "conversation.session-repair-command/v1",
        sourceSessionId: "parent",
        targetSessionId: "child",
        actorKey: "main",
        selector: { kind: "current_head" },
        expectedSourceAuthorityDigest: digestConversationForkSourceAuthority(source),
        expectedTargetAuthorityDigest: digestConversationForkSourceAuthority(target),
        dryRun: true,
        occurredAt,
      });
      expect(result.status).toBe("dry_run");
      if (result.status !== "dry_run") return;
      expect(result.receipt.repairEvidence).toMatchObject({
        expectedTargetAuthorityDigest: digestConversationForkSourceAuthority(target),
        targetHeads: {
          historyHeadGenerationId: "main__active",
          promptHeadGenerationId: "child-prompt",
        },
      });
      expect(result.receipt.repairEvidence?.plannedHeads.historyHeadGenerationId).not.toBe("main__active");
      expect(result.receipt.repairEvidence?.tailMapping).toHaveLength(1);
      expect(result.receipt.repairEvidence?.tailMapping[0]).toMatchObject({
        sourceGenerationId: "main__active",
        sourceRecordId: "child-tail-record-0",
        sourceMessageId: "child-tail-message-0",
      });
      const childRepository = new LocalFileConversationPersistenceRepository(path.join(root, "child"));
      expect(await childRepository.loadConversationForkHead()).toBeNull();
      expect({
        historyIndex: await childRepository.loadHistoryIndex(),
        promptIndex: await childRepository.loadPromptIndex(),
        sessionIndex: await childRepository.loadSessionIndex(),
        artifactRefs: await childRepository.loadArtifactRefs(),
        historyGenerations: [await childRepository.loadHistoryGeneration("main__active")],
        promptGenerations: [await childRepository.loadPromptGeneration("child-prompt")],
      }).toEqual(JSON.parse(before));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects stale or incomplete repair evidence without producing a transaction", () => {
    const source = fixture();
    const target = brokenChildFixture();
    const result = planConversationSessionRepair({
      command: {
        schemaVersion: "conversation.session-repair-command/v1",
        sourceSessionId: "parent",
        targetSessionId: "child",
        actorKey: "main",
        selector: { kind: "current_head" },
        expectedSourceAuthorityDigest: digestConversationForkSourceAuthority(source),
        expectedTargetAuthorityDigest: digestProviderContextClosedValue({ stale: true }),
        dryRun: true,
        occurredAt,
      },
      source,
      target,
    });
    expect(result).toMatchObject({ status: "rejected", rejection: { code: "TARGET_AUTHORITY_CHANGED" } });
  });

  it("atomically grafts the parent base before the child tail, clears optimization state and retries idempotently", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-repair-commit-"));
    try {
      const source = fixture();
      const target = brokenChildFixture();
      await persistSnapshot(root, "parent", source);
      await persistSnapshot(root, "child", target);
      const command = {
        schemaVersion: "conversation.session-repair-command/v1" as const,
        sourceSessionId: "parent",
        targetSessionId: "child",
        actorKey: "main",
        selector: { kind: "current_head" as const },
        expectedSourceAuthorityDigest: digestConversationForkSourceAuthority(source),
        expectedTargetAuthorityDigest: digestConversationForkSourceAuthority(target),
        dryRun: false,
        occurredAt,
      };
      const port = createConversationSessionForkPort({
        owner: { sessionId: "parent", actorKey: "main", actorId: "parent-actor" },
        repositoryFactory: { createRepository: (sessionDir) => new LocalFileConversationPersistenceRepository(sessionDir) },
        resolveSessionDir: (sessionId) => path.join(root, sessionId),
        createChildActorId: () => "unused",
        runExclusive: async (_sessionId, action) => await action(),
      });
      const first = await port.repair(command);
      const retry = await port.repair(command);
      expect(first.status).toBe("committed");
      expect(retry.status).toBe("committed");
      if (first.status !== "committed" || retry.status !== "committed") return;
      expect(retry.receipt.transactionId).toBe(first.receipt.transactionId);

      const fresh = new LocalFileConversationPersistenceRepository(path.join(root, "child"));
      const [historyIndex, sessionIndex] = await Promise.all([
        fresh.loadHistoryIndex(),
        fresh.loadSessionIndex(),
      ]);
      const repaired = await fresh.loadHistoryGeneration(historyIndex.heads.main!.activeGenerationId!);
      expect(repaired?.messages.map((entry) => entry.message.messageId))
        .toEqual(["message-0", "message-1", "child-tail-message-0"]);
      const binding = sessionIndex.session.actorBindings.main!;
      expect(binding.providerEpochReceiptV2).toMatchObject({
        epoch: 2,
        previousReceiptDigest: target.sessionIndex.session.actorBindings.main!.providerEpochReceiptV2!.receiptDigest,
        reason: "history_rewind_or_fork",
      });
      expect(binding.providerRequestAdmissions).toEqual([]);
      expect(binding.providerContextFactHead).toBeNull();
      expect(sessionIndex.lineage).toMatchObject({ parentSessionId: "parent" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a changed child authority at the atomic repair CAS", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "conversation-repair-cas-"));
    try {
      const source = fixture();
      const target = brokenChildFixture();
      await persistSnapshot(root, "child", target);
      const planned = planConversationSessionRepair({
        command: {
          schemaVersion: "conversation.session-repair-command/v1",
          sourceSessionId: "parent",
          targetSessionId: "child",
          actorKey: "main",
          selector: { kind: "current_head" },
          expectedSourceAuthorityDigest: digestConversationForkSourceAuthority(source),
          expectedTargetAuthorityDigest: digestConversationForkSourceAuthority(target),
          dryRun: false,
          occurredAt,
        },
        source,
        target,
      });
      expect(planned.status).toBe("planned");
      if (planned.status !== "planned") return;
      const repository = new LocalFileConversationPersistenceRepository(path.join(root, "child"));
      await repository.writeSessionIndex({
        ...target.sessionIndex,
        updatedAt: "2026-09-01T01:01:00.000Z",
      });
      await expect(repository.commitConversationForkInitialization(planned.generation))
        .rejects.toThrow("conversation_fork_repair_target_authority_cas_conflict");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
