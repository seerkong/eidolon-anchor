import type { StdInnerLogic } from "depa-processor"
import { spawnChildExecutionActor } from "@cell/ai-organ-logic/agent/DelegateActor"
import {
  DETACHED_ACTOR_KINDS,
  DETACHED_ACTOR_STATUSES,
} from "@cell/ai-organ-logic/detached/DetachedActorRegistry"

import type {
  DetachedBashInnerConfig,
  DetachedBashInnerInput,
  DetachedBashInnerOutput,
  DetachedBashInnerRuntime,
} from "./InnerTypes"

function safeJsonRunning(taskId: string): string {
  return JSON.stringify({ task_id: taskId, status: DETACHED_ACTOR_STATUSES.running })
}

export const detachedBashCoreLogic: StdInnerLogic<
  DetachedBashInnerRuntime,
  DetachedBashInnerInput,
  DetachedBashInnerConfig,
  DetachedBashInnerOutput
> = async (runtime, input, _config) => {
  try {
    const command = typeof (input as any)?.command === "string" ? String((input as any).command) : ""
    const agentType = typeof (input as any)?.agent_type === "string" ? String((input as any).agent_type) : ""

    if (!command.trim()) {
      return JSON.stringify({ ok: false, error: "missing_command" })
    }
    if (!agentType.trim()) {
      return JSON.stringify({ ok: false, error: "missing_agent_type" })
    }

    const prompt = JSON.stringify({ command })

    const out = await spawnChildExecutionActor(runtime.vm, runtime.actor, {
      description: "Detached bash",
      prompt,
      agentType,
      mode: "detached",
      toolCallId: (runtime as any)?.toolCallId,
      detachedActorKind: DETACHED_ACTOR_KINDS.bash,
    })

    // Ensure stable JSON output for callers/tests.
    try {
      const parsed = JSON.parse(String(out ?? ""))
      const taskId = typeof parsed?.task_id === "string" ? parsed.task_id : ""
      if (taskId) return safeJsonRunning(taskId)
    } catch {
      // ignore
    }
    return String(out ?? "")
  } catch (e: any) {
    return JSON.stringify({ ok: false, error: String(e?.message ?? e ?? "unknown") })
  }
}
