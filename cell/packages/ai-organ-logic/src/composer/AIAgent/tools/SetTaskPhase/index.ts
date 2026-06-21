import type { ToolDef } from "@cell/ai-core-contract/types"
import { TASK_PHASES } from "@cell/ai-core-contract/runtime/ContextControl"
import { setActorTaskPhase } from "@cell/ai-organ-logic/runtime/ContextControlPlane"

type SetTaskPhaseInput = {
  phase?: "normal" | "answer"
  reason?: string
}

export function buildSetTaskPhaseToolDef(): ToolDef<SetTaskPhaseInput, string> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "SetTaskPhase",
        description: "Set the current task phase. Use phase=answer when ready to provide the final answer; use phase=normal when returning to tool-driven work.",
        parameters: {
          type: "object",
          properties: {
            phase: { type: "string", enum: [TASK_PHASES.normal, TASK_PHASES.answer] },
            reason: { type: "string" },
          },
          required: ["phase"],
        },
      },
    },
    briefPromptXnl: `<tool name="SetTaskPhase" />`,
    detailPromptXnl: `<tool name="SetTaskPhase">Set task phase to normal or answer without changing work mode.</tool>`,
    run: async (runtime, input) => {
      const phase = input?.phase === TASK_PHASES.answer ? TASK_PHASES.answer : TASK_PHASES.normal
      const next = setActorTaskPhase({
        actor: runtime.actor,
        taskPhase: phase,
        source: "tool_call",
        occurredAt: new Date().toISOString(),
      })
      runtime.vm?.effects?.log?.("debug", "task phase changed by tool", {
        actorKey: runtime.actor.key,
        taskPhase: next.taskPhase,
        reason: typeof input?.reason === "string" ? input.reason : undefined,
      })
      return JSON.stringify({
        ok: true,
        taskPhase: next.taskPhase,
        workMode: next.workMode,
      })
    },
  }
}
