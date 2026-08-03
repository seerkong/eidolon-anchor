import type { AiAgentOneActorRuntime, ToolDef } from "@cell/ai-core-contract/types"
import { spawnChildExecutionActor } from "@cell/ai-organ-logic/agent/DelegateActor"
import {
  getDetachedActorRegistry,
  type DetachedActorRecord,
} from "@cell/ai-organ-logic/detached/DetachedActorRegistry"
import {
  getDetachedActorObservabilityStore,
  type DetachedMessageKind,
  type DetachedMessageRole,
} from "@cell/ai-organ-logic/detached/DetachedActorObservability"
import { createWorkflowComponent } from "../component"

type ToolConfig = Record<string, unknown>

type WorkflowRunInput = {
  workflow_ref: string
  input?: unknown
  prompt?: string
  agent_type?: string
  description?: string
  task_key?: string
}

type WorkflowRunIdInput = {
  run_id?: string
  task_id?: string
}

type WorkflowEventsInput = WorkflowRunIdInput & {
  roles?: DetachedMessageRole[]
  kinds?: DetachedMessageKind[]
  after_seq?: number
  limit_entries?: number
  limit_bytes?: number
  tail?: boolean
}

type WorkflowResultInput = WorkflowRunIdInput & {
  allow_partial?: boolean
  include_events?: boolean
  roles?: DetachedMessageRole[]
  kinds?: DetachedMessageKind[]
  limit_entries?: number
  limit_bytes?: number
}

const RUNTIME_ID = "eidolon.detached_actor" as const

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"])
const MESSAGE_ROLES = new Set(["user", "assistant", "tool", "system_event"])
const MESSAGE_KINDS = new Set(["message", "tool_call", "tool_result", "error", "status"])

