export type AutonomousHolonReplyMode = "final" | "none" | "stream"

export type AutonomousHolonAssignEnvelope = {
  kind: "assign"
  taskId: string
  holonId: string
  initiatorActorKey: string
  initiatorActorId: string
  replyMode: AutonomousHolonReplyMode
  content: string
}

export type AutonomousHolonMemberTaskEnvelope = {
  kind: "member_task"
  taskId: string
  holonId: string
  replyMode: AutonomousHolonReplyMode
}

export type AutonomousHolonResultEnvelope = {
  kind: "result"
  taskId: string
  holonId: string
  ownerMemberId: string
  ownerActorKey: string
  ownerActorId: string
  text: string
}

export type AutonomousHolonEnvelope =
  | AutonomousHolonAssignEnvelope
  | AutonomousHolonMemberTaskEnvelope
  | AutonomousHolonResultEnvelope

const OPEN_TAG = "<autonomous_holon_task>"
const CLOSE_TAG = "</autonomous_holon_task>"

export function buildAutonomousHolonEnvelope(payload: AutonomousHolonEnvelope, bodyText = ""): string {
  const body = String(bodyText ?? "")
  return `${OPEN_TAG}${JSON.stringify(payload)}${CLOSE_TAG}${body ? `\n${body}` : ""}`
}

export function parseAutonomousHolonEnvelope(text: string): { payload: AutonomousHolonEnvelope; bodyText: string } | null {
  const raw = String(text ?? "")
  const start = raw.indexOf(OPEN_TAG)
  const end = raw.indexOf(CLOSE_TAG)
  if (start < 0 || end < 0 || end < start) {
    return null
  }

  const jsonText = raw.slice(start + OPEN_TAG.length, end).trim()
  if (!jsonText) return null

  try {
    const payload = JSON.parse(jsonText) as AutonomousHolonEnvelope
    if (!payload || typeof payload !== "object" || typeof (payload as any).kind !== "string") {
      return null
    }
    const bodyText = raw.slice(end + CLOSE_TAG.length).replace(/^\n/, "")
    return { payload, bodyText }
  } catch {
    return null
  }
}
