import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  ActorHistoryGenerationData,
  ActorPromptGenerationData,
  ConversationPersistenceRepository,
  ConversationSessionRawState,
} from "@cell/ai-organ-contract";
import { CONVERSATION_PERSISTENCE_SCHEMA_VERSION as version } from "@cell/ai-organ-contract";
import {
  chatMessagesToCommittedHistoryRefs,
  materializeConversationRuntimePrompt,
  materializeConversationVisibleHistory,
  materializeConversationVisibleMessages,
} from "../src/ConversationProjection";
import {
  loadConversationActorRawState,
  loadConversationSessionRawState,
} from "../src/ConversationRecovery";

const timestamp = "2026-09-05T00:00:00.000Z";
const sessionId = "persisted-id";
const actorKey = "main";
const actorId = "actor-main";

function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeDeep);
    Object.freeze(value);
  }
  return value;
}

function fixture() {
  const history: ActorHistoryGenerationData = {
    version, sessionId, actorKey, actorId, generationId: "history",
    parentGenerationId: null, predecessorGenerationIds: [], createdReason: "append",
    sealed: false, createdAt: timestamp, updatedAt: timestamp, messageCount: 2,
    messages: chatMessagesToCommittedHistoryRefs({
      actorKey, actorId, recordIdPrefix: "history",
      messages: [
        { role: "assistant", content: "Checking", reasoning_content: "Think", toolCalls: [{ id: "call", name: "read", input: {} }] },
        { role: "tool", content: "result", tool_call_id: "call" },
      ],
    }),
  };
  const prompt: ActorPromptGenerationData = {
    version, sessionId, actorKey, actorId, promptGenerationId: "prompt",
    basedOnPromptGenerationId: null, createdReason: "request_build", sealed: false,
    createdAt: timestamp, updatedAt: timestamp, sealedAt: null, materializedContext: "summary",
    basis: { version, basisHistoryGenerationIds: ["history"], basisMessageRecordIds: [] },
    metadata: { systemPrompts: [" system ", "system"] },
    transforms: [{
      transformId: "late", kind: "overlay", appliedAt: timestamp,
      payload: { insertPlacement: "late_status", content: "status" },
    }],
  };
  const session = {
    version, sessionId, activeActorKey: actorKey,
    actorBindings: { main: { actorKey, actorId, boundAt: timestamp, historyHeadGenerationId: "history", promptHeadGenerationId: "prompt" } },
    contextAssetRegistry: null, contextAssets: [], activeSelection: null,
    createdAt: timestamp, updatedAt: timestamp,
  };
  const rawSession: ConversationSessionRawState = {
    ...session, lineage: null,
    sessionIndex: { version, sessionId, session, lineage: null, updatedAt: timestamp },
    historyIndex: {
      version, sessionId, heads: {}, lineages: {},
      generations: { history: { generationId: "history", actorKey, actorId, sealed: false, createdAt: timestamp, updatedAt: timestamp } },
      updatedAt: timestamp,
    },
    promptIndex: { version, sessionId, heads: {}, generations: {}, updatedAt: timestamp },
  };
  return { history, prompt, rawSession };
}

function repositoryReads(data: ReturnType<typeof fixture>) {
  const calls: string[] = [];
  const reads = {
    loadSessionIndex: async () => { calls.push("session"); return data.rawSession.sessionIndex; },
    loadHistoryIndex: async () => { calls.push("history-index"); return data.rawSession.historyIndex; },
    loadPromptIndex: async () => { calls.push("prompt-index"); return data.rawSession.promptIndex; },
    loadHistoryGeneration: async (id: string) => { calls.push(`history:${id}`); return id === "history" ? data.history : null; },
    loadPromptGeneration: async (id: string) => { calls.push(`prompt:${id}`); return id === "prompt" ? data.prompt : null; },
  };
  // Any write or undeclared capability access fails immediately.
  const repository = new Proxy(reads, {
    get(target, property) {
      if (!(property in target)) throw new Error(`unexpected repository capability: ${String(property)}`);
      return Reflect.get(target, property);
    },
  }) as ConversationPersistenceRepository;
  return { repository, calls };
}