function readRunId(input: WorkflowRunIdInput): string {
  return String((input as any)?.run_id ?? (input as any)?.task_id ?? "").trim()
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function normalizeArray<T extends string>(value: unknown, allowed: Set<string>): T[] | undefined {
  if (!Array.isArray(value)) return undefined
  const next = value.map((item) => String(item)).filter((item) => allowed.has(item)) as T[]
  return next.length > 0 ? next : undefined
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`
}

function stableHash(value: unknown): string {
  const text = stableStringify(value)
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  }
  return hash.toString(16)
}

function parseSpawnResult(output: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(output)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { output }
  } catch {
    return { output }
  }
}

function buildRunPrompt(input: WorkflowRunInput): string {
  const workflowRef = normalizeString(input.workflow_ref)
  const instruction = normalizeString(input.prompt)
  const runInput = input.input ?? null
  return [
    `Run the Eidolon AI workflow resource: ${workflowRef}`,
    "",
    "Runtime boundary:",
    "- Use Eidolon native actor/session/runtime facts for execution and recovery.",
    "- Treat the workflow resource as the authoring fact source.",
    "- Return a concise workflow result and cite any material outputs you produce.",
    "",
    instruction ? `User instruction:\n${instruction}` : "User instruction: run the workflow according to its definition.",
    "",
    "Workflow input JSON:",
    JSON.stringify(runInput, null, 2),
  ].join("\n")
}

function toStatusPayload(record: DetachedActorRecord, runId: string) {
  return {
    ok: true,
    kind: "workflow.runStatus",
    runtime: RUNTIME_ID,
    run_id: runId,
    task_id: record.taskId,
    actor_kind: record.kind,
    status: record.status,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    tool_call_id: record.toolCallId ?? null,
    parent_fiber_id: record.parentFiberId ?? null,
    child_fiber_id: record.childFiberId ?? null,
    child_actor_key: record.childActorKey ?? null,
    child_actor_id: record.childActorId ?? null,
    output_text: record.outputText ?? null,
    error: record.error ?? null,
  }
}

function toMessageWireEntry(entry: any) {
  return {
    task_id: entry.taskId,
    run_id: entry.taskId,
    seq: entry.seq,
    role: entry.role,
    kind: entry.kind,
    text: entry.text,
    created_at: entry.createdAt,
    tool_name: entry.toolName ?? null,
    tool_call_id: entry.toolCallId ?? null,
  }
}

function missingRunIdPayload() {
  return JSON.stringify({ ok: false, error: "missing_run_id" })
}

function notFoundPayload(runId: string) {
  return JSON.stringify({ ok: false, error: "not_found", run_id: runId, task_id: runId })
}

function getDetachedRecord(runtime: AiAgentOneActorRuntime, runId: string): DetachedActorRecord | null {
  return getDetachedActorRegistry(runtime.vm as any).get(runId)
}

export function buildWorkflowRunToolDef(): ToolDef<WorkflowRunInput, string, ToolConfig> {
  return {
    schema: {
      type: "function",
      function: {
        name: "WorkflowRun",
        description: "Start an Eidolon AI workflow run by delegating execution to the existing detached actor runtime.",
        parameters: {
          type: "object",
          properties: {
            workflow_ref: {
              type: "string",
              description: "Workflow resource ref such as resource://pkg.Workflow or vfs://./workflows/demo/manifest.xnl.",
            },
            input: {
              description: "Optional structured workflow input.",
            },
            prompt: {
              type: "string",
              description: "Optional extra run instruction.",
            },
            agent_type: {
              type: "string",
              description: "Eidolon agent type that should execute the workflow. Defaults to code.",
            },
            description: {
              type: "string",
              description: "Short detached actor task description.",
            },
            task_key: {
              type: "string",
              description: "Optional stable single-flight key. If omitted, the workflow ref and input determine the active-run slot.",
            },
          },
          required: ["workflow_ref"],
          additionalProperties: false,
        },
      },
    },
    briefPromptXnl: "",
    detailPromptXnl: "",
    run: async (runtime, input) => {
      const workflowRef = normalizeString((input as any)?.workflow_ref)
      const validation = createWorkflowComponent().queries.validateResourceRef(workflowRef)
      if (!validation.ok) {
        return JSON.stringify({
          ok: false,
          error: "invalid_workflow_ref",
          workflow_ref: workflowRef,
          validation,
        })
      }

      const agentType = normalizeString((input as any)?.agent_type) || "code"
      const taskKey = normalizeString((input as any)?.task_key)
        || `workflow:${workflowRef}:${stableHash({
          input: (input as any)?.input ?? null,
          prompt: normalizeString((input as any)?.prompt),
        })}`
      const description = normalizeString((input as any)?.description) || `Run workflow ${workflowRef}`

      try {
        const output = await spawnChildExecutionActor(runtime.vm as any, runtime.actor as any, {
          description,
          prompt: buildRunPrompt(input),
          agentType,
          mode: "detached",
          taskKey,
          toolCallId: (runtime as any)?.toolCallId,
        })
        const delegate = parseSpawnResult(output)
        const runId = normalizeString(delegate.task_id) || null
        return JSON.stringify({
          ok: true,
          kind: "workflow.run",
          runtime: RUNTIME_ID,
          workflow_ref: workflowRef,
          run_id: runId,
          task_id: runId,
          status: delegate.status ?? null,
          reused: delegate.reused === true,
          agent_type: agentType,
          task_key: taskKey,
          delegate,
        })
      } catch (e: any) {
        return JSON.stringify({
          ok: false,
          error: String(e?.message ?? e ?? "unknown"),
          workflow_ref: workflowRef,
          runtime: RUNTIME_ID,
          agent_type: agentType,
        })
      }
    },
  }
}

export function buildWorkflowStatusToolDef(): ToolDef<WorkflowRunIdInput, string, ToolConfig> {
  return {
    schema: {
      type: "function",
      function: {
        name: "WorkflowStatus",
        description: "Read workflow run status from Eidolon detached actor runtime facts.",
        parameters: {
          type: "object",
          properties: {
            run_id: { type: "string", description: "Workflow run id returned by WorkflowRun." },
            task_id: { type: "string", description: "Alias for run_id when the detached actor task id is already known." },
          },
          required: ["run_id"],
          additionalProperties: false,
        },
      },
    },
    briefPromptXnl: "",
    detailPromptXnl: "",
    run: async (runtime, input) => {
      const runId = readRunId(input)
      if (!runId) return missingRunIdPayload()
      const record = getDetachedRecord(runtime, runId)
      if (!record) return notFoundPayload(runId)
      return JSON.stringify(toStatusPayload(record, runId))
    },
  }
}

export function buildWorkflowEventsToolDef(): ToolDef<WorkflowEventsInput, string, ToolConfig> {
  return {
    schema: {
      type: "function",
      function: {
        name: "WorkflowEvents",
        description: "Read workflow run message and tool events from Eidolon detached actor observability facts.",
        parameters: {
          type: "object",
          properties: {
            run_id: { type: "string" },
            task_id: { type: "string" },
            roles: { type: "array", items: { type: "string", enum: ["user", "assistant", "tool", "system_event"] } },
            kinds: { type: "array", items: { type: "string", enum: ["message", "tool_call", "tool_result", "error", "status"] } },
            after_seq: { type: "number" },
            limit_entries: { type: "number" },
            limit_bytes: { type: "number" },
            tail: { type: "boolean" },
          },
          required: ["run_id"],
          additionalProperties: false,
        },
      },
    },
    briefPromptXnl: "",
    detailPromptXnl: "",
    run: async (runtime, input) => {
      const runId = readRunId(input)
      if (!runId) return missingRunIdPayload()
      const record = getDetachedRecord(runtime, runId)
      if (!record) return notFoundPayload(runId)
      const result = getDetachedActorObservabilityStore(runtime.vm as any).queryMessages(runId, {
        roles: normalizeArray<DetachedMessageRole>((input as any)?.roles, MESSAGE_ROLES),
        kinds: normalizeArray<DetachedMessageKind>((input as any)?.kinds, MESSAGE_KINDS),
        after_seq: (input as any)?.after_seq,
        limit_entries: (input as any)?.limit_entries,
        limit_bytes: (input as any)?.limit_bytes,
        tail: (input as any)?.tail,
      })
      return JSON.stringify({
        kind: "workflow.runEvents",
        runtime: RUNTIME_ID,
        run_id: runId,
        actor_kind: record.kind,
        status: record.status,
        ...result,
        entries: result.entries.map(toMessageWireEntry),
      })
    },
  }
}

export function buildWorkflowResultToolDef(): ToolDef<WorkflowResultInput, string, ToolConfig> {
  return {
    schema: {
      type: "function",
      function: {
        name: "WorkflowResult",
        description: "Read a workflow run terminal result from Eidolon detached actor runtime facts.",
        parameters: {
          type: "object",
          properties: {
            run_id: { type: "string" },
            task_id: { type: "string" },
            allow_partial: { type: "boolean" },
            include_events: { type: "boolean" },
            roles: { type: "array", items: { type: "string", enum: ["user", "assistant", "tool", "system_event"] } },
            kinds: { type: "array", items: { type: "string", enum: ["message", "tool_call", "tool_result", "error", "status"] } },
            limit_entries: { type: "number" },
            limit_bytes: { type: "number" },
          },
          required: ["run_id"],
          additionalProperties: false,
        },
      },
    },
    briefPromptXnl: "",
    detailPromptXnl: "",
    run: async (runtime, input) => {
      const runId = readRunId(input)
      if (!runId) return missingRunIdPayload()
      const record = getDetachedRecord(runtime, runId)
      if (!record) return notFoundPayload(runId)
      if (!TERMINAL_STATUSES.has(record.status) && (input as any)?.allow_partial !== true) {
        return JSON.stringify({
          ok: false,
          error: "not_terminal",
          run_id: runId,
          task_id: record.taskId,
          status: record.status,
          runtime: RUNTIME_ID,
        })
      }

      const payload: Record<string, unknown> = {
        ok: true,
        kind: "workflow.runResult",
        runtime: RUNTIME_ID,
        run_id: runId,
        task_id: record.taskId,
        actor_kind: record.kind,
        status: record.status,
        output_text: record.outputText ?? null,
        error: record.error ?? null,
      }

      if ((input as any)?.include_events === true) {
        const result = getDetachedActorObservabilityStore(runtime.vm as any).queryMessages(runId, {
          roles: normalizeArray<DetachedMessageRole>((input as any)?.roles, MESSAGE_ROLES),
          kinds: normalizeArray<DetachedMessageKind>((input as any)?.kinds, MESSAGE_KINDS),
          limit_entries: (input as any)?.limit_entries,
          limit_bytes: (input as any)?.limit_bytes,
        })
        payload.events = {
          ...result,
          entries: result.entries.map(toMessageWireEntry),
        }
      }

      return JSON.stringify(payload)
    },
  }
}

export function buildWorkflowResumeToolDef(): ToolDef<WorkflowRunIdInput, string, ToolConfig> {
  return {
    schema: {
      type: "function",
      function: {
        name: "WorkflowResume",
        description: "Inspect workflow run recovery state; scheduling remains owned by Eidolon actor/session runtime.",
        parameters: {
          type: "object",
          properties: {
            run_id: { type: "string" },
            task_id: { type: "string" },
          },
          required: ["run_id"],
          additionalProperties: false,
        },
      },
    },
    briefPromptXnl: "",
    detailPromptXnl: "",
    run: async (runtime, input) => {
      const runId = readRunId(input)
      if (!runId) return missingRunIdPayload()
      const record = getDetachedRecord(runtime, runId)
      if (!record) return notFoundPayload(runId)
      return JSON.stringify({
        ok: true,
        kind: "workflow.runResume",
        runtime: RUNTIME_ID,
        run_id: runId,
        task_id: record.taskId,
        status: record.status,
        terminal: TERMINAL_STATUSES.has(record.status),
        resumed: false,
        workflow_specific_resume_created: false,
        owner: "eidolon.actor_session_runtime",
        reason: "Workflow runtime facts are already represented by Eidolon detached actor/session state; resume is handled by Eidolon recovery rather than a separate workflow scheduler.",
        parent_fiber_id: record.parentFiberId ?? null,
        child_fiber_id: record.childFiberId ?? null,
        child_actor_key: record.childActorKey ?? null,
        child_actor_id: record.childActorId ?? null,
      })
    },
  }
}
