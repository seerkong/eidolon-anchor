import type { AiAgentVm } from "@cell/ai-core-contract/runtime/AiAgentVm";
import type {
  MarkExecutingInput,
  PlanToolInput,
  ReconstructedToolResult,
  RecordFailureInput,
  RecordGateDecisionInput,
  RecordResultInput,
  ToolCallDomain,
  ToolCallRecord,
} from "@cell/ai-core-contract/runtime/ToolCallDomain";
import { isTerminalToolCallStatus } from "@cell/ai-core-contract/runtime/ToolCallDomain";

/**
 * Per-vm runtime data implementing the {@link ToolCallDomain} contract: a
 * `Map<tool_call_id, ToolCallRecord>` with guarded lifecycle transitions.
 * See `@cell/ai-core-contract/runtime/ToolCallDomain` for the invariants.
 */
export type ToolCallDomainRuntime = ToolCallDomain & {
  readonly records: Map<string, ToolCallRecord>;
};

function fail(message: string): never {
  throw new Error(`ToolCallDomain: ${message}`);
}

export function createToolCallDomainRuntime(): ToolCallDomainRuntime {
  const records = new Map<string, ToolCallRecord>();

  const require = (toolCallId: string): ToolCallRecord => {
    const record = records.get(toolCallId);
    if (!record) {
      fail(`unknown tool_call_id "${toolCallId}"`);
    }
    return record;
  };

  const planTool = (input: PlanToolInput): ToolCallRecord => {
    if (records.has(input.toolCallId)) {
      // Root-cause defense (replaces the retired supervisor): the same
      // tool_call_id must never be planned — hence consumed — twice.
      fail(`duplicate tool_call_id "${input.toolCallId}"`);
    }
    const record: ToolCallRecord = {
      toolCallId: input.toolCallId,
      actorKey: input.actorKey,
      turnId: input.turnId,
      funcName: input.funcName,
      args: input.args,
      plannedAt: input.at,
      status: "planned",
    };
    records.set(record.toolCallId, record);
    return record;
  };

  const recordGateDecision = (input: RecordGateDecisionInput): ToolCallRecord => {
    const record = require(input.toolCallId);
    if (record.status !== "planned" && record.status !== "deferred") {
      fail(`cannot gate tool_call_id "${input.toolCallId}" in status "${record.status}"`);
    }
    record.dispatchedAt = input.at;
    record.gateOutcome = input.gateOutcome;
    record.status = input.gateOutcome === "deny" ? "denied" : input.gateOutcome === "defer" ? "deferred" : "dispatched";
    return record;
  };

  const markExecuting = (input: MarkExecutingInput): ToolCallRecord => {
    const record = require(input.toolCallId);
    if (record.status !== "dispatched") {
      fail(`cannot execute tool_call_id "${input.toolCallId}" in status "${record.status}"`);
    }
    record.executedAt = input.at;
    record.status = "executing";
    return record;
  };

  const recordResult = (input: RecordResultInput): ToolCallRecord => {
    const record = require(input.toolCallId);
    if (isTerminalToolCallStatus(record.status)) {
      fail(`tool_call_id "${input.toolCallId}" already terminal ("${record.status}") — result rejected`);
    }
    if (record.status !== "executing") {
      fail(`cannot result tool_call_id "${input.toolCallId}" in status "${record.status}"`);
    }
    record.resultAt = input.at;
    record.outputText = input.outputText;
    record.status = "completed";
    return record;
  };

  const recordFailure = (input: RecordFailureInput): ToolCallRecord => {
    const record = require(input.toolCallId);
    if (isTerminalToolCallStatus(record.status)) {
      fail(`tool_call_id "${input.toolCallId}" already terminal ("${record.status}") — failure rejected`);
    }
    if (record.status !== "executing" && record.status !== "dispatched") {
      fail(`cannot fail tool_call_id "${input.toolCallId}" in status "${record.status}"`);
    }
    record.resultAt = input.at;
    record.failureKind = input.failureKind;
    if (input.outputText !== undefined) {
      record.outputText = input.outputText;
    }
    record.status = "failed";
    return record;
  };

  return {
    records,
    planTool,
    recordGateDecision,
    markExecuting,
    recordResult,
    recordFailure,
    getRecord: (toolCallId) => records.get(toolCallId),
    getActiveRecords: () => [...records.values()].filter((record) => !isTerminalToolCallStatus(record.status)),
    getAllRecords: () => [...records.values()],
  };
}

/**
 * Lazily create + attach the per-vm ToolCallDomain runtime. Idempotent; the
 * domain lives for the vm's lifetime at `vm.runtimeContext.toolCallDomain`.
 */
export function ensureVmToolCallDomain(vm: AiAgentVm): ToolCallDomainRuntime {
  const current = vm.runtimeContext.toolCallDomain as ToolCallDomainRuntime | null;
  if (current) {
    return current;
  }
  const created = createToolCallDomainRuntime();
  vm.runtimeContext.toolCallDomain = created;
  return created;
}

export function getVmToolCallDomain(vm: AiAgentVm): ToolCallDomainRuntime | null {
  return (vm.runtimeContext.toolCallDomain as ToolCallDomainRuntime | null) ?? null;
}

/**
 * Restore a per-vm ToolCallDomain from persisted records (recovery). Records
 * are loaded directly into the map in their already-final state (bypassing the
 * lifecycle guards, which only apply to live transitions).
 */
export function restoreVmToolCallDomain(
  vm: AiAgentVm,
  records: readonly ToolCallRecord[] | undefined | null,
): ToolCallDomainRuntime {
  const runtime = createToolCallDomainRuntime();
  for (const record of records ?? []) {
    if (record && typeof record.toolCallId === "string" && record.toolCallId) {
      runtime.records.set(record.toolCallId, { ...record });
    }
  }
  vm.runtimeContext.toolCallDomain = runtime;
  return runtime;
}

/**
 * Recovery rebuild: reconstruct the tool-result messages for an actor from the
 * domain's completed/failed records (in plan order) rather than from
 * runtime-control effect evidence payloads (decision D3). Active and gate-only
 * (deferred) records produce no result.
 */
export function reconstructToolResultsFromDomain(
  domain: ToolCallDomain,
  params: { actorKey: string },
): ReconstructedToolResult[] {
  return domain
    .getAllRecords()
    .filter((record) => record.actorKey === params.actorKey)
    .filter((record) => record.status === "completed" || record.status === "failed")
    .sort((a, b) => a.plannedAt - b.plannedAt)
    .map((record) => ({
      toolCallId: record.toolCallId,
      funcName: record.funcName,
      outputText: record.outputText ?? "",
      isError: record.status === "failed",
    }));
}
