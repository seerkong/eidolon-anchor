import type { StdInnerLogic } from "depa-processor"
import type { WebfetchInnerConfig, WebfetchInnerInput, WebfetchInnerOutput, WebfetchInnerRuntime } from "./InnerTypes"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_SECONDS = 120

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error("url required")
  }
  if (trimmed.startsWith("http://")) {
    return `https://${trimmed.slice("http://".length)}`
  }
  if (trimmed.startsWith("https://")) {
    return trimmed
  }
  throw new Error("URL must start with http:// or https://")
}

function pickFormat(raw: unknown): "text" | "markdown" | "html" {
  if (raw === "text" || raw === "markdown" || raw === "html") return raw
  return "markdown"
}

function buildAcceptHeader(format: "text" | "markdown" | "html"): string {
  if (format === "markdown") {
    return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
  }
  if (format === "text") {
    return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
  }
  if (format === "html") {
    return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
  }
  return "*/*"
}

function stripHtmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")

  const text = withoutScripts
    .replace(/<br\s*\/>/gi, "\n")
    .replace(/<\/?p\b[^>]*>/gi, "\n")
    .replace(/<\/?div\b[^>]*>/gi, "\n")
    .replace(/<\/?h\d\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()

  return text
}

export const webfetchCoreLogic: StdInnerLogic<WebfetchInnerRuntime, WebfetchInnerInput, WebfetchInnerConfig, WebfetchInnerOutput> = async (
  _runtime,
  input,
  _config,
) => {
  try {
    const url = normalizeUrl(String((input as any)?.url ?? ""))
    const format = pickFormat((input as any)?.format)
    const timeoutSecondsRaw = (input as any)?.timeout
    const timeoutSeconds =
      typeof timeoutSecondsRaw === "number" && Number.isFinite(timeoutSecondsRaw)
        ? Math.min(Math.max(Math.floor(timeoutSecondsRaw), 1), MAX_TIMEOUT_SECONDS)
        : DEFAULT_TIMEOUT_SECONDS

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000)

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
          Accept: buildAcceptHeader(format),
          "Accept-Language": "en-US,en;q=0.9",
        },
      })

      if (!response.ok) {
        return `Error: Request failed with status code: ${response.status}`
      }

      const contentLength = response.headers.get("content-length")
      if (contentLength && Number.parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
        return "Error: Response too large (exceeds 5MB limit)"
      }

      const ab = await response.arrayBuffer()
      if (ab.byteLength > MAX_RESPONSE_SIZE) {
        return "Error: Response too large (exceeds 5MB limit)"
      }

      const content = new TextDecoder().decode(ab)
      const contentType = (response.headers.get("content-type") || "").toLowerCase()

      if (format === "html") {
        return content
      }

      if (contentType.includes("text/html")) {
        const text = stripHtmlToText(content)
        return text
      }

      return content
    } finally {
      clearTimeout(timeoutId)
    }
  } catch (e: any) {
    if (e && typeof e === "object" && e.name === "AbortError") {
      return "Error: Request timed out"
    }
    return `Error: ${String(e?.message ?? e ?? "unknown")}`
  }
}
