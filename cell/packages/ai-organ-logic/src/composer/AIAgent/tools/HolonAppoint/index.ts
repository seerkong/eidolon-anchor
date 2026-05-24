import { getMemberManager } from "@cell/ai-organ-logic/organization/MemberManager"
import { getOrganizationManager } from "@cell/ai-organ-logic/organization/OrganizationManager"
import { baseHolonToolDef, mapHolonPayload, resolveHolon } from "../_holonTooling"

export function buildHolonAppointToolDef() {
  return baseHolonToolDef(
    "HolonAppoint",
    "Appoint the leader of a leader-led holon.",
    {
      type: "object",
      properties: {
        holon: { type: "string" },
        member: { type: "string" },
      },
      required: ["holon", "member"],
    },
    async (runtime, input) => {
      const holonQuery = String((input as any)?.holon ?? "").trim()
      const memberQuery = String((input as any)?.member ?? "").trim()
      const holon = resolveHolon(runtime.vm as any, holonQuery)
      if (!holon) return JSON.stringify({ ok: false, error: "holon_not_found", holon: holonQuery })
      if (holon.governance !== "leader_led") {
        return JSON.stringify({ ok: false, error: "holon_governance_does_not_support_appoint", holon_id: holon.holonId })
      }
      const member = getMemberManager().resolveMember({ vm: runtime.vm as any, query: memberQuery })
      if (!member) return JSON.stringify({ ok: false, error: "member_not_found", member: memberQuery })
      if (!holon.memberIds.includes(member.memberId)) {
        return JSON.stringify({ ok: false, error: "holon_member_required_for_appoint", holon_id: holon.holonId, member_id: member.memberId })
      }
      getOrganizationManager().appointHolonLeader(runtime.vm as any, holon.holonId, member.memberId)
      const updated = resolveHolon(runtime.vm as any, holon.holonId)
      if (!updated) return JSON.stringify({ ok: false, error: "holon_appoint_failed", holon: holonQuery, member: memberQuery })
      return JSON.stringify({ ok: true, appointed: true, ...mapHolonPayload(updated) })
    },
  )
}
