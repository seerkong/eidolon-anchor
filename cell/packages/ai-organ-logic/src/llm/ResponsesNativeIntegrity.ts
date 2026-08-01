import { createHash } from "node:crypto";
import type {
  ResponsesCallLineageDecision,
  ResponsesCallLineageProof,
  ResponsesNativeItem,
  ResponsesNativeOutputCompletenessDecision,
  ResponsesNativeOutputCompletenessProof,
  ResponsesNativeOutputEvidence,
  ResponsesNativeOutputEvidenceItem,
  ResponsesProviderOutputSnapshot,
} from "@cell/ai-organ-contract/llm/ResponsesReplay";

type JsonRecord = Record<string, unknown>;

const SHA256_DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;

function isRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalize(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : { $number: String(value) };
  if (typeof value === "undefined") return { $undefined: true };
  if (typeof value !== "object") throw new TypeError(`Unsupported integrity value: ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError("Cannot inspect cyclic Responses evidence");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => normalize(item, ancestors));
    return Object.fromEntries(
      Object.keys(value as JsonRecord)
        .sort()
        .map((key) => [key, normalize((value as JsonRecord)[key], ancestors)]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value, new Set()));
}

function digest(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256").update(domain).update("\0").update(stableJson(value)).digest("base64url")}`;
}

function cloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze)) as T;
  if (isRecord(value)) {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneAndFreeze(item)]),
    )) as T;
  }
  return value;
}

function isNativeItem(value: unknown): value is ResponsesNativeItem {
  if (!isRecord(value)) return false;
  try {
    stableJson(value);
    return true;
  } catch {
    return false;
  }
}

function itemComparisonView(item: ResponsesNativeItem): unknown {
  if (item.type === "function_call") {
    return {
      type: item.type,
      id: item.id,
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments ?? "",
    };
  }
  const { status: _status, ...rest } = item;
  return rest;
}

function itemsMatch(left: readonly ResponsesNativeItem[], right: readonly ResponsesNativeItem[]): boolean {
  return stableJson(left.map(itemComparisonView)) === stableJson(right.map(itemComparisonView));
}

type EvidenceSequence =
  | { valid: true; items: ResponsesNativeItem[] }
  | { valid: false };

function orderEvidenceItems(entries: readonly ResponsesNativeOutputEvidenceItem[]): EvidenceSequence {
  if (entries.length === 0) return { valid: true, items: [] };
  if (!entries.every((entry) => isRecord(entry) && isNativeItem(entry.item))) return { valid: false };
  const indexed = entries.filter((entry) => entry.outputIndex !== undefined);
  if (indexed.length !== 0 && indexed.length !== entries.length) return { valid: false };
  if (indexed.length === 0) return { valid: true, items: entries.map((entry) => entry.item) };

  const seen = new Set<number>();
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.outputIndex) || (entry.outputIndex as number) < 0) return { valid: false };
    if (seen.has(entry.outputIndex as number)) return { valid: false };
    seen.add(entry.outputIndex as number);
  }
  const ordered = [...entries].sort((left, right) => left.outputIndex! - right.outputIndex!);
  if (ordered.some((entry, index) => entry.outputIndex !== index)) return { valid: false };
  return { valid: true, items: ordered.map((entry) => entry.item) };
}

function rebuildAddedItems(evidence: ResponsesNativeOutputEvidence): EvidenceSequence {
  const functionCallEntries = evidence.addedItems.filter((entry) => entry.item?.type === "function_call");
  const ordered = orderEvidenceItems(functionCallEntries.map((entry, index) => ({
    ...entry,
    outputIndex: index,
  })));
  if (!ordered.valid) return ordered;
  const byId = new Map<string, JsonRecord>();
  const rebuilt = ordered.items.map((item) => {
    const clone = structuredClone(item) as JsonRecord;
    if (clone.type === "function_call" && typeof clone.id === "string" && clone.id) {
      byId.set(clone.id, clone);
    }
    return clone;
  });
  for (const delta of evidence.functionCallArgumentDeltas) {
    if (!isRecord(delta) || typeof delta.itemId !== "string" || typeof delta.delta !== "string") {
      return { valid: false };
    }
    const item = byId.get(delta.itemId);
    if (!item) return { valid: false };
    item.arguments = `${typeof item.arguments === "string" ? item.arguments : ""}${delta.delta}`;
  }
  return { valid: true, items: rebuilt };
}

