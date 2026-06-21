import type { AiAgentVm } from "@cell/ai-core-contract/runtime/AiAgentVm";
import type {
  AppendProviderSegmentInput,
  CompleteProviderCallInput,
  FailProviderCallInput,
  ProviderCallDomain,
  ProviderCallRecord,
  StartProviderCallInput,
} from "@cell/ai-core-contract/runtime/ProviderCallDomain";
import type { ProviderCallSegmentSet } from "@cell/ai-core-contract/runtime/ProviderCallDomain";
import { isTerminalProviderCallStatus } from "@cell/ai-core-contract/runtime/ProviderCallDomain";

/**
 * Per-vm runtime data implementing the {@link ProviderCallDomain} contract: a
 * `Map<provider_call_id, ProviderCallRecord>` with guarded lifecycle
 * transitions and the reasoning/content split accumulators.
 */
export type ProviderCallDomainRuntime = ProviderCallDomain & {
  readonly records: Map<string, ProviderCallRecord>;
};

function fail(message: string): never {
  throw new Error(`ProviderCallDomain: ${message}`);
}

function appendSegment(set: ProviderCallSegmentSet | undefined, input: AppendProviderSegmentInput): ProviderCallSegmentSet {
  const next = set ?? { text: "", segments: [] };
  next.segments.push({ startAt: input.startAt, endAt: input.endAt, text: input.text });
  next.text += input.text;
  return next;
}

export function createProviderCallDomainRuntime(): ProviderCallDomainRuntime {
  const records = new Map<string, ProviderCallRecord>();

  const require = (providerCallId: string): ProviderCallRecord => {
    const record = records.get(providerCallId);
    if (!record) {
      fail(`unknown provider_call_id "${providerCallId}"`);
    }
    return record;
  };

  const requireOpen = (providerCallId: string): ProviderCallRecord => {
    const record = require(providerCallId);
    if (isTerminalProviderCallStatus(record.status)) {
      fail(`provider_call_id "${providerCallId}" already terminal ("${record.status}")`);
    }
    return record;
  };

  const startProviderCall = (input: StartProviderCallInput): ProviderCallRecord => {
    if (records.has(input.providerCallId)) {
      fail(`duplicate provider_call_id "${input.providerCallId}"`);
    }
    const record: ProviderCallRecord = {
      providerCallId: input.providerCallId,
      actorKey: input.actorKey,
      turnId: input.turnId,
      modelRef: input.modelRef,
      modelParams: { ...input.modelParams },
      toolSchemas: input.toolSchemas.map((schema) => ({ ...schema })),
      promptGenerationRef: input.promptGenerationRef,
      startedAt: input.at,
      status: "started",
    };
    records.set(record.providerCallId, record);
    return record;
  };

  const recordFirstToken = (input: { providerCallId: string; at: number }): ProviderCallRecord => {
    const record = requireOpen(input.providerCallId);
    if (record.firstTokenAt === undefined) {
      record.firstTokenAt = input.at;
    }
    if (record.status === "started") {
      record.status = "streaming";
    }
    return record;
  };

  const appendReasoningSegment = (input: AppendProviderSegmentInput): ProviderCallRecord => {
    const record = requireOpen(input.providerCallId);
    record.reasoning = appendSegment(record.reasoning, input);
    if (record.status === "started") record.status = "streaming";
    return record;
  };

  const appendContentSegment = (input: AppendProviderSegmentInput): ProviderCallRecord => {
    const record = requireOpen(input.providerCallId);
    record.content = appendSegment(record.content, input);
    if (record.status === "started") record.status = "streaming";
    return record;
  };

  const completeProviderCall = (input: CompleteProviderCallInput): ProviderCallRecord => {
    const record = requireOpen(input.providerCallId);
    record.completedAt = input.completedAt;
    if (input.toolCallIds && input.toolCallIds.length) {
      record.toolCallIds = [...input.toolCallIds];
    }
    record.status = "completed";
    return record;
  };

  const failProviderCall = (input: FailProviderCallInput): ProviderCallRecord => {
    const record = requireOpen(input.providerCallId);
    record.completedAt = input.at;
    record.failureKind = input.failureKind;
    if (input.rawError !== undefined) {
      record.rawError = input.rawError;
    }
    record.status = "failed";
    return record;
  };

  return {
    records,
    startProviderCall,
    recordFirstToken,
    appendReasoningSegment,
    appendContentSegment,
    completeProviderCall,
    failProviderCall,
    getRecord: (providerCallId) => records.get(providerCallId),
    getActiveRecords: () => [...records.values()].filter((record) => !isTerminalProviderCallStatus(record.status)),
    getAllRecords: () => [...records.values()],
  };
}

export function ensureVmProviderCallDomain(vm: AiAgentVm): ProviderCallDomainRuntime {
  const current = vm.runtimeContext.providerCallDomain as ProviderCallDomainRuntime | null;
  if (current) {
    return current;
  }
  const created = createProviderCallDomainRuntime();
  vm.runtimeContext.providerCallDomain = created;
  return created;
}

export function getVmProviderCallDomain(vm: AiAgentVm): ProviderCallDomainRuntime | null {
  return (vm.runtimeContext.providerCallDomain as ProviderCallDomainRuntime | null) ?? null;
}

/**
 * Explicit reasoning-fact read (decision 5 / spec downstream-explicit-access):
 * downstream consumers — observability, TUI think card, MessageAssembly —
 * query the reasoning channel from the ProviderCallDomain via these accessors,
 * NOT via the implicit content-parts reasoning convention.
 */
export function getProviderReasoningFact(vm: AiAgentVm, providerCallId: string): ProviderCallSegmentSet | undefined {
  return getVmProviderCallDomain(vm)?.getRecord(providerCallId)?.reasoning;
}

export function getProviderContentFact(vm: AiAgentVm, providerCallId: string): ProviderCallSegmentSet | undefined {
  return getVmProviderCallDomain(vm)?.getRecord(providerCallId)?.content;
}

/** Latest recorded reasoning fact for an actor (the think card's read path). */
export function getLatestActorProviderReasoning(vm: AiAgentVm, actorKey: string): ProviderCallSegmentSet | undefined {
  const domain = getVmProviderCallDomain(vm);
  if (!domain) return undefined;
  const withReasoning = domain.getAllRecords().filter((record) => record.actorKey === actorKey && record.reasoning);
  return withReasoning.length ? withReasoning[withReasoning.length - 1].reasoning : undefined;
}

/**
 * Restore a per-vm ProviderCallDomain from persisted records (recovery).
 * Records are loaded directly in their already-final state.
 */
export function restoreVmProviderCallDomain(
  vm: AiAgentVm,
  records: readonly ProviderCallRecord[] | undefined | null,
): ProviderCallDomainRuntime {
  const runtime = createProviderCallDomainRuntime();
  for (const record of records ?? []) {
    if (record && typeof record.providerCallId === "string" && record.providerCallId) {
      runtime.records.set(record.providerCallId, { ...record });
    }
  }
  vm.runtimeContext.providerCallDomain = runtime;
  return runtime;
}
