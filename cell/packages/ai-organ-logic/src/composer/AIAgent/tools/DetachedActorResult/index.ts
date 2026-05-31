import type { ToolDef } from "@cell/ai-core-contract/types"
import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import { getDetachedActorRegistry } from "@cell/ai-organ-logic/detached/DetachedActorRegistry"
import {
  getDetachedActorObservabilityStore,
  type DetachedLogSource,
} from "@cell/ai-organ-logic/detached/DetachedActorObservability"

type DetachedActorResultInput = {
  task_id: string
  allow_partial?: boolean
  include_logs?: boolean
  include_messages?: boolean
  sources?: DetachedLogSource[]
  limit_entries?: number
  limit_bytes?: number
}

function isTerminalStatus(status: unknown): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
}

function shouldIncludeLogs(input: DetachedActorResultInput, kind: unknown): boolean {
  if ((input as any)?.include_logs === false) return false
  if ((input as any)?.include_logs === true) return true
  return kind === "bash"
}

function normalizeSources(value: unknown): DetachedLogSource[] | undefined {
  if (!Array.isArray(value)) return undefined
  const allowed = new Set(["stdout", "stderr", "system"])
  return value.map((item) => String(item)).filter((item) => allowed.has(item)) as DetachedLogSource[]
}

function toLogWireEntry(entry: any) {
  return {
    task_id: entry.taskId,
    seq: entry.seq,
    source: entry.source,
    text: entry.text,
    created_at: entry.createdAt,
  }
}

function toMessageWireEntry(entry: any) {
  return {
    task_id: entry.taskId,
    seq: entry.seq,
    role: entry.role,
    kind: entry.kind,
    text: entry.text,
    created_at: entry.createdAt,
    tool_name: entry.toolName ?? null,
    tool_call_id: entry.toolCallId ?? null,
  }
}

export function buildDetachedActorResultToolDef(): ToolDef<DetachedActorResultInput, string, Record<string, unknown>> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "DetachedActorResult",
        description: "Query the terminal result for a detached actor task.",
        parameters: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            allow_partial: { type: "boolean" },
            include_logs: { type: "boolean" },
            include_messages: { type: "boolean" },
            sources: { type: "array", items: { type: "string", enum: ["stdout", "stderr", "system"] } },
            limit_entries: { type: "number" },
            limit_bytes: { type: "number" },
          },
          required: ["task_id"],
        },
      },
    },
    briefPromptXnl: "",
    detailPromptXnl: "",
    run: async (runtime: AiAgentOneActorRuntime, input: DetachedActorResultInput) => {
      const taskId = String((input as any)?.task_id ?? "").trim()
      if (!taskId) return JSON.stringify({ ok: false, error: "missing_task_id" })
      const rec = getDetachedActorRegistry(runtime.vm as any).get(taskId)
      if (!rec) return JSON.stringify({ ok: false, error: "not_found", task_id: taskId })
      if (!isTerminalStatus(rec.status) && (input as any)?.allow_partial !== true) {
        return JSON.stringify({ ok: false, error: "not_terminal", task_id: taskId, status: rec.status })
      }

      const store = getDetachedActorObservabilityStore(runtime.vm as any)
      const result: Record<string, unknown> = {
        ok: true,
        task_id: taskId,
        kind: rec.kind,
        status: rec.status,
        output_text: rec.outputText ?? null,
        error: rec.error ?? null,
      }

      if (shouldIncludeLogs(input, rec.kind)) {
        const logs = store.queryLogs(taskId, {
          sources: normalizeSources((input as any)?.sources),
          limit_entries: (input as any)?.limit_entries,
          limit_bytes: (input as any)?.limit_bytes,
        })
        result.logs = {
          ...logs,
          entries: logs.entries.map(toLogWireEntry),
        }
      }
      if ((input as any)?.include_messages === true) {
        const messages = store.queryMessages(taskId, {
          limit_entries: (input as any)?.limit_entries,
          limit_bytes: (input as any)?.limit_bytes,
        })
        result.messages = {
          ...messages,
          entries: messages.entries.map(toMessageWireEntry),
        }
      }

      return JSON.stringify(result)
    },
  }
}