describe("conversation lower-logic boundary", () => {
  it("orders legacy visible memberships by envelopes so a predecessor cannot overwrite the active body", async () => {
    const data = fixture();
    const old = structuredClone(data.history);
    old.generationId = "old";
    old.messages[1]!.message.content = "old result";
    data.history.predecessorGenerationIds = ["old"];
    data.rawSession.historyIndex.heads.main = { version, sessionId, actorKey, actorId, activeGenerationId: "history", visibleGenerationIds: ["history", "old"], updatedAt: timestamp };
    const { repository } = repositoryReads(data);
    const reads = new Proxy(repository, { get(target, key) {
      if (key === "loadHistoryGeneration") return async (id: string) => id === "old" ? old : id === "history" ? data.history : null;
      return Reflect.get(target, key);
    } });
    const raw = await loadConversationActorRawState({ sessionDir: "/nonexistent/session", repository: reads });
    expect(raw!.visibleGenerationIds).toEqual(["old", "history"]);
    expect(materializeConversationVisibleHistory(raw!).at(-1)?.content).toBe("result");
    expect(data.rawSession.historyIndex.lineages).toEqual({});
  });

  it("recovers solely through injected reads and retains directory-basename session identity", async () => {
    const data = freezeDeep(fixture());
    const { repository, calls } = repositoryReads(data);
    const params = { sessionDir: "/nonexistent/conversation/path-session/", repository };
    const session = await loadConversationSessionRawState(params);
    expect(session.sessionId).toBe("path-session");
    expect(session.sessionIndex.sessionId).toBe("persisted-id");
    expect(calls).toEqual(["session", "history-index", "prompt-index"]);
    calls.length = 0;
    const raw = await loadConversationActorRawState(params);
    expect(raw?.actorKey).toBe(actorKey);
    expect(raw?.activeHistoryGeneration).toBe(data.history);
    expect(raw?.promptGeneration).toBe(data.prompt);
    expect(calls).toEqual(["session", "history-index", "prompt-index", "prompt:prompt", "history:history", "history:history"]);
  });

  it("projects frozen recovery materials repeatedly without changing authority or splitting tool pairs", async () => {
    const data = freezeDeep(fixture());
    const { repository } = repositoryReads(data);
    const raw = freezeDeep((await loadConversationActorRawState({ sessionDir: "/unavailable/session", repository }))!);
    const before = JSON.stringify(raw);
    const messages = materializeConversationRuntimePrompt(raw);
    expect(messages.map(({ role, content }) => [role, content])).toEqual([
      ["system", "system"], ["system", "status"], ["user", "summary"],
      ["assistant", "Checking"], ["tool", "result"],
    ]);
    expect(messages[3].toolCalls?.[0].id).toBe(messages[4].toolCallId);
    expect(messages[3]).toMatchObject({ content_parts: [{ type: "reasoning", text: "Think" }, { type: "text", text: "Checking" }] });
    expect(materializeConversationRuntimePrompt(raw)).toEqual(messages);
    expect(materializeConversationVisibleHistory(raw).map(({ role }) => role)).toEqual(["assistant", "tool"]);
    expect(materializeConversationVisibleMessages(raw).map(({ role }) => role)).toEqual(["user", "assistant", "tool"]);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it("keeps selected domain cores and recovery independent of concrete support", () => {
    const packagesRoot = path.resolve(import.meta.dir, "../..");
    const files = [
      "ai-organ-logic/src/conversationCapsule/internals/domainRuntime.ts",
      "ai-organ-logic/src/conversationCapsule/internals/derivations.ts",
      "ai-persistence-logic/src/ConversationProjection.ts",
      "ai-persistence-logic/src/ConversationRecovery.ts",
    ];
    for (const file of files) {
      const source = readFileSync(path.join(packagesRoot, file), "utf8");
      expect(source, file).not.toMatch(/(?:from\s*|import\s*\()\s*["'][^"']*(?:ai-support|LocalFileConversationPersistenceRepository)/);
    }
    const projection = readFileSync(path.join(packagesRoot, files[2]), "utf8");
    expect(projection).not.toMatch(/node:(?:fs|path|http|net|child_process)|Date\.now|new Date|Math\.random|process\.env|fetch\s*\(/);
    expect(projection).not.toMatch(/repository\s*\./);
  });

  it("retains support compatibility exports as the same lower-level functions", async () => {
    const support = await import("../../ai-support/src/conversation/local/LocalConversationRuntime");
    expect(support.materializeConversationRuntimePrompt).toBe(materializeConversationRuntimePrompt);
    expect(support.chatMessagesToCommittedHistoryRefs).toBe(chatMessagesToCommittedHistoryRefs);
    expect(support.loadConversationActorRawState).toBe(loadConversationActorRawState);
  });
});
