import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ActorModelConfig } from "@cell/ai-core-contract/runtime/AiAgentActor"
import type { LlmGenerateOptions, LlmStreamResult } from "@cell/ai-core-contract/LlmTypes"
import { ProviderRuntimeLlmAdapter } from "@cell/ai-organ-logic/llm/ProviderRuntimeAdapter"
import { buildDeepSeekProviderDriver } from "@cell/ai-organ-logic/llm/drivers/DeepSeekDriver"
import { deepSeekChatEffectBundle } from "@cell/ai-organ-logic/llm/ChatCompletionsEffectBundles"
import { OpenAICompletionsAdmittedFetchTransport } from "@cell/ai-organ-logic/llm/OpenAICompletionsNodejsFetchAdapter"
import type { ProviderToolSchemaProjectionAuthority } from "@cell/ai-organ-contract/llm/ProviderToolSchemaProjection"

type FailureCode = "CONFIGURATION" | "REQUEST_LIMIT" | "DEADLINE" | "CLOSED" | "CANCELLED" | "TRANSPORT_FAILED"
export class HolonLiveBudgetError extends Error {
  constructor(readonly code: FailureCode) { super(`holon_live_${code.toLowerCase()}`); this.name = "HolonLiveBudgetError" }
}

export type HolonProductLiveProviderOptions = Readonly<{
  catalog?: unknown
  env?: Readonly<Record<string, string | undefined>>
  fetch?: typeof fetch
  now?: () => number
  /** Tests may shorten, never extend, the authorized total deadline. */
  deadlineMs?: number
  /** Explicit per-run output budget; defaults to the original 512-token gate. */
  maxOutputTokens?: number
  sessionId?: string
}>

function selectProvider(options: HolonProductLiveProviderOptions) {
  try {
    const env = options.env ?? process.env
    const catalog = options.catalog ?? JSON.parse(readFileSync(join(homedir(), ".eidolon", "llm-provider.json"), "utf8"))
    const raw = (catalog as any)?.providers
    const providers: any[] = Array.isArray(raw) ? raw : raw && typeof raw === "object"
      ? Object.entries(raw).map(([id, value]) => ({ ...(value as object), id })) : []
    const requested = env.EIDOLON_DEEPSEEK_COMPATIBLE_PROVIDER?.trim()
    const valid = providers.filter(p => typeof p?.id === "string"
      && p.adapter === "deepseek" && typeof p.options?.apiKey === "string" && p.options.apiKey.trim()
      && typeof p.options?.baseURL === "string" && new URL(p.options.baseURL).protocol === "https:")
    const provider = requested ? valid.find(p => p.id === requested)
      : valid.find(p => p.id === "siliconflow") ?? valid.find(p => p.id !== "deepseek") ?? valid[0]
    if (!provider) throw new HolonLiveBudgetError("CONFIGURATION")
    const models: any[] = Array.isArray(provider.models) ? provider.models : Object.values(provider.models ?? {})
    const requestedModel = env.EIDOLON_DEEPSEEK_COMPATIBLE_MODEL?.trim()
    const model = requestedModel ? models.find(m => m.id === requestedModel)
      : models.find(m => typeof m.id === "string" && /deepseek/i.test(m.id))
    if (!model) throw new HolonLiveBudgetError("CONFIGURATION")
    return { providerId: provider.id as string, model: model.id as string,
      apiKey: provider.options.apiKey as string, baseURL: provider.options.baseURL as string }
  } catch { throw new HolonLiveBudgetError("CONFIGURATION") }
}

