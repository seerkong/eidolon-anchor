export type LeaderLedHolonRouteReplyMode = "final" | "none" | "stream"

export type LeaderLedHolonAssignEnvelope = {
  kind: "assign"
  routeId: string
  holonId: string
  initiatorActorKey: string
  initiatorActorId: string
  replyMode: LeaderLedHolonRouteReplyMode
  content: string
}

export type LeaderLedHolonLeaderRequestEnvelope = {
  kind: "leader_request"
  routeId: string
  holonId: string
  leaderMemberId: string
  replyMode: LeaderLedHolonRouteReplyMode
}

export type LeaderLedHolonResultEnvelope = {
  kind: "result"
  routeId: string
  holonId: string
  leaderMemberId: string
  text: string
}

export type LeaderLedHolonEventEnvelope = {
  kind: "event"
  routeId: string
  holonId: string
  leaderMemberId: string
  eventType: "leader_received" | "leader_progress"
  text: string
}

export type LeaderLedHolonEnvelope =
  | LeaderLedHolonAssignEnvelope
  | LeaderLedHolonLeaderRequestEnvelope
  | LeaderLedHolonEventEnvelope
  | LeaderLedHolonResultEnvelope

const OPEN_TAG = "<leader_led_holon_route>"
const CLOSE_TAG = "</leader_led_holon_route>"

export function buildLeaderLedHolonEnvelope(payload: LeaderLedHolonEnvelope, bodyText = ""): string {
  const body = String(bodyText ?? "")
  return `${OPEN_TAG}${JSON.stringify(payload)}${CLOSE_TAG}${body ? `\n${body}` : ""}`
}

export function parseLeaderLedHolonEnvelope(text: string): { payload: LeaderLedHolonEnvelope; bodyText: string } | null {
  const raw = String(text ?? "")
  const start = raw.indexOf(OPEN_TAG)
  const end = raw.indexOf(CLOSE_TAG)
  if (start < 0 || end < 0 || end < start) {
    return null
  }

  const jsonText = raw.slice(start + OPEN_TAG.length, end).trim()
  if (!jsonText) return null

  try {
    const payload = JSON.parse(jsonText) as LeaderLedHolonEnvelope
    if (!payload || typeof payload !== "object" || typeof (payload as any).kind !== "string") {
      return null
    }
    const bodyText = raw.slice(end + CLOSE_TAG.length).replace(/^\n/, "")
    return { payload, bodyText }
  } catch {
    return null
  }
}
