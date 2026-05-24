import { describe, expect, it } from "bun:test";

import { OpenAICompletionsNodejsFetchLlmAdapter } from "@cell/ai-organ-logic/llm/OpenAICompletionsNodejsFetchAdapter";

function sseResponse(): Response {
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("OpenAICompletionsNodejsFetchLlmAdapter", () => {
  it("does not force DeepSeek thinking by default", async () => {
    let body: any;
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com/v1",
      providerOptions: {
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body ?? "{}"));
          return sseResponse();
        },
      },
    });

    await adapter.createStream({
      model: "deepseek-reasoner",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    expect(body.thinking).toBeUndefined();
    expect(body.reasoning_split).toBeUndefined();
    expect(body.stream).toBe(true);
  });

  it("preserves explicit DeepSeek thinking options", async () => {
    let body: any;
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com/v1",
      providerOptions: {
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body ?? "{}"));
          return sseResponse();
        },
      },
    });

    await adapter.createStream({
      model: "deepseek-chat",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      extraBody: { thinking: { type: "enabled" } },
    });

    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("preserves reasoning-only assistant messages for DeepSeek replay", async () => {
    let body: any;
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com/v1",
      providerOptions: {
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body ?? "{}"));
          return sseResponse();
        },
      },
    });

    await adapter.createStream({
      model: "deepseek-reasoner",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", reasoning_content: "private reasoning" },
        { role: "assistant", content: "visible answer", reasoning_content: "answer reasoning" },
      ],
      tools: [],
    });

    expect(body.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "", reasoning_content: "private reasoning" },
      { role: "assistant", content: "visible answer", reasoning_content: "answer reasoning" },
    ]);
  });
});
