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
});
