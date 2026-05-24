import { getMemberManager } from "@cell/ai-organ-logic/organization/MemberManager"
import { getOrganizationManager } from "@cell/ai-organ-logic/organization/OrganizationManager"
import { baseHolonToolDef, mapHolonPayload, resolveHolon } from "../_holonTooling"

export function buildHolonAddToolDef() {
  return baseHolonToolDef(
    "HolonAdd",
    "Add a member to a holon.",
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
      const member = getMemberManager().resolveMember({ vm: runtime.vm as any, query: memberQuery })
      if (!member) return JSON.stringify({ ok: false, error: "member_not_found", member: memberQuery })
      if (holon.memberIds.includes(member.memberId)) {
        return JSON.stringify({ ok: false, error: "holon_membership_exists", holon_id: holon.holonId, member_id: member.memberId })
      }
      const organizations = getOrganizationManager()
      organizations.addHolonMember(runtime.vm as any, holon.holonId, member.memberId)
      const updated = resolveHolon(runtime.vm as any, holon.holonId)
      if (!updated) return JSON.stringify({ ok: false, error: "holon_add_failed", holon: holonQuery, member: memberQuery })
      return JSON.stringify({ ok: true, ...mapHolonPayload(updated) })
    },
  )
}
