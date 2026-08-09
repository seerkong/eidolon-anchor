import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { AiAgentVm } from "@cell/ai-core-contract/runtime/AiAgentVm";
import { defaultRuntimeConfig } from "@cell/ai-support";
import type {
  MarkExecutingInput,
  PlanToolInput,
  ReconstructedToolResult,
  RecordFailureInput,
  RecordGateDecisionInput,
  RecordResultInput,
  ToolCallDomain,
  ToolCallOutputArtifactRef,
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
  retain(policy?: ToolCallRetentionPolicy): ToolCallRetentionResult;
};

export type ToolCallRetentionPolicy = {
  terminalRecordLimit?: number;
};

export type ToolCallRetentionResult = {
  retainedActiveRecords: number;
  retainedTerminalRecords: number;
  prunedTerminalRecords: number;
  prunedToolCallIds: string[];
};

/**
 * Matches the normal microCompact recent-tool-result budget. The field vm
 * contained 4,008 records, so 20 is conservative while still bounding growth.
 */
export const DEFAULT_TOOL_CALL_TERMINAL_RETENTION_LIMIT = 20;

const defaultToolResultBudget = defaultRuntimeConfig().compact.microCompact.budget;
export const DEFAULT_TOOL_CALL_OUTPUT_EXTERNALIZATION_THRESHOLD_BYTES =
  defaultToolResultBudget.toolResultPersistThresholdBytes;
export const DEFAULT_TOOL_CALL_OUTPUT_PREVIEW_CHARS = defaultToolResultBudget.toolResultPreviewChars;

export type PrepareToolCallDomainSnapshotOptions = {
  sessionDir: string;
  terminalRecordLimit?: number;
  outputThresholdBytes?: number;
  outputPreviewChars?: number;
};

export type PrepareToolCallDomainSnapshotResult = {
  records: ToolCallRecord[];
  externalizedRecords: number;
  retention: ToolCallRetentionResult;
};

function fail(message: string): never {
  throw new Error(`ToolCallDomain: ${message}`);
}

