import { baseHolonToolDef, mapHolonPayload, resolveHolon } from "../_holonTooling"

export function buildHolonStatusToolDef() {
  return baseHolonToolDef(
    "HolonStatus",
    "Show holon status.",
    {
      type: "object",
      properties: {
        target: { type: "string" },
      },
      required: ["target"],
    },
    async (runtime, input) => {
      const target = String((input as any)?.target ?? "").trim()
      const holon = resolveHolon(runtime.vm as any, target)
      if (!holon) return JSON.stringify({ ok: false, error: "holon_not_found", target })
      return JSON.stringify({
        ok: true,
        organization_kind: "holon",
        ...mapHolonPayload(holon),
      })
    },
  )
}
