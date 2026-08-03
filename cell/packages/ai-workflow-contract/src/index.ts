import { createDataSubgraphContractRegistry, type DataSubgraphContract } from "@cell/platform-contract"

export const AI_WORKFLOW_FORMS = ["AICtrlWorkflow", "AIDataWorkflow"] as const
export type AiWorkflowForm = (typeof AI_WORKFLOW_FORMS)[number]

export const AI_WORKFLOW_RESOURCE_SCHEMES = ["vfs", "resource", "config", "secret"] as const
export type AiWorkflowResourceScheme = (typeof AI_WORKFLOW_RESOURCE_SCHEMES)[number]

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

function hasUnsafeDecodedText(value: string): boolean {
  let decoded = value
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return true
  }
  return decoded.includes("\\") || decoded.split(/[/?#]/).some((part) => part === "..")
}

function validateLogicalPathLike(ref: string): string | null {
  if (!ref.trim()) return "ref is empty"
  if (/^(\/|~\/|[a-zA-Z]:[\\/])/.test(ref)) return "host absolute paths are not workflow resource refs"
  if (ref.includes("\\")) return "backslashes are not allowed in workflow resource refs"
  if (hasUnsafeDecodedText(ref)) return "path traversal is not allowed in workflow resource refs"
  return null
}

export function validateAiWorkflowResourceRef(input: unknown): AiWorkflowResourceRefValidationResult {
  const ref = typeof input === "string" ? input : ""
  const pathIssue = validateLogicalPathLike(ref)
  if (pathIssue) return { ok: false, ref, reason: pathIssue }

  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.+)$/.exec(ref)
  if (!match) {
    return { ok: false, ref, reason: "workflow resource refs must use a registered URI scheme" }
  }

  const scheme = match[1] as AiWorkflowResourceScheme
  const body = match[2] ?? ""
  if (!(AI_WORKFLOW_RESOURCE_SCHEMES as readonly string[]).includes(scheme)) {
    return { ok: false, ref, reason: `unsupported workflow resource scheme: ${scheme}` }
  }

  if (scheme === "vfs") {
    if (!body.startsWith("./") && !body.startsWith("@/")) {
      return { ok: false, ref, reason: "vfs refs must be scoped to vfs://./ or vfs://@/" }
    }
  }

  if (scheme === "resource" && !body.split(/[/?#]/)[0]) {
    return { ok: false, ref, reason: "resource refs must include an authority" }
  }

  return { ok: true, ref, scheme }
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