function nonEmptyItemIdentity(item: ResponsesNativeItem): string | undefined {
  if (typeof item.id !== "string") return undefined;
  const id = item.id.trim();
  return id || undefined;
}

function nonEmptyItemType(item: ResponsesNativeItem): string | undefined {
  if (typeof item.type !== "string") return undefined;
  const type = item.type.trim();
  return type || undefined;
}

/**
 * Reconstruct an empty terminal output only when the event stream is a
 * self-contained proof: both added and terminal-done cover the same continuous
 * indexes, identities remain stable, and function argument deltas reach the
 * exact terminal item.
 */
function reconstructIndexedEventItems(
  evidence: ResponsesNativeOutputEvidence,
): EvidenceSequence {
  if (evidence.addedItems.length === 0 || evidence.doneItems.length === 0) {
    return { valid: false };
  }
  if (evidence.addedItems.length !== evidence.doneItems.length) {
    return { valid: false };
  }
  if (
    !evidence.addedItems.every((entry) => Number.isSafeInteger(entry.outputIndex) && entry.outputIndex! >= 0)
    || !evidence.doneItems.every((entry) => Number.isSafeInteger(entry.outputIndex) && entry.outputIndex! >= 0)
  ) {
    return { valid: false };
  }

  const added = orderEvidenceItems(evidence.addedItems);
  const done = orderEvidenceItems(evidence.doneItems);
  if (!added.valid || !done.valid || added.items.length !== done.items.length) {
    return { valid: false };
  }

  const rebuiltAdded = added.items.map((item) => structuredClone(item) as JsonRecord);
  const functionCallsByItemId = new Map<string, JsonRecord>();
  const seenItemIds = new Set<string>();
  for (let index = 0; index < rebuiltAdded.length; index += 1) {
    const initial = rebuiltAdded[index];
    const terminal = done.items[index];
    const initialId = nonEmptyItemIdentity(initial);
    const terminalId = nonEmptyItemIdentity(terminal);
    const initialType = nonEmptyItemType(initial);
    const terminalType = nonEmptyItemType(terminal);
    if (
      !initialId
      || !terminalId
      || initialId !== terminalId
      || !initialType
      || initialType !== terminalType
      || seenItemIds.has(initialId)
    ) return { valid: false };
    seenItemIds.add(initialId);

    if (initialType === "function_call") {
      const initialCallId = callId(initial);
      const terminalCallId = callId(terminal);
      if (!initialCallId || initialCallId !== terminalCallId) return { valid: false };
      if (
        typeof initial.name !== "string"
        || !initial.name.trim()
        || initial.name !== terminal.name
      ) return { valid: false };
      functionCallsByItemId.set(initialId, initial);
    }
  }

  for (const delta of evidence.functionCallArgumentDeltas) {
    if (!isRecord(delta) || typeof delta.itemId !== "string" || !delta.itemId.trim() || typeof delta.delta !== "string") {
      return { valid: false };
    }
    const item = functionCallsByItemId.get(delta.itemId);
    if (!item) return { valid: false };
    item.arguments = `${typeof item.arguments === "string" ? item.arguments : ""}${delta.delta}`;
  }

  for (let index = 0; index < rebuiltAdded.length; index += 1) {
    if (rebuiltAdded[index].type === "function_call" && !itemsMatch([rebuiltAdded[index]], [done.items[index]])) {
      return { valid: false };
    }
  }

  const lineage = decideResponsesCallLineage(done.items);
  if (lineage.status !== "valid") return { valid: false };
  return { valid: true, items: done.items };
}

function evidenceMatchesFinalItems(params: {
  finalItems: readonly ResponsesNativeItem[];
  entries: readonly ResponsesNativeOutputEvidenceItem[];
  evidenceItems: readonly ResponsesNativeItem[];
}): boolean {
  if (params.evidenceItems.length === 0) return true;
  if (params.evidenceItems.length !== params.entries.length) return false;
  const allIndexed = params.entries.every((entry) => Number.isSafeInteger(entry.outputIndex) && entry.outputIndex! >= 0);
  if (allIndexed) {
    return params.evidenceItems.every((item, index) => {
      const finalItem = params.finalItems[params.entries[index].outputIndex!];
      return Boolean(finalItem) && itemsMatch([finalItem], [item]);
    });
  }
  return params.evidenceItems.every((item) => params.finalItems.some((finalItem) => itemsMatch([finalItem], [item])));
}

