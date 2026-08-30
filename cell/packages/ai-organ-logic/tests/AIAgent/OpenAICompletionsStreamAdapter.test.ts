import { describe, expect, it } from "bun:test";

import { OpenAICompletionsNodejsFetchStreamAdapter } from "@cell/ai-organ-logic/stream/OpenAICompletionsNodejsFetchStreamAdapter";
import { deepSeekOfficialChatEffectBundle } from "@cell/ai-organ-logic/llm/ChatCompletionsEffectBundles";
import { normalizeOpenAIChatUsage } from "@cell/ai-organ-logic/llm/OpenAICompletionsNodejsFetchAdapter";
import { OutputStream } from "@cell/symbiont-logic/stream/stream";

describe("OpenAICompletionsNodejsFetchStreamAdapter", () => {
  it("normalizes OpenAI-compatible cached_tokens usage into the DeepSeek cache contract", () => {
    expect(normalizeOpenAIChatUsage({
      prompt_tokens: 100,
      completion_tokens: 8,
      total_tokens: 108,
      prompt_tokens_details: { cached_tokens: 75 },
      completion_tokens_details: { reasoning_tokens: 7 },
    })).toEqual({
      prompt_tokens: 100,
      completion_tokens: 8,
      total_tokens: 108,
      prompt_cache_hit_tokens: 75,
      prompt_cache_miss_tokens: 25,
    });
  });

  it("captures interleaved reasoning_content into reasoning_content field", async () => {
    const timeline = new OutputStream();
    const adapter = new OpenAICompletionsNodejsFetchStreamAdapter({ timeline, effectBundle: deepSeekOfficialChatEffectBundle });
    const events: Array<{ event: string; data: string }> = [];
    timeline.onData((ev) => events.push(ev));

    async function* stream() {
      yield {
        choices: [
          {
            delta: {
              reasoning_content: [{ text: "step-1 " }],
            },
          },
        ],
      };
      yield {
        choices: [
          {
            delta: {
              reasoning_content: "step-2",
              content: "answer",
            },
          },
        ],
      };
    }

    const msg = await adapter.processStream(stream());

    expect(msg.reasoning_content).toBe("step-1 step-2");
    expect(msg.content).toBe("answer");
    expect(events.filter((ev) => ev.event === "think").map((ev) => ev.data).join("")).toBe("step-1 step-2");
  });

  it("preserves an observed empty reasoning_content field for provider roundtrip", async () => {
    const timeline = new OutputStream();
    const adapter = new OpenAICompletionsNodejsFetchStreamAdapter({ timeline, effectBundle: deepSeekOfficialChatEffectBundle });

    async function* stream() {
      yield {
        choices: [
          {
            delta: {
              reasoning_content: "",
              content: "answer",
            },
          },
        ],
      };
    }

    const msg = await adapter.processStream(stream());

    expect(msg).toHaveProperty("reasoning_content", "");
    expect(msg.content).toBe("answer");
  });

  it("deduplicates repeated transport events only when the provider supplies an explicit event identity", async () => {
    const timeline = new OutputStream();
    const adapter = new OpenAICompletionsNodejsFetchStreamAdapter({ timeline, effectBundle: deepSeekOfficialChatEffectBundle });
    const events: Array<{ event: string; data: string }> = [];
    timeline.onData((ev) => events.push(ev));

    const repeatedReasoningChunk = {
      id: "completion-1",
      event_id: "event-1",
      choices: [
        {
          delta: {
            reasoning_content: "Great",
          },
        },
      ],
    };
    const repeatedContentChunk = {
      id: "completion-1",
      event_id: "event-2",
      choices: [
        {
          delta: {
            content: "Created member successfully",
          },
        },
      ],
    };

    async function* stream() {
      yield repeatedReasoningChunk;
      yield repeatedReasoningChunk;
      yield repeatedContentChunk;
      yield repeatedContentChunk;
    }

    const msg = await adapter.processStream(stream());

    expect(msg.reasoning_content).toBe("Great");
    expect(msg.content).toBe("Created member successfully");
    expect(events.filter((ev) => ev.event === "think").map((ev) => ev.data)).toEqual(["Great"]);
    expect(events.filter((ev) => ev.event === "content").map((ev) => ev.data)).toEqual(["Created member successfully"]);
  });

  it("preserves identical consecutive tool argument deltas as distinct semantic tokens", async () => {
    const timeline = new OutputStream();
    const adapter = new OpenAICompletionsNodejsFetchStreamAdapter({ timeline, effectBundle: deepSeekOfficialChatEffectBundle });

    async function* stream() {
      yield {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_nested_object",
              type: "function",
              function: { name: "Prepare", arguments: "" },
            }],
          },
        }],
      };
      for (const fragment of ['{"nested":{', "}", "}"]) {
        yield {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, function: { arguments: fragment } }],
            },
          }],
        };
      }
      yield { choices: [{ finish_reason: "tool_calls", delta: {} }] };
    }

    const msg = await adapter.processStream(stream());

    expect(msg.tool_calls).toEqual([{
      id: "call_nested_object",
      type: "function",
      function: { name: "Prepare", arguments: '{"nested":{}}' },
    }]);
  });

  it("preserves mirrored reasoning_content for roundtrip without duplicate think emission", async () => {
    const timeline = new OutputStream();
    const adapter = new OpenAICompletionsNodejsFetchStreamAdapter({ timeline, effectBundle: deepSeekOfficialChatEffectBundle });
    const events: Array<{ event: string; data: string }> = [];
    timeline.onData((ev) => events.push(ev));

    async function* stream() {
      yield {
        choices: [
          {
            delta: {
              reasoning_content: "我是你的AI助手",
              content: "我是你的AI助手",
            },
          },
        ],
      };
    }

    const msg = await adapter.processStream(stream());

    expect(msg.reasoning_content).toBe("我是你的AI助手");
    expect(msg.content).toBe("我是你的AI助手");
    expect(events.filter((ev) => ev.event === "think").length).toBe(0);
    expect(events.filter((ev) => ev.event === "content").map((ev) => ev.data)).toEqual(["我是你的AI助手"]);
  });

  it("closes the visible stream lifecycle when the provider stream throws", async () => {
    const timeline = new OutputStream();
    const adapter = new OpenAICompletionsNodejsFetchStreamAdapter({ timeline });
    const events: Array<{ event: string; data: string }> = [];
    timeline.onData((ev) => events.push(ev));

    async function* stream() {
      yield {
        choices: [
          {
            delta: {
              content: "partial",
            },
          },
        ],
      };
      throw new Error("provider stream aborted");
    }

    await expect(adapter.processStream(stream())).rejects.toThrow("provider stream aborted");
    expect(events.filter((ev) => ev.event === "control").map((ev) => JSON.parse(ev.data).event)).toEqual([
      "StreamStart",
      "StreamEnd",
    ]);
  });

  it("rejects a reasoning-only response truncated by the provider output limit", async () => {
    const timeline = new OutputStream();
    const adapter = new OpenAICompletionsNodejsFetchStreamAdapter({ timeline, effectBundle: deepSeekOfficialChatEffectBundle });
    const events: Array<{ event: string; data: string }> = [];
    timeline.onData((ev) => events.push(ev));

    async function* stream() {
      yield { choices: [{ delta: { reasoning_content: "I will plan the implementation." }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: "length" }] };
    }

    await expect(adapter.processStream(stream())).rejects.toThrow("provider_output_truncated");
    expect(events.filter((ev) => ev.event === "control").map((ev) => JSON.parse(ev.data).event)).toEqual([
      "StreamStart",
      "StreamEnd",
    ]);
  });

  it("normalizes compatible finish-reason aliases before semantic completion", async () => {
    const timeline = new OutputStream();
    const adapter = new OpenAICompletionsNodejsFetchStreamAdapter({ timeline, effectBundle: deepSeekOfficialChatEffectBundle });

    async function* stream() {
      yield { choices: [{ delta: { reasoning_content: "Still thinking." } }] };
      yield { choices: [{ delta: {}, finishReason: "max_output_tokens" }] };
    }

    await expect(adapter.processStream(stream())).rejects.toThrow(
      "provider_output_truncated: chat completion ended with finish_reason=length",
    );
  });

  it("rejects a reasoning-only response even when the provider reports a normal stop", async () => {
    const timeline = new OutputStream();
    const adapter = new OpenAICompletionsNodejsFetchStreamAdapter({ timeline, effectBundle: deepSeekOfficialChatEffectBundle });

    async function* stream() {
      yield { choices: [{ delta: { reasoning_content: "I planned the work but produced no action." }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: "stop" }] };
    }

    try {
      await adapter.processStream(stream());
      throw new Error("expected a reasoning-only protocol error");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("provider_reasoning_only_response");
      expect((error as { observedReasoningBytes?: number }).observedReasoningBytes).toBe(
        new TextEncoder().encode("I planned the work but produced no action.").byteLength,
      );
      expect((error as { continuationAssistantMessage?: unknown }).continuationAssistantMessage).toEqual({
        role: "assistant",
        content: "",
        reasoning_content: "I planned the work but produced no action.",
      });
    }
  });
});
