import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic"
import { buildDomainRuntimeSemanticBase, DomainRuntimeEventGraph } from "@cell/ai-core-logic"
import type { ActorType } from "@cell/ai-core-logic/runtime/actor"
import { IngressStreamRuntime } from "@cell/symbiont-logic/stream/IngressStreamRuntime"
import {
  createIngressStreamAdapter,
  createMockOpenAI,
  createSemanticStreamPipeline,
} from "../stream"
import {
  bindIngressStreamsToSessionXnlLog,
  createSessionDiagnosticsXnlLog,
} from "./SessionRuntimeXnlLogs"
import {
  extractProviderOptions,
  loadProviderConfig,
  ProviderRuntimeLlmAdapter,
  type LlmAdapterType,
} from "../llm"

export {
  extractProviderOptions,
  loadProviderConfig,
  type LlmAdapterType,
} from "../llm"

export type RuntimeLlmAdapterDefaults = {
  openai: {
    apiKey: string
    baseUrl: string
    model: string
  }
  anthropic: {
    apiKey: string
    baseUrl: string
    model: string
  }
  deepseek?: {
    apiKey: string
    baseUrl: string
    model: string
  }
}

export type RuntimeAdapterOverrides = {
  apiKey?: string
  baseUrl?: string
  model?: string
  options?: Record<string, unknown>
}

export type RuntimeLlmAdapterFactoryOverride = null | ((
  adapterType: LlmAdapterType,
  workDir: string,
  overrides?: RuntimeAdapterOverrides,
) => Promise<any>)

export async function createRuntimeLlmAdapter(params: {
  adapterType: LlmAdapterType
  workDir: string
  defaults: RuntimeLlmAdapterDefaults
  useMock?: boolean
  overrides?: RuntimeAdapterOverrides
  factoryOverride?: RuntimeLlmAdapterFactoryOverride
}) {
  if (params.factoryOverride) {
    const overridden = await params.factoryOverride(params.adapterType, params.workDir, params.overrides)
    if (overridden) return overridden
  }

  const config =
    params.adapterType === "anthropic" || params.adapterType === "claude"
      ? params.defaults.anthropic
      : params.adapterType === "deepseek"
        ? params.defaults.deepseek ?? { apiKey: "", baseUrl: "", model: "" }
      : params.defaults.openai
  const providerConfig = await loadProviderConfig(params.adapterType, params.workDir)

  if (params.adapterType === "anthropic") {
    const providerOptions = { ...extractProviderOptions(providerConfig, "anthropic"), ...(params.overrides?.options ?? {}) }
    if (params.overrides?.apiKey) providerOptions.apiKey = params.overrides.apiKey
    if (params.overrides?.baseUrl) providerOptions.baseURL = params.overrides.baseUrl
    const selectedModel = params.overrides?.model || config.model
    return new ProviderRuntimeLlmAdapter({
      providerId: "anthropic",
      selectedModel,
      adapterName: "anthropic",
      options: {
        ...providerOptions,
        apiKey: providerOptions.apiKey || config.apiKey,
        baseURL: providerOptions.baseURL || config.baseUrl,
      },
    })
  }

  if (params.adapterType === "claude") {
    const providerOptions = { ...extractProviderOptions(providerConfig, "claude"), ...(params.overrides?.options ?? {}) }
    if (params.overrides?.apiKey) providerOptions.apiKey = params.overrides.apiKey
    if (params.overrides?.baseUrl) providerOptions.baseURL = params.overrides.baseUrl
    const selectedModel = params.overrides?.model || config.model
    return new ProviderRuntimeLlmAdapter({
      providerId: "claude",
      selectedModel,
      adapterName: "claude-code",
      options: {
        ...providerOptions,
        apiKey: providerOptions.apiKey || config.apiKey,
        baseURL: providerOptions.baseURL || config.baseUrl,
      },
    })
  }

  if (params.adapterType === "codex") {
    const providerOptions = { ...extractProviderOptions(providerConfig, "codex"), ...(params.overrides?.options ?? {}) }
    if (params.overrides?.apiKey) providerOptions.apiKey = params.overrides.apiKey
    if (params.overrides?.baseUrl) providerOptions.baseURL = params.overrides.baseUrl
    const selectedModel = params.overrides?.model || config.model
    const baseUrl = providerOptions.baseURL || config.baseUrl
    const apiKey = providerOptions.apiKey || config.apiKey
    if (params.useMock) {
      const mock = createMockOpenAI()
      return {
        type: "codex" as const,
        async createStream(options: any) {
          const stream = await mock.chat.completions.create({
            model: options.model,
            messages: options.messages,
            stream: true,
          })
          return { stream }
        },
      }
    }
    if (!apiKey) return null
    return new ProviderRuntimeLlmAdapter({
      providerId: "codex",
      selectedModel,
      adapterName: "openai-responses",
      options: { ...providerOptions, apiKey, baseURL: baseUrl },
    })
  }

  if (params.adapterType === "deepseek") {
    const providerOptions = { ...extractProviderOptions(providerConfig, "deepseek"), ...(params.overrides?.options ?? {}) }
    if (params.overrides?.apiKey) providerOptions.apiKey = params.overrides.apiKey
    if (params.overrides?.baseUrl) providerOptions.baseURL = params.overrides.baseUrl
    const selectedModel = params.overrides?.model || config.model
    const baseUrl = providerOptions.baseURL || config.baseUrl
    const apiKey = providerOptions.apiKey || config.apiKey
    if (params.useMock) {
      const mock = createMockOpenAI()
      return {
        type: "deepseek" as const,
        async createStream(options: any) {
          const stream = await mock.chat.completions.create({
            model: options.model,
            messages: options.messages,
            tools: options.tools,
            stream: true,
            extra_body: options.extraBody,
          })
          return { stream }
        },
      }
    }
    if (!apiKey) return null
    return new ProviderRuntimeLlmAdapter({
      providerId: "deepseek",
      selectedModel,
      adapterName: "deepseek",
      options: { ...providerOptions, apiKey, baseURL: baseUrl },
    })
  }

  const providerOptions = { ...extractProviderOptions(providerConfig, "openai"), ...(params.overrides?.options ?? {}) }
  if (params.overrides?.apiKey) providerOptions.apiKey = params.overrides.apiKey
  if (params.overrides?.baseUrl) providerOptions.baseURL = params.overrides.baseUrl
  const selectedModel = params.overrides?.model || config.model
  const baseUrl = providerOptions.baseURL || config.baseUrl
  const apiKey = providerOptions.apiKey || config.apiKey
  if (params.useMock) {
    const mock = createMockOpenAI()
    return {
      type: "openai" as const,
      async createStream(options: any) {
        const stream = await mock.chat.completions.create({
          model: options.model,
          messages: options.messages,
          tools: options.tools,
          stream: true,
          extra_body: options.extraBody || { reasoning_split: true },
        })
        return { stream }
      },
    }
  }
  if (!apiKey) return null
  return new ProviderRuntimeLlmAdapter({
    providerId: "openai",
    selectedModel,
    adapterName: "openai-chat",
    options: { ...providerOptions, apiKey, baseURL: baseUrl },
  })
}

