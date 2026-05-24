export const HOLON_TASK_SCOPE_PREFIXES = {
  autonomous: "holon:autonomous:",
  leaderLed: "holon:leader_led:",
} as const

export function buildAutonomousHolonTaskScope(holonId: string): string {
  return `${HOLON_TASK_SCOPE_PREFIXES.autonomous}${holonId}`
}

export function buildLeaderLedHolonTaskScope(holonId: string): string {
  return `${HOLON_TASK_SCOPE_PREFIXES.leaderLed}${holonId}`
}

export function parseHolonTaskScope(activeForm: string): {
  governance: "autonomous" | "leader_led"
  holonId: string
} | null {
  const value = String(activeForm ?? "").trim()
  if (value.startsWith(HOLON_TASK_SCOPE_PREFIXES.autonomous)) {
    return {
      governance: "autonomous",
      holonId: value.slice(HOLON_TASK_SCOPE_PREFIXES.autonomous.length),
    }
  }
  if (value.startsWith(HOLON_TASK_SCOPE_PREFIXES.leaderLed)) {
    return {
      governance: "leader_led",
      holonId: value.slice(HOLON_TASK_SCOPE_PREFIXES.leaderLed.length),
    }
  }
  return null
}