function incomplete(
  reason: Extract<ResponsesNativeOutputCompletenessDecision, { status: "incomplete" }>['reason'],
): ResponsesNativeOutputCompletenessDecision {
  return Object.freeze({
    schemaVersion: 1,
    kind: "responses_native_output_completeness_decision",
    status: "incomplete",
    reason,
  });
}

function complete(params: {
  responseId: string;
  items: readonly ResponsesNativeItem[];
  source: ResponsesNativeOutputCompletenessProof["source"];
  evidence: ResponsesNativeOutputEvidence;
}): ResponsesNativeOutputCompletenessDecision {
  const completenessProof: ResponsesNativeOutputCompletenessProof = Object.freeze({
    schemaVersion: 1,
    kind: "responses_native_output_completeness_proof",
    status: "complete",
    source: params.source,
    evidenceDigest: digest("responses-native-output-evidence-v1", params.evidence),
  });
  const output: ResponsesProviderOutputSnapshot = Object.freeze({
    schemaVersion: 2,
    kind: "responses_provider_output_snapshot",
    ...(params.responseId ? { responseId: params.responseId } : {}),
    items: cloneAndFreeze([...params.items]),
    completenessProof,
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: "responses_native_output_completeness_decision",
    status: "complete",
    output,
  });
}

export function decideResponsesNativeOutputCompleteness(
  evidence: ResponsesNativeOutputEvidence,
): ResponsesNativeOutputCompletenessDecision {
  try {
    if (
      !isRecord(evidence)
      || evidence.schemaVersion !== 1
      || evidence.kind !== "responses_native_output_evidence"
      || typeof evidence.responseId !== "string"
      || !evidence.responseId.trim()
      || !isRecord(evidence.completedOutput)
      || typeof evidence.completedOutput.observed !== "boolean"
      || !Array.isArray(evidence.completedOutput.items)
      || !evidence.completedOutput.items.every(isNativeItem)
      || !Array.isArray(evidence.addedItems)
      || !Array.isArray(evidence.doneItems)
      || !Array.isArray(evidence.functionCallArgumentDeltas)
    ) return incomplete("invalid_evidence");

    const added = rebuildAddedItems(evidence);
    const done = orderEvidenceItems(evidence.doneItems);
    if (!added.valid || !done.valid) return incomplete("indexed_output_conflict");

    const completed = evidence.completedOutput.items;
    if (evidence.completedOutput.observed) {
      if (completed.length === 0) {
        const reconstructed = reconstructIndexedEventItems(evidence);
        if (!reconstructed.valid) return incomplete("terminal_output_conflict");
        return complete({
          responseId: evidence.responseId.trim(),
          items: reconstructed.items,
          source: "reconstructed_event_items",
          evidence,
        });
      }
      if (!evidenceMatchesFinalItems({
        finalItems: completed,
        entries: evidence.doneItems,
        evidenceItems: done.items,
      })) {
        return incomplete("terminal_output_conflict");
      }
      const functionCallAddedEntries = evidence.addedItems.filter((entry) => entry.item?.type === "function_call");
      if (!evidenceMatchesFinalItems({
        finalItems: completed,
        entries: functionCallAddedEntries,
        evidenceItems: added.items,
      })) {
        return incomplete("terminal_output_conflict");
      }
      return complete({
        responseId: evidence.responseId.trim(),
        items: completed,
        source: "completed_output",
        evidence,
      });
    }

    const reconstructed = reconstructIndexedEventItems(evidence);
    if (!reconstructed.valid) return incomplete("indexed_output_conflict");
    return complete({
      responseId: evidence.responseId.trim(),
      items: reconstructed.items,
      source: "indexed_done_items",
      evidence,
    });
  } catch {
    return incomplete("invalid_evidence");
  }
}

export function createResponsesProviderOutputSnapshot(params: {
  responseId?: string;
  items: readonly ResponsesNativeItem[];
}): ResponsesProviderOutputSnapshot {
  const decision = decideResponsesNativeOutputCompleteness({
    schemaVersion: 1,
    kind: "responses_native_output_evidence",
    responseId: params.responseId ?? "fixture-response",
    completedOutput: { observed: true, items: params.items },
    addedItems: [],
    doneItems: [],
    functionCallArgumentDeltas: [],
  });
  if (decision.status !== "complete") throw new TypeError("Invalid Responses provider output snapshot");
  if (!params.responseId) {
    const { responseId: _responseId, ...withoutResponseId } = decision.output;
    return Object.freeze(withoutResponseId);
  }
  return decision.output;
}

