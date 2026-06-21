import {
  createDataSubgraphContractRegistry,
  isLiveTruthCapableFactGrade,
  type DataSubgraphContract,
  type DataSubgraphContractRegistry,
} from "@cell/platform-contract";

import { AI_STAGE_COMPONENT_CONTRACTS } from "./ConversationSpineContracts";

/**
 * First-batch AI runtime data components.
 *
 * Each contract declares the single writer boundary for one runtime data
 * subgraph. Node ids reference the runtime concepts as they exist today
 * (conversation three-domain runtime, runtime-control evidence, checkpoint
 * snapshots, surface projections); migration of the real write paths onto
 * these contracts belongs to later tracks.
 */

export const AI_RUNTIME_DATA_COMPONENT_IDS = [
  "actor_runtime",
  "ai_turn_state",
  "history_domain",
  "llm_context_domain",
  "session_domain",
  "tool_call_domain",
  "provider_call_domain",
  "runtime_control",
  "checkpoint_snapshot",
  "surface_projection",
  "ingress_stage",
  "lexical_syntactic_stage",
  "semantic_event",
  "member_holon_data_components",
] as const;

export type AiRuntimeDataComponentId = (typeof AI_RUNTIME_DATA_COMPONENT_IDS)[number];

const ACTOR_RUNTIME_CONTRACT: DataSubgraphContract = {
  id: "actor_runtime",
  layer: "platform",
  ownedFactNodes: [
    { nodeId: "actor.registry", grade: "authoritative_fact" },
    { nodeId: "actor.fiber_registry", grade: "authoritative_fact" },
    { nodeId: "actor.mailbox_state", grade: "authoritative_fact" },
    { nodeId: "actor.scheduler_state", grade: "authoritative_fact" },
  ],
  derivedNodes: [{ nodeId: "actor.scheduler_signal_view", grade: "derived_projection_cache" }],
  writeCommands: ["actor.register", "actor.enqueue_mailbox", "actor.update_fiber_state"],
  readViews: ["actor.scheduler_view", "actor.mailbox_pending_view"],
  factStreams: ["actor.lifecycle_events"],
  projectionSinks: ["surface.actor_surface_lanes", "journal.diagnostics"],
  notOwnedHere: ["history.committed_messages", "turn.state"],
  allowedRecoveryReads: ["checkpoint.vm_durable_subset"],
  forbiddenLiveReads: ["checkpoint.vm_durable_subset", "control.effect_wal"],
};

const AI_TURN_STATE_CONTRACT: DataSubgraphContract = {
  id: "ai_turn_state",
  layer: "domain",
  // Aligned with the implemented TurnState ADT + turnReducer (track
  // refactor-ai-turn-tool-provider-lifecycle, P1). The wait boundary is an
  // owned fact (gate G-ai-wait-message): the ADT distinguishes the human /
  // tool / provider / questionnaire / compress wait kinds as separate variants
  // (wait_human / wait_tool / wait_llm / wait_questionnaire_parse /
  // wait_compress), each carrying its own boundary fields. State advance is the
  // pure turnReducer (one event -> {state, effects}).
  ownedFactNodes: [
    { nodeId: "turn.state", grade: "authoritative_fact" },
    { nodeId: "turn.wait_boundary", grade: "authoritative_fact" },
    { nodeId: "turn.mandatory_continuation", grade: "authoritative_fact" },
  ],
  derivedNodes: [{ nodeId: "turn.status_view", grade: "derived_projection_cache" }],
  writeCommands: ["turn.reduce_event", "turn.advance_state", "turn.mark_mandatory_continuation"],
  readViews: ["turn.current_state", "turn.wait_view"],
  factStreams: ["turn.state_events"],
  projectionSinks: ["surface.tui_view", "journal.diagnostics"],
  notOwnedHere: ["control.operation_lifecycle", "checkpoint.vm_durable_subset"],
  allowedRecoveryReads: ["checkpoint.vm_durable_subset"],
  forbiddenLiveReads: ["checkpoint.vm_durable_subset", "control.effect_wal", "journal.diagnostics"],
};

