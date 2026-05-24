import type { StdInnerLogic } from "depa-processor"
import { spawnChildExecutionActor } from "@cell/ai-organ-logic/agent/DelegateActor"
import {
  DETACHED_ACTOR_KINDS,
  DETACHED_ACTOR_STATUSES,
} from "@cell/ai-organ-logic/detached/DetachedActorRegistry"

import type {
  DetachedToolCallInnerConfig,
  DetachedToolCallInnerInput,
  DetachedToolCallInnerOutput,
  DetachedToolCallInnerRuntime,
} from "./InnerTypes"

function safeJsonRunning(taskId: string): string {
  return JSON.stringify({ task_id: taskId, status: DETACHED_ACTOR_STATUSES.running })
}

export const detachedToolCallCoreLogic: StdInnerLogic<
  DetachedToolCallInnerRuntime,
  DetachedToolCallInnerInput,
  DetachedToolCallInnerConfig,
  DetachedToolCallInnerOutput
> = async (runtime, input, _config) => {
  try {
    const toolName = typeof (input as any)?.tool_name === "string" ? String((input as any).tool_name) : ""
    const agentType = typeof (input as any)?.agent_type === "string" ? String((input as any).agent_type) : ""
    const args = (input as any)?.arguments

    if (!toolName.trim()) {
      return JSON.stringify({ ok: false, error: "missing_tool_name" })
    }
    if (!agentType.trim()) {
      return JSON.stringify({ ok: false, error: "missing_agent_type" })
    }

    const prompt = JSON.stringify({ tool_name: toolName, arguments: args })

    const out = await spawnChildExecutionActor(runtime.vm, runtime.actor, {
      description: "Detached tool call",
      prompt,
      agentType,
      mode: "detached",
      toolCallId: (runtime as any)?.toolCallId,
      detachedActorKind: DETACHED_ACTOR_KINDS.toolCall,
    })

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
