import type { ToolDef } from "@cell/ai-core-contract/types"
import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import { getDetachedActorRegistry } from "@cell/ai-organ-logic/detached/DetachedActorRegistry"
import {
  getDetachedActorObservabilityStore,
  type DetachedMessageKind,
  type DetachedMessageRole,
} from "@cell/ai-organ-logic/detached/DetachedActorObservability"

type DetachedActorMessagesInput = {
  task_id: string
  roles?: DetachedMessageRole[]
  kinds?: DetachedMessageKind[]
  after_seq?: number
  limit_entries?: number
  limit_bytes?: number
  tail?: boolean
}

function normalizeArray<T extends string>(value: unknown, allowed: Set<string>): T[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.map((item) => String(item)).filter((item) => allowed.has(item)) as T[]
}

function toWireEntry(entry: any) {
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

export function buildDetachedActorMessagesToolDef(): ToolDef<DetachedActorMessagesInput, string, Record<string, unknown>> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "DetachedActorMessages",
        description: "Query recent message and tool event entries for a detached actor task.",
        parameters: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            roles: { type: "array", items: { type: "string", enum: ["user", "assistant", "tool", "system_event"] } },
            kinds: { type: "array", items: { type: "string", enum: ["message", "tool_call", "tool_result", "error", "status"] } },
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
    run: async (runtime: AiAgentOneActorRuntime, input: DetachedActorMessagesInput) => {
      const taskId = String((input as any)?.task_id ?? "").trim()
      if (!taskId) return JSON.stringify({ ok: false, error: "missing_task_id" })
      const rec = getDetachedActorRegistry(runtime.vm as any).get(taskId)
      if (!rec) return JSON.stringify({ ok: false, error: "not_found", task_id: taskId })
      const roles = normalizeArray<DetachedMessageRole>(
        (input as any)?.roles,
        new Set(["user", "assistant", "tool", "system_event"]),
      )
      const kinds = normalizeArray<DetachedMessageKind>(
        (input as any)?.kinds,
        new Set(["message", "tool_call", "tool_result", "error", "status"]),
      )
      const result = getDetachedActorObservabilityStore(runtime.vm as any).queryMessages(taskId, {
        roles,
        kinds,
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
