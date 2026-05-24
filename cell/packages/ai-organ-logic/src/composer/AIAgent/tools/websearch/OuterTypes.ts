import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"

export type WebsearchOuterRuntime = AiAgentOneActorRuntime

export type WebsearchOuterInput = {
  query: string
  numResults?: number
  livecrawl?: "fallback" | "preferred"
  type?: "auto" | "fast" | "deep"
  contextMaxCharacters?: number
}

export type WebsearchOuterConfig = Record<string, unknown>
export type WebsearchOuterDerived = null
export type WebsearchOuterOutput = string