const HISTORY_DOMAIN_CONTRACT: DataSubgraphContract = {
  id: "history_domain",
  layer: "domain",
  ownedFactNodes: [
    { nodeId: "history.committed_messages", grade: "authoritative_fact" },
    { nodeId: "history.generation_head", grade: "authoritative_fact" },
    { nodeId: "history.compaction_record", grade: "domain_canonical_event" },
  ],
  derivedNodes: [{ nodeId: "history.visible_view", grade: "derived_projection_cache" }],
  writeCommands: ["history.append_committed_message", "history.apply_compaction"],
  readViews: ["history.active_tail", "history.visible_history"],
  factStreams: ["history.domain_events"],
  projectionSinks: ["surface.tui_view", "journal.diagnostics"],
  notOwnedHere: ["llm_context.materialized_provider_context", "checkpoint.vm_durable_subset"],
  allowedRecoveryReads: ["checkpoint.vm_durable_subset"],
  forbiddenLiveReads: ["checkpoint.vm_durable_subset", "control.effect_wal", "surface.tui_view"],
};

const LLM_CONTEXT_DOMAIN_CONTRACT: DataSubgraphContract = {
  id: "llm_context_domain",
  layer: "domain",
  ownedFactNodes: [
    { nodeId: "llm_context.generation", grade: "authoritative_fact" },
    { nodeId: "llm_context.basis", grade: "authoritative_fact" },
    { nodeId: "llm_context.transforms", grade: "authoritative_fact" },
    { nodeId: "llm_context.materialized_provider_context", grade: "authoritative_fact" },
  ],
  derivedNodes: [],
  writeCommands: ["llm_context.record_prompt_request", "llm_context.apply_transform"],
  readViews: ["llm_context.provider_request_view"],
  factStreams: ["llm_context.domain_events"],
  projectionSinks: ["journal.diagnostics"],
  notOwnedHere: ["history.committed_messages", "session.active_history_head"],
  allowedRecoveryReads: ["checkpoint.vm_durable_subset"],
  forbiddenLiveReads: [
    "checkpoint.vm_durable_subset",
    "control.effect_wal",
    "journal.diagnostics",
    "surface.tui_view",
  ],
};

const SESSION_DOMAIN_CONTRACT: DataSubgraphContract = {
  id: "session_domain",
  layer: "domain",
  ownedFactNodes: [
    { nodeId: "session.metadata", grade: "authoritative_fact" },
    { nodeId: "session.active_actor_binding", grade: "authoritative_fact" },
    { nodeId: "session.active_history_head", grade: "authoritative_fact" },
    { nodeId: "session.active_llm_context_head", grade: "authoritative_fact" },
    { nodeId: "session.lineage", grade: "authoritative_fact" },
  ],
  derivedNodes: [{ nodeId: "session.list_index", grade: "derived_projection_cache" }],
  writeCommands: ["session.bind_actor", "session.move_history_head", "session.move_llm_context_head"],
  readViews: ["session.active_binding"],
  factStreams: ["session.domain_events"],
  projectionSinks: ["surface.session_picker_view"],
  notOwnedHere: ["history.committed_messages", "llm_context.materialized_provider_context"],
  allowedRecoveryReads: ["checkpoint.vm_durable_subset"],
  forbiddenLiveReads: ["checkpoint.vm_durable_subset", "surface.session_picker_view"],
};