export function isValidResponsesNativeOutputCompletenessProof(
  value: unknown,
): value is ResponsesNativeOutputCompletenessProof {
  return isRecord(value)
    && value.schemaVersion === 1
    && value.kind === "responses_native_output_completeness_proof"
    && value.status === "complete"
    && (
      value.source === "completed_output"
      || value.source === "indexed_done_items"
      || value.source === "reconstructed_event_items"
    )
    && typeof value.evidenceDigest === "string"
    && SHA256_DIGEST_PATTERN.test(value.evidenceDigest);
}

export function isValidResponsesProviderOutputSnapshot(
  value: unknown,
): value is ResponsesProviderOutputSnapshot {
  return isRecord(value)
    && Object.keys(value).every((key) => ["schemaVersion", "kind", "responseId", "items", "completenessProof"].includes(key))
    && value.schemaVersion === 2
    && value.kind === "responses_provider_output_snapshot"
    && (!("responseId" in value) || (typeof value.responseId === "string" && value.responseId.length > 0))
    && Array.isArray(value.items)
    && value.items.every(isNativeItem)
    && isValidResponsesNativeOutputCompletenessProof(value.completenessProof);
}

function callId(item: ResponsesNativeItem): string {
  return typeof item.call_id === "string" ? item.call_id.trim() : "";
}

export function decideResponsesCallLineage(
  items: readonly ResponsesNativeItem[],
): ResponsesCallLineageDecision {
  const calls = new Set<string>();
  const outputs = new Set<string>();
  const futureCalls = new Set(
    items.filter((item) => item?.type === "function_call").map(callId).filter(Boolean),
  );
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const item = items[itemIndex];
    if (!isNativeItem(item)) {
      return Object.freeze({
        schemaVersion: 1,
        kind: "responses_call_lineage_decision",
        status: "invalid",
        reason: "empty_call_id",
        itemIndex,
      });
    }
    if (item.type === "function_call") {
      const id = callId(item);
      if (!id) return Object.freeze({ schemaVersion: 1, kind: "responses_call_lineage_decision", status: "invalid", reason: "empty_call_id", itemIndex });
      futureCalls.delete(id);
      if (calls.has(id)) return Object.freeze({ schemaVersion: 1, kind: "responses_call_lineage_decision", status: "invalid", reason: "duplicate_function_call", itemIndex, callId: id });
      calls.add(id);
    } else if (item.type === "function_call_output") {
      const id = callId(item);
      if (!id) return Object.freeze({ schemaVersion: 1, kind: "responses_call_lineage_decision", status: "invalid", reason: "empty_call_id", itemIndex });
      if (outputs.has(id)) return Object.freeze({ schemaVersion: 1, kind: "responses_call_lineage_decision", status: "invalid", reason: "duplicate_function_call_output", itemIndex, callId: id });
      if (!calls.has(id)) {
        return Object.freeze({
          schemaVersion: 1,
          kind: "responses_call_lineage_decision",
          status: "invalid",
          reason: futureCalls.has(id) ? "out_of_order_function_call_output" : "orphan_function_call_output",
          itemIndex,
          callId: id,
        });
      }
      outputs.add(id);
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: "responses_call_lineage_proof",
    status: "valid",
    itemCount: items.length,
    lineageDigest: digest("responses-call-lineage-v1", items),
  });
}

export function isValidResponsesCallLineageProof(
  value: unknown,
  items: readonly ResponsesNativeItem[],
): value is ResponsesCallLineageProof {
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== "responses_call_lineage_proof"
    || value.status !== "valid"
    || value.itemCount !== items.length
    || typeof value.lineageDigest !== "string"
    || !SHA256_DIGEST_PATTERN.test(value.lineageDigest)
  ) return false;
  const decision = decideResponsesCallLineage(items);
  return decision.status === "valid" && decision.lineageDigest === value.lineageDigest;
}

export class ResponsesRequestLineageError extends Error {
  readonly decision: Extract<ResponsesCallLineageDecision, { status: "invalid" }>;

  constructor(decision: Extract<ResponsesCallLineageDecision, { status: "invalid" }>) {
    super(`Invalid Responses request lineage: ${decision.reason}${decision.callId ? ` (${decision.callId})` : ""}`);
    this.name = "ResponsesRequestLineageError";
    this.decision = decision;
  }
}