/** One instance owns the HTTP budget for every actor in one product run. Creation performs no HTTP. */
export function createHolonProductLiveProvider(options: HolonProductLiveProviderOptions = {}) {
  const maxOutputTokens = options.maxOutputTokens ?? 512
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 16384) throw new HolonLiveBudgetError("CONFIGURATION")
  const config = selectProvider(options)
  const deadlineMs = options.deadlineMs ?? 60_000
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 180_000) throw new HolonLiveBudgetError("CONFIGURATION")
  const now = options.now ?? (() => performance.now())
  const startedAt = now()
  const owner = new AbortController()
  let closed = false
  let httpRequests = 0
  let completedOutputs = 0
  const failures = new Set<FailureCode>()
  const requestDiagnostics: { request: number; httpStatus: number | null; errorCode?: string }[] = []
  const outputDiagnostics: { content: string; contentLength: number; reasoningLength: number; finishReasons: string[]; toolCalls: { index: number; name: string; argumentsLength: number }[] }[] = []
  const adapterErrors: { code: string; name: string; message: string }[] = []
  function redactDiagnostic(value: unknown): string {
    return String(value ?? "").split(config.apiKey).join("[credential]")
      .split(config.baseURL).join("[provider-url]")
      .replace(/https?:\/\/[^\s"<>]+/gi, "[url]")
      .replace(/(?:Bearer\s+|sk-)[A-Za-z0-9_.-]+/gi, "[credential]").slice(0, 4096)
  }
  const usageCounts = new Map<string, number>()
  const networkCodes = new Set(["ECONNRESET", "ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"])
  function diagnosticCode(error: unknown): string {
    if (error instanceof HolonLiveBudgetError) return error.code
    for (const value of [error, error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "cause")?.value : null]) {
      const code = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "code")?.value : null
      if (typeof code === "string" && networkCodes.has(code)) return code
    }
    return "NETWORK_UNKNOWN"
  }
  const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }
  function fail(code: FailureCode): HolonLiveBudgetError { failures.add(code); return new HolonLiveBudgetError(code) }
  const timer = setTimeout(() => owner.abort(new HolonLiveBudgetError("DEADLINE")), deadlineMs)
  timer.unref?.()
  function check(signal?: AbortSignal) {
    if (closed) throw fail("CLOSED")
    if (now() - startedAt >= deadlineMs && !owner.signal.aborted) owner.abort(new HolonLiveBudgetError("DEADLINE"))
    if (owner.signal.aborted) throw fail("DEADLINE")
    if (signal?.aborted) throw fail("CANCELLED")
  }
  function safeError(error: unknown): HolonLiveBudgetError {
    adapterErrors.push({ code: diagnosticCode(error), name: redactDiagnostic(error instanceof Error ? error.name : typeof error), message: redactDiagnostic(error instanceof Error ? error.message : error) })
    if (closed) return fail("CLOSED")
    if (owner.signal.aborted) return fail("DEADLINE")
    return error instanceof HolonLiveBudgetError ? fail(error.code) : fail("TRANSPORT_FAILED")
  }
  function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    const aborted = () => owner.signal.aborted ? safeError(owner.signal.reason) : fail("CANCELLED")
    if (signal.aborted) return Promise.reject(aborted())
    return new Promise((resolve, reject) => {
      const abort = () => reject(aborted())
      signal.addEventListener("abort", abort, { once: true })
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    })
  }
  const actualFetch = options.fetch ?? globalThis.fetch
  const budgetedFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    check(init?.signal ?? undefined)
    if (httpRequests >= 2) throw fail("REQUEST_LIMIT")
    // Check admitted bytes instead of silently changing the request after its provenance was recorded.
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null
    if (body?.max_tokens !== maxOutputTokens) throw fail("CONFIGURATION")
    const signal = AbortSignal.any([owner.signal, ...(init?.signal ? [init.signal] : [])])
    httpRequests += 1 // Reserve synchronously: parallel actors cannot overdraw the shared budget.
    const request = httpRequests
    try {
      const response = await bounded(Promise.resolve(actualFetch(url, { ...init, signal, redirect: "error" })), signal)
      requestDiagnostics.push({ request, httpStatus: response.status })
      return response
    } catch (error) {
      requestDiagnostics.push({ request, httpStatus: null, errorCode: diagnosticCode(error) })
      throw safeError(error)
    }
  }) as typeof fetch
  const baseDriver = buildDeepSeekProviderDriver()
  const adapter = new ProviderRuntimeLlmAdapter({
    providerId: config.providerId, selectedModel: config.model, adapterName: "deepseek",
    options: { apiKey: config.apiKey, baseURL: config.baseURL },
    runtime: { sessionId: options.sessionId ?? "holon-product-live" },
    driver: { ...baseDriver, async createStream(params) {
      const transport = new OpenAICompletionsAdmittedFetchTransport({
        apiKey: config.apiKey, baseUrl: config.baseURL, effectBundle: deepSeekChatEffectBundle,
        providerOptions: { apiKey: config.apiKey, baseURL: config.baseURL, fetch: budgetedFetch },
        requestObserver: params.transportRequestObserver,
      })
      return transport.createStream({ model: params.model, messages: params.messages as any[],
        extraBody: { ...params.requestOptions, ...params.extraBody, max_tokens: maxOutputTokens,
          stream_options: { include_usage: true } }, signal: params.signal,
      }, params.toolSchemaProjectionAuthority as ProviderToolSchemaProjectionAuthority)
    } },
  })
  const createStream = adapter.createStream.bind(adapter)
  adapter.createStream = async (input: LlmGenerateOptions): Promise<LlmStreamResult> => {
    check(input.signal)
    if (httpRequests >= 2) throw fail("REQUEST_LIMIT")
    const signal = AbortSignal.any([owner.signal, ...(input.signal ? [input.signal] : [])])
    const extraBody = { ...input.extraBody, max_tokens: maxOutputTokens, stream_options: { include_usage: true } }
    for (const key of ["max_completion_tokens", "max_output_tokens", "max_new_tokens"]) delete extraBody[key]
    let result: LlmStreamResult
    try {
      result = await bounded(createStream({ ...input, model: config.model, signal,
        extraBody,
        providerRetryOwner: "assistant_turn",
      }), signal)
    } catch (error) { throw safeError(error) }
    const providerOutput = result.providerOutput?.then(value => {
      completedOutputs += 1
      const raw = (value as any)?.usage
      if (raw) {
        for (const [target, source] of Object.entries({ promptTokens: "prompt_tokens", completionTokens: "completion_tokens",
          totalTokens: "total_tokens", cacheHitTokens: "prompt_cache_hit_tokens", cacheMissTokens: "prompt_cache_miss_tokens" })) {
          if (Number.isFinite(raw[source]) && raw[source] >= 0) {
            usage[target as keyof typeof usage] += raw[source]
            usageCounts.set(target, (usageCounts.get(target) ?? 0) + 1)
          }
        }
      }
      return value
    }, () => { throw fail("TRANSPORT_FAILED") })
    // Observation must never produce an unhandled rejection if the actor abandons the output promise.
    void providerOutput?.catch(() => {})
    const stream = (async function* () {
      const diagnostic = { content: "", contentLength: 0, reasoningLength: 0, finishReasons: [] as string[], toolCalls: [] as { index: number; name: string; argumentsLength: number }[] }
      outputDiagnostics.push(diagnostic)
      let content = ""
      const iterator = result.stream[Symbol.asyncIterator]()
      try {
        while (true) {
          check(input.signal)
          const next = await bounded(Promise.resolve(iterator.next()), signal)
          if (next.done) break
          for (const choice of (next.value as any)?.choices ?? []) {
            const delta = choice.delta ?? {}
            if (typeof delta.content === "string") { content += delta.content; diagnostic.contentLength += delta.content.length }
            if (typeof delta.reasoning_content === "string") diagnostic.reasoningLength += delta.reasoning_content.length
            if (typeof choice.finish_reason === "string" && !diagnostic.finishReasons.includes(choice.finish_reason)) diagnostic.finishReasons.push(redactDiagnostic(choice.finish_reason))
            for (const call of delta.tool_calls ?? []) {
              let tool = diagnostic.toolCalls.find(item => item.index === call.index)
              if (!tool) { tool = { index: call.index, name: "", argumentsLength: 0 }; diagnostic.toolCalls.push(tool) }
              if (typeof call.function?.name === "string") tool.name = redactDiagnostic(tool.name + call.function.name)
              if (typeof call.function?.arguments === "string") tool.argumentsLength += call.function.arguments.length
            }
          }
          yield next.value
        }
      } catch (error) { throw safeError(error) }
      finally { diagnostic.content = redactDiagnostic(content); void Promise.resolve(iterator.return?.()).catch(() => {}) }
    })()
    return { ...result, stream, providerOutput }
  }
  const modelConfig: ActorModelConfig = Object.freeze({ provider: config.providerId, adapter: "deepseek",
    model: config.model, maxOutputTokens, outputLimit: maxOutputTokens })
  return {
    adapter, modelConfig, redactDiagnostic,
    get metrics() { return Object.freeze({ transport: "https-provider", httpRequests, completedOutputs,
      usageObserved: usageCounts.size > 0,
      usage: usageCounts.size ? Object.freeze(Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, usageCounts.get(key) === completedOutputs ? value : null]))) : null,
      requestDiagnostics: Object.freeze(requestDiagnostics.map(item => Object.freeze({ ...item }))),
      outputDiagnostics: structuredClone(outputDiagnostics), adapterErrors: structuredClone(adapterErrors),
      elapsedMs: Math.max(0, now() - startedAt),
      failureCodes: Object.freeze([...failures]), maxRequests: 2, maxOutputTokens, deadlineMs }) },
    async close() { if (!closed) { closed = true; clearTimeout(timer); owner.abort(new HolonLiveBudgetError("CLOSED")) } },
  }
}
