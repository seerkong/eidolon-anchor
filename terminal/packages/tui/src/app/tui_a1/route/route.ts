import type { PromptInfo } from "../features/composer/model/prompt-info"
import { Log } from "../../../support/util/log"

export type HomeRoute = {
  type: "home"
  initialPrompt?: PromptInfo
}

export type SessionRoute = {
  type: "session"
  sessionID: string
  initialPrompt?: PromptInfo
}

export type Route = HomeRoute | SessionRoute

export function resolveInitialRoute(): Route {
  const raw = process.env["EIDOLON_ROUTE"]
  if (!raw) return { type: "home" }
  try {
    const parsed = JSON.parse(raw) as Route
    if (parsed && (parsed.type === "home" || parsed.type === "session")) {
      return parsed
    }
    Log.Default.warn("tui.route.invalid_shape", { raw })
  } catch (error) {
    Log.Default.error("tui.route.parse_failed", {
      raw,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return { type: "home" }
}