export async function processRuntimeIngressStream(params: {
  stream: any
  adapterType: LlmAdapterType
  eventBus?: DomainRuntimeEventGraph
  actorMeta?: { agentKey: string; agentActorId: string }
  sessionDir?: string
  sessionId?: string
  storageLogsEnabled?: boolean
  signal?: AbortSignal
}) {
  const runtime = IngressStreamRuntime.create()
  const [ingressStreams, runAdapter] = createIngressStreamAdapter(params.stream, runtime, params.adapterType, {
    signal: params.signal,
  })
  const logSessionDir = params.storageLogsEnabled === false ? undefined : params.sessionDir
  const ingressLog = bindIngressStreamsToSessionXnlLog({
    sessionDir: logSessionDir,
    sessionId: params.sessionId,
    ingressStreams,
    actorMeta: params.actorMeta,
  })
  const diagnosticsLog = createSessionDiagnosticsXnlLog({
    sessionDir: logSessionDir,
  })
  const { semanticGraph, runPipeline } = createSemanticStreamPipeline(
    ingressStreams,
    params.actorMeta ?? { agentKey: "unknown", agentActorId: "unknown" },
  )

  semanticGraph.onSemanticEvent((event) => {
    if (params.signal?.aborted) return
    diagnosticsLog.appendSemanticEvent(event)
    params.eventBus?.emit(event)
  })

  try {
    const results = await Promise.all([runAdapter(), runPipeline()])
    return results[0]
  } finally {
    ingressLog.dispose()
    await Promise.all([
      ingressLog.flush(),
      diagnosticsLog.flush(),
    ]).catch(() => {})
  }
}

export function emitRuntimeDirectSlashAssistantOutput(params: {
  eventBus: DomainRuntimeEventGraph
  actor: { key: string; id: string; type?: ActorType }
  text: string
}): void {
  if (!params.text) return

  const baseMeta = { agentKey: params.actor.key, agentActorId: params.actor.id }
  const events: SemanticEvent[] = [
    {
      ...buildDomainRuntimeSemanticBase(baseMeta, Date.now()),
      event_type: "semantic_content_start",
    },
    {
      ...buildDomainRuntimeSemanticBase(baseMeta, Date.now() + 1),
      event_type: "semantic_content_delta",
      text: params.text,
    },
    {
      ...buildDomainRuntimeSemanticBase(baseMeta, Date.now() + 2),
      event_type: "semantic_content_end",
    },
  ]

  for (const event of events) {
    params.eventBus.emit(event)
  }
}
