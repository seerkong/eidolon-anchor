import { describe, expect, it } from "bun:test"

import * as llm from "@cell/ai-organ-logic/llm"
import { isLlmProviderCatalogRawConfig } from "@cell/ai-organ-contract/llm/ProviderConfig"

const visionConfig = {
  providers: [{
    id: "openai",
    adapter: "openai",
    options: { baseURL: "https://api.openai.example/v1", apiKey: "secret" },
    models: [{
      id: "gpt-vision",
      limits: { context: 128_000, output: 8_192 },
      modalities: { input: ["text", "image"], output: ["text"] },
    }],
  }],
}

describe("model modalities config propagation", () => {
  it("parses, normalizes, flattens, and exposes configured modalities as model capabilities", () => {
    expect(isLlmProviderCatalogRawConfig(visionConfig)).toBe(true)

    const parsed = llm.parseProviderCatalogRaw(visionConfig)
    expect(parsed.providers[0]?.models[0]).toMatchObject({
      modalities: { input: ["text", "image"], output: ["text"] },
    })

    const flattened = llm.flattenModelConfig("openai/gpt-vision", parsed)
    expect(flattened).toMatchObject({
      modalities: { input: ["text", "image"], output: ["text"] },
      capabilities: {
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    })
  })
})

describe("send-before modality validation contract", () => {
  it("fails closed before observation/I/O and emits only a redacted unsupported_modality diagnostic", async () => {
    const validateInputModalities = (llm as Record<string, unknown>).validateInputModalities
    expect(validateInputModalities, "llm must export validateInputModalities").toBeFunction()

    const networkCalls: unknown[] = []
    const observations: unknown[] = []
    const absolutePath = "C:\\Users\\alice\\Pictures\\private.png"
    const dataUrl = "data:image/png;base64,cHJpdmF0ZS1pbWFnZS1ieXRlcw=="
    const draft = {
      input: "describe this ",
      parts: [{
        type: "file" as const,
        mime: "image/png",
        url: dataUrl,
        filename: absolutePath,
        source: { start: 14, end: 26, value: "@fs:private.png" },
      }],
    }
    const before = structuredClone(draft)

    const result = await (validateInputModalities as Function)({
      modelRef: "deepseek/deepseek-text",
      modalities: { input: ["text"], output: ["text"] },
      content: [{
        type: "image",
        mime: "image/png",
        dataUrl,
        size: 19,
        sourceDigest: "sha256:0123456789abcdef",
        filename: absolutePath,
      }],
      observe: (event: unknown) => observations.push(event),
      send: (request: unknown) => networkCalls.push(request),
    })

    expect(result).toMatchObject({
      ok: false,
      error: { code: "unsupported_modality" },
      diagnostic: {
        kind: "unsupported_modality",
        model: "deepseek/deepseek-text",
        modalities: { input: ["text"], output: ["text"] },
        partKind: "image",
        mime: "image/png",
        size: 19,
        digest: "sha256:0123456789abcdef",
      },
    })
    expect(networkCalls).toHaveLength(0)
    expect(observations).toHaveLength(0)
    expect(draft).toEqual(before)

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain("base64")
    expect(serialized).not.toContain("cHJpdmF0ZS1pbWFnZS1ieXRlcw")
    expect(serialized).not.toContain("C:\\\\Users")
  })

  it("treats missing or unknown input modalities as unsupported instead of guessing image support", async () => {
    const validateInputModalities = (llm as Record<string, unknown>).validateInputModalities as Function
    expect(validateInputModalities, "llm must export validateInputModalities").toBeFunction()

    for (const modalities of [undefined, { input: ["text", "future_media"], output: ["text"] }]) {
      const result = await validateInputModalities({
        modelRef: "example/unknown-capability",
        modalities,
        content: [{
          type: "image",
          mime: "image/jpeg",
          dataUrl: "data:image/jpeg;base64,eA==",
          size: 1,
          sourceDigest: "sha256:unknown-case",
        }],
      })
      expect(result).toMatchObject({ ok: false, error: { code: "unsupported_modality" } })
    }
  })

  it("keeps legacy text-only callers compatible when modalities are absent or unknown", async () => {
    const validateInputModalities = (llm as Record<string, unknown>).validateInputModalities as Function

    for (const modalities of [undefined, { input: ["text", "future_media"], output: ["text"] }]) {
      const result = await validateInputModalities({
        modelRef: "example/legacy-text-model",
        modalities,
        content: [{ type: "text", text: "legacy string caller" }],
      })
      expect(result).toEqual({ ok: true })
    }
  })
})