const TOOL_CALL_DOMAIN_CONTRACT: DataSubgraphContract = {
  id: "tool_call_domain",
  layer: "domain",
  // Aligned with the implemented ToolCallDomain runtime (track
  // refactor-ai-turn-tool-provider-lifecycle, P4): the gate decision is an
  // owned fact (decision D3 — stored in the domain, read back for stopAfterTools)
  // and the lifecycle commands match the runtime's guarded state machine.
  ownedFactNodes: [
    { nodeId: "tool_call.requested", grade: "domain_canonical_event" },
    { nodeId: "tool_call.started", grade: "domain_canonical_event" },
    { nodeId: "tool_call.completed", grade: "domain_canonical_event" },
    { nodeId: "tool_call.failed", grade: "domain_canonical_event" },
    { nodeId: "tool_call.gate_decision", grade: "authoritative_fact" },
    { nodeId: "tool_call.result_attribution", grade: "authoritative_fact" },
  ],
  derivedNodes: [],
  writeCommands: [
    "tool_call.plan",
    "tool_call.record_gate_decision",
    "tool_call.mark_executing",
    "tool_call.record_result",
    "tool_call.record_failure",
  ],
  readViews: ["tool_call.pairing_view", "tool_call.active_records_view"],
  factStreams: ["tool_call.domain_events"],
  projectionSinks: ["surface.tui_view", "journal.diagnostics"],
  notOwnedHere: ["control.effect_wal", "history.committed_messages"],
  allowedRecoveryReads: ["checkpoint.vm_durable_subset"],
  forbiddenLiveReads: ["control.effect_wal", "journal.diagnostics"],
};

const PROVIDER_CALL_DOMAIN_CONTRACT: DataSubgraphContract = {
  id: "provider_call_domain",
  layer: "domain",
  // Aligned with the implemented ProviderCallDomain runtime (track
  // refactor-ai-turn-tool-provider-lifecycle, P5 / decision 5): reasoning and
  // content are two distinct owned facts (not a merged content_parts array),
  // each read via an explicit view; the lifecycle commands match the runtime.
  ownedFactNodes: [
    { nodeId: "provider_call.request", grade: "domain_canonical_event" },
    { nodeId: "provider_call.reasoning", grade: "authoritative_fact" },
    { nodeId: "provider_call.content", grade: "authoritative_fact" },
    { nodeId: "provider_call.result", grade: "domain_canonical_event" },
    { nodeId: "provider_call.failure", grade: "domain_canonical_event" },
    { nodeId: "provider_call.usage", grade: "domain_canonical_event" },
  ],
  derivedNodes: [],
  writeCommands: [
    "provider_call.start",
    "provider_call.record_first_token",
    "provider_call.append_reasoning_segment",
    "provider_call.append_content_segment",
    "provider_call.complete",
    "provider_call.fail",
  ],
  readViews: ["provider_call.exchange_view", "provider_call.reasoning_view", "provider_call.content_view"],
  factStreams: ["provider_call.domain_events"],
  projectionSinks: ["journal.diagnostics"],
  notOwnedHere: ["history.committed_messages", "llm_context.materialized_provider_context"],
  allowedRecoveryReads: [],
  forbiddenLiveReads: ["control.effect_wal", "checkpoint.vm_durable_subset"],
};

const RUNTIME_CONTROL_CONTRACT: DataSubgraphContract = {
  id: "runtime_control",
  layer: "platform",
  ownedFactNodes: [
    { nodeId: "control.operation_lifecycle", grade: "runtime_control_fact" },
    { nodeId: "control.barrier_state", grade: "runtime_control_fact" },
    { nodeId: "control.checkpoint_cohort", grade: "runtime_control_fact" },
    { nodeId: "control.recovery_scan", grade: "runtime_control_fact" },
    { nodeId: "control.effect_wal", grade: "append_only_journal" },
  ],
  derivedNodes: [],
  writeCommands: ["control.enqueue_command", "control.append_effect_evidence", "control.commit_cohort"],
  readViews: ["control.operation_view", "control.recovery_view"],
  factStreams: ["control.lifecycle_events"],
  projectionSinks: ["journal.diagnostics"],
  notOwnedHere: [
    "history.committed_messages",
    "llm_context.materialized_provider_context",
    "tool_call.result_attribution",
    "turn.state",
  ],
  allowedRecoveryReads: ["control.effect_wal", "checkpoint.manifest"],
  forbiddenLiveReads: ["surface.tui_view"],
};

