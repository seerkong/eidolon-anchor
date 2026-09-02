import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "bun:test";
import workflowIncident from "./fixtures/ai-workflow-incident-parallel-tool-calls.json" with { type: "json" };

const repoRoot = path.resolve(import.meta.dir, "../../../../..");

function source(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function exists(relativePath: string): boolean {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function sseResponse(): Response {
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("official Chat Completions effect bundles", () => {
  it("exports distinct OpenAI and canonical DeepSeek protocol implementations", async () => {
    const modulePath = "@cell/ai-organ-logic/llm/ChatCompletionsEffectBundles";
    const bundles = await import(modulePath);

    expect(bundles.openAIOfficialChatEffectBundle.id).toBe("openai-official-chat");
    expect(bundles.deepSeekChatEffectBundle.id).toBe("deepseek-chat");
    expect(bundles.deepSeekOfficialChatEffectBundle).toBe(bundles.deepSeekChatEffectBundle);
    expect(bundles.deepSeekCompatibleChatEffectBundle).toBe(bundles.deepSeekChatEffectBundle);
    expect(bundles.openAIOfficialChatEffectBundle).not.toBe(
      bundles.deepSeekOfficialChatEffectBundle,
    );
  });

  it("keeps the shared reducer deterministic and side-effect free", async () => {
    const modulePath = "@cell/ai-organ-logic/stream/ChatCompletionsStreamCore";
    const core = await import(modulePath);
    const state = core.createChatCompletionsStreamState();
    const snapshot = structuredClone(state);
    const chunk = {
      choices: [
        {
          delta: {
            reasoning_content: "inspect ",
            content: "answer",
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "read", arguments: "{\"path\":" },
              },
            ],
          },
        },
      ],
    };

    const first = core.reduceChatCompletionsChunk(state, chunk);
    const second = core.reduceChatCompletionsChunk(state, chunk);

    expect(first).toEqual(second);
    expect(state).toEqual(snapshot);
    expect(first.events.map((event: any) => event.event)).toEqual([
      "think",
      "content",
    ]);
  });

  it("keeps parallel same-name calls separate when a provider omits index", async () => {
    const core = await import("@cell/ai-organ-logic/stream/ChatCompletionsStreamCore");
    let state = core.createChatCompletionsStreamState();
    for (const chunk of workflowIncident.chunks) {
      state = core.reduceChatCompletionsChunk(state, chunk).state;
    }

    expect(workflowIncident.provenance.observed_corruption).toContain("WorkflowGetAuthoringSummaryWorkflowGetAuthoringSummary");
    expect(core.buildChatCompletionsToolCalls(state)).toEqual(workflowIncident.expected);
  });

  it("fails closed when a no-index tool delta has ambiguous identity", async () => {
    const core = await import("@cell/ai-organ-logic/stream/ChatCompletionsStreamCore");
    let state = core.createChatCompletionsStreamState();
    for (const id of ["call_a", "call_b"]) {
      state = core.reduceChatCompletionsChunk(state, {
        choices: [{ delta: { tool_calls: [{ id, type: "function", function: { name: "WorkflowWorkspace" } }] } }],
      }).state;
    }
    state = core.reduceChatCompletionsChunk(state, {
      choices: [{ delta: { tool_calls: [{ function: { arguments: "{}" } }] } }],
    }).state;

    expect(() => core.buildChatCompletionsAssistantMessage(state)).toThrow("ambiguous_tool_call_identity");
  });

  it("selects protocol behavior from the explicit bundle despite misleading strings", async () => {
    const adapterPath = "@cell/ai-organ-logic/llm/OpenAICompletionsNodejsFetchAdapter";
    const bundlePath = "@cell/ai-organ-logic/llm/ChatCompletionsEffectBundles";
    const { OpenAICompletionsNodejsFetchLlmAdapter } = await import(adapterPath);
    const {
      deepSeekOfficialChatEffectBundle,
      openAIOfficialChatEffectBundle,
    } = await import(bundlePath);
    const requests: Array<{ url: string; body: any }> = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return sseResponse();
    };

    const openAI = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com",
      effectBundle: openAIOfficialChatEffectBundle,
      providerOptions: { fetch },
    });
    await openAI.createStream({
      model: "deepseek-v4-flash",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_openai", type: "function", function: { name: "read", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_openai", content: "ok" },
      ],
      tools: [],
    });

    const deepSeek = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      baseUrl: "https://inferaiapi.com",
      effectBundle: deepSeekOfficialChatEffectBundle,
      providerOptions: { fetch },
    });
    await deepSeek.createStream({
      model: "gpt-compatible-name",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_deepseek", type: "function", function: { name: "read", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_deepseek", content: "ok" },
      ],
      tools: [],
    });

    expect(requests[0].body.messages[0]).not.toHaveProperty("reasoning_content");
    expect(requests[0].url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(requests[1].body.messages[0]).not.toHaveProperty("reasoning_content");
    expect(requests[1].url).toBe("https://inferaiapi.com/v1/chat/completions");
  });

  it("keeps provider semantics in ai-organ and out of symbiont", () => {
    expect(
      exists(
        "cell/packages/ai-organ-logic/src/stream/OpenAICompletionsNodejsFetchStreamAdapter.ts",
      ),
    ).toBe(true);
    expect(
      exists(
        "cell/packages/symbiont-logic/src/stream/OpenAICompletionsNodejsFetchStreamAdapter.ts",
      ),
    ).toBe(false);
    expect(
      source("cell/packages/symbiont-logic/src/stream/index.ts"),
    ).not.toContain("OpenAICompletionsNodejsFetchStreamAdapter");
  });

  it("binds one selected driver through request and ingress without secondary inference", () => {
    const fetchAdapter = source(
      "cell/packages/ai-organ-logic/src/llm/OpenAICompletionsNodejsFetchAdapter.ts",
    );
    const openAIDriver = source(
      "cell/packages/ai-organ-logic/src/llm/drivers/OpenAIChatDriver.ts",
    );
    const deepSeekDriver = source(
      "cell/packages/ai-organ-logic/src/llm/drivers/DeepSeekDriver.ts",
    );
    const executor = source(
      "cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts",
    );
    const terminalRuntime = source(
      "terminal/packages/organ/src/AIAgent/TerminalRuntime.ts",
    );

    expect(fetchAdapter).not.toContain("function isDeepseekRequest");
    expect(openAIDriver).toContain("openAIOfficialChatEffectBundle");
    expect(deepSeekDriver).toContain("deepSeekOfficialChatEffectBundle");
    expect(executor).toContain("llmAdapter");
    expect(terminalRuntime).toContain("options?.llmAdapter");
    expect(terminalRuntime).not.toContain("actor.llmClient as any");
  });

  it("uses the selected driver's bundle for normalized ingress", async () => {
    const { createIngressStreamAdapter } = await import(
      "@cell/ai-organ-logic/stream/IngressStreamAdapter"
    );
    const { IngressStreamRuntime } = await import(
      "@cell/symbiont-logic/stream/IngressStreamRuntime"
    );
    const {
      deepSeekOfficialChatEffectBundle,
      openAIOfficialChatEffectBundle,
    } = await import(
      "@cell/ai-organ-logic/llm/ChatCompletionsEffectBundles"
    );
    const stream = async function* () {
      yield {
        choices: [
          {
            delta: {
              reasoning_content: "private reasoning",
              content: "answer",
            },
          },
        ],
      };
    };
    const adapterFor = (type: "openai" | "deepseek", bundle: unknown) => ({
      type,
      driver: { chatCompletionsEffectBundle: bundle },
      async createStream() {
        return { stream: stream() };
      },
    });

    const [, runOpenAI] = createIngressStreamAdapter(
      stream(),
      IngressStreamRuntime.create(),
      adapterFor("deepseek", openAIOfficialChatEffectBundle) as any,
    );
    const [, runDeepSeek] = createIngressStreamAdapter(
      stream(),
      IngressStreamRuntime.create(),
      adapterFor("openai", deepSeekOfficialChatEffectBundle) as any,
    );

    const [openAIMessage, deepSeekMessage] = await Promise.all([
      runOpenAI(),
      runDeepSeek(),
    ]);
    expect(openAIMessage).not.toHaveProperty("reasoning_content");
    expect(deepSeekMessage).toHaveProperty(
      "reasoning_content",
      "private reasoning",
    );
  });

  it("prefers the adapter-selected bundle over the driver's registry default for ingress", async () => {
    const { createIngressStreamAdapter } = await import(
      "@cell/ai-organ-logic/stream/IngressStreamAdapter"
    );
    const { IngressStreamRuntime } = await import(
      "@cell/symbiont-logic/stream/IngressStreamRuntime"
    );
    const {
      deepSeekOfficialChatEffectBundle,
      openAIOfficialChatEffectBundle,
    } = await import(
      "@cell/ai-organ-logic/llm/ChatCompletionsEffectBundles"
    );
    const stream = async function* () {
      yield {
        choices: [{ delta: { reasoning_content: "selected authority" } }],
      };
    };
    const adapter = {
      type: "deepseek" as const,
      chatCompletionsEffectBundle: openAIOfficialChatEffectBundle,
      driver: { chatCompletionsEffectBundle: deepSeekOfficialChatEffectBundle },
      async createStream() {
        return { stream: stream() };
      },
    };

    const [, run] = createIngressStreamAdapter(
      stream(),
      IngressStreamRuntime.create(),
      adapter,
    );

    expect(await run()).not.toHaveProperty("reasoning_content");
  });

  it("passes the adapter-selected bundle to DeepSeek request preparation and transport", async () => {
    const { ProviderRuntimeLlmAdapter } = await import(
      "@cell/ai-organ-logic/llm/ProviderRuntimeAdapter"
    );
    const {
      deepSeekCompatibleChatEffectBundle,
      deepSeekOfficialChatEffectBundle,
    } = await import(
      "@cell/ai-organ-logic/llm/ChatCompletionsEffectBundles"
    );
    let preparedBundle: unknown;
    let streamedBundle: unknown;
    const driver = {
      name: "deepseek-chat",
      adapterNames: ["deepseek"],
      chatCompletionsEffectBundle: deepSeekOfficialChatEffectBundle,
      prepareRequest(params: any) {
        preparedBundle = params.chatCompletionsEffectBundle;
        return { contract: { body: { model: params.model } } };
      },
      async createStream(params: any) {
        streamedBundle = params.chatCompletionsEffectBundle;
        return { stream: (async function* () {})() };
      },
    };
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: "compatible",
      selectedModel: "deepseek-compatible",
      adapterName: "deepseek",
      driver,
      options: { compatibility_profile: "deepseek-compatible-chat@1" },
    });

    adapter.prepareRequest({ model: "deepseek-compatible", messages: [], tools: [] });
    const result = await adapter.createStream({
      model: "deepseek-compatible",
      messages: [],
      tools: [],
    });
    for await (const _chunk of result.stream) {
      // Consume the selected transport path.
    }

    expect(adapter.chatCompletionsEffectBundle).toBe(
      deepSeekCompatibleChatEffectBundle,
    );
    expect(preparedBundle).toBe(deepSeekCompatibleChatEffectBundle);
    expect(streamedBundle).toBe(deepSeekCompatibleChatEffectBundle);
  });

  it("keeps explicit DeepSeek semantics on the runtime mock adapter", async () => {
    const runtimePath =
      "@cell/ai-organ-logic/runtime/ShellRuntimeSupport";
    const bundlePath =
      "@cell/ai-organ-logic/llm/ChatCompletionsEffectBundles";
    const { createRuntimeLlmAdapter } = await import(runtimePath);
    const { deepSeekOfficialChatEffectBundle } = await import(bundlePath);

    const adapter = await createRuntimeLlmAdapter({
      adapterType: "deepseek",
      workDir: repoRoot,
      useMock: true,
      defaults: {
        openai: { apiKey: "", baseUrl: "", model: "mock-openai" },
        anthropic: { apiKey: "", baseUrl: "", model: "mock-anthropic" },
        deepseek: { apiKey: "", baseUrl: "", model: "mock-deepseek" },
      },
      overrides: { options: { compatibility_profile: "deepseek-official-chat@1" } },
    });

    expect(adapter?.chatCompletionsEffectBundle).toBe(
      deepSeekOfficialChatEffectBundle,
    );
  });

  it("normalizes conflicting legacy DeepSeek profile inputs through real Shell construction", async () => {
    const { createRuntimeLlmAdapter } = await import(
      "@cell/ai-organ-logic/runtime/ShellRuntimeSupport"
    );

    const adapter = await createRuntimeLlmAdapter({
      adapterType: "deepseek",
      workDir: repoRoot,
      defaults: {
        openai: { apiKey: "", baseUrl: "", model: "mock-openai" },
        anthropic: { apiKey: "", baseUrl: "", model: "mock-anthropic" },
        deepseek: {
          apiKey: "test-key",
          baseUrl: "https://third-party.example/v1",
          model: "deepseek-compatible",
        },
      },
      overrides: { options: { compatibility_profile: "deepseek-compatible-chat@1" } },
      runtime: { chatCompatibilityProfileId: "deepseek-official-chat@1" },
    });
    expect(adapter?.runtime.chatCompatibilityProfileId).toBe("deepseek-chat@1");
  });

  it("uses the adapter-owned DeepSeek profile for third-party gateways", async () => {
    const runtimePath = "@cell/ai-organ-logic/runtime/ShellRuntimeSupport";
    const { createRuntimeLlmAdapter } = await import(runtimePath);
    const {
      deepSeekCompatibleChatEffectBundle,
      deepSeekOfficialChatEffectBundle,
    } = await import(
      "@cell/ai-organ-logic/llm/ChatCompletionsEffectBundles"
    );
    const defaults = {
      openai: { apiKey: "", baseUrl: "", model: "mock-openai" },
      anthropic: { apiKey: "", baseUrl: "", model: "mock-anthropic" },
      deepseek: { apiKey: "test-key", baseUrl: "https://third-party.example/v1", model: "deepseek-compatible" },
    };

    const implicit = await createRuntimeLlmAdapter({
      adapterType: "deepseek",
      workDir: repoRoot,
      defaults,
    });
    expect(implicit?.runtime.chatCompatibilityProfileId).toBe("deepseek-chat@1");

    const compatible = await createRuntimeLlmAdapter({
      adapterType: "deepseek",
      workDir: repoRoot,
      defaults,
      overrides: { options: { compatibility_profile: "deepseek-compatible-chat@1" } },
    });
    expect(compatible?.runtime.chatCompatibilityProfileId).toBe("deepseek-chat@1");
    expect(compatible?.chatCompletionsEffectBundle).toBe(
      deepSeekCompatibleChatEffectBundle,
    );

    const matchingDuplicate = await createRuntimeLlmAdapter({
      adapterType: "deepseek",
      workDir: repoRoot,
      defaults,
      overrides: { options: { compatibility_profile: "deepseek-compatible-chat@1" } },
      runtime: { chatCompatibilityProfileId: "deepseek-compatible-chat@1" },
    });
    expect(matchingDuplicate?.runtime.chatCompatibilityProfileId).toBe(
      "deepseek-chat@1",
    );

    const conflictingLegacy = await createRuntimeLlmAdapter({
      adapterType: "deepseek",
      workDir: repoRoot,
      defaults,
      overrides: { options: { compatibility_profile: "deepseek-compatible-chat@1" } },
      runtime: { chatCompatibilityProfileId: "deepseek-official-chat@1" },
    });
    expect(conflictingLegacy?.runtime.chatCompatibilityProfileId).toBe("deepseek-chat@1");

    const official = await createRuntimeLlmAdapter({
      adapterType: "deepseek",
      workDir: repoRoot,
      defaults: {
        ...defaults,
        deepseek: { ...defaults.deepseek, baseUrl: "https://api.deepseek.com/v1" },
      },
      overrides: { options: { compatibility_profile: "deepseek-official-chat@1" } },
    });
    expect(official?.runtime.chatCompatibilityProfileId).toBe("deepseek-chat@1");
    expect(official?.chatCompletionsEffectBundle).toBe(
      deepSeekOfficialChatEffectBundle,
    );
  });

  it("keeps OpenAI Responses outside both Chat Completions bundles", async () => {
    const registryPath = "@cell/ai-organ-logic/llm/ProviderDriverRegistry";
    const { buildProviderDriverRegistry } = await import(registryPath);
    const registry = buildProviderDriverRegistry();

    expect(registry["openai-chat"].chatCompletionsEffectBundle?.id).toBe(
      "openai-official-chat",
    );
    expect(registry["deepseek-chat"].chatCompletionsEffectBundle?.id).toBe(
      "deepseek-chat",
    );
    expect(registry["openai-responses"].chatCompletionsEffectBundle).toBeUndefined();
    expect(
      registry["openai-responses"].normalizedChatCompletionsStreamBinding?.id,
    ).toBe("openai-responses-normalized");
    expect(
      registry["openai-responses"].normalizedChatCompletionsStreamBinding,
    ).not.toBe(registry["openai-chat"].chatCompletionsEffectBundle);
    expect(
      registry["openai-responses"].normalizedChatCompletionsStreamBinding,
    ).not.toHaveProperty("resolveEndpoint");
  });
});
