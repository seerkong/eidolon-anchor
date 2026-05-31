import { describe, expect, it } from "bun:test";
import { estimateTokens, estimateUsageRatio } from "@cell/ai-organ-logic/compression/TokenEstimator";

describe("token_estimator", () => {
  it("estimates normal text with chars/4 and rounds up", () => {
    const messages = [
      { role: "user", content: "12345678" },
      {
        role: "assistant",
        tool_calls: [{ function: { arguments: "{\"q\":\"ab\"}" } }],
        content_parts: [{ type: "text", text: "hello" }],
      },
    ];

    const expectedChars = "12345678".length + "{\"q\":\"ab\"}".length + "hello".length;
    expect(estimateTokens(messages)).toBe(Math.ceil(expectedChars / 4));
  });

  it("uses a conservative estimate for dense low-whitespace tool output", () => {
    const denseBundle = "function a(){return b.c(d)};".repeat(500);
    const messages = [{ role: "tool", content: denseBundle }];

    expect(estimateTokens(messages)).toBe(Math.ceil(denseBundle.length / 2.5));
  });

  it("counts reasoning text and camelCase tool call inputs", () => {
    const messages = [
      {
        role: "assistant",
        reasoningContent: "think",
        toolCalls: [{ name: "write", input: { filePath: "a.ts", content: "hello" } }],
      },
    ];

    expect(estimateTokens(messages)).toBeGreaterThan(Math.ceil("think".length / 4));
  });

  it("calculates usage ratio and handles non-positive limits", () => {
    const messages = [{ role: "user", content: "12345678" }];

    expect(estimateUsageRatio(messages, 4)).toBe(0.5);
    expect(estimateUsageRatio(messages, 0)).toBe(0);
    expect(estimateUsageRatio(messages, -10)).toBe(0);
  });
});