const CHECKPOINT_SNAPSHOT_CONTRACT: DataSubgraphContract = {
  id: "checkpoint_snapshot",
  layer: "platform",
  // Fact-grade alignment (track refactor-persistent-session-backplane, P1 /
  // requirement persistence-file-grades): the checkpoint snapshot owns ONLY
  // its declared vm durable subset (graded checkpoint_snapshot) — never the
  // History / LlmContext / ToolCall owned facts. Its recovery-time derived
  // index files (actors_by_key / actors_by_id / fibers_by_id and the derived
  // index set) are a rebuildable projection cache, declared as a derived node
  // graded derived_projection_cache so they can never be treated as a recovery
  // source of truth or live truth.
  ownedFactNodes: [
    { nodeId: "checkpoint.vm_durable_subset", grade: "checkpoint_snapshot" },
    { nodeId: "checkpoint.manifest", grade: "checkpoint_snapshot" },
    { nodeId: "checkpoint.known_good_marker", grade: "checkpoint_snapshot" },
  ],
  derivedNodes: [{ nodeId: "checkpoint.derived_index", grade: "derived_projection_cache" }],
  writeCommands: ["checkpoint.write_snapshot_at_safepoint"],
  readViews: ["checkpoint.recovery_view"],
  factStreams: [],
  projectionSinks: ["journal.diagnostics"],
  notOwnedHere: [
    "history.committed_messages",
    "llm_context.materialized_provider_context",
    "tool_call.result_attribution",
    "control.signal_payloads",
  ],
  allowedRecoveryReads: [],
  forbiddenLiveReads: [],
};

const SURFACE_PROJECTION_CONTRACT: DataSubgraphContract = {
  id: "surface_projection",
  layer: "surface",
  ownedFactNodes: [
    { nodeId: "surface.tui_view", grade: "surface_view" },
    { nodeId: "surface.actor_surface_lanes", grade: "surface_view" },
    { nodeId: "surface.session_picker_view", grade: "surface_view" },
  ],
  derivedNodes: [],
  /** Surfaces never expose domain write commands; input goes through domain protocols. */
  writeCommands: [],
  readViews: ["surface.rendered_view"],
  factStreams: [],
  projectionSinks: [],
  notOwnedHere: [
    "history.committed_messages",
    "llm_context.materialized_provider_context",
    "tool_call.result_attribution",
    "turn.state",
    "session.active_history_head",
  ],
  allowedRecoveryReads: [],
  forbiddenLiveReads: [],
};

const MEMBER_HOLON_DATA_CONTRACT: DataSubgraphContract = {
  id: "member_holon_data_components",
  layer: "domain",
  // Track refactor-ai-multi-agent-domain-integration, P1. Governs the runtime
  // state of the AI domain extension (member / holon / delegate+subagent) as a
  // single-writer data subgraph. The three owned facts mirror the real state
  // owners today — the member roster lives on the VM session state
  // (VmMemberRosterEntry records: member identity / role / lane), holon
  // governance lives on the actor (HolonActorState: autonomous vs leader_led,
  // memberIds, taskOwnership / routes), and detached tasks live on the VM
  // session state (VmDetachedActorRecord delegate/subagent task records). All
  // three are live runtime truth, single writer, so they are authoritative_fact.
  // Routing the ad-hoc write points onto the writeCommands belongs to P2.
  //
  // Not-Owned-Here is the load-bearing boundary of this track: member / holon /
  // delegate / subagent are an AI domain *extension* and must never own the
  // conversation-truth facts. It explicitly disowns the exact owned-fact nodes
  // of the History (history.committed_messages), LLM Context
  // (llm_context.materialized_provider_context), ToolCall
  // (tool_call.result_attribution) and TurnState (turn.state) contracts.
  ownedFactNodes: [
    { nodeId: "member.roster", grade: "authoritative_fact" },
    { nodeId: "holon.governance", grade: "authoritative_fact" },
    { nodeId: "detached.tasks", grade: "authoritative_fact" },
  ],
  derivedNodes: [],
  writeCommands: [
    "member_holon.upsert_roster_record",
    "member_holon.update_holon_governance",
    "member_holon.upsert_detached_task",
  ],
  readViews: [
    "member_holon.roster_view",
    "member_holon.holon_governance_view",
    "member_holon.detached_tasks_view",
  ],
  factStreams: ["member_holon.domain_events"],
  projectionSinks: ["surface.actor_surface_lanes", "journal.diagnostics"],
  notOwnedHere: [
    "history.committed_messages",
    "llm_context.materialized_provider_context",
    "tool_call.result_attribution",
    "turn.state",
  ],
  allowedRecoveryReads: ["checkpoint.vm_durable_subset"],
  forbiddenLiveReads: ["checkpoint.vm_durable_subset", "control.effect_wal", "surface.tui_view"],
};

