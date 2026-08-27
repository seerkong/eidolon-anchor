import { createHash } from "node:crypto";

import type { ProviderEpochProfileId, ProviderEpochReceipt } from "@cell/ai-organ-contract";

export type ProviderEpochProjectionDiagnostic = Readonly<{
  code:
    | "provider_epoch_pending_delivery_incompatible"
    | "provider_epoch_receipt_incompatible";
  path: string;
  valueKind: "digest_mismatch" | "missing_pair" | "missing_reasoning";
}>;

export class ProviderEpochProjectionError extends Error {
  readonly diagnostic: ProviderEpochProjectionDiagnostic;

  constructor(diagnostic: ProviderEpochProjectionDiagnostic) {
    super(diagnostic.code);
    this.name = "ProviderEpochProjectionError";
    this.diagnostic = Object.freeze({ ...diagnostic });
  }
}

function toolCalls(message: any): any[] {
  return Array.isArray(message?.tool_calls)
    ? message.tool_calls
    : Array.isArray(message?.toolCalls)
      ? message.toolCalls
      : [];
}

function toolCallId(message: any): string {
  return String(message?.tool_call_id ?? message?.toolCallId ?? "").trim();
}

function callId(call: any): string {
  return String(call?.id ?? "").trim();
}

function digest(domain: string, value: unknown): `sha256:${string}` {
  const json = JSON.stringify(value);
  return `sha256:${createHash("sha256").update(domain).update("\0").update(json).digest("hex")}`;
}

function messageOccurredAtMs(message: any): number | null {
  for (const value of [message?.endAt, message?.startAt, message?.createdAt, message?.created_at]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      return typeof record.text === "string"
        ? record.text
        : typeof record.content === "string"
          ? record.content
          : "";
    })
    .filter(Boolean)
    .join("\n");
}

function truncate(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  return `${value.slice(0, maxCharacters)}\n[truncated provider-epoch handoff]`;
}

function boundNeutralHistory(messages: any[]): any[] {
  const selected: any[] = [];
  let remainingCharacters = 12_000;
  for (let index = messages.length - 1; index >= 0 && selected.length < 20 && remainingCharacters > 0; index -= 1) {
    const message = messages[index];
    const text = contentText(message?.content);
    const structuralPendingPair = message?.role === "tool" || toolCalls(message).length > 0;
    if (!text && !structuralPendingPair) continue;
    if (!text) {
      selected.push({ ...message });
      continue;
    }
    const bounded = truncate(text, Math.min(2_000, remainingCharacters));
    remainingCharacters -= bounded.length;
    selected.push({ ...message, content: bounded });
  }
  return selected.reverse();
}

function normalizedToolCalls(message: any): any[] {
  return toolCalls(message).map((call) => ({
    id: callId(call),
    type: typeof call?.type === "string" ? call.type : "function",
    function: {
      name: typeof call?.function?.name === "string" ? call.function.name : "",
      arguments: typeof call?.function?.arguments === "string" ? call.function.arguments : "",
    },
  }));
}

function canonicalSourceMessage(message: any): Record<string, unknown> {
  const role = typeof message?.role === "string" ? message.role : "";
  const canonical: Record<string, unknown> = {
    role,
    content: contentText(message?.content),
  };
  if (typeof message?.name === "string") canonical.name = message.name;
  const reasoning = typeof message?.reasoning_content === "string"
    ? message.reasoning_content
    : typeof message?.reasoningContent === "string"
      ? message.reasoningContent
      : null;
  if (reasoning !== null) canonical.reasoning_content = reasoning;
  const calls = normalizedToolCalls(message);
  if (calls.length > 0) canonical.tool_calls = calls;
  const resultId = toolCallId(message);
  if (resultId) canonical.tool_call_id = resultId;
  return canonical;
}

