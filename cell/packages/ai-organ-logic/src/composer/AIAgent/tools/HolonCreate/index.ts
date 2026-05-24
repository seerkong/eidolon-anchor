import { getOrganizationManager } from "@cell/ai-organ-logic/organization/OrganizationManager"
import { baseHolonToolDef, mapHolonPayload, normalizeGovernance, resolveHolon } from "../_holonTooling"

export function buildHolonCreateToolDef() {
  return baseHolonToolDef(
    "HolonCreate",
    "Create a holon.",
    {
      type: "object",
      properties: {
        governance: { type: "string", enum: ["autonomous", "leader_led"] },
        name: { type: "string" },
      },
      required: ["governance", "name"],
    },
    async (runtime, input) => {
      const governance = normalizeGovernance((input as any)?.governance)
      const name = String((input as any)?.name ?? "").trim()
      if (!governance) return JSON.stringify({ ok: false, error: "invalid_holon_governance" })
      if (!name) return JSON.stringify({ ok: false, error: "empty_holon_name" })
      if (resolveHolon(runtime.vm as any, name)) {
        return JSON.stringify({ ok: false, error: "holon_name_conflict", name })
      }
      const organizations = getOrganizationManager()
      const created = organizations.createHolon(runtime.vm as any, governance, name)
      const holon = resolveHolon(runtime.vm as any, created.holonId)
      if (!holon) return JSON.stringify({ ok: false, error: "holon_create_failed", name, governance })
      return JSON.stringify({ ok: true, ...mapHolonPayload(holon) })
    },
  )
}
