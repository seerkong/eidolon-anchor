import { createDataSubgraphContractRegistry, type DataSubgraphContract } from "@cell/platform-contract"
import {
  AI_CTRL_WORKFLOW_DESCRIPTOR,
  AI_DATA_WORKFLOW_DESCRIPTOR,
  AI_WORKFLOW_ALLOWED_RESOURCE_REF_SCHEMES,
  type AIWorkflowKind,
  type AIWorkflowResourceRefScheme,
} from "ai-workflow-contract"
import { parseAIWorkflowResourceRef } from "ai-workflow-logic"

export * from "ai-workflow-contract"
export * from "ai-ctrl-workflow-contract"
export * from "ai-data-workflow-contract"

export const AI_WORKFLOW_FORMS = [
  AI_CTRL_WORKFLOW_DESCRIPTOR.kind,
  AI_DATA_WORKFLOW_DESCRIPTOR.kind,
] as const
export type AiWorkflowForm = AIWorkflowKind

export const AI_WORKFLOW_RESOURCE_SCHEMES = AI_WORKFLOW_ALLOWED_RESOURCE_REF_SCHEMES
export type AiWorkflowResourceScheme = AIWorkflowResourceRefScheme

export type AiWorkflowRuntimeRef = {
  actorKey?: string
  actorId?: string
  fiberId?: string
  taskId?: string
  toolCallId?: string
  providerCallId?: string
  domainFactIds?: string[]
}

export type AiWorkflowNodeRecord = {
  nodeId: string
  generation: number
  status: "pending" | "runnable" | "waiting" | "completed" | "failed" | "repair_required"
  refs: AiWorkflowRuntimeRef
  materialRefs: string[]
}

export type AiWorkflowRunRecord = {
  runId: string
  workflowRef: string
  form: AiWorkflowForm
  graphGeneration: number
  nodes: Record<string, AiWorkflowNodeRecord>
}

export type AiWorkflowRootDescriptor = {
  globalRoot?: string
  workspaceRoot?: string
  sessionWorkflowRoot?: string
}

export type AiWorkflowResourceRefValidationResult =
  | {
      ok: true
      ref: string
      scheme: AiWorkflowResourceScheme
    }
  | {
      ok: false
      ref: string
      reason: string
    }

const EXISTING_EIDOLON_RUNTIME_FACTS = [
  "actor.registry",
  "actor.fiber_registry",
  "actor.mailbox_state",
  "actor.scheduler_state",
  "turn.state",
  "history.committed_messages",
  "llm_context.materialized_provider_context",
  "session.active_actor_binding",
  "session.active_history_head",
  "tool_call.result_attribution",
  "provider_call.reasoning",
  "provider_call.content",
  "control.effect_wal",
  "checkpoint.vm_durable_subset",
  "member.roster",
  "holon.governance",
  "detached.tasks",
] as const

export const AI_WORKFLOW_DATA_COMPONENT_ID = "ai_workflow_orchestration" as const

export const AI_WORKFLOW_DATA_SUBGRAPH_CONTRACT: DataSubgraphContract = {
  id: AI_WORKFLOW_DATA_COMPONENT_ID,
  layer: "domain",
  ownedFactNodes: [
    { nodeId: "workflow.definition", grade: "authoritative_fact" },
    { nodeId: "workflow.run_graph", grade: "authoritative_fact" },
    { nodeId: "workflow.node_generation", grade: "authoritative_fact" },
    { nodeId: "workflow.invalidation_reuse_policy", grade: "authoritative_fact" },
    { nodeId: "workflow.material_bindings", grade: "authoritative_fact" },
    { nodeId: "workflow.node_runtime_refs", grade: "authoritative_fact" },
    { nodeId: "workflow.graph_patch_record", grade: "domain_canonical_event" },
    { nodeId: "workflow.promote_record", grade: "domain_canonical_event" },
    { nodeId: "workflow.audit_decision", grade: "domain_canonical_event" },
  ],
  derivedNodes: [
    { nodeId: "workflow.run_status_view", grade: "derived_projection_cache" },
    { nodeId: "workflow.ready_node_view", grade: "derived_projection_cache" },
  ],
  writeCommands: [
    "workflow.define",
    "workflow.start_run",
    "workflow.record_node_ref",
    "workflow.apply_graph_patch",
    "workflow.promote_run_graph",
    "workflow.record_audit_decision",
  ],
  readViews: [
    "workflow.definition_view",
    "workflow.run_graph_view",
    "workflow.node_status_view",
    "workflow.material_binding_view",
  ],
  factStreams: ["workflow.domain_events"],
  projectionSinks: ["surface.actor_surface_lanes", "journal.diagnostics"],
  notOwnedHere: [...EXISTING_EIDOLON_RUNTIME_FACTS],
  allowedRecoveryReads: [
    "actor.registry",
    "actor.fiber_registry",
    "tool_call.result_attribution",
    "provider_call.content",
    "member.roster",
    "holon.governance",
    "detached.tasks",
  ],
  forbiddenLiveReads: [
    "control.effect_wal",
    "checkpoint.vm_durable_subset",
    "surface.tui_view",
  ],
}

export const AI_WORKFLOW_DATA_SUBGRAPH_CONTRACTS = [
  AI_WORKFLOW_DATA_SUBGRAPH_CONTRACT,
] as const

export function createAiWorkflowDataSubgraphRegistry() {
  return createDataSubgraphContractRegistry([...AI_WORKFLOW_DATA_SUBGRAPH_CONTRACTS])
}

export function validateAiWorkflowResourceRef(input: unknown): AiWorkflowResourceRefValidationResult {
  const ref = typeof input === "string" ? input : ""
  const parsed = parseAIWorkflowResourceRef(ref)
  if (!parsed) {
    return {
      ok: false,
      ref,
      reason: "invalid AI workflow resource ref: expected a registered, containment-safe logical URI",
    }
  }
  if (parsed.scheme === "vfs" && !parsed.target.startsWith("./") && !parsed.target.startsWith("@/")) {
    return { ok: false, ref, reason: "vfs refs must be scoped to vfs://./ or vfs://@/" }
  }
  return { ok: true, ref: parsed.ref, scheme: parsed.scheme }
}

export function summarizeAiWorkflowContractBoundary() {
  return {
    componentId: AI_WORKFLOW_DATA_COMPONENT_ID,
    forms: [...AI_WORKFLOW_FORMS],
    resourceSchemes: [...AI_WORKFLOW_RESOURCE_SCHEMES],
    ownedFactNodes: AI_WORKFLOW_DATA_SUBGRAPH_CONTRACT.ownedFactNodes.map((node) => node.nodeId),
    notOwnedHere: [...AI_WORKFLOW_DATA_SUBGRAPH_CONTRACT.notOwnedHere],
    forbiddenLiveReads: [...AI_WORKFLOW_DATA_SUBGRAPH_CONTRACT.forbiddenLiveReads],
  }
}