function projectHandoff(params: {
  messages: readonly any[];
  targetProfileId: ProviderEpochProfileId;
  createdAt: string;
  sourceMessageCount?: number;
  pendingToolCallIds: readonly string[];
}): Readonly<{
  bounded: any[];
  currentMessages: any[];
  sourceMessages: ReadonlyArray<Record<string, unknown>>;
}> {
  const cutoff = Date.parse(params.createdAt);
  const pending = new Set(params.pendingToolCallIds.filter(Boolean));
  const assistantByCallId = new Map<string, any>();
  const resultByCallId = new Map<string, any>();
  for (const message of params.messages) {
    if (message?.role === "assistant") {
      for (const call of toolCalls(message)) {
        const id = callId(call);
        if (id) assistantByCallId.set(id, message);
      }
    } else if (message?.role === "tool") {
      const id = toolCallId(message);
      if (id) resultByCallId.set(id, message);
    }
  }

  for (const id of pending) {
    const assistant = assistantByCallId.get(id);
    if (!assistant || !resultByCallId.has(id)) {
      throw new ProviderEpochProjectionError({
        code: "provider_epoch_pending_delivery_incompatible",
        path: `/tool-deliveries/${id}`,
        valueKind: "missing_pair",
      });
    }
    if (
      params.targetProfileId === "deepseek-official-chat@1"
      && typeof assistant.reasoning_content !== "string"
      && typeof assistant.reasoningContent !== "string"
    ) {
      throw new ProviderEpochProjectionError({
        code: "provider_epoch_pending_delivery_incompatible",
        path: `/tool-deliveries/${id}/assistant/reasoning_content`,
        valueKind: "missing_reasoning",
      });
    }
  }

  const sourceMessages: Array<Record<string, unknown>> = [];
  const neutralHistory: any[] = [];
  const currentMessages: any[] = [];
  let nonSystemMessageIndex = 0;
  for (const message of params.messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "system" || message.role === "developer") {
      currentMessages.push(message);
      continue;
    }
    const occurredAt = messageOccurredAtMs(message);
    const belongsToSourceFrontier = params.sourceMessageCount === undefined
      ? !Number.isFinite(cutoff) || occurredAt === null || occurredAt <= cutoff
      : nonSystemMessageIndex < params.sourceMessageCount;
    nonSystemMessageIndex += 1;
    if (!belongsToSourceFrontier) {
      currentMessages.push(message);
      continue;
    }

    sourceMessages.push(canonicalSourceMessage(message));
    if (message.role === "assistant" && toolCalls(message).length > 0) {
      const pendingCalls = normalizedToolCalls(message).filter((call) => pending.has(call.id));
      if (pendingCalls.length > 0) {
        const projected: Record<string, unknown> = {
          role: "assistant",
          content: contentText(message.content),
          tool_calls: pendingCalls,
        };
        const reasoning = typeof message.reasoning_content === "string"
          ? message.reasoning_content
          : typeof message.reasoningContent === "string"
            ? message.reasoningContent
            : null;
        if (reasoning !== null) projected.reasoning_content = reasoning;
        neutralHistory.push(projected);
      } else {
        const text = contentText(message.content);
        if (text) neutralHistory.push({ role: "assistant", content: text });
      }
      continue;
    }
    if (message.role === "tool") {
      const id = toolCallId(message);
      if (pending.has(id)) {
        neutralHistory.push({
          role: "tool",
          tool_call_id: id,
          content: contentText(message.content),
        });
      } else {
        neutralHistory.push({
          role: "assistant",
          content: `[Completed tool outcome ${id || "unknown"}]\n${truncate(contentText(message.content), 1_200)}`,
        });
      }
      continue;
    }
    if (message.role === "user" || message.role === "assistant") {
      const projected: Record<string, unknown> = {
        role: message.role,
        content: contentText(message.content),
      };
      if (typeof message.name === "string") projected.name = message.name;
      neutralHistory.push(projected);
    }
  }

  return Object.freeze({
    bounded: boundNeutralHistory(neutralHistory),
    currentMessages,
    sourceMessages,
  });
}

export function computeProviderEpochConversationProjectionDigests(params: {
  messages: readonly any[];
  targetProviderId: string;
  targetProfileId: ProviderEpochProfileId;
  createdAt: string;
  sourceMessageCount?: number;
  pendingToolCallIds: readonly string[];
}): Readonly<{
  sourceMessageCount: number;
  sourceFrontierDigest: `sha256:${string}`;
  handoffDigest: `sha256:${string}`;
}> {
  const projection = projectHandoff(params);
  const sourceFrontierDigest = digest("provider-epoch-source-frontier/v2", {
    createdAt: params.createdAt,
    sourceMessages: projection.sourceMessages,
  });
  const handoffDigest = digest("provider-epoch-handoff/v2", {
    targetProviderId: params.targetProviderId,
    targetProfileId: params.targetProfileId,
    pendingToolCallIds: [...params.pendingToolCallIds],
    messages: projection.bounded,
  });
  return Object.freeze({
    sourceMessageCount: projection.sourceMessages.length,
    sourceFrontierDigest,
    handoffDigest,
  });
}

