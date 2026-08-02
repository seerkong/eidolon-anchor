import { describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  applyCheapCompactionPipeline,
  compressHistory,
  findSplitPoint,
  loadCompressionPrompt,
} from "@cell/ai-organ-logic/compression/ContextCompressor";

describe("context_compressor", () => {
  it("finds split point on user boundary while keeping last 4", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a2" },
      { role: "assistant", content: "a3" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a4" },
      { role: "assistant", content: "a5" },
    ];

    const split = findSplitPoint(messages);
    expect(split).toBe(2);
    expect(messages.slice(split).length).toBeGreaterThanOrEqual(4);
    expect(messages[split].role).toBe("user");
  });

  it("returns -1 when no valid split exists", () => {
    const messages = [
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
      { role: "assistant", content: "a3" },
      { role: "assistant", content: "a4" },
      { role: "assistant", content: "a5" },
    ];

    expect(findSplitPoint(messages)).toBe(-1);
  });

  it("falls back to an assistant tool-call boundary during a long autonomous turn", () => {
    const messages = [
      { role: "user", content: "implement the task" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "tc-old", type: "function", function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "tc-old", content: "old result" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "tc-recent-a", type: "function", function: { name: "edit", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "tc-recent-a", content: "recent result a" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "tc-recent-b", type: "function", function: { name: "bash", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "tc-recent-b", content: "recent result b" },
      { role: "user", content: "请继续" },
    ];

    const split = findSplitPoint(messages, 4);
    expect(split).toBe(3);
    expect(messages[split]?.role).toBe("assistant");
    expect(messages[split]?.tool_calls?.[0]?.id).toBe("tc-recent-a");
    expect(messages.slice(split).map((message) => message.tool_call_id).filter(Boolean)).toEqual([
      "tc-recent-a",
      "tc-recent-b",
    ]);
  });

  it("compacts a single-user autonomous turn while preserving a pending tool pair", async () => {
    const pendingCall = {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "tc-pending-autonomous",
        type: "function",
        function: { name: "DetachedActorResult", arguments: "{}" },
      }],
    };
    const pendingResult = {
      role: "tool",
      tool_call_id: "tc-pending-autonomous",
      content: "pending detached result",
    };
    const messages = [
      { role: "user", content: "implement the task" },
      ...Array.from({ length: 6 }, (_, index) => [
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `tc-autonomous-${index}`,
            type: "function",
            function: { name: "read", arguments: "{}" },
          }],
        },
        {
          role: "tool",
          tool_call_id: `tc-autonomous-${index}`,
          content: `old autonomous result ${index} `.repeat(200),
        },
      ]).flat(),
      pendingCall,
      pendingResult,
      { role: "user", content: "请继续" },
    ];
    let compressionCalls = 0;
    const llmAdapter = {
      type: "openai" as const,
      async createStream() {
        compressionCalls += 1;
        async function* stream() {
          yield {
            type: "text-delta",
            text: "<state_snapshot><overall_goal>continue autonomous task</overall_goal></state_snapshot>",
          };
        }
        return { stream: stream() };
      },
    };

    const compressed = await compressHistory({
      messages,
      llmAdapter,
      model: "mock-model",
      inputLimit: 10_000,
      recentKeep: 5,
      protectedToolCallIds: ["tc-pending-autonomous"],
    });

    expect(compressionCalls).toBe(1);
    expect(compressed).not.toBeNull();
    const pendingIndex = compressed!.indexOf(pendingCall);
    expect(pendingIndex).toBeGreaterThan(1);
    expect(compressed?.[pendingIndex + 1]).toBe(pendingResult);
    expect(compressed?.at(-1)?.content).toBe("请继续");
  });

  it("compresses successfully with mocked llm and processStream", async () => {
    const messages = [
      { role: "user", content: "A".repeat(300) },
      { role: "assistant", content: "B".repeat(300) },
      { role: "user", content: "C".repeat(300) },
      { role: "assistant", content: "recent-1" },
      { role: "user", content: "recent-2" },
      { role: "assistant", content: "recent-3" },
      { role: "assistant", content: "recent-4" },
    ];

    let called = false;
    const llmAdapter = {
      type: "openai" as const,
      async createStream(options: any) {
        called = true;
        expect(options.model).toBe("mock-model");
        expect(options.tools).toEqual([]);
        expect(options.extraBody).toEqual({ reasoning_split: false });
        expect(options.messages[0].role).toBe("system");
        expect(options.messages[0].content).toContain("<state_snapshot>");
        expect(options.messages[1].role).toBe("user");

        async function* stream() {
          yield { choices: [{ delta: { content: "unused" } }] };
        }

        return { stream: stream() };
      },
    };

    const compressed = await compressHistory({
      messages,
      llmAdapter,
      model: "mock-model",
      inputLimit: 1000,
      processStream: async () => ({
        content: "<state_snapshot><overall_goal></overall_goal><key_knowledge></key_knowledge><file_system_state></file_system_state><recent_actions></recent_actions><current_plan></current_plan></state_snapshot>",
      }),
    });

    expect(called).toBe(true);
    expect(compressed).not.toBeNull();
    expect(compressed?.[0].role).toBe("user");
    expect(compressed?.[0].content).toContain("<state_snapshot>");
    expect(compressed?.[1].role).toBe("assistant");
    expect(compressed?.slice(-4).map((m) => m.content)).toEqual(["recent-1", "recent-2", "recent-3", "recent-4"]);
  });

  it("keeps a protected pending assistant call and matching tool result unchanged in the tail", async () => {
    const pendingCall = {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "tc-pending-summary",
        type: "function",
        function: { name: "read", arguments: "{}" },
      }],
    };
    const pendingResult = {
      role: "tool",
      tool_call_id: "tc-pending-summary",
      content: "PENDING_SUMMARY_RESULT_".repeat(400),
    };
    const messages = [
      { role: "user", content: "old user ".repeat(500) },
      { role: "assistant", content: "old assistant ".repeat(500) },
      { role: "user", content: "request pending tool" },
      pendingCall,
      pendingResult,
      { role: "user", content: "recovered input 1" },
      { role: "assistant", content: "recovered status 1" },
      { role: "user", content: "recovered input 2" },
      { role: "assistant", content: "recovered status 2" },
    ];
    let compressionInput = "";
    const llmAdapter = {
      type: "openai" as const,
      async createStream(options: any) {
        compressionInput = String(options.messages?.[1]?.content ?? "");
        async function* stream() {
          yield {
            type: "text-delta",
            text: "<state_snapshot><overall_goal>protected</overall_goal></state_snapshot>",
          };
        }
        return { stream: stream() };
      },
    };

    const compressed = await compressHistory({
      messages,
      llmAdapter,
      model: "mock-model",
      inputLimit: 100_000,
      protectedToolCallIds: new Set(["tc-pending-summary"]),
    });

    expect(compressionInput).not.toContain("tc-pending-summary");
    expect(compressed).not.toBeNull();
    const callIndex = compressed!.findIndex((message) => (
      message?.role === "assistant"
      && message.tool_calls?.some((call: any) => call.id === "tc-pending-summary")
    ));
    expect(callIndex).toBeGreaterThan(1);
    expect(compressed?.[callIndex]).toBe(pendingCall);
    expect(compressed?.[callIndex + 1]).toBe(pendingResult);
  });

  it("keeps a protected committed message atomically outside the generated summary", async () => {
    const pendingMessage = {
      messageId: "message-pending-summary",
      role: "assistant",
      content: "DETACHED_COMPLETION_".repeat(400),
    };
    const messages = [
      { messageId: "old-user", role: "user", content: "old user ".repeat(500) },
      { messageId: "old-assistant", role: "assistant", content: "old assistant ".repeat(500) },
      { messageId: "pending-boundary", role: "user", content: "wait for detached completion" },
      pendingMessage,
      { messageId: "recovery-user-1", role: "user", content: "recovered input 1" },
      { messageId: "recovery-assistant-1", role: "assistant", content: "recovered status 1" },
      { messageId: "recovery-user-2", role: "user", content: "recovered input 2" },
      { messageId: "recovery-assistant-2", role: "assistant", content: "recovered status 2" },
    ];
    let compressionInput = "";
    const llmAdapter = {
      type: "openai" as const,
      async createStream(options: any) {
        compressionInput = String(options.messages?.[1]?.content ?? "");
        async function* stream() {
          yield {
            type: "text-delta",
            text: "<state_snapshot><overall_goal>protected message</overall_goal></state_snapshot>",
          };
        }
        return { stream: stream() };
      },
    };

    const compressed = await compressHistory({
      messages,
      llmAdapter,
      model: "mock-model",
      inputLimit: 100_000,
      protectedMessageIds: ["message-pending-summary"],
    });

    expect(compressionInput).not.toContain("DETACHED_COMPLETION_");
    expect(compressed).not.toBeNull();
    const pendingIndex = compressed!.findIndex((message) => (
      message?.messageId === "message-pending-summary"
    ));
    expect(pendingIndex).toBeGreaterThan(1);
    expect(compressed?.[pendingIndex]).toBe(pendingMessage);
    expect(compressed?.[pendingIndex]?.content).toBe(pendingMessage.content);
  });

  it("skips summary generation when the protected tail cannot fit the provider input limit", async () => {
    let createStreamCalls = 0;
    const llmAdapter = {
      type: "openai" as const,
      async createStream() {
        createStreamCalls += 1;
        async function* stream() {
          yield {
            type: "text-delta",
            text: "<state_snapshot><overall_goal>unreachable</overall_goal></state_snapshot>",
          };
        }
        return { stream: stream() };
      },
    };
    const messages = [
      { role: "user", content: "old user ".repeat(500) },
      { role: "assistant", content: "old assistant ".repeat(500) },
      { role: "user", content: "request pending tool" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "tc-too-large",
          type: "function",
          function: { name: "read", arguments: "{}" },
        }],
      },
      {
        role: "tool",
        tool_call_id: "tc-too-large",
        content: "UNSPLITTABLE_PENDING_RESULT_".repeat(2_000),
      },
      { role: "user", content: "recovered input 1" },
      { role: "assistant", content: "recovered status 1" },
      { role: "user", content: "recovered input 2" },
      { role: "assistant", content: "recovered status 2" },
    ];

    const compressed = await compressHistory({
      messages,
      llmAdapter,
      model: "mock-model",
      inputLimit: 1_000,
      protectedToolCallIds: ["tc-too-large"],
    });

    expect(compressed).toBeNull();
    expect(createStreamCalls).toBe(0);
  });

  it("returns null when llm call fails", async () => {
    const loggerCalls: any[] = [];
    const llmAdapter = {
      type: "openai" as const,
      async createStream() {
        throw new Error("boom");
      },
    };

    const result = await compressHistory({
      messages: [
        { role: "user", content: "x".repeat(200) },
        { role: "assistant", content: "y".repeat(200) },
        { role: "user", content: "z".repeat(200) },
        { role: "assistant", content: "r1" },
        { role: "user", content: "r2" },
        { role: "assistant", content: "r3" },
        { role: "assistant", content: "r4" },
      ],
      llmAdapter,
      model: "mock-model",
      inputLimit: 1000,
      logger: { warn: (...args: any[]) => loggerCalls.push(args) },
    });

    expect(result).toBeNull();
    expect(loggerCalls.length).toBeGreaterThan(0);
  });

  it("fits compression request history within the supplied token budget", async () => {
    let requestMessages: any[] | null = null;
    const llmAdapter = {
      type: "openai" as const,
      async createStream(options: any) {
        requestMessages = options.messages;
        async function* stream() {
          yield {
            choices: [{ delta: { content: "<state_snapshot><overall_goal>budgeted</overall_goal></state_snapshot>" } }],
          };
        }
        return { stream: stream() };
      },
    };

    const messages = [
      { role: "user", content: "old-a".repeat(400) },
      { role: "assistant", content: "old-b".repeat(400) },
      { role: "user", content: "old-c".repeat(400) },
      { role: "assistant", content: "recent" },
      { role: "user", content: "tail" },
      { role: "assistant", content: "tail ack" },
      { role: "user", content: "last" },
    ];

    const result = await compressHistory({
      messages,
      llmAdapter,
      model: "mock-model",
      inputLimit: 800,
      tokenBudget: 600,
    });

    expect(result?.[0]?.content).toContain("budgeted");
    const serializedOld = String(requestMessages?.[1]?.content ?? "");
    expect(serializedOld.length).toBeLessThan(JSON.stringify(messages.slice(0, 3), null, 2).length);
    expect(serializedOld).toContain("old-");
    expect(serializedOld).not.toContain("old-a");
  });

  it("returns null when compressed tokens are not smaller", async () => {
    const llmAdapter = {
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { choices: [{ delta: { content: "tiny" } }] };
        }
        return { stream: stream() };
      },
    };

    const messages = [
      { role: "user", content: "old-1" },
      { role: "assistant", content: "old-2" },
      { role: "user", content: "old-3" },
      { role: "assistant", content: "r1" },
      { role: "user", content: "r2" },
      { role: "assistant", content: "r3" },
      { role: "assistant", content: "r4" },
    ];

    const result = await compressHistory({
      messages,
      llmAdapter,
      model: "mock-model",
      inputLimit: 1000,
      processStream: async () => ({
        content:
          "<state_snapshot><overall_goal>" +
          "L".repeat(500) +
          "</overall_goal><key_knowledge></key_knowledge><file_system_state></file_system_state><recent_actions></recent_actions><current_plan></current_plan></state_snapshot>",
      }),
    });

    expect(result).toBeNull();
  });

  it("loads compression prompt from markdown file", () => {
    const prompt = loadCompressionPrompt();
    expect(prompt).toContain("<state_snapshot>");
  });

  it("persists oversized tool results before micro compacting older results", () => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-tool-results-"));
    const largeOutput = "FULL_OUTPUT_".repeat(200);
    const messages = [
      { role: "assistant", content: "", tool_calls: [{ id: "tc-big", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "tc-big", content: largeOutput },
      { role: "assistant", content: "", tool_calls: [{ id: "tc-small", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "tc-small", content: "small result" },
      { role: "assistant", content: "", tool_calls: [{ id: "tc-recent", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "tc-recent", content: "recent result" },
    ];

    const result = applyCheapCompactionPipeline(messages, {
      artifactDir,
      toolResultBudgetBytes: 100,
      toolResultPersistThresholdBytes: 100,
      toolResultPreviewChars: 24,
      microKeepRecentToolResults: 1,
      microMinContentChars: 10,
    });

    expect(result.changed).toBe(true);
    expect(result.stats.persistedToolResults).toBe(1);
    expect(result.stats.microCompactedToolResults).toBeGreaterThanOrEqual(1);
    const compactedBig = String(result.messages[1]?.content ?? "");
    expect(compactedBig).toContain("<compacted-tool-result");
    expect(compactedBig).toContain("delivered_and_compacted");
    expect(compactedBig).toContain("Do not repeat the same tool call solely because");
    expect(compactedBig).toContain("Full output persisted at:");
    const persistedPath = compactedBig.match(/Full output persisted at:\s*([^\n]+)/)?.[1]?.trim();
    expect(persistedPath).toBeTruthy();
    expect(fs.readFileSync(String(persistedPath), "utf8")).toBe(largeOutput);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("recent result");
  });

  it("keeps a preview for older compacted tool results instead of instructing a rerun", () => {
    const oldOutput = "READ_OUTPUT_LINE\n".repeat(200);
    const messages = [
      { role: "assistant", content: "", tool_calls: [{ id: "tc-read-old", type: "function", function: { name: "read", arguments: "{\"filePath\":\"scripts/build_tui_release.sh\",\"offset\":1,\"limit\":170}" } }] },
      { role: "tool", tool_call_id: "tc-read-old", content: oldOutput },
      { role: "assistant", content: "", tool_calls: [{ id: "tc-read-recent", type: "function", function: { name: "read", arguments: "{\"filePath\":\"scripts/build_tui_release.sh\",\"offset\":170,\"limit\":170}" } }] },
      { role: "tool", tool_call_id: "tc-read-recent", content: "recent output" },
    ];

    const result = applyCheapCompactionPipeline(messages, {
      toolResultBudgetBytes: 1_000_000,
      microKeepRecentToolResults: 1,
      microMinContentChars: 100,
      microPreviewChars: 80,
    });

    expect(result.changed).toBe(true);
    const compacted = String(result.messages[1]?.content ?? "");
    expect(compacted).toContain("<compacted-tool-result");
    expect(compacted).toContain("delivered_and_compacted");
    expect(compacted).toContain("READ_OUTPUT_LINE");
    expect(compacted).not.toContain("Re-run the tool");
    expect(String(result.messages[3]?.content ?? "")).toBe("recent output");
  });

  it("does not mutate the original tool result objects when producing compacted provider messages", () => {
    const oldOutput = "FULL_PROVIDER_TOOL_OUTPUT\n".repeat(120);
    const messages = [
      { role: "assistant", content: "", tool_calls: [{ id: "tc-original", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "tc-original", content: oldOutput },
      { role: "assistant", content: "", tool_calls: [{ id: "tc-recent", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "tc-recent", content: "recent output" },
    ];

    const result = applyCheapCompactionPipeline(messages, {
      toolResultBudgetBytes: 1_000_000,
      microKeepRecentToolResults: 1,
      microMinContentChars: 100,
      microPreviewChars: 48,
    });

    expect(result.changed).toBe(true);
    expect(String(result.messages[1]?.content ?? "")).toContain("<compacted-tool-result");
    expect(messages[1]?.content).toBe(oldOutput);
    expect(result.messages[1]).not.toBe(messages[1]);
  });

  it("protects pending tool results from persistence and micro compaction while legacy results remain compactable", () => {
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-pending-tool-results-"));
    const pendingOutput = "PENDING_FIRST_DELIVERY\n".repeat(400);
    const legacyOutput = "LEGACY_ALREADY_DELIVERED\n".repeat(400);
    const messages = [
      { role: "assistant", content: "", tool_calls: [{ id: "tc-pending", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "tc-pending", content: pendingOutput },
      { role: "assistant", content: "", tool_calls: [{ id: "tc-legacy", type: "function", function: { name: "read", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "tc-legacy", content: legacyOutput },
    ];

    const protectedResult = applyCheapCompactionPipeline(messages, {
      artifactDir,
      toolResultBudgetBytes: 100,
      toolResultPersistThresholdBytes: 100,
      microKeepRecentToolResults: 0,
      microMinContentChars: 100,
      protectedToolCallIds: new Set(["tc-pending"]),
    });

    expect(protectedResult.messages[1]?.content).toBe(pendingOutput);
    expect(String(protectedResult.messages[3]?.content ?? "")).toContain("delivered_and_compacted");
    expect(fs.readdirSync(artifactDir).some((name) => name.startsWith("tc-pending-"))).toBe(false);

    const deliveredResult = applyCheapCompactionPipeline(messages, {
      artifactDir,
      toolResultBudgetBytes: 100,
      toolResultPersistThresholdBytes: 100,
      microKeepRecentToolResults: 0,
      microMinContentChars: 100,
    });
    expect(String(deliveredResult.messages[1]?.content ?? "")).toContain("delivered_and_compacted");
  });
});
