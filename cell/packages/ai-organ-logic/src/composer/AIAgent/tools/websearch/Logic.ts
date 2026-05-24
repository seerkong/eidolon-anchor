import type { StdInnerLogic } from "depa-processor"
import type {
  WebsearchInnerConfig,
  WebsearchInnerInput,
  WebsearchInnerOutput,
  WebsearchInnerRuntime,
} from "./InnerTypes"

const API_CONFIG = {
  BASE_URL: "https://mcp.exa.ai",
  ENDPOINTS: {
    SEARCH: "/mcp",
  },
  DEFAULT_NUM_RESULTS: 8,
  TIMEOUT_MS: 25000,
} as const

type McpSearchRequest = {
  jsonrpc: "2.0"
  id: number
  method: "tools/call"
  params: {
    name: "web_search_exa"
    arguments: {
      query: string
      numResults?: number
      livecrawl?: "fallback" | "preferred"
      type?: "auto" | "fast" | "deep"
      contextMaxCharacters?: number
    }
  }
}

type McpSearchResponse = {
  jsonrpc?: string
  result?: {
    content?: Array<{
      type?: string
      text?: string
    }>
  }
}

function tryParseFirstSseDataText(bodyText: string): string | null {
  const lines = bodyText.split("\n")
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue
    const payload = line.slice("data: ".length).trim()
    if (!payload || payload === "[DONE]") continue
    try {
      const data = JSON.parse(payload) as McpSearchResponse
      const text = data?.result?.content?.[0]?.text
      if (typeof text === "string" && text.trim()) return text
    } catch {
      // ignore invalid JSON lines
    }
  }
  return null
}

export const websearchCoreLogic: StdInnerLogic<
  WebsearchInnerRuntime,
  WebsearchInnerInput,
  WebsearchInnerConfig,
  WebsearchInnerOutput
> = async (_runtime, input, _config) => {
  const query = typeof input?.query === "string" ? input.query.trim() : ""
  if (!query) return "Error: query required"

  const searchRequest: McpSearchRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: {
        query,
        type: input.type ?? "auto",
        numResults: input.numResults ?? API_CONFIG.DEFAULT_NUM_RESULTS,
        livecrawl: input.livecrawl ?? "fallback",
        contextMaxCharacters: input.contextMaxCharacters,
      },
    },
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), API_CONFIG.TIMEOUT_MS)

  try {
    const response = await fetch(`${API_CONFIG.BASE_URL}${API_CONFIG.ENDPOINTS.SEARCH}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify(searchRequest),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      const suffix = errorText ? `: ${errorText}` : ""
      return `Error: Search error (${response.status})${suffix}`
    }

    const responseText = await response.text()
    const found = tryParseFirstSseDataText(responseText)
    if (found) return found
    return "No search results found. Please try a different query."
  } catch (e: any) {
    if (e && typeof e === "object" && e.name === "AbortError") {
      return "Error: Search request timed out"
    }
    return `Error: ${String(e?.message ?? e ?? "unknown")}`
  } finally {
    clearTimeout(timeoutId)
  }
}
