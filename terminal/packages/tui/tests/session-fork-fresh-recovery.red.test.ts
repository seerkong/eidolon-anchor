import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "bun:test";
import { CONVERSATION_PERSISTENCE_SCHEMA_VERSION } from "@cell/ai-organ-contract";
import {
  chatMessagesToCommittedHistoryRefs,
  LocalFileConversationPersistenceRepositoryFactory,
  loadConversationRuntimeMessages,
} from "@cell/ai-support";
import {
  createProviderEpochReceiptV2,
  digestProviderContextClosedValue,
  digestProviderContextHistoryFrontier,
} from "@cell/ai-organ-logic";
import { runHeadlessConversationFork } from "../../organ-support/src/headless";

import { createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient";
import {
  __setLlmAdapterFactoryForTest,
  configureTuiRuntime,
  disposeTuiRuntimeBridge,
  getTuiRuntimeBridge,
} from "../src/runtime/bridge/TuiRuntime";

function configureForkRuntime(workDir: string) {
  configureTuiRuntime({
    workDir,
    adapter: "openai",
    model: "gpt-4o-mini",
    debug: false,
    mcp: false,
  });
  __setLlmAdapterFactoryForTest(async () => ({
    type: "openai" as const,
    async createStream() {
      throw new Error("provider transport is not expected during fork");
    },
  }));
}

async function seedForkableParent(workDir: string, sessionId: string) {
  const sessionDir = path.join(workDir, ".eidolon", "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);
  const actorKey = "main";
  const actorId = "actor-parent";
  const historyGenerationId = "parent-history";
  const promptGenerationId = "parent-prompt";
  const occurredAt = "2026-09-01T00:00:00.000Z";
  const messages = chatMessagesToCommittedHistoryRefs({
    actorKey,
    actorId,
    recordIdPrefix: historyGenerationId,
    messages: [
      { role: "user", content: "fork this persisted session", messageId: "parent-user" },
      { role: "assistant", content: "forked history should survive", messageId: "parent-assistant" },
    ] as any[],
  });
  const emptyDigest = digestProviderContextClosedValue([]);
  const receipt = createProviderEpochReceiptV2({
    sessionId,
    actorKey,
    actorId,
    epoch: 0,
    previousReceiptDigest: null,
    targetProviderId: "deepseek-iqingwa",
    targetModelId: "deepseek-v4-pro",
    targetProfileId: "deepseek-chat@1",
    baselineHeads: {
      historyHeadGenerationId: historyGenerationId,
      promptHeadGenerationId: promptGenerationId,
      factHeadDigest: null,
    },
    sourceHistoryMessageCount: messages.length,
    sourceFrontierDigest: digestProviderContextHistoryFrontier(messages),
    pendingDeliveryDigest: emptyDigest,
    handoffDigest: digestProviderContextClosedValue({ historyGenerationId, promptGenerationId }),
    frozenResourceDigest: emptyDigest,
    providerSurfaceDigest: emptyDigest,
    retentionPolicy: { maxRevisionsPerNamespace: 8, maxCanonicalFactBytesPerEpoch: 262_144 },
    reason: "initial_projection",
    compactionProofDigest: null,
    createdAt: occurredAt,
  });

  await repository.writeHistoryGeneration({
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    generationId: historyGenerationId,
    sessionId,
    actorKey,
    actorId,
    parentGenerationId: null,
    predecessorGenerationIds: [],
    createdReason: "bootstrap",
    sealed: false,
    messageCount: messages.length,
    messages,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
  await repository.writePromptGeneration({
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    promptGenerationId,
    sessionId,
    actorKey,
    actorId,
    basedOnPromptGenerationId: null,
    basis: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      basisHistoryGenerationIds: [historyGenerationId],
      basisMessageRecordIds: [],
      basisRefs: [{ refKind: "history_generation", refId: historyGenerationId }],
    },
    transforms: [],
    createdReason: "request_build",
    materializedContext: null,
    sealed: false,
    createdAt: occurredAt,
    sealedAt: null,
    updatedAt: occurredAt,
    metadata: { systemPrompts: ["stable child system prefix"] },
  });
  await repository.writeHistoryIndex({
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    heads: {
      [actorKey]: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        sessionId,
        actorKey,
        actorId,
        activeGenerationId: historyGenerationId,
        visibleGenerationIds: [historyGenerationId],
        updatedAt: occurredAt,
      },
    },
    lineages: {
      [historyGenerationId]: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        sessionId,
        actorKey,
        actorId,
        generationId: historyGenerationId,
        parentGenerationId: null,
        rolledBackFromGenerationId: null,
        predecessorGenerationIds: [],
        successorGenerationIds: [],
        forkGenerationIds: [],
        branchLabel: null,
        updatedAt: occurredAt,
      },
    },
    generations: {
      [historyGenerationId]: {
        generationId: historyGenerationId,
        actorKey,
        actorId,
        sealed: false,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
    },
    updatedAt: occurredAt,
  });
  await repository.writePromptIndex({
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    heads: {
      [actorKey]: {
        version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
        sessionId,
        actorKey,
        actorId,
        activePromptGenerationId: promptGenerationId,
        updatedAt: occurredAt,
      },
    },
    generations: {
      [promptGenerationId]: {
        promptGenerationId,
        actorKey,
        actorId,
        sealed: false,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
    },
    updatedAt: occurredAt,
  });
  await repository.writeSessionIndex({
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    session: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      activeActorKey: actorKey,
      actorBindings: {
        [actorKey]: {
          actorKey,
          actorId,
          boundAt: occurredAt,
          historyHeadGenerationId: historyGenerationId,
          promptHeadGenerationId: promptGenerationId,
          contextEpoch: 0,
          providerEpochReceiptV2: receipt,
          providerRequestAdmissions: [],
          providerContextFactHead: null,
        },
      },
      contextAssetRegistry: null,
      contextAssets: [],
      activeSelection: {
        sessionId,
        activeActorKey: actorKey,
        historyHeadGenerationId: historyGenerationId,
        promptHeadGenerationId: promptGenerationId,
        selectedAt: occurredAt,
      },
      createdAt: occurredAt,
      updatedAt: occurredAt,
    },
    lineage: null,
    updatedAt: occurredAt,
  });
  return { actorKey };
}

function textParts(result: Awaited<ReturnType<ReturnType<typeof createTuiRuntimeClient>["client"]["session"]["messages"]>>) {
  return result.data?.flatMap((entry) => entry.parts.flatMap((part) => part.type === "text" ? [part.text] : [])) ?? [];
}

describe("Conversation-native current-head fork RED", () => {
  it("persists child History so a fresh client does not rely on the creating client's clone", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-fork-red-"));
    try {
      const sourceSessionId = "source-current-head";
      configureForkRuntime(workDir);
      await seedForkableParent(workDir, sourceSessionId);
      const creatingClient = createTuiRuntimeClient({ mode: "local-runtime", directory: workDir });
      const forked = await creatingClient.client.session.fork({ sessionID: sourceSessionId });
      expect(textParts(await creatingClient.client.session.messages({ sessionID: forked.data!.id })))
        .toContain("fork this persisted session");

      const freshClient = createTuiRuntimeClient({ mode: "local-runtime", directory: workDir });
      const freshTexts = textParts(await freshClient.client.session.messages({ sessionID: forked.data!.id }));
      expect(freshTexts).toContain("fork this persisted session");
      expect(freshTexts).toContain("forked history should survive");
    } finally {
      __setLlmAdapterFactoryForTest(null);
      await disposeTuiRuntimeBridge("source-current-head");
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("materializes the first child provider context from child canonical authority", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-fork-provider-red-"));
    try {
      const sourceSessionId = "source-provider-context";
      configureForkRuntime(workDir);
      const { actorKey } = await seedForkableParent(workDir, sourceSessionId);
      const creatingClient = createTuiRuntimeClient({ mode: "local-runtime", directory: workDir });
      const forked = await creatingClient.client.session.fork({ sessionID: sourceSessionId });
      const childSessionDir = path.join(workDir, ".eidolon", "sessions", forked.data!.id);
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(childSessionDir);
      const provider = await loadConversationRuntimeMessages({ sessionDir: childSessionDir, actorKey, repository });
      expect(provider.messages.map((message) => String(message.content))).toEqual([
        "stable child system prefix",
        "fork this persisted session",
        "forked history should survive",
      ]);
    } finally {
      __setLlmAdapterFactoryForTest(null);
      await disposeTuiRuntimeBridge("source-provider-context");
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("uses the same Conversation-owned command from the headless surface", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-headless-fork-"));
    const sourceSessionId = "source-headless";
    const targetSessionId = "child-headless";
    try {
      configureForkRuntime(workDir);
      await seedForkableParent(workDir, sourceSessionId);
      const result = await runHeadlessConversationFork({
        workDir,
        sourceSessionId,
        targetSessionId,
        adapter: "openai",
        model: "gpt-4o-mini",
        mcp: false,
        occurredAt: "2026-09-01T00:01:00.000Z",
      });
      expect(result).toMatchObject({
        status: "committed",
        receipt: { mode: "create", sourceSessionId, targetSessionId },
      });
      const freshClient = createTuiRuntimeClient({ mode: "local-runtime", directory: workDir });
      expect(textParts(await freshClient.client.session.messages({ sessionID: targetSessionId }))).toEqual([
        "fork this persisted session",
        "forked history should survive",
      ]);
    } finally {
      __setLlmAdapterFactoryForTest(null);
      await disposeTuiRuntimeBridge(sourceSessionId);
      await disposeTuiRuntimeBridge(targetSessionId);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("captures the first child wire request as a new epoch without parent continuation state", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-fork-first-wire-"));
    const sourceSessionId = "source-first-wire";
    let childSessionId: string | null = null;
    try {
      configureForkRuntime(workDir);
      const { actorKey } = await seedForkableParent(workDir, sourceSessionId);
      const creatingClient = createTuiRuntimeClient({ mode: "local-runtime", directory: workDir });
      const forked = await creatingClient.client.session.fork({ sessionID: sourceSessionId });
      childSessionId = forked.data!.id;
      const childSessionDir = path.join(workDir, ".eidolon", "sessions", childSessionId);
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(childSessionDir);
      const childBefore = await repository.loadSessionIndex();
      const childBinding = childBefore.session.actorBindings[actorKey]!;
      const parentRepository = LocalFileConversationPersistenceRepositoryFactory.createRepository(
        path.join(workDir, ".eidolon", "sessions", sourceSessionId),
      );
      const parentBinding = (await parentRepository.loadSessionIndex()).session.actorBindings[actorKey]!;
      expect(childBinding.providerEpochReceiptV2).toMatchObject({
        epoch: 0,
        previousReceiptDigest: null,
        reason: "history_rewind_or_fork",
      });
      expect(childBinding.providerEpochReceiptV2?.receiptDigest)
        .not.toBe(parentBinding.providerEpochReceiptV2?.receiptDigest);
      expect(childBinding.providerRequestAdmissions).toEqual([]);
      expect(childBinding.providerContextFactHead).toBeNull();

      let captured: Record<string, unknown> | null = null;
      __setLlmAdapterFactoryForTest(async () => ({
        type: "openai" as const,
        async createStream(options: Record<string, unknown>) {
          captured = options;
          async function* stream() {
            yield { choices: [{ delta: { content: "continued from fork" } }] } as any;
          }
          return { stream: stream() };
        },
      }));
      const childRuntime = await getTuiRuntimeBridge(childSessionId);
      await childRuntime!.turn("continue from the durable fork");
      expect(captured).not.toBeNull();
      const wireMessages = ((captured as any)?.messages ?? []) as Array<{ role?: string; content?: unknown }>;
      const wireTexts = wireMessages.map((message) => (
        typeof message.content === "string" ? message.content : JSON.stringify(message.content)
      ));
      const parentUserIndex = wireTexts.indexOf("fork this persisted session");
      const parentAssistantIndex = wireTexts.indexOf("forked history should survive");
      const continueIndex = wireTexts.findIndex((text) => text.includes("continue from the durable fork"));
      expect(wireMessages[0]?.role).toBe("system");
      expect(parentUserIndex).toBeGreaterThan(0);
      expect(parentAssistantIndex).toBe(parentUserIndex + 1);
      expect(continueIndex).toBeGreaterThan(parentAssistantIndex);
      const wire = JSON.stringify(captured);
      expect(wire).not.toContain("previousResponseId");
      expect(wire).not.toContain("previous_response_id");
      expect(wire).not.toContain("replayCheckpoint");
      expect(wire).not.toContain(parentBinding.providerEpochReceiptV2!.receiptDigest);
      await childRuntime!.abort();
    } finally {
      __setLlmAdapterFactoryForTest(null);
      await disposeTuiRuntimeBridge(sourceSessionId);
      if (childSessionId) await disposeTuiRuntimeBridge(childSessionId);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("forks through the selected canonical message instead of a surface array index", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-message-fork-"));
    const sourceSessionId = "source-message-cutoff";
    try {
      configureForkRuntime(workDir);
      await seedForkableParent(workDir, sourceSessionId);
      const client = createTuiRuntimeClient({ mode: "local-runtime", directory: workDir });
      const forked = await client.client.session.fork({ sessionID: sourceSessionId, messageID: "parent-user" });
      expect(forked.error).toBeUndefined();
      const fresh = createTuiRuntimeClient({ mode: "local-runtime", directory: workDir });
      expect(textParts(await fresh.client.session.messages({ sessionID: forked.data!.id }))).toEqual([
        "fork this persisted session",
      ]);
    } finally {
      __setLlmAdapterFactoryForTest(null);
      await disposeTuiRuntimeBridge(sourceSessionId);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("rejects an unknown message id without current-head fallback or ghost child", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-message-fork-reject-"));
    const sourceSessionId = "source-message-reject";
    try {
      configureForkRuntime(workDir);
      await seedForkableParent(workDir, sourceSessionId);
      const sessionsDir = path.join(workDir, ".eidolon", "sessions");
      const before = fs.readdirSync(sessionsDir).sort();
      const client = createTuiRuntimeClient({ mode: "local-runtime", directory: workDir });
      const toastMessages: string[] = [];
      const unsubscribe = client.event.on("tui.toast.show", (event) => {
        toastMessages.push(String(event.properties?.message ?? ""));
      });
      const result = await client.client.session.fork({ sessionID: sourceSessionId, messageID: "display-only-id" });
      unsubscribe();
      expect(result.data).toBeUndefined();
      expect(result.error).toMatchObject({ code: "MESSAGE_NOT_FOUND" });
      expect(toastMessages).toEqual([
        expect.stringContaining("Fork failed [MESSAGE_NOT_FOUND]"),
      ]);
      expect(fs.readdirSync(sessionsDir).sort()).toEqual(before);
      expect((await client.client.session.list({})).data?.map((session) => session.id)).toEqual([sourceSessionId]);
    } finally {
      __setLlmAdapterFactoryForTest(null);
      await disposeTuiRuntimeBridge(sourceSessionId);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe("Conversation-native same-session rewind", () => {
  it("excludes the abandoned future from same-process and fresh-restart provider context", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-rewind-provider-"));
    const sessionId = "source-rewind";
    let captured: Record<string, unknown> | null = null;
    try {
      configureForkRuntime(workDir);
      await seedForkableParent(workDir, sessionId);
      __setLlmAdapterFactoryForTest(async () => ({
        type: "openai" as const,
        async createStream(options: Record<string, unknown>) {
          captured = options;
          async function* stream() {
            yield { choices: [{ delta: { content: "D-answer" } }] } as any;
          }
          return { stream: stream() };
        },
      }));

      const client = createTuiRuntimeClient({ mode: "local-runtime", directory: workDir });
      const rewound = await client.client.session.revert({ sessionID: sessionId, messageID: "parent-user" });
      expect(rewound.error).toBeUndefined();
      expect(textParts(await client.client.session.messages({ sessionID: sessionId }))).toEqual([
        "fork this persisted session",
      ]);
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(
        path.join(workDir, ".eidolon", "sessions", sessionId),
      );
      expect((await repository.loadSessionIndex()).session.actorBindings.main?.providerEpochReceiptV2?.reason)
        .toBe("history_rewind_or_fork");

      await client.client.session.prompt({
        sessionID: sessionId,
        messageID: "message-d",
        parts: [{ id: "part-d", sessionID: sessionId, messageID: "message-d", type: "text", text: "D" } as any],
      });
      const wire = JSON.stringify(captured);
      expect(wire).toContain("fork this persisted session");
      expect(wire).toContain("D");
      expect(wire).not.toContain("forked history should survive");

      await disposeTuiRuntimeBridge(sessionId);
      const fresh = createTuiRuntimeClient({ mode: "local-runtime", directory: workDir });
      const freshText = textParts(await fresh.client.session.messages({ sessionID: sessionId }));
      expect(freshText).toContain("fork this persisted session");
      expect(freshText).toContain("D");
      expect(freshText).not.toContain("forked history should survive");
    } finally {
      __setLlmAdapterFactoryForTest(null);
      await disposeTuiRuntimeBridge(sessionId);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("keeps UI and authority unchanged when the canonical message id is missing", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-rewind-reject-"));
    const sessionId = "source-rewind-reject";
    try {
      configureForkRuntime(workDir);
      await seedForkableParent(workDir, sessionId);
      const client = createTuiRuntimeClient({ mode: "local-runtime", directory: workDir });
      const before = textParts(await client.client.session.messages({ sessionID: sessionId }));
      const result = await client.client.session.revert({ sessionID: sessionId, messageID: "display-only-id" });
      expect(result.error).toMatchObject({ code: "MESSAGE_NOT_FOUND" });
      expect(textParts(await client.client.session.messages({ sessionID: sessionId }))).toEqual(before);
    } finally {
      __setLlmAdapterFactoryForTest(null);
      await disposeTuiRuntimeBridge(sessionId);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("rejects local-runtime unrevert without inventing a non-durable redo branch", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-unrevert-reject-"));
    const sessionId = "source-unrevert-reject";
    try {
      configureForkRuntime(workDir);
      await seedForkableParent(workDir, sessionId);
      const client = createTuiRuntimeClient({ mode: "local-runtime", directory: workDir });
      const rewound = await client.client.session.revert({ sessionID: sessionId, messageID: "parent-user" });
      expect(rewound.error).toBeUndefined();
      const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(
        path.join(workDir, ".eidolon", "sessions", sessionId),
      );
      const beforeHead = (await repository.loadHistoryIndex()).heads.main?.activeGenerationId;
      const beforeMessages = textParts(await client.client.session.messages({ sessionID: sessionId }));

      const result = await client.client.session.unrevert({ sessionID: sessionId });

      expect(result.error).toMatchObject({ code: "UNREVERT_UNSUPPORTED" });
      expect(textParts(await client.client.session.messages({ sessionID: sessionId }))).toEqual(beforeMessages);
      expect((await repository.loadHistoryIndex()).heads.main?.activeGenerationId).toBe(beforeHead);
    } finally {
      __setLlmAdapterFactoryForTest(null);
      await disposeTuiRuntimeBridge(sessionId);
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
