export const HOLON_TASK_SCOPE_PREFIXES = {
  leaderLed: "holon:leader_led:",
} as const

export function buildLeaderLedHolonTaskScope(holonId: string): string {
  return `${HOLON_TASK_SCOPE_PREFIXES.leaderLed}${holonId}`
}
