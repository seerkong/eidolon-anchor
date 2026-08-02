import { describe, expect, it } from "bun:test"
import fs from "fs"
import path from "path"

import {
  OpenAICompletionsNodejsFetchLlmAdapter,
} from "@cell/ai-organ-logic/llm/OpenAICompletionsNodejsFetchAdapter"
import {
  flattenModelConfig,
  parseProviderCatalogRaw,
  ProviderRuntimeLlmAdapter,
  validateInputModalities,
} from "@cell/ai-organ-logic/llm"

const EXAMPLE_CONFIG_PATH = path.resolve(
  import.meta.dir,
  "../../../../../examples/config/llm-provider.json",
)

function loadExampleCatalog() {
  return parseProviderCatalogRaw(JSON.parse(fs.readFileSync(EXAMPLE_CONFIG_PATH, "utf8")))
}

function sseResponse(): Response {
  return new Response("data: [DONE]\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

describe("DeepSeek V4 Flash official capability contract (2026-08-02)", () => {
  it("publishes the official model id, limits, reasoning controls, and text-only modalities", () => {
    const catalog = loadExampleCatalog()
    const provider = catalog.providers.find((candidate) => candidate.name === "deepseek")
    const model = provider?.models.find((candidate) => candidate.name === "deepseek-v4-flash")

    expect(provider?.options.baseURL).toBe("https://api.deepseek.com")
    expect(model).toMatchObject({
      name: "deepseek-v4-flash",
      context: 1_000_000,
      output: 393_216,
      reasoning: { effort: "high" },
      modalities: { input: ["text"], output: ["text"] },
      options: { thinking: { type: "enabled" }, reasoningEffort: "high" },
    })

    const flattened = flattenModelConfig("deepseek/deepseek-v4-flash", catalog)
    expect(flattened).toMatchObject({
      model: "deepseek-v4-flash",
      inputLimit: 1_000_000,
      outputLimit: 393_216,
      reasoningEffort: "high",
      modalities: { input: ["text"], output: ["text"] },
      capabilities: {
        family: "deepseek",
        contextWindow: 1_000_000,
        outputLimit: 393_216,
        reasoningEffort: "high",
        modalities: { input: ["text"], output: ["text"] },
      },
    })
  })

  it("keeps the official Chat Completions model/tool/stream/thinking request shape", async () => {
    let requestedUrl = ""
    let body: Record<string, unknown> = {}
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.com",
      providerOptions: {
        fetch: async (url, init) => {
          requestedUrl = String(url)
          body = JSON.parse(String(init?.body ?? "{}"))
          return sseResponse()
        },
      },
    })
    const tools = [{
      type: "function",
      function: {
        name: "lookup_weather",
        description: "Look up weather",
        parameters: { type: "object", properties: {} },
      },
    }] as any

    await adapter.createStream({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "weather" }],
      tools,
      extraBody: {
        thinking: { type: "enabled" },
        reasoning_effort: "high",
      },
    })

    expect(requestedUrl).toBe("https://api.deepseek.com/chat/completions")
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "weather" }],
      tools,
      stream: true,
      thinking: { type: "enabled" },
      reasoning_effort: "high",
    })
  })

  it("preserves V4 Flash options through the DeepSeek provider driver", () => {
    const flattened = flattenModelConfig("deepseek/deepseek-v4-flash", loadExampleCatalog())!
    const adapter = new ProviderRuntimeLlmAdapter({
      providerId: flattened.provider,
      selectedModel: "deepseek/deepseek-v4-flash",
      adapterName: flattened.adapter,
      options: {
        baseURL: flattened.baseURL,
        apiKey: "test-key",
        ...flattened.options,
      },
    })
    const tools = [{ type: "function", function: { name: "clock", parameters: { type: "object" } } }] as any
    const prepared = adapter.prepareRequest({
      model: flattened.model,
      messages: [{ role: "user", content: "time" }],
      tools,
    })

    expect(prepared.connectionOptions.base_url).toBe("https://api.deepseek.com")
    expect(prepared.contract).toMatchObject({
      method: "POST",
      body: {
        model: "deepseek-v4-flash",
        tools,
        stream: true,
        thinking: { type: "enabled" },
        reasoning_effort: "high",
      },
    })
  })

  it("rejects V4 Flash images before provider observation and network send", () => {
    const flattened = flattenModelConfig("deepseek/deepseek-v4-flash", loadExampleCatalog())!
    const requestObservations: unknown[] = []
    const networkCalls: unknown[] = []
    const result = validateInputModalities({
      modelRef: "deepseek/deepseek-v4-flash",
      modalities: flattened.modalities,
      content: [{
        type: "image",
        mime: "image/png",
        dataUrl: "data:image/png;base64,cHJpdmF0ZS1pbWFnZQ==",
        size: 13,
        sourceDigest: "sha256:deepseek-v4-flash-gate",
        filename: "C:\\Users\\alice\\private.png",
      }],
      observe: (event) => requestObservations.push(event),
      send: (request) => networkCalls.push(request),
    })

    expect(result).toMatchObject({
      ok: false,
      error: { code: "unsupported_modality" },
      diagnostic: {
        kind: "unsupported_modality",
        model: "deepseek/deepseek-v4-flash",
        modalities: { input: ["text"], output: ["text"] },
        partKind: "image",
        mime: "image/png",
        size: 13,
        digest: "sha256:deepseek-v4-flash-gate",
      },
    })
    expect(requestObservations).toHaveLength(0)
    expect(networkCalls).toHaveLength(0)
    const serialized = JSON.stringify(result)
    expect(serialized).toContain("sha256:deepseek-v4-flash-gate")
    expect(serialized).not.toContain("base64")
    expect(serialized).not.toContain("cHJpdmF0ZS1pbWFnZQ")
    expect(serialized).not.toContain("C:\\\\Users")
  })
})
