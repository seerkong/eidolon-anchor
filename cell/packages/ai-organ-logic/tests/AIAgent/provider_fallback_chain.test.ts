import { describe, expect, it } from "bun:test";
import { executeProviderFallbackChain } from "@cell/ai-organ-logic/llm";

describe("provider fallback chain execution", () => {
  it("tries fallback model after retry exhaustion", async () => {
    const attempted: string[] = [];
    const result = await executeProviderFallbackChain(
      ["openai/gpt-4o", "anthropic/claude"],
      async (model) => {
        attempted.push(model);
        if (model === "openai/gpt-4o") throw new Error("stream exceeded timeout");
        return `ok:${model}`;
      },
    );

    expect(result.value).toBe("ok:anthropic/claude");
    expect(result.selectedModel).toBe("anthropic/claude");
    expect(result.attemptedModels).toEqual(["openai/gpt-4o", "anthropic/claude"]);
    expect(result.fallbackUsed).toBe(true);
    expect(attempted).toEqual(["openai/gpt-4o", "anthropic/claude"]);
  });
});