export function computeProviderEpochReceiptIntegrityDigest(
  receipt: Omit<ProviderEpochReceipt, "integrityDigest">,
): `sha256:${string}` {
  return digest("provider-epoch-receipt-integrity/v1", {
    schemaVersion: receipt.schemaVersion,
    sessionId: receipt.sessionId,
    actorKey: receipt.actorKey,
    actorId: receipt.actorId,
    epoch: receipt.epoch,
    targetProviderId: receipt.targetProviderId,
    targetProfileId: receipt.targetProfileId,
    sourceMessageCount: receipt.sourceMessageCount,
    pendingToolCallIds: [...receipt.pendingToolCallIds],
    sourceFrontierDigest: receipt.sourceFrontierDigest,
    handoffDigest: receipt.handoffDigest,
    reason: receipt.reason,
    createdAt: receipt.createdAt,
  });
}

export function projectProviderEpochConversationMessages(params: {
  messages: readonly any[];
  receipt: ProviderEpochReceipt | null | undefined;
}): any[] {
  const receipt = params.receipt;
  if (!receipt || !receipt.targetProfileId.startsWith("deepseek-")) {
    return [...params.messages];
  }
  if (
    !Number.isInteger(receipt.sourceMessageCount)
    || receipt.sourceMessageCount < 0
    || !Array.isArray(receipt.pendingToolCallIds)
  ) {
    throw new ProviderEpochProjectionError({
      code: "provider_epoch_receipt_incompatible",
      path: "/provider-epoch-receipt/sourceBoundary",
      valueKind: "digest_mismatch",
    });
  }
  const { integrityDigest, ...receiptFacts } = receipt;
  if (integrityDigest !== computeProviderEpochReceiptIntegrityDigest(receiptFacts)) {
    throw new ProviderEpochProjectionError({
      code: "provider_epoch_receipt_incompatible",
      path: "/provider-epoch-receipt/integrityDigest",
      valueKind: "digest_mismatch",
    });
  }
  const currentDigests = computeProviderEpochConversationProjectionDigests({
    messages: params.messages,
    targetProviderId: receipt.targetProviderId,
    targetProfileId: receipt.targetProfileId,
    createdAt: receipt.createdAt,
    sourceMessageCount: receipt.sourceMessageCount,
    pendingToolCallIds: receipt.pendingToolCallIds,
  });
  for (const key of ["sourceFrontierDigest", "handoffDigest"] as const) {
    if (receipt[key] !== currentDigests[key]) {
      throw new ProviderEpochProjectionError({
        code: "provider_epoch_receipt_incompatible",
        path: `/provider-epoch-receipt/${key}`,
        valueKind: "digest_mismatch",
      });
    }
  }
  const projection = projectHandoff({
    messages: params.messages,
    targetProfileId: receipt.targetProfileId,
    createdAt: receipt.createdAt,
    sourceMessageCount: receipt.sourceMessageCount,
    pendingToolCallIds: receipt.pendingToolCallIds,
  });
  const bounded = projection.bounded;
  const currentMessages = projection.currentMessages;
  if (bounded.length === 0) return currentMessages;
  return [
    ...currentMessages.filter((message) => message.role === "system" || message.role === "developer"),
    {
      role: "system",
      content: [
        "Provider epoch handoff from canonical conversation facts.",
        `provider=${receipt.targetProviderId}`,
        `target=${receipt.targetProfileId}`,
        `source_frontier=${receipt.sourceFrontierDigest}`,
        `handoff=${receipt.handoffDigest}`,
      ].join("\n"),
    },
    ...bounded,
    ...currentMessages.filter((message) => message.role !== "system" && message.role !== "developer"),
  ];
}
