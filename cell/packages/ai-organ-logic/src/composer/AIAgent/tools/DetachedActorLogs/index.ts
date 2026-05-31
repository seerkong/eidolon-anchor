import type { ToolDef } from "@cell/ai-core-contract/types"
import { getDetachedActorRegistry } from "@cell/ai-organ-logic/detached/DetachedActorRegistry"
import {
  getDetachedActorObservabilityStore,
  type DetachedLogSource,
} from "@cell/ai-organ-logic/detached/DetachedActorObservability"
import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"

type DetachedActorLogsInput = {
  task_id: string
  sources?: DetachedLogSource[]
  after_seq?: number
  limit_entries?: number
  limit_bytes?: number
  tail?: boolean
}

function normalizeSources(value: unknown): DetachedLogSource[] | undefined {
  if (!Array.isArray(value)) return undefined
  const allowed = new Set(["stdout", "stderr", "system"])
  return value.map((item) => String(item)).filter((item) => allowed.has(item)) as DetachedLogSource[]
}

function toWireEntry(entry: any) {
  return {
    task_id: entry.taskId,
    seq: entry.seq,
    source: entry.source,
    text: entry.text,
    created_at: entry.createdAt,
  }
}

export function buildDetachedActorLogsToolDef(): ToolDef<DetachedActorLogsInput, string, Record<string, unknown>> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "DetachedActorLogs",
        description: "Query recent logs for a detached actor task.",
        parameters: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            sources: { type: "array", items: { type: "string", enum: ["stdout", "stderr", "system"] } },
            after_seq: { type: "number" },
            limit_entries: { type: "number" },
            limit_bytes: { type: "number" },
            tail: { type: "boolean" },
          },
          required: ["task_id"],
        },
      },
    },
    briefPromptXnl: "",
    detailPromptXnl: "",
    run: async (runtime: AiAgentOneActorRuntime, input: DetachedActorLogsInput) => {
      const taskId = String((input as any)?.task_id ?? "").trim()
      if (!taskId) return JSON.stringify({ ok: false, error: "missing_task_id" })
      const rec = getDetachedActorRegistry(runtime.vm as any).get(taskId)
      if (!rec) return JSON.stringify({ ok: false, error: "not_found", task_id: taskId })
      const result = getDetachedActorObservabilityStore(runtime.vm as any).queryLogs(taskId, {
        sources: normalizeSources((input as any)?.sources),
        after_seq: (input as any)?.after_seq,
        limit_entries: (input as any)?.limit_entries,
        limit_bytes: (input as any)?.limit_bytes,
        tail: (input as any)?.tail,
      })
      return JSON.stringify({
        ...result,
        entries: result.entries.map(toWireEntry),
      })
    },
  }
}
