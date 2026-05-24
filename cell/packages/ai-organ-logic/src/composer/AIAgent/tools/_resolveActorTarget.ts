import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime"
import { getOrganizationManager } from "@cell/ai-organ-logic/organization/OrganizationManager"

function stripPrefix(query: string): string {
  const idx = query.indexOf(":")
  if (idx < 0) return query
  return query.slice(idx + 1)
}

export function resolveActorTarget(vm: AiAgentVm, query: string): AiAgentActor | null {
  const raw = String(query ?? "").trim()
  if (!raw) return null
  const candidate = stripPrefix(raw)

  if (vm.actors[raw]) return vm.actors[raw]!
  if (vm.actors[candidate]) return vm.actors[candidate]!

  for (const actor of Object.values(vm.actors)) {
    if (!actor) continue
    if (actor.id === raw || actor.id === candidate) return actor
    const identity = (actor as any).identity
    const identityName = typeof identity?.name === "string" ? identity.name : ""
    if (identityName === raw || identityName === candidate) return actor
  }

  return null
}

export type ResolvedActorSubject =
  | AiAgentActor
  | {
      key: string
      id: string
      type: null
      degraded: true
      truthSource: "organization_projection"
      organizationKind: "holon"
      governance: "autonomous" | "leader_led"
      watchState: "watched" | "unwatched"
      identity: { kind: "holon"; holonId: string; governance: "autonomous" | "leader_led"; name: string; leaderId?: string }
      memberIds: string[]
      leaderMemberId?: string | null
    }

export function resolveActorSubject(vm: AiAgentVm, query: string): ResolvedActorSubject | null {
  const actor = resolveActorTarget(vm, query)
  if (actor) return actor

  const raw = String(query ?? "").trim()
  if (!raw) return null
  const candidate = stripPrefix(raw)
  const organization = getOrganizationManager()

  const holon = organization.resolveHolon(vm, raw) ?? organization.resolveHolon(vm, candidate)
  if (holon) {
    const actorKey = organization.getHolonActorKey(holon.holonId)
    const holonActor = vm.actors[actorKey]
    if (holonActor?.identity?.kind === "holon" && holonActor.identity.governance === holon.governance) {
      return holonActor
    }
    return {
      key: actorKey,
      id: holon.holonId,
      type: null,
      degraded: true,
      truthSource: "organization_projection",
      organizationKind: "holon",
      governance: holon.governance,
      watchState: holon.watchState ?? "unwatched",
      identity: {
        kind: "holon",
        holonId: holon.holonId,
        governance: holon.governance,
        name: holon.name,
        leaderId: holon.governance === "leader_led" ? holon.leaderMemberId ?? undefined : undefined,
      },
      memberIds: [...holon.memberIds],
      leaderMemberId: holon.governance === "leader_led" ? holon.leaderMemberId ?? null : undefined,
    }
  }

  return null
}
