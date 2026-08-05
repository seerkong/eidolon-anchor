import { describe, expect, it } from "bun:test";

import { OpenAICompletionsNodejsFetchLlmAdapter } from "@cell/ai-organ-logic/llm/OpenAICompletionsNodejsFetchAdapter";
import { deepSeekOfficialChatEffectBundle } from "@cell/ai-organ-logic/llm/ChatCompletionsEffectBundles";

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
      effectBundle: deepSeekOfficialChatEffectBundle,
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
      effectBundle: deepSeekOfficialChatEffectBundle,
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

  it("strips runtime-only diagnostic fields from chat completion requests", async () => {
    let body: any;
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      effectBundle: deepSeekOfficialChatEffectBundle,
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
      extraBody: {
        prompt_plan: { id: "plan", turn: 1 },
        work_context: { task_phase: "implementation" },
        thinking: { type: "enabled" },
      },
    });

    expect(body.prompt_plan).toBeUndefined();
    expect(body.work_context).toBeUndefined();
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("preserves reasoning-only assistant messages for DeepSeek replay", async () => {
    let body: any;
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      effectBundle: deepSeekOfficialChatEffectBundle,
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

  it("serializes DeepSeek reasoning and tool results for continuation", async () => {
    let body: any;
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      effectBundle: deepSeekOfficialChatEffectBundle,
      baseUrl: "https://inferaiapi.com/v1",
      providerOptions: {
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body ?? "{}"));
          return sseResponse();
        },
      },
    });
    const toolCalls = [
      {
        id: "call_read_1",
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: "README.md" }) },
      },
    ];

    await adapter.createStream({
      model: "deepseek-v4-flash",
      messages: [
        { role: "user", content: "Inspect the project" },
        {
          role: "assistant",
          content: "I will inspect the README.",
          reasoning_content: "The README is the best starting point.",
          tool_calls: toolCalls,
        },
        { role: "tool", tool_call_id: "call_read_1", content: "project contents" },
      ],
      tools: [],
    });

    expect(body.messages).toEqual([
      { role: "user", content: "Inspect the project" },
      {
        role: "assistant",
        content: "I will inspect the README.",
        reasoning_content: "The README is the best starting point.",
        tool_calls: toolCalls,
      },
      { role: "tool", tool_call_id: "call_read_1", content: "project contents" },
    ]);
  });

  it("repairs missing reasoning_content in serialized legacy DeepSeek tool calls", async () => {
    let body: any;
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      effectBundle: deepSeekOfficialChatEffectBundle,
      baseUrl: "https://inferaiapi.com/v1",
      providerOptions: {
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body ?? "{}"));
          return sseResponse();
        },
      },
    });
    const toolCalls = [
      {
        id: "call_legacy_1",
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: "package.json" }) },
      },
    ];

    await adapter.createStream({
      model: "deepseek-v4-flash",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: toolCalls,
        },
        { role: "tool", tool_call_id: "call_legacy_1", content: "package contents" },
      ],
      tools: [],
    });

    expect(body.messages).toEqual([
      {
        role: "assistant",
        content: "",
        reasoning_content: "",
        tool_calls: toolCalls,
      },
      { role: "tool", tool_call_id: "call_legacy_1", content: "package contents" },
    ]);
  });

  it("keeps transport timeout controls out of the request body and aborts a stalled header wait", async () => {
    let body: Record<string, unknown> = {};
    let fetchSignal: AbortSignal | undefined;
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      effectBundle: deepSeekOfficialChatEffectBundle,
      baseUrl: "https://api.deepseek.com/v1",
      providerOptions: {
        fetch: async (_url, init) => {
          body = JSON.parse(String(init?.body ?? "{}"));
          fetchSignal = init?.signal ?? undefined;
          return await new Promise<Response>((_resolve, reject) => {
            fetchSignal?.addEventListener(
              "abort",
              () => reject(fetchSignal?.reason),
              { once: true },
            );
          });
        },
      },
    });

    let error: unknown;
    try {
      await adapter.createStream({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        extraBody: {
          timeout: 1,
          first_event_timeout_seconds: 0.01,
          stream_idle_timeout_seconds: 0.01,
          temperature: 0.2,
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "first event exceeded timeout after 0.01s",
    );
    expect(fetchSignal?.aborted).toBe(true);
    expect(body.temperature).toBe(0.2);
    expect(body.timeout).toBeUndefined();
    expect(body.first_event_timeout_seconds).toBeUndefined();
    expect(body.stream_idle_timeout_seconds).toBeUndefined();
  });

  it("times out when response headers arrive but the first SSE event never does", async () => {
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      effectBundle: deepSeekOfficialChatEffectBundle,
      baseUrl: "https://api.deepseek.com/v1",
      providerOptions: {
        fetch: async () =>
          new Response(new ReadableStream({ start() {} }), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
      },
    });
    const result = await adapter.createStream({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      extraBody: { first_event_timeout_seconds: 0.01 },
    });

    let error: unknown;
    try {
      await result.stream[Symbol.asyncIterator]().next();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "first event exceeded timeout after 0.01s",
    );
  });
});
