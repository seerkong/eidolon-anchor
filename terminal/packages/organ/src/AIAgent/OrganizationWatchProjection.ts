import type { AdditionalWatchedProjection } from "@cell/ai-organ-logic/runtime/ShellRuntimeFacade"
import { getMemberManager } from "@cell/ai-organ-logic/organization/MemberManager"
import { getOrganizationManager } from "@cell/ai-organ-logic/organization/OrganizationManager"

/** TUI organization visibility is an opt-in presentation policy, never a Web actor resolver. */
export const isWatchedOrganizationProjection: AdditionalWatchedProjection = ({ vm, event }) => {
  const target = { key: event.actor.actor_name || event.actor.actor_id, id: event.actor.actor_id }
  const holon = getOrganizationManager().resolveHolon(vm, target.key)
  if (holon?.holonId === target.id && holon.watchState === "watched") return true
  const member = getMemberManager().findByActor({ vm, actorKey: target.key, actorId: target.id })
  if (!member) return false
  return getOrganizationManager().listHolons(vm).some(group => group.watchState === "watched" && (
    group.governance === "autonomous" ? group.memberIds.includes(member.memberId) : group.leaderMemberId === member.memberId
  ))
}