function retentionTimestamp(record: ToolCallRecord): number {
  const timestamp = record.resultAt ?? record.executedAt ?? record.dispatchedAt ?? record.plannedAt;
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function compareToolCallIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sanitizeArtifactSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe.slice(0, 80) || "tool-result";
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function persistToolCallOutput(params: {
  sessionDir: string;
  record: ToolCallRecord;
  outputText: string;
  previewChars: number;
}): ToolCallOutputArtifactRef {
  const digestHex = sha256(params.outputText);
  const actorSegment = sanitizeArtifactSegment(params.record.actorKey);
  const fileName = `${sanitizeArtifactSegment(params.record.toolCallId)}-${digestHex.slice(0, 16)}.txt`;
  const assetId = path.posix.join("artifacts", "tool-results", actorSegment, fileName);
  const filePath = path.join(params.sessionDir, ...assetId.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(filePath, params.outputText, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== "EEXIST") throw error;
    const existing = fs.readFileSync(filePath, "utf8");
    if (Buffer.byteLength(existing, "utf8") !== Buffer.byteLength(params.outputText, "utf8") || sha256(existing) !== digestHex) {
      fail(`tool output artifact collision "${assetId}"`);
    }
  }
  return {
    kind: "artifact_ref",
    assetId,
    preview: params.outputText.slice(0, params.previewChars),
    size: Buffer.byteLength(params.outputText, "utf8"),
    digest: `sha256:${digestHex}`,
  };
}

function resolveToolCallArtifactPath(sessionDir: string, ref: ToolCallOutputArtifactRef): string {
  const normalized = path.posix.normalize(ref.assetId.replace(/\\/g, "/"));
  if (
    path.posix.isAbsolute(normalized)
    || normalized === ".."
    || normalized.startsWith("../")
    || !normalized.startsWith("artifacts/tool-results/")
  ) {
    fail(`invalid tool output artifact assetId "${ref.assetId}"`);
  }
  return path.join(sessionDir, ...normalized.split("/"));
}

export function readToolCallRecordOutputText(
  record: ToolCallRecord,
  params: { sessionDir?: string } = {},
): string {
  if (typeof record.outputText === "string") return record.outputText;
  const ref = record.outputTextRef;
  if (!ref) return "";
  if (!params.sessionDir) {
    fail(`sessionDir is required to resolve tool output artifact "${ref.assetId}"`);
  }
  const outputText = fs.readFileSync(resolveToolCallArtifactPath(params.sessionDir, ref), "utf8");
  const size = Buffer.byteLength(outputText, "utf8");
  const digest = `sha256:${sha256(outputText)}`;
  if (size !== ref.size || digest !== ref.digest) {
    fail(`tool output artifact integrity mismatch "${ref.assetId}"`);
  }
  return outputText;
}

export function prepareToolCallDomainRecordsForSnapshot(
  domain: ToolCallDomain,
  options: PrepareToolCallDomainSnapshotOptions,
): PrepareToolCallDomainSnapshotResult {
  const outputThresholdBytes = options.outputThresholdBytes
    ?? DEFAULT_TOOL_CALL_OUTPUT_EXTERNALIZATION_THRESHOLD_BYTES;
  const outputPreviewChars = options.outputPreviewChars ?? DEFAULT_TOOL_CALL_OUTPUT_PREVIEW_CHARS;
  if (!Number.isSafeInteger(outputThresholdBytes) || outputThresholdBytes < 0) {
    fail(`outputThresholdBytes must be a non-negative safe integer (received ${outputThresholdBytes})`);
  }
  if (!Number.isSafeInteger(outputPreviewChars) || outputPreviewChars < 0) {
    fail(`outputPreviewChars must be a non-negative safe integer (received ${outputPreviewChars})`);
  }

  const persisted = createToolCallDomainRuntime();
  for (const record of domain.getAllRecords()) {
    persisted.records.set(record.toolCallId, {
      ...record,
      ...(record.outputTextRef ? { outputTextRef: { ...record.outputTextRef } } : {}),
    });
  }
  const retention = persisted.retain({ terminalRecordLimit: options.terminalRecordLimit });
  let externalizedRecords = 0;
  for (const record of persisted.records.values()) {
    const outputText = record.outputText;
    if (typeof outputText !== "string" || Buffer.byteLength(outputText, "utf8") <= outputThresholdBytes) continue;
    record.outputTextRef = persistToolCallOutput({
      sessionDir: options.sessionDir,
      record,
      outputText,
      previewChars: outputPreviewChars,
    });
    delete record.outputText;
    externalizedRecords += 1;
  }
  return { records: persisted.getAllRecords(), externalizedRecords, retention };
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

  const retain = (policy: ToolCallRetentionPolicy = {}): ToolCallRetentionResult => {
    const terminalRecordLimit = policy.terminalRecordLimit ?? DEFAULT_TOOL_CALL_TERMINAL_RETENTION_LIMIT;
    if (!Number.isSafeInteger(terminalRecordLimit) || terminalRecordLimit < 0) {
      fail(`terminalRecordLimit must be a non-negative safe integer (received ${terminalRecordLimit})`);
    }

    const activeRecords: ToolCallRecord[] = [];
    const terminalRecords: ToolCallRecord[] = [];
    for (const record of records.values()) {
      (isTerminalToolCallStatus(record.status) ? terminalRecords : activeRecords).push(record);
    }

    const retainedTerminalIds = new Set(
      terminalRecords
        .slice()
        .sort((left, right) => {
          const terminalOrder = retentionTimestamp(right) - retentionTimestamp(left);
          if (terminalOrder !== 0) return terminalOrder;
          const planOrder = right.plannedAt - left.plannedAt;
          if (planOrder !== 0) return planOrder;
          return compareToolCallIds(left.toolCallId, right.toolCallId);
        })
        .slice(0, terminalRecordLimit)
        .map((record) => record.toolCallId),
    );

    const prunedToolCallIds: string[] = [];
    for (const record of terminalRecords) {
      if (!retainedTerminalIds.has(record.toolCallId)) {
        records.delete(record.toolCallId);
        prunedToolCallIds.push(record.toolCallId);
      }
    }

    return {
      retainedActiveRecords: activeRecords.length,
      retainedTerminalRecords: retainedTerminalIds.size,
      prunedTerminalRecords: prunedToolCallIds.length,
      prunedToolCallIds,
    };
  };

  return {
    records,
    planTool,
    recordGateDecision,
    markExecuting,
    recordResult,
    recordFailure,
    retain,
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
  params: { actorKey: string; sessionDir?: string },
): ReconstructedToolResult[] {
  return domain
    .getAllRecords()
    .filter((record) => record.actorKey === params.actorKey)
    .filter((record) => record.status === "completed" || record.status === "failed")
    .sort((a, b) => a.plannedAt - b.plannedAt)
    .map((record) => ({
      toolCallId: record.toolCallId,
      funcName: record.funcName,
      outputText: readToolCallRecordOutputText(record, params),
      isError: record.status === "failed",
      ...(record.failureKind ? { failureKind: record.failureKind } : {}),
    }));
}
