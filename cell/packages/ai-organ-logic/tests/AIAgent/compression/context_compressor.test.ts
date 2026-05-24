import { describe, expect, it } from "bun:test";
import {
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
});
