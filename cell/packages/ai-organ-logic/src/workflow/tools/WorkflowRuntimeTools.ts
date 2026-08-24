import type { AiAgentOneActorRuntime, ToolDef } from "@cell/ai-core-contract/types"
import {
  getDetachedActorRegistry,
  type DetachedActorRecord,
} from "@cell/ai-organ-logic/detached/DetachedActorRegistry"
import {
  getDetachedActorObservabilityStore,
  type DetachedMessageKind,
  type DetachedMessageRole,
} from "@cell/ai-organ-logic/detached/DetachedActorObservability"
import { getWorkflowRuntimeService } from "../runtime"
import {
  withWorkflowDomainProgress,
  type WorkflowDomainProgressTransition,
} from "../runtime/WorkflowDomainProgress"
import { startWorkflowRunFromFulfillmentContinuation } from "./WorkflowFulfill/ExecutionContinuation"

type ToolConfig = Record<string, unknown>

type WorkflowRunInput = {
  instance_id: string
  run_id?: string
  confirmed?: boolean
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

type WorkflowResumeInput = WorkflowRunIdInput & {
  node_id?: string
  output?: unknown
  signal_kind?: string
  signal_key?: string
  resume_token?: string
  outcome?: "Success" | "Failure" | "Cancelled"
  payload?: unknown
}

type WorkflowGraphPatchInput = WorkflowRunIdInput & {
  patch: {
    patchId: string
    reason?: string
    operations: unknown[]
    atMs?: number
  }
}

type WorkflowStepExtensionMutationInput = {
  instance_id: string
  run_id: string
  step_id: string
  extension_kind: string
  expected_revision: number
  value: unknown
}

type WorkflowProcessHolonTaskInput = {
  run_id: string
  node_id: string
  task_space_id: string
  task_id: string
  assignment_command_id: string
  start_command_id: string
  settlement_command_id: string
  invocation_ref: string
  claimed_at: string
  started_at: string
  settled_at: string
  lease_duration_ms: number
  input: unknown
}

type WorkflowReplanHolonTaskInput = {
  run_id: string
  node_id: string
  task_space_id: string
  previous_task_id: string
  successor_task_id: string
  successor_task_name: string
  successor_effective_at: string
  cancel_command_id: string
  replan_command_id: string
  plan_id: string
  replanned_at: string
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

function ownDataValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && "value" in descriptor && descriptor.enumerable ? descriptor.value : undefined
}

function successfulRuntimeProgress(
  value: unknown,
  transition: Extract<WorkflowDomainProgressTransition, "run_started" | "result_observed">,
): unknown {
  if (ownDataValue(value, "ok") !== true) return value
  const runId = normalizeString(ownDataValue(value, "run_id"))
  if (!runId) return value
  const definitionRevision = normalizeString(ownDataValue(value, "definition_revision"))
  return withWorkflowDomainProgress(value as object, {
    owner: "workflow.runtime",
    transition,
    subjectId: runId,
    revision: definitionRevision || runId,
  })
}

function normalizeArray<T extends string>(value: unknown, allowed: Set<string>): T[] | undefined {
  if (!Array.isArray(value)) return undefined
  const next = value.map((item) => String(item)).filter((item) => allowed.has(item)) as T[]
  return next.length > 0 ? next : undefined
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
        description: "Preview or explicitly confirm start of a prepared workflow Instance using frozen definition and Material facts; an active execution continuation returns its exact durable run without starting another.",
        parameters: {
          type: "object",
          properties: {
            instance_id: {
              type: "string",
              description: "Prepared workflow Instance id returned by WorkflowCreateInstance.",
            },
            run_id: { type: "string", description: "Optional stable caller-supplied run id." },
            confirmed: { type: "boolean", description: "Independent execution confirmation; omit for no-effect preview." },
          },
          required: ["instance_id"],
          additionalProperties: false,
        },
      },
    },
    briefPromptXnl: "",
    detailPromptXnl: "",
    run: async (runtime, input) => {
      const instanceId = normalizeString((input as any)?.instance_id)
      try {
        const result = await startWorkflowRunFromFulfillmentContinuation(runtime as any, {
          instanceId,
          runId: normalizeString((input as any)?.run_id) || undefined,
          confirmed: (input as any)?.confirmed === true,
        })
        return JSON.stringify(successfulRuntimeProgress(result, "run_started"))
      } catch (e: any) {
        return JSON.stringify({
          ok: false,
          error: String(e?.message ?? e ?? "unknown"),
          instance_id: instanceId,
          runtime: "depa-flows",
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
        description: "Read graph status from persisted workflow facts, with legacy detached-run compatibility.",
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
      const workflow = await getWorkflowRuntimeService(runtime as any).status(runId)
      if (workflow) return JSON.stringify(workflow)
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
        description: "Read workflow domain/effect events, with legacy detached-run compatibility.",
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
      const workflow = await getWorkflowRuntimeService(runtime as any).events(runId)
      if (workflow) return JSON.stringify(workflow)
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
        description: "Read a workflow graph terminal result, with optional partial state and legacy compatibility.",
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
      const workflow = await getWorkflowRuntimeService(runtime as any).result(
        runId,
        (input as any)?.allow_partial === true,
      )
      if (workflow) {
        if ((input as any)?.include_events === true && workflow.ok) {
          const events = await getWorkflowRuntimeService(runtime as any).events(runId)
          return JSON.stringify(successfulRuntimeProgress({ ...workflow, events }, "result_observed"))
        }
        return JSON.stringify(successfulRuntimeProgress(workflow, "result_observed"))
      }
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

      return JSON.stringify(successfulRuntimeProgress(payload, "result_observed"))
    },
  }
}

export function buildWorkflowResumeToolDef(): ToolDef<WorkflowResumeInput, string, ToolConfig> {
  return {
    schema: {
      type: "function",
      function: {
        name: "WorkflowResume",
        description: "Resume a persisted waiting workflow graph using an explicit signal or its sole open wait handle.",
        parameters: {
          type: "object",
          properties: {
            run_id: { type: "string" },
            task_id: { type: "string" },
            node_id: { type: "string", description: "Stable waiting manual node id for AIDataWorkflow." },
            output: { description: "Manual node output record for AIDataWorkflow." },
            signal_kind: { type: "string" },
            signal_key: { type: "string" },
            resume_token: { type: "string" },
            outcome: { type: "string", enum: ["Success", "Failure", "Cancelled"] },
            payload: {},
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
      const service = getWorkflowRuntimeService(runtime as any)
      const current = await service.status(runId)
      if (current) {
        if (current.terminal) {
          return JSON.stringify({ ...current, kind: "workflow.runResume", resumed: false })
        }
        if (current.form === "AIDataWorkflow") {
          const waitingNodes = (current.nodes as Array<Record<string, any>>)
            .filter((node) => node.nodeType === "manual" && node.result?.status === "Waiting")
          const requestedNodeId = normalizeString((input as any)?.node_id)
          const nodeId = requestedNodeId || (waitingNodes.length === 1 ? String(waitingNodes[0].id) : "")
          if (!nodeId) {
            return JSON.stringify({
              ok: false,
              error: waitingNodes.length > 1 ? "ambiguous_manual_node" : "missing_manual_node",
              run_id: runId,
              waiting_nodes: waitingNodes.map((node) => node.id),
            })
          }
          try {
            const resumed = await service.resumeDataNode(runId, nodeId, (input as any)?.output ?? (input as any)?.payload)
            return JSON.stringify({ ...resumed, resumed: true })
          } catch (error) {
            return JSON.stringify({ ok: false, error: String((error as Error)?.message ?? error), run_id: runId })
          }
        }
        const handles = current.open_wait_handles as Array<Record<string, unknown>>
        const only = handles.length === 1 ? handles[0] : undefined
        const signalKind = normalizeString((input as any)?.signal_kind) || normalizeString(only?.signalKind)
        const signalKey = normalizeString((input as any)?.signal_key) || normalizeString(only?.signalKey)
        const resumeToken = normalizeString((input as any)?.resume_token) || normalizeString(only?.resumeToken)
        if (!signalKind || !signalKey || !resumeToken) {
          return JSON.stringify({
            ok: false,
            error: handles.length > 1 ? "ambiguous_wait_handle" : "missing_resume_signal",
            run_id: runId,
            open_wait_handles: handles,
          })
        }
        try {
          const resumed = await service.resume(runId, {
            signalKind,
            signalKey,
            resumeToken,
            outcome: (input as any)?.outcome,
            payload: (input as any)?.payload,
          })
          return JSON.stringify({ ...resumed, resumed: true })
        } catch (error) {
          return JSON.stringify({ ok: false, error: String((error as Error)?.message ?? error), run_id: runId })
        }
      }
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

function buildWorkflowTerminalSignalToolDef(
  name: "WorkflowResolve" | "WorkflowReject",
  outcome: "Success" | "Failure",
): ToolDef<WorkflowResumeInput, string, ToolConfig> {
  const resume = buildWorkflowResumeToolDef()
  return {
    ...resume,
    schema: {
      type: "function",
      function: {
        name,
        description: outcome === "Success"
          ? "Resolve an exact pending workflow wait handle through the durable depa-flows/Eidolon lifecycle."
          : "Reject an exact pending workflow wait handle through the durable depa-flows/Eidolon lifecycle.",
        parameters: {
          type: "object",
          properties: {
            run_id: { type: "string" },
            signal_kind: { type: "string" },
            signal_key: { type: "string" },
            resume_token: { type: "string" },
            payload: {},
          },
          required: ["run_id"],
          additionalProperties: false,
        },
      },
    },
    run: (runtime, input, config) => resume.run(runtime, { ...input, outcome }, config),
  }
}

export function buildWorkflowResolveToolDef(): ToolDef<WorkflowResumeInput, string, ToolConfig> {
  return buildWorkflowTerminalSignalToolDef("WorkflowResolve", "Success")
}

export function buildWorkflowRejectToolDef(): ToolDef<WorkflowResumeInput, string, ToolConfig> {
  return buildWorkflowTerminalSignalToolDef("WorkflowReject", "Failure")
}

export function buildWorkflowApplyGraphPatchToolDef(): ToolDef<WorkflowGraphPatchInput, string, ToolConfig> {
  return {
    schema: {
      type: "function",
      function: {
        name: "WorkflowApplyGraphPatch",
        description: "Apply a structurally validated canonical GraphPatch to one AIDataWorkflow run generation and advance its ready frontier.",
        parameters: {
          type: "object",
          properties: {
            run_id: { type: "string" },
            task_id: { type: "string" },
            patch: {
              type: "object",
              properties: {
                patchId: { type: "string" },
                reason: { type: "string" },
                atMs: { type: "number" },
                operations: { type: "array", items: { type: "object" } },
              },
              required: ["patchId", "operations"],
              additionalProperties: false,
            },
          },
          required: ["run_id", "patch"],
          additionalProperties: false,
        },
      },
    },
    briefPromptXnl: "",
    detailPromptXnl: "",
    run: async (runtime, input) => {
      const runId = readRunId(input)
      if (!runId) return missingRunIdPayload()
      try {
        const patched = await getWorkflowRuntimeService(runtime as any).applyGraphPatch(
          runId,
          (input as any)?.patch,
        )
        return patched ? JSON.stringify(patched) : notFoundPayload(runId)
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: String((error as Error)?.message ?? error),
          run_id: runId,
        })
      }
    },
  }
}

export function buildWorkflowMutateStepExtensionToolDef(): ToolDef<WorkflowStepExtensionMutationInput, string, ToolConfig> {
  return {
    schema: {
      type: "function",
      function: {
        name: "WorkflowMutateStepExtension",
        description: "Mutate one admitted logical Step extension by exact instance/run/step/kind identity and expected revision.",
        parameters: {
          type: "object",
          properties: {
            instance_id: { type: "string" },
            run_id: { type: "string" },
            step_id: { type: "string" },
            extension_kind: { type: "string" },
            expected_revision: { type: "number" },
            value: {},
          },
          required: ["instance_id", "run_id", "step_id", "extension_kind", "expected_revision", "value"],
          additionalProperties: false,
        },
      },
    },
    briefPromptXnl: "",
    detailPromptXnl: "",
    run: async (runtime, input) => {
      try {
        const checkpoint = await getWorkflowRuntimeService(runtime as any).mutateRunStepExtension({
          instanceId: input.instance_id,
          runId: input.run_id,
          stepId: input.step_id,
          kind: input.extension_kind,
          expectedRevision: input.expected_revision,
          value: input.value as import("ai-workflow-contract").FlowClosedValue,
        })
        const fact = checkpoint.stepExtensions?.byStepId[input.step_id]?.[input.extension_kind]
        if (!fact) throw new Error("Accepted checkpoint omitted the selected Step extension fact")
        return JSON.stringify({
          ok: true,
          kind: "workflow.stepExtensionMutation",
          instance_id: checkpoint.instanceId,
          run_id: checkpoint.runId,
          step_id: input.step_id,
          extension_kind: input.extension_kind,
          checkpoint_version: checkpoint.version,
          revision: fact.revision,
          ...(fact.schemaRef === undefined ? {} : { schema_ref: fact.schemaRef }),
          value: fact.value,
        })
      } catch (error) {
        return JSON.stringify({
          ok: false,
          kind: "workflow.stepExtensionMutation",
          instance_id: input.instance_id,
          run_id: input.run_id,
          step_id: input.step_id,
          extension_kind: input.extension_kind,
          error: String((error as Error)?.message ?? error),
        })
      }
    },
  }
}

export function buildWorkflowProcessHolonTaskToolDef(): ToolDef<WorkflowProcessHolonTaskInput, string, ToolConfig> {
  return {
    schema: {
      type: "function",
      function: {
        name: "WorkflowProcessHolonTask",
        description: "Assign, claim, execute and settle one organization-owned TaskSpace task through its frozen Holon MemberRuntime.",
        parameters: {
          type: "object",
          properties: {
            run_id: { type: "string" },
            node_id: { type: "string" },
            task_space_id: { type: "string" },
            task_id: { type: "string" },
            assignment_command_id: { type: "string" },
            start_command_id: { type: "string" },
            settlement_command_id: { type: "string" },
            invocation_ref: { type: "string" },
            claimed_at: { type: "string" },
            started_at: { type: "string" },
            settled_at: { type: "string" },
            lease_duration_ms: { type: "number" },
            input: {},
          },
          required: [
            "run_id", "node_id", "task_space_id", "task_id", "assignment_command_id",
            "start_command_id", "settlement_command_id", "invocation_ref", "claimed_at",
            "started_at", "settled_at", "lease_duration_ms", "input",
          ],
          additionalProperties: false,
        },
      },
    },
    briefPromptXnl: "",
    detailPromptXnl: "",
    run: async (runtime, input) => {
      try {
        const result = await getWorkflowRuntimeService(runtime as any).processHolonTask({
          runId: input.run_id,
          nodeId: input.node_id,
          taskSpaceId: input.task_space_id,
          taskId: input.task_id,
          assignmentCommandId: input.assignment_command_id,
          startCommandId: input.start_command_id,
          settlementCommandId: input.settlement_command_id,
          invocationRef: input.invocation_ref,
          claimedAt: input.claimed_at,
          startedAt: input.started_at,
          settledAt: input.settled_at,
          leaseDurationMs: input.lease_duration_ms,
          input: input.input as import("holarchy-eidolon-adapter").ClosedValue,
        })
        return JSON.stringify({ ok: true, kind: "workflow.holonTaskSettlement", ...result })
      } catch (error) {
        return JSON.stringify({
          ok: false,
          kind: "workflow.holonTaskSettlement",
          run_id: input.run_id,
          task_space_id: input.task_space_id,
          task_id: input.task_id,
          error: String((error as Error)?.message ?? error),
        })
      }
    },
  }
}

export function buildWorkflowReplanHolonTaskToolDef(): ToolDef<WorkflowReplanHolonTaskInput, string, ToolConfig> {
  return {
    schema: {
      type: "function",
      function: {
        name: "WorkflowReplanHolonTask",
        description: "Explicitly adopt a newer issuer-owned organization snapshot for a successor TaskSpace task without mutating the frozen Flow instance.",
        parameters: {
          type: "object",
          properties: {
            run_id: { type: "string" },
            node_id: { type: "string" },
            task_space_id: { type: "string" },
            previous_task_id: { type: "string" },
            successor_task_id: { type: "string" },
            successor_task_name: { type: "string" },
            successor_effective_at: { type: "string" },
            cancel_command_id: { type: "string" },
            replan_command_id: { type: "string" },
            plan_id: { type: "string" },
            replanned_at: { type: "string" },
          },
          required: [
            "run_id", "node_id", "task_space_id", "previous_task_id", "successor_task_id",
            "successor_task_name", "successor_effective_at", "cancel_command_id",
            "replan_command_id", "plan_id", "replanned_at",
          ],
          additionalProperties: false,
        },
      },
    },
    briefPromptXnl: "",
    detailPromptXnl: "",
    run: async (runtime, input) => {
      try {
        const result = await getWorkflowRuntimeService(runtime as any).replanHolonTask({
          runId: input.run_id,
          nodeId: input.node_id,
          taskSpaceId: input.task_space_id,
          previousTaskId: input.previous_task_id,
          successorTaskId: input.successor_task_id,
          successorTaskName: input.successor_task_name,
          successorEffectiveAt: input.successor_effective_at,
          cancelCommandId: input.cancel_command_id,
          replanCommandId: input.replan_command_id,
          planId: input.plan_id,
          replannedAt: input.replanned_at,
        })
        return JSON.stringify({
          ok: true,
          kind: "workflow.holonTaskReplan",
          run_id: input.run_id,
          task_space_id: input.task_space_id,
          previous_task_id: input.previous_task_id,
          successor_task_id: input.successor_task_id,
          task_space_revision: result.snapshot.revision,
          receipt_id: result.receipt.receiptId,
          replayed: result.replayed,
          adoptionReceipt: result.adoptionReceipt,
          successorSnapshotReceipt: result.successorSnapshotReceipt,
        })
      } catch (error) {
        return JSON.stringify({
          ok: false,
          kind: "workflow.holonTaskReplan",
          run_id: input.run_id,
          task_space_id: input.task_space_id,
          previous_task_id: input.previous_task_id,
          successor_task_id: input.successor_task_id,
          error: String((error as Error)?.message ?? error),
        })
      }
    },
  }
}
