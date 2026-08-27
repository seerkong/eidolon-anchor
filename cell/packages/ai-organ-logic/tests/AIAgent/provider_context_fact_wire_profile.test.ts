import { describe, expect, it } from "bun:test";
import type { ProviderEpochProfileId } from "@cell/ai-organ-contract";
import {
  AnthropicNodejsFetchLlmAdapter,
  ClaudeNodejsFetchLlmAdapter,
  OpenAICompletionsNodejsFetchLlmAdapter,
  OpenAIResponsesNodejsFetchLlmAdapter,
} from "@cell/ai-organ-logic/llm";
import {
  deepSeekCompatibleChatEffectBundle,
  deepSeekOfficialChatEffectBundle,
  openAIOfficialChatEffectBundle,
} from "@cell/ai-organ-logic/llm/ChatCompletionsEffectBundles";
import {
  ProviderContextFactWireProfileError,
  validateProviderContextFactsInFinalWire,
} from "@cell/ai-organ-logic/llm/ProviderContextFactWireProfile";

const FACT = "eidolon-context-fact/v1\n{\"kind\":\"workflow-stage-context\",\"revision\":1}";

function sse(): Response {
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function validBody(profileId: ProviderEpochProfileId): Record<string, unknown> {
  if (profileId === "openai-responses@1") {
    return { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: FACT }] }] };
  }
  if (profileId === "anthropic-chat@1") {
    return { messages: [{ role: "user", content: [{ type: "text", text: FACT }] }] };
  }
  return { messages: [{ role: "user", content: FACT }] };
}

describe("provider-context fact final-wire profiles", () => {
  const profiles: ProviderEpochProfileId[] = [
    "deepseek-official-chat@1",
    "deepseek-compatible-chat@1",
    "openai-chat@1",
    "openai-responses@1",
    "anthropic-chat@1",
    "claude-code@1",
  ];

  it("accepts the exact user-role container for every versioned provider profile", () => {
    for (const profileId of profiles) {
      expect(validateProviderContextFactsInFinalWire({
        profileId,
        serializedBody: JSON.stringify(validBody(profileId)),
      })).toEqual({ factCount: 1 });
    }
  });

  it("rejects system hoisting, split blocks, wrong roles, and hidden duplicate facts", () => {
    const invalid: Array<readonly [ProviderEpochProfileId, Record<string, unknown>]> = [
      ["deepseek-official-chat@1", { messages: [{ role: "system", content: FACT }] }],
      ["deepseek-compatible-chat@1", { messages: [{ role: "assistant", content: FACT }] }],
      ["openai-chat@1", { messages: [{ role: "user", content: FACT }], metadata: { copied: FACT } }],
      ["openai-responses@1", { input: [{ type: "message", role: "user", content: [{ type: "output_text", text: FACT }] }] }],
      ["anthropic-chat@1", { messages: [{ role: "user", content: [{ type: "text", text: FACT }, { type: "text", text: "split" }] }] }],
      ["claude-code@1", { system: FACT, messages: [] }],
    ];
    for (const [profileId, body] of invalid) {
      expect(() => validateProviderContextFactsInFinalWire({
        profileId,
        serializedBody: JSON.stringify(body),
      })).toThrow(new ProviderContextFactWireProfileError("provider_context_fact_wire_profile_mismatch"));
    }
  });

  it("preserves the exact fact through all six real transport serializers", async () => {
    const observed = new Map<ProviderEpochProfileId, string>();
    const observe = (profileId: ProviderEpochProfileId) => (input: { requestBody: string }) => {
      observed.set(profileId, input.requestBody);
    };
    const fetchFn = async () => sse();
    const chatCases = [
      ["deepseek-official-chat@1", deepSeekOfficialChatEffectBundle],
      ["deepseek-compatible-chat@1", deepSeekCompatibleChatEffectBundle],
      ["openai-chat@1", openAIOfficialChatEffectBundle],
    ] as const;
    for (const [profileId, chatCompletionsEffectBundle] of chatCases) {
      const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
        apiKey: "test-key",
        requestObserver: observe(profileId),
        chatCompletionsEffectBundle,
        providerOptions: { fetch: fetchFn },
      });
      await adapter.createStream({ model: "wire-model", messages: [{ role: "user", content: FACT }], tools: [] });
    }
    await new AnthropicNodejsFetchLlmAdapter({
      apiKey: "test-key",
      baseUrl: "https://provider.test",
      requestObserver: observe("anthropic-chat@1"),
      providerOptions: { fetch: fetchFn },
    }).createStream({ model: "wire-model", messages: [{ role: "user", content: FACT }], tools: [] });
    await new ClaudeNodejsFetchLlmAdapter({
      apiKey: "test-key",
      requestObserver: observe("claude-code@1"),
      providerOptions: { fetch: fetchFn },
    }).createStream({ model: "wire-model", messages: [{ role: "user", content: FACT }], tools: [] });
    await new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      requestObserver: observe("openai-responses@1"),
      providerOptions: { fetch: fetchFn },
    }).createStream({ model: "wire-model", messages: [{ role: "user", content: FACT }], tools: [] });

    expect(new Set(observed.keys())).toEqual(new Set(profiles));
    for (const profileId of profiles) {
      const serializedBody = observed.get(profileId);
      expect(serializedBody).toBeDefined();
      expect(validateProviderContextFactsInFinalWire({ profileId, serializedBody: serializedBody! })).toEqual({ factCount: 1 });
      expect(serializedBody!.match(/eidolon-context-fact\/v1/g)).toHaveLength(1);
    }
  });
});
