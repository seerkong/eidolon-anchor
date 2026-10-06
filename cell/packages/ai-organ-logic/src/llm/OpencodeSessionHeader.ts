/** Stable conversation id required by OpenCode Go routing and prompt cache. */
export function opencodeSessionHeaders(
  baseUrl: string,
  sessionKey: string | undefined,
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (headers?.["x-opencode-session"]) return headers
  const key = sessionKey?.trim()
  if (!key) return headers
  let hostname = ""
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return headers
  }
  if (hostname !== "opencode.ai" && !hostname.endsWith(".opencode.ai")) return headers
  return { ...headers, "x-opencode-session": key }
}
