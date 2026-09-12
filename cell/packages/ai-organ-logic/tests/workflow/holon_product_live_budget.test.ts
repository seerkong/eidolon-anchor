import { describe, expect, test } from "bun:test"
import { createHolonProductLiveProvider } from "./fixtures/holonProductLiveProvider"
import { readHolonProductProviderMessage } from "./fixtures/holonProductProviderTransport"

const secret = "never-report-this-test-credential"
const provider = { id: "siliconflow", adapter: "deepseek", options: { apiKey: secret, baseURL: "https://provider.invalid/v1" }, models: [{ id: "DeepSeek-Test" }] }
const catalog = { providers: [provider] }
const input = { model: "DeepSeek-Test", messages: [{ role: "user", content: "Respond briefly" }], tools: [] }
function response() {
  return new Response([
    { choices: [{ index: 0, delta: { role: "assistant", content: "actual parsed stream" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 10 } },
  ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } })
}
async function consume(live: ReturnType<typeof createHolonProductLiveProvider>, options = input) {
  const result = await live.adapter.createStream(options)
  const message = await readHolonProductProviderMessage(result.stream)
  await result.providerOutput
  return message
}

describe("Holon product shared live HTTP budget (offline)", () => {
  test("explicit output budget reaches wire and diagnostics without relaxing request limits", async () => {
    const wires: any[] = []
    const live = createHolonProductLiveProvider({ catalog, env: {}, maxOutputTokens: 16384, deadlineMs: 175_000, fetch: (async (_url, init) => {
      wires.push(JSON.parse(String(init?.body))); return response()
    }) as typeof fetch })
    try {
      await consume(live, { ...input, extraBody: { max_tokens: 9000, max_completion_tokens: 9000 } } as any)
      await consume(live)
      await expect(consume(live)).rejects.toThrow("request_limit")
      expect(wires).toHaveLength(2)
      expect(wires.every(wire => wire.max_tokens === 16384 && !("max_completion_tokens" in wire))).toBe(true)
      expect(live.modelConfig).toMatchObject({ maxOutputTokens: 16384, outputLimit: 16384 })
      expect(live.metrics).toMatchObject({ maxRequests: 2, maxOutputTokens: 16384, deadlineMs: 175_000 })
    } finally { await live.close() }
    for (const maxOutputTokens of [0, -1, 1.5, NaN, Infinity, 16385]) {
      expect(() => createHolonProductLiveProvider({ catalog, env: {}, maxOutputTokens })).toThrow("configuration")
    }
  })
  test("reasoning-only and truncated JSON diagnostics retain finish reasons without leaking credentials", async () => {
    const live = createHolonProductLiveProvider({ catalog, env: {}, fetch: (async () => new Response([
      { choices: [{ index: 0, delta: { reasoning_content: "compute privately", content: `partial ${secret} https://private.invalid/?token=secret` }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "artifact", arguments: "{}" } }] }, finish_reason: "length" }] },
    ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } })) as typeof fetch })
    try {
      await consume(live)
      expect(live.metrics.outputDiagnostics).toMatchObject([{ finishReasons: ["length"], reasoningLength: 17,
        content: "partial [credential] [url]", toolCalls: [{ index: 0, name: "artifact", argumentsLength: 2 }] }])
      expect(JSON.stringify(live.metrics)).not.toContain(secret)
      expect(JSON.stringify(live.metrics)).not.toContain("private.invalid")
    } finally { await live.close() }
  })
  test("two parallel actors share two actual sends; third is rejected and admitted wire caps output", async () => {
    const wires: any[] = []
    const live = createHolonProductLiveProvider({ catalog, env: {}, fetch: (async (_url, init) => {
      expect(init?.redirect).toBe("error")
      wires.push(JSON.parse(String(init?.body)))
      return response()
    }) as typeof fetch })
    try {
      expect(live.metrics.httpRequests).toBe(0)
      expect(live.metrics.usageObserved).toBe(false)
      expect(live.metrics.usage).toBeNull()
      const messages = await Promise.all([consume(live, { ...input, extraBody: { max_tokens: 9000, max_completion_tokens: 9000 } } as any), consume(live)])
      expect(messages.map(message => message.content)).toEqual(["actual parsed stream", "actual parsed stream"])
      await expect(consume(live)).rejects.toThrow()
      expect(wires).toHaveLength(2)
      expect(wires.every(wire => wire.max_tokens === 512 && wire.stream_options.include_usage === true)).toBe(true)
      expect(wires.every(wire => !("max_completion_tokens" in wire))).toBe(true)
      expect(live.metrics.httpRequests).toBe(2)
      expect(live.metrics.completedOutputs).toBe(2)
      expect(live.metrics.usageObserved).toBe(true)
      expect(live.metrics.usage).toEqual({ promptTokens: 40, completionTokens: 8, totalTokens: 48, cacheHitTokens: 20, cacheMissTokens: 20 })
      expect(live.metrics.failureCodes).toContain("REQUEST_LIMIT")
      expect(JSON.stringify({ metrics: live.metrics, modelConfig: live.modelConfig })).not.toContain(secret)
    } finally { await live.close() }
  })

  test("three simultaneously admitted actors cannot race past two transport reservations", async () => {
    let sends = 0
    const live = createHolonProductLiveProvider({ catalog, env: {}, fetch: (async () => {
      sends += 1; await Promise.resolve(); return response()
    }) as typeof fetch })
    try {
      const results = await Promise.allSettled([consume(live), consume(live), consume(live)])
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2)
      expect(results.filter(result => result.status === "rejected")).toHaveLength(1)
      expect(sends).toBe(2)
      expect(live.metrics.httpRequests).toBe(2)
    } finally { await live.close() }
  })

  test("caller cancellation aborts a pending send with a sanitized code", async () => {
    const controller = new AbortController()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const live = createHolonProductLiveProvider({ catalog, env: {}, fetch: (async () => {
      entered(); return new Promise<Response>(() => {})
    }) as typeof fetch })
    try {
      const pending = consume(live, { ...input, signal: controller.signal } as any).then(() => "resolved", error => String(error))
      await started
      controller.abort(new Error(secret))
      expect(await pending).toBe("HolonLiveBudgetError: holon_live_cancelled")
      expect(live.metrics.httpRequests).toBe(1)
      expect(JSON.stringify(live.metrics)).not.toContain(secret)
    } finally { await live.close() }
  })

  for (const status of [400, 401, 429, 500]) test(`HTTP ${status} never triggers automatic adapter retries or exposes response secrets`, async () => {
    let sends = 0
    const live = createHolonProductLiveProvider({ catalog, env: {}, fetch: (async () => {
      sends += 1
      return new Response(secret, { status })
    }) as typeof fetch })
    try {
      let failure: unknown
      try { await consume(live) } catch (error) { failure = error }
      expect(String(failure)).toBe("HolonLiveBudgetError: holon_live_transport_failed")
      expect(sends).toBe(1)
      expect(live.metrics.httpRequests).toBe(1)
      expect(live.metrics.completedOutputs).toBe(0)
      expect(live.metrics.requestDiagnostics).toEqual([{ request: 1, httpStatus: status }])
      expect(JSON.stringify(live.metrics)).not.toContain(secret)
    } finally { await live.close() }
  })

  test("network rejection is sanitized and does not retry", async () => {
    let sends = 0
    const live = createHolonProductLiveProvider({ catalog, env: {}, fetch: (async () => {
      sends += 1; throw new Error(secret)
    }) as typeof fetch })
    try {
      await expect(consume(live)).rejects.toThrow("holon_live_transport_failed")
      expect(sends).toBe(1)
    } finally { await live.close() }
  })

  test("total deadline interrupts pending headers even if injected transport ignores abort", async () => {
    let signal: AbortSignal | undefined
    const live = createHolonProductLiveProvider({ catalog, env: {}, deadlineMs: 30, fetch: (async (_url, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    }) as typeof fetch })
    try {
      await expect(consume(live)).rejects.toThrow("holon_live_deadline")
      expect(signal?.aborted).toBe(true)
      await expect(consume(live)).rejects.toThrow("holon_live_deadline")
      expect(live.metrics.httpRequests).toBe(1)
    } finally { await live.close() }
  })

  test("total deadline covers a stalled response body, including post-header reads", async () => {
    let signal: AbortSignal | undefined
    const live = createHolonProductLiveProvider({ catalog, env: {}, deadlineMs: 30, fetch: (async (_url, init) => {
      signal = init?.signal ?? undefined
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'))
      } }), { headers: { "Content-Type": "text/event-stream" } })
    }) as typeof fetch })
    try {
      await expect(consume(live)).rejects.toThrow("holon_live_deadline")
      expect(signal?.aborted).toBe(true)
      expect(live.metrics.completedOutputs).toBe(0)
    } finally { await live.close() }
  })

  test("deadline is shared across sequential calls rather than restarted per actor", async () => {
    let time = 0
    const live = createHolonProductLiveProvider({ catalog, env: {}, now: () => time, fetch: (async () => response()) as typeof fetch })
    try {
      await consume(live)
      time = 60_001
      await expect(consume(live)).rejects.toThrow("holon_live_deadline")
      expect(live.metrics.httpRequests).toBe(1)
    } finally { await live.close() }
  })

  test("close aborts active HTTP, is idempotent, and prevents any later send", async () => {
    let signal: AbortSignal | undefined
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const live = createHolonProductLiveProvider({ catalog, env: {}, fetch: (async (_url, init) => {
      signal = init?.signal ?? undefined
      entered()
      return new Promise<Response>(() => {})
    }) as typeof fetch })
    const pending = consume(live)
    const observed = pending.then(() => "resolved", error => String(error))
    await started
    await live.close()
    await live.close()
    expect(await observed).toBe("HolonLiveBudgetError: holon_live_closed")
    expect(signal?.aborted).toBe(true)
    await expect(consume(live)).rejects.toThrow("holon_live_closed")
    expect(live.metrics.httpRequests).toBe(1)
  })

  test("explicit catalog selection is exact, model config is value safe, missing selection fails closed", async () => {
    const live = createHolonProductLiveProvider({ catalog: { providers: { other: { ...provider, models: { selected: { id: "custom" } } } } },
      env: { EIDOLON_DEEPSEEK_COMPATIBLE_PROVIDER: "other", EIDOLON_DEEPSEEK_COMPATIBLE_MODEL: "custom" } })
    expect(live.modelConfig.provider).toBe("other")
    expect(live.modelConfig.model).toBe("custom")
    expect(live.metrics.httpRequests).toBe(0)
    await live.close()
    expect(() => createHolonProductLiveProvider({ catalog, env: { EIDOLON_DEEPSEEK_COMPATIBLE_PROVIDER: "missing" } })).toThrow("holon_live_configuration")
    expect(() => createHolonProductLiveProvider({ catalog, env: { EIDOLON_DEEPSEEK_COMPATIBLE_MODEL: "missing" } })).toThrow("holon_live_configuration")
    expect(() => createHolonProductLiveProvider({ catalog, env: {}, deadlineMs: 180_001 })).toThrow("holon_live_configuration")
    expect(() => createHolonProductLiveProvider({ catalog: { providers: [{ ...provider, options: { ...provider.options, baseURL: "http://unsafe.invalid" } }] }, env: {} })).toThrow("holon_live_configuration")
  })

  test("official DeepSeek is usable as fallback and missing provider usage remains unknown", async () => {
    const live = createHolonProductLiveProvider({ catalog: { providers: [{ ...provider, id: "deepseek" }] }, env: {},
      fetch: (async () => new Response('data: {"choices":[{"index":0,"delta":{"content":"response without usage"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "Content-Type": "text/event-stream" } })) as typeof fetch })
    try {
      expect(live.modelConfig.provider).toBe("deepseek")
      expect((await consume(live)).content).toBe("response without usage")
      expect(live.metrics.completedOutputs).toBe(1)
      expect(live.metrics.httpRequests).toBe(1)
      expect(live.metrics.usageObserved).toBe(false)
      expect(live.metrics.usage).toBeNull()
    } finally { await live.close() }
  })
})


test("network diagnostics retain only allowlisted codes, never an error message or URL", async () => {
  for (const code of ["ECONNRESET", secret]) {
    const live = createHolonProductLiveProvider({ catalog, env: {}, fetch: (async () => {
      throw Object.assign(new Error(`https://provider.invalid/?key=${secret}`), { cause: { code } })
    }) as typeof fetch })
    try {
      await expect(consume(live)).rejects.toThrow("holon_live_transport_failed")
      expect(live.metrics.requestDiagnostics).toEqual([{ request: 1, httpStatus: null, errorCode: code === "ECONNRESET" ? code : "NETWORK_UNKNOWN" }])
      expect(JSON.stringify(live.metrics)).not.toContain(secret)
      expect(JSON.stringify(live.metrics)).not.toContain("https://")
    } finally { await live.close() }
  }
})
