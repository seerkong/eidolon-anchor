import type { AiAgentOneActorRuntime, ToolDef } from "@cell/ai-core-contract/types"
import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime"
import { getOrganizationManager, type OrganizationHolonRecord } from "@cell/ai-organ-logic/organization/OrganizationManager"

export type HolonGovernance = "autonomous" | "leader_led"

export type LegacyHolonRecord = {
  holonId: string
  governance: HolonGovernance
  name: string
  memberIds: string[]
  leaderMemberId: string | null
  watchState: "watched" | "unwatched"
}

function stripPrefix(query: string): { prefix: string | null; value: string } {
  const raw = String(query ?? "").trim()
  const idx = raw.indexOf(":")
  if (idx < 0) return { prefix: null, value: raw }
  return { prefix: raw.slice(0, idx), value: raw.slice(idx + 1) }
}

export function resolveHolon(vm: AiAgentVm, query: string): LegacyHolonRecord | null {
  const organizations = getOrganizationManager()
  const { prefix, value } = stripPrefix(query)
  const candidate = value || String(query ?? "").trim()
  if (!candidate) return null

  const resolved =
    prefix === "collective"
      ? organizations.resolveAutonomousHolon(vm, candidate)
      : prefix === "formation"
        ? organizations.resolveLeaderLedHolon(vm, candidate)
        : organizations.resolveHolon(vm, candidate)

  return resolved ? mapOrganizationHolonRecord(resolved) : null
}

export function mapHolonPayload(record: LegacyHolonRecord): Record<string, unknown> {
  return {
    holon_id: record.holonId,
    governance: record.governance,
    name: record.name,
    member_ids: [...record.memberIds],
    member_count: record.memberIds.length,
    leader_member_id: record.leaderMemberId,
    watch_state: record.watchState,
  }
}

function mapOrganizationHolonRecord(record: OrganizationHolonRecord): LegacyHolonRecord {
  return {
    holonId: record.holonId,
    governance: record.governance,
    name: record.name,
    memberIds: [...record.memberIds],
    leaderMemberId: record.governance === "leader_led" ? record.leaderMemberId ?? null : null,
    watchState: record.watchState ?? "unwatched",
  }
}

export function baseHolonToolDef(
  name: string,
  description: string,
  parameters: ToolDef["schema"]["function"]["parameters"],
  run: ToolDef["run"],
): ToolDef {
  return {
    schema: {
      type: "function",
      function: {
        name,
        description,
        parameters,
      },
    },
    briefPromptXnl: "",
    detailPromptXnl: "",
    run,
  }
}

export function normalizeGovernance(input: unknown): HolonGovernance | null {
  return input === "autonomous" || input === "leader_led" ? input : null
}

export function resolveHolonTarget(runtime: AiAgentOneActorRuntime, target: string): LegacyHolonRecord | null {
  return resolveHolon(runtime.vm as AiAgentVm, target)
}
