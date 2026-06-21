export const AI_AGENT_ORCHESTRATOR_TICK_SCOPES = {
  all: "all",
  foreground: "foreground",
  background: "background",
} as const

export const AI_AGENT_FIBER_RESULT_KINDS = {
  yield: "yield",
  suspend: "suspend",
  complete: "complete",
  fail: "fail",
  cancel: "cancel",
} as const
