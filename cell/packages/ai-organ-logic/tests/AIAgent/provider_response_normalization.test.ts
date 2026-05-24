import { describe, expect, it } from "bun:test";
import { normalizeProviderResponse } from "@cell/ai-organ-logic/llm";

describe("provider response normalization", () => {
  it("normalizes text responses and stop reason", () => {
    const normalized = normalizeProviderResponse({ content: [{ type: "text", text: "hello" }], stop_reason: "stop" });

    expect(normalized.contentText).toBe("hello");
    expect(normalized.stopReason).toBe("end_turn");
    expect(normalized.toolCalls).toEqual([]);
  });

  it("normalizes tool-call responses", () => {
    const normalized = normalizeProviderResponse({
      id: "resp_1",
      output_text: "",
      tool_calls: [
        { id: "call_1", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } },
      ],
      usage: { input_tokens: 10 },
    });

    expect(normalized.responseId).toBe("resp_1");
    expect(normalized.stopReason).toBe("tool_use");
    expect(normalized.usage).toEqual({ input_tokens: 10 });
    expect(normalized.toolCalls).toEqual([
      { id: "call_1", name: "read_file", input: { path: "a" } },
    ]);
  });
});
