import { expect, it } from "bun:test"
import { createHolonProductProviderTransport, readHolonProductProviderMessage } from "./fixtures/holonProductProviderTransport"

it("sends actual DeepSeek wire requests over loopback, preserving prefix/schema and parsing synthetic usage", async () => {
  const transport = createHolonProductProviderTransport({
    sessionId: "holon-product-transport",
    respond: (wire) => ({ observed: wire.messages.at(-1)?.content }),
  })
  try {
    const tool = { type: "function" as const, function: { name: "material_write", description: "Write validated material", parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] } } }
    for (const [prefix, payload] of [["recipe-v1", "order-a"], ["recipe-v1", "order-b"], ["recipe-v2", "order-c"]]) {
      const result = await transport.adapter.createStream({ model: "deepseek-chat", messages: [{ role: "system", content: prefix }, { role: "user", content: payload }], tools: [tool] })
      expect(JSON.parse((await readHolonProductProviderMessage(result.stream)).content)).toEqual({ observed: payload })
      expect(await result.providerOutput).toMatchObject({ usage: { prompt_tokens: 120, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20, completion_tokens: 7 } })
    }
    expect(transport.requests).toHaveLength(3)
    expect(transport.requests[0]!.body.stream_options).toEqual({ include_usage: true })
    expect(transport.requests[0]!.body.tools).toHaveLength(1)
    expect(transport.requests[0]!.stablePrefixDigest).toBe(transport.requests[1]!.stablePrefixDigest)
    expect(transport.requests[0]!.requestDigest).not.toBe(transport.requests[1]!.requestDigest)
    expect(transport.requests[2]!.stablePrefixDigest).not.toBe(transport.requests[0]!.stablePrefixDigest)
    expect(new Set(transport.requests.map(fact => fact.toolSchemaDigest)).size).toBe(1)
    const observations = transport.observations.filter(fact => fact.captureLayer === "provider_transport_before_send")
    expect(observations).toHaveLength(3)
    expect(observations.map(fact => typeof fact.requestBody === "string" ? JSON.parse(fact.requestBody) : fact.requestBody)).toEqual(transport.requests.map(fact => fact.body))
    expect(transport.failures).toEqual([])
    expect(transport.metrics).toMatchObject({ usage: "synthetic", paidRequests: 0, paidCost: 0, liveProviderCacheHitRate: null })
  } finally { await transport.close() }
})