export const AI_RUNTIME_DATA_SUBGRAPH_CONTRACTS: readonly DataSubgraphContract[] = [
  ACTOR_RUNTIME_CONTRACT,
  AI_TURN_STATE_CONTRACT,
  HISTORY_DOMAIN_CONTRACT,
  LLM_CONTEXT_DOMAIN_CONTRACT,
  SESSION_DOMAIN_CONTRACT,
  TOOL_CALL_DOMAIN_CONTRACT,
  PROVIDER_CALL_DOMAIN_CONTRACT,
  RUNTIME_CONTROL_CONTRACT,
  CHECKPOINT_SNAPSHOT_CONTRACT,
  SURFACE_PROJECTION_CONTRACT,
  ...AI_STAGE_COMPONENT_CONTRACTS,
  MEMBER_HOLON_DATA_CONTRACT,
];

export function createAiRuntimeDataSubgraphRegistry(): DataSubgraphContractRegistry {
  return createDataSubgraphContractRegistry([...AI_RUNTIME_DATA_SUBGRAPH_CONTRACTS]);
}

export type AiProviderContextAllowedInput = {
  componentId: AiRuntimeDataComponentId;
  readView: string;
};

/**
 * Rule one of the data plane: the next provider request may only be
 * materialized from these three inputs. Everything else — effect WAL,
 * checkpoint snapshots, journals, surface views — is a forbidden live source.
 */
export const AI_PROVIDER_CONTEXT_ALLOWED_INPUTS: readonly AiProviderContextAllowedInput[] = [
  { componentId: "llm_context_domain", readView: "llm_context.provider_request_view" },
  { componentId: "history_domain", readView: "history.active_tail" },
  { componentId: "session_domain", readView: "session.active_binding" },
];

/**
 * The single declared resolution rule for the active history head. No other
 * component may maintain its own head resolution logic.
 */
export const AI_SESSION_HISTORY_HEAD_RESOLUTION_PRIORITY = [
  "llm_context_prompt_target_reference",
  "session_declared_history_head",
] as const;

export type AiSessionHistoryHeadResolutionStep =
  (typeof AI_SESSION_HISTORY_HEAD_RESOLUTION_PRIORITY)[number];

export type AiProviderContextSource = {
  componentId: string;
  readView: string;
};

/**
 * Validates a provider-context materialization plan against rule one: every
 * source must be one of the declared allowed inputs. Returns one violation
 * message per illegal source; an empty array means the plan conforms.
 */
export function listAiProviderContextViolations(
  sources: readonly AiProviderContextSource[],
): string[] {
  const violations: string[] = [];
  for (const source of sources) {
    const allowed = AI_PROVIDER_CONTEXT_ALLOWED_INPUTS.some(
      (input) => input.componentId === source.componentId && input.readView === source.readView,
    );
    if (!allowed) {
      violations.push(
        `provider context source ${source.componentId}/${source.readView} is not an allowed input`,
      );
    }
  }
  return violations;
}

/**
 * Throws when a node is read as live truth even though its fact grade only
 * allows observation, recovery, or rebuild.
 */
export function assertAiRuntimeLiveReadAllowed(
  registry: DataSubgraphContractRegistry,
  nodeId: string,
): void {
  const grade = registry.classifyFactNode(nodeId);
  if (!grade) {
    throw new Error(`unknown runtime data node: ${nodeId}`);
  }
  if (!isLiveTruthCapableFactGrade(grade)) {
    throw new Error(`live read of ${nodeId} is forbidden: fact grade ${grade} is not live-truth capable`);
  }
}
