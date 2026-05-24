import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"

export type WebfetchFormat = "text" | "markdown" | "html"

export type WebfetchOuterRuntime = AiAgentOneActorRuntime

export type WebfetchOuterInput = {
  url: string
  format?: WebfetchFormat
  timeout?: number
}

export type WebfetchOuterConfig = Record<string, unknown>
export type WebfetchOuterDerived = null
export type WebfetchOuterOutput = string
