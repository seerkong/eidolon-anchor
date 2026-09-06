import { createHash } from "node:crypto"
import type { LlmGenerateOptions, LlmStreamResult } from "@cell/ai-core-contract/LlmTypes"
import type { ProviderRequestObservationData } from "@cell/ai-organ-contract/llm/ProviderRuntime"
import { ProviderRuntimeLlmAdapter } from "@cell/ai-organ-logic/llm/ProviderRuntimeAdapter"

export type HolonProductWire = Readonly<{
  model: string
  messages: readonly Readonly<{ role: string; content?: unknown }>[]
  tools?: readonly unknown[]
  stream_options?: Readonly<{ include_usage?: boolean }>
}>

export type HolonProductWireFact = Readonly<{
  body: HolonProductWire
  stablePrefixDigest: string
  toolSchemaDigest: string
  requestDigest: string
}>

export type HolonProductProviderTransport = Readonly<{
  adapter: ProviderRuntimeLlmAdapter
  requests: HolonProductWireFact[]
  observations: ProviderRequestObservationData[]
  outputs: unknown[]
  failures: unknown[]
  metrics: Readonly<{
    transport: "loopback-http-sse"
    usage: "synthetic"
    paidRequests: 0
    paidCost: 0
    liveProviderCacheHitRate: null
  }>
  close(): Promise<void>
}>

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

/** Local transport replacement, not a claim about a live provider's cache hit rate. */
export function createHolonProductProviderTransport(options: Readonly<{
  sessionId: string
  respond: (wire: HolonProductWire) => Promise<unknown> | unknown
}>): HolonProductProviderTransport {
  const requests: HolonProductWireFact[] = []
  const observations: ProviderRequestObservationData[] = []
  const outputs: unknown[] = []
  const failures: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions") {
        return new Response("Unexpected local provider route", { status: 404 })
      }
      try {
        const body = await request.json() as HolonProductWire
        const prefix = []
        for (const message of body.messages) {
          if (message.role !== "system" && message.role !== "developer") break
          prefix.push(message)
        }
        requests.push(Object.freeze({
          body: structuredClone(body), stablePrefixDigest: digest(prefix),
          toolSchemaDigest: digest(body.tools ?? []), requestDigest: digest(body),
        }))
        const value = await options.respond(body)
        const content = typeof value === "string" ? value : JSON.stringify(value)
        return new Response([
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
          // Deliberately synthetic values verify accounting, never production SLOs.
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20 } })}`,
          "data: [DONE]", "",
        ].join("\n\n"), { headers: { "Content-Type": "text/event-stream" } })
      } catch (error) {
        failures.push(error)
        return new Response("Local fixture response failed", { status: 400 })
      }
    },
  })
  const adapter = new ProviderRuntimeLlmAdapter({
    providerId: "holon-product-local-transport",
    selectedModel: "deepseek-chat", adapterName: "deepseek",
    options: { apiKey: "local-fixture-only", baseURL: `http://127.0.0.1:${server.port}/v1` },
    runtime: { sessionId: options.sessionId, requestObservationPort: {
      append: (fact) => { observations.push(fact) }, appendOutcome: () => {},
    } },
  })
  const createStream = adapter.createStream.bind(adapter)
  adapter.createStream = async (input: LlmGenerateOptions): Promise<LlmStreamResult> => {
    const result = await createStream(input)
    return { ...result, providerOutput: result.providerOutput?.then((value) => {
      outputs.push(value)
      return value
    }) }
  }
  return {
    adapter, requests, observations, outputs, failures,
    metrics: Object.freeze({ transport: "loopback-http-sse", usage: "synthetic", paidRequests: 0, paidCost: 0, liveProviderCacheHitRate: null }),
    async close(): Promise<void> { await server.stop(true) },
  }
}

/** Consume real provider parser output; do not substitute a canned assistant message. */
export async function readHolonProductProviderMessage(stream: AsyncIterable<unknown>): Promise<{ role: "assistant"; content: string }> {
  let content = ""
  for await (const chunk of stream) {
    const choices = (chunk as { choices?: { delta?: { content?: unknown } }[] }).choices
    for (const choice of choices ?? []) {
      if (typeof choice.delta?.content === "string") content += choice.delta.content
    }
  }
  if (!content) throw new Error("Product provider transport returned no assistant content")
  return { role: "assistant", content }
}
