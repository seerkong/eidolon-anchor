import { describe, expect, it } from "bun:test"

import type { InputContentPart } from "@shared/composer"
import * as llm from "@cell/ai-organ-logic/llm"

const PRIVATE_BASE64 = "cHJpdmF0ZS1pbWFnZS1ieXRlcw=="
const PRIVATE_PATH = "C:\\Users\\alice\\Pictures\\private.png"

function imagePart(dataUrl = `data:image/png;base64,${PRIVATE_BASE64}`): InputContentPart {
  return {
    type: "image",
    mime: "image/png",
    dataUrl,
    size: 19,
    sourceDigest: "sha256:image-fixture",
    filename: PRIVATE_PATH,
  }
}

function mixedContent(image = imagePart()): InputContentPart[] {
  return [
    { type: "text", text: "before " },
    image,
    { type: "text", text: " after" },
  ]
}

const expectedResponsesContent = [
  { type: "input_text", text: "before " },
  { type: "input_image", image_url: `data:image/png;base64,${PRIVATE_BASE64}` },
  { type: "input_text", text: " after" },
]

describe("OpenAI canonical image projection", () => {
  it("preserves canonical text/image order as Chat Completions text/image_url content", () => {
    const messages = llm.normalizeOpenAIChatMessages([
      { role: "user", content: mixedContent() },
    ])

    expect(messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "before " },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${PRIVATE_BASE64}` },
        },
        { type: "text", text: " after" },
      ],
    }])
  })

  it("preserves canonical text/image order as Responses input_text/input_image content", () => {
    const built = llm.buildOpenAIResponsesInputItems([
      { role: "user", content: mixedContent() },
    ])

    expect(built.messageItems).toEqual([{
      type: "message",
      role: "user",
      content: expectedResponsesContent,
    }])
  })

  it("rejects unsupported data URL MIME and oversize images through the canonical validator", () => {
    const validateCanonicalImage = (llm as Record<string, unknown>).validateCanonicalImage
    expect(validateCanonicalImage, "llm must export validateCanonicalImage").toBeFunction()

    expect(() => (validateCanonicalImage as Function)(
      imagePart("data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA=="),
      { allowedMimeTypes: ["image/png"], maxBytes: 32 },
    )).toThrow(/mime|image\/gif/i)

    expect(() => (validateCanonicalImage as Function)(
      { ...imagePart(), size: 33 },
      { allowedMimeTypes: ["image/png"], maxBytes: 32 },
    )).toThrow(/size|large|32/i)
  })

  it("keeps exactly one image in Responses full replay", () => {
    const input = llm.buildOpenAIResponsesFullInputItems([
      { role: "user", content: mixedContent() },
      { role: "assistant", content: "seen" },
    ])

    expect(input[0]).toEqual({
      type: "message",
      role: "user",
      content: expectedResponsesContent,
    })
    expect(JSON.stringify(input).match(/input_image/g)).toHaveLength(1)
  })

  it("keeps exactly one image in Responses incremental replay", () => {
    const input = llm.buildOpenAIResponsesIncrementalInputItems([
      { role: "user", content: mixedContent() },
    ])

    expect(input).toEqual([{
      type: "message",
      role: "user",
      content: expectedResponsesContent,
    }])
    expect(JSON.stringify(input).match(/input_image/g)).toHaveLength(1)
  })

  it("changes the provider-visible context digest when only image content changes", () => {
    const first = llm.buildOpenAIResponsesFullInputItems([
      { role: "user", content: mixedContent(imagePart("data:image/png;base64,Zmlyc3Q=")) },
    ])
    const second = llm.buildOpenAIResponsesFullInputItems([
      { role: "user", content: mixedContent(imagePart("data:image/png;base64,c2Vjb25k")) },
    ])

    expect(llm.createResponsesContextDigest({ input: first }))
      .not.toBe(llm.createResponsesContextDigest({ input: second }))
  })

  it("summarizes images for observations and logs without data URL, base64, or local path", () => {
    const summarizeCanonicalImage = (llm as Record<string, unknown>).summarizeCanonicalImage
    expect(summarizeCanonicalImage, "llm must export summarizeCanonicalImage").toBeFunction()

    const summary = (summarizeCanonicalImage as Function)(imagePart())
    expect(summary).toEqual({
      mime: "image/png",
      size: 19,
      digest: "sha256:image-fixture",
    })
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain("data:image")
    expect(serialized).not.toContain(PRIVATE_BASE64)
    expect(serialized).not.toContain("C:\\\\Users")
    expect(serialized).not.toContain("private.png")
  })

  it("materializes image wire content in both adapter request bodies while preserving text-only bodies", async () => {
    const chatBodies: any[] = []
    const chat = new llm.OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      providerOptions: {
        fetch: async (_url, init) => {
          chatBodies.push(JSON.parse(String(init?.body)))
          return new Response("data: [DONE]\n\n", { status: 200 })
        },
      },
    })
    await chat.createStream({ model: "gpt-vision", messages: [{ role: "user", content: mixedContent() }], tools: [] })
    await chat.createStream({ model: "gpt-text", messages: [{ role: "user", content: "hello" }], tools: [] })
    expect(chatBodies[0].messages[0].content).toEqual([
      { type: "text", text: "before " },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PRIVATE_BASE64}` } },
      { type: "text", text: " after" },
    ])
    expect(chatBodies[1].messages).toEqual([{ role: "user", content: "hello" }])

    const responsesBodies: any[] = []
    const responses = new llm.OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      providerOptions: {
        fetch: async (_url, init) => {
          responsesBodies.push(JSON.parse(String(init?.body)))
          return new Response("data: [DONE]\n\n", { status: 200 })
        },
      },
    })
    await responses.createStream({ model: "gpt-vision", messages: [{ role: "user", content: mixedContent() }], tools: [] })
    await responses.createStream({ model: "gpt-text", messages: [{ role: "user", content: "hello" }], tools: [] })
    expect(responsesBodies[0].input[0].content).toEqual(expectedResponsesContent)
    expect(responsesBodies[1].input).toEqual([{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    }])
  })

  it("redacts image bytes and local paths from provider observation copies", async () => {
    const observations: any[] = []
    const adapter = new llm.ProviderRuntimeLlmAdapter({
      providerId: "openai",
      selectedModel: "gpt-vision",
      adapterName: "openai-chat",
      runtime: { requestObservationPort: { append: (event) => observations.push(event) } },
      driver: {
        name: "image-observation-fixture",
        adapterNames: ["openai-chat"],
        async createStream(params) {
          const body = JSON.stringify({ model: params.model, messages: llm.normalizeOpenAIChatMessages(params.messages as any[]) })
          params.transportRequestObserver?.({ transportType: "http", requestBody: body })
          return { stream: (async function* () {})() }
        },
      },
    })
    await adapter.createStream({ model: "gpt-vision", messages: [{ role: "user", content: mixedContent() }], tools: [] })

    const serialized = JSON.stringify(observations)
    expect(serialized).not.toContain("data:image")
    expect(serialized).not.toContain(PRIVATE_BASE64)
    expect(serialized).not.toContain(PRIVATE_PATH)
    expect(serialized).toContain("sha256:")
  })
})
