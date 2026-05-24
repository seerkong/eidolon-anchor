import { describe, expect, it } from "bun:test";

import { OpenAIResponsesNodejsFetchLlmAdapter } from "@cell/ai-organ-logic/llm";

describe("OpenAIResponsesNodejsFetchLlmAdapter reasoning effort", () => {
  it("injects codex worktree guidance without treating agent-owned edits as unexpected", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      providerOptions: {
        fetch: async (_input, init) => {
          capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          return new Response("data: [DONE]\n\n", {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
            },
          });
        },
      },
    });

    await adapter.createStream({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    });

    const instructions = String(capturedBody?.instructions ?? "");
    expect(instructions).toContain('Files you modified earlier in the current task are not "unexpected changes"');
    expect(instructions).toContain("If those changes conflict with your current work and you are in an interactive mode, stop and ask the user");
    expect(instructions).toContain("In non-interactive `approval_policy: never` or exec `full-auto` mode");
    expect(instructions).not.toContain("STOP IMMEDIATELY and ask the user");
  });

  it("allows extraBody.reasoning.effort to override the default effort", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      providerOptions: {
        fetch: async (_input, init) => {
          capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          return new Response("data: [DONE]\n\n", {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
            },
          });
        },
      },
    });

    await adapter.createStream({
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "hello" },
      ],
      tools: [],
      extraBody: {
        reasoning: {
          effort: "high",
        },
      },
    });

    expect(capturedBody).not.toBeNull();
    expect(capturedBody?.reasoning).toEqual({
      effort: "high",
      summary: "auto",
    });
  });

  it("accepts xhigh reasoning effort overrides", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      providerOptions: {
        fetch: async (_input, init) => {
          capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          return new Response("data: [DONE]\n\n", {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
            },
          });
        },
      },
    });

    await adapter.createStream({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      extraBody: {
        reasoning: {
          effort: "xhigh",
        },
      },
    });

    expect(capturedBody?.reasoning).toEqual({
      effort: "xhigh",
      summary: "auto",
    });
  });

  it("does not forward runtime-only prompt metadata as provider body fields", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      providerOptions: {
        fetch: async (_input, init) => {
          capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          return new Response("data: [DONE]\n\n", {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
            },
          });
        },
      },
    });

    await adapter.createStream({
      model: "gpt-5.4",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      extraBody: {
        prompt_plan: { id: "plan" },
        work_context: { task_phase: "implementation" },
        prompt_cache_key: "cache",
      },
    });

    expect(capturedBody).not.toBeNull();
    expect(capturedBody).not.toHaveProperty("prompt_plan");
    expect(capturedBody).not.toHaveProperty("work_context");
    expect(capturedBody?.prompt_cache_key).toBe("cache");
  });

  it("summarizes HTML provider failures instead of surfacing the full page", async () => {
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      baseUrl: "https://api.example.com/v1",
      providerOptions: {
        fetch: async () =>
          new Response(
            "<html><head><title>beecode.cc | 502: Bad gateway</title></head><body><script>noise()</script>full cloudflare page</body></html>",
            {
              status: 502,
              statusText: "Bad Gateway",
              headers: {
                "Content-Type": "text/html",
              },
            },
          ),
      },
    });

    await expect(
      adapter.createStream({
        model: "gpt-5.4",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      }),
    ).rejects.toThrow("OpenAI responses fetch error 502 Bad Gateway: beecode.cc | 502: Bad gateway");
  });
});
