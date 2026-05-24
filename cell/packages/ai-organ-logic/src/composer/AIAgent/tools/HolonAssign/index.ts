import { queueAutonomousHolonAssign } from "../_autonomousHolonAssignCore"
import { queueLeaderLedHolonAssign } from "../_leaderLedHolonAssignCore"
import { baseHolonToolDef, resolveHolon } from "../_holonTooling"

export function buildHolonAssignToolDef() {
  return baseHolonToolDef(
    "HolonAssign",
    "Assign work to a holon.",
    {
      type: "object",
      properties: {
        target: { type: "string" },
        mode: { type: "string", enum: ["final", "none", "stream"] },
        content: { type: "string" },
      },
      required: ["target", "mode", "content"],
    },
    async (runtime, input) => {
      const target = String((input as any)?.target ?? "").trim()
      const holon = resolveHolon(runtime.vm as any, target)
      if (!holon) return JSON.stringify({ ok: false, error: "holon_not_found", target })
      const raw = holon.governance === "autonomous"
        ? await queueAutonomousHolonAssign({ runtime, target, mode: (input as any)?.mode, content: (input as any)?.content })
        : await queueLeaderLedHolonAssign({ runtime, target, mode: (input as any)?.mode, content: (input as any)?.content })
      const parsed = JSON.parse(String(raw))
      const updatedHolon = resolveHolon(runtime.vm as any, holon.holonId) ?? holon
      if (!parsed?.ok) {
        return JSON.stringify({
          ...parsed,
          governance: updatedHolon.governance,
          holon_id: updatedHolon.holonId,
        })
      }
      return JSON.stringify({
        ...parsed,
        target_type: "holon",
        governance: updatedHolon.governance,
        holon_id: updatedHolon.holonId,
        leader_member_id: updatedHolon.leaderMemberId,
        member_ids: updatedHolon.memberIds,
        member_count: updatedHolon.memberIds.length,
        watch_state: updatedHolon.watchState,
      })
    },
  )
}
