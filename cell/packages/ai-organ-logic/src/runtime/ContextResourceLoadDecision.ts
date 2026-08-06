import { createHash } from "node:crypto";

import type {
  LocalConversationContextResourceDeliveryFact,
  LocalConversationContextResourceDigest,
  LocalConversationContextResourceFact,
  LocalConversationContextResourceFragmentSelection,
} from "@cell/ai-organ-contract";
import type { ToolCallRecord } from "@cell/ai-core-contract";
import type { ChatMessage } from "@shared/composer";

type LineRange = LocalConversationContextResourceFragmentSelection;

type VisibilityInput = {
  resourceFact: LocalConversationContextResourceFact;
  revisionDigest: string;
  materializedMessages: ChatMessage[];
  toolCallRecords: ToolCallRecord[];
};

type LoadDecisionInput = Omit<VisibilityInput, "revisionDigest"> & {
  currentRevisionDigest: string;
  requestedRanges: LineRange[];
};

export type ContextResourceLoadDecision =
  | {
      kind: "already_visible";
      revisionDigest: string;
      requestedRanges: LineRange[];
      visibleRanges: LineRange[];
      missingRanges: [];
      /** Artifact paths recorded in delivered_and_compacted wrappers, so the
       *  model can read the original output when it needs more than the wrapper. */
      recoveryPaths: string[];
    }
  | {
      kind: "missing_ranges";
      revisionDigest: string;
      requestedRanges: LineRange[];
      visibleRanges: LineRange[];
      missingRanges: LineRange[];
      /** Always empty for missing_ranges: re-delivery carries the body itself. */
      recoveryPaths: string[];
    }
  | {
      kind: "changed_revision";
      previousRevisionDigest: string;
      revisionDigest: string;
      requestedRanges: LineRange[];
      visibleRanges: [];
      missingRanges: LineRange[];
      recoveryPaths: [];
    };

export function computeTextResourceRevision(sourceText: string): LocalConversationContextResourceDigest {
  return {
    algorithm: "sha256",
    digest: createHash("sha256").update(sourceText).digest("hex"),
  };
}

export function normalizeLineRanges(ranges: LineRange[]): LineRange[] {
  const sorted = ranges
    .map(({ startLine, endLine }) => ({
      kind: "line_range" as const,
      startLine: Math.min(startLine, endLine),
      endLine: Math.max(startLine, endLine),
    }))
    .sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);

  const normalized: LineRange[] = [];
  for (const current of sorted) {
    const previous = normalized.at(-1);
    if (!previous || current.startLine > previous.endLine + 1) {
      normalized.push(current);
      continue;
    }
    previous.endLine = Math.max(previous.endLine, current.endLine);
  }
  return normalized;
}

export function subtractLineRanges(requested: LineRange[], covered: LineRange[]): LineRange[] {
  const remaining: LineRange[] = [];
  const normalizedCoverage = normalizeLineRanges(covered);

  for (const request of normalizeLineRanges(requested)) {
    let cursor = request.startLine;
    for (const coverage of normalizedCoverage) {
      if (coverage.endLine < cursor) continue;
      if (coverage.startLine > request.endLine) break;
      if (coverage.startLine > cursor) {
        remaining.push({
          kind: "line_range",
          startLine: cursor,
          endLine: Math.min(request.endLine, coverage.startLine - 1),
        });
      }
      cursor = Math.max(cursor, coverage.endLine + 1);
      if (cursor > request.endLine) break;
    }
    if (cursor <= request.endLine) {
      remaining.push({ kind: "line_range", startLine: cursor, endLine: request.endLine });
    }
  }

  return remaining;
}

function isCompactedResult(content: string): boolean {
  return /<(?:compacted|persisted)-tool-result\b[^>]*\bstatus=["']delivered_and_compacted["'][^>]*>/i.test(
    content,
  );
}

function isPendingFirstDeliveryResult(content: string): boolean {
  return /<(?:compacted|persisted)-tool-result\b[^>]*\bstatus=["']pending_first_delivery_compacted["'][^>]*>/i.test(
    content,
  );
}

function isCompactedResultStatus(content: string): boolean {
  return isCompactedResult(content) || isPendingFirstDeliveryResult(content);
}

/** Extracts the `Full output persisted at:` artifact path from a compacted or
 *  persisted wrapper, or null when the wrapper carries no persisted path. */
function recoveryPathFromContent(content: string): string | null {
  const match = content.match(/Full output persisted at:\s*(.+)/);
  return match?.[1]?.trim() || null;
}

function messageToolCallId(message: ChatMessage): string | undefined {
  return message.toolCallId ?? message.tool_call_id;
}

export type VisibleResourceCoverage = {
  visibleRanges: LineRange[];
  recoveryPaths: string[];
};

export function deriveVisibleResourceCoverage({
  resourceFact,
  revisionDigest,
  materializedMessages,
  toolCallRecords,
}: VisibilityInput): VisibleResourceCoverage {
  const completedRecords = new Map(
    toolCallRecords
      .filter((record) => record.status === "completed" && typeof record.outputText === "string")
      .map((record) => [record.toolCallId, record]),
  );
  const visibleResults = new Map(
    materializedMessages
      .filter(
        (message): message is ChatMessage & { content: string } =>
          message.role === "tool" && typeof message.content === "string" && !isCompactedResultStatus(message.content),
      )
      .map((message) => [messageToolCallId(message), message.content]),
  );
  const deliveredAndCompactedMessages = new Set(
    materializedMessages
      .filter(
        (message): message is ChatMessage & { content: string } =>
          message.role === "tool" && typeof message.content === "string" && isCompactedResult(message.content),
      )
      .map((message) => messageToolCallId(message))
      .filter((toolCallId): toolCallId is string => typeof toolCallId === "string"),
  );
  const fragments = new Map(resourceFact.fragments.map((fragment) => [fragment.fragmentId, fragment]));
  const deliveredAndCompactedByToolCallId = new Map(
    [...deliveredAndCompactedMessages].map((toolCallId) => [
      toolCallId,
      materializedMessages.find(
        (message) => message.role === "tool" && messageToolCallId(message) === toolCallId,
      ),
    ]),
  );

  const recoveryPathsForDelivery = (delivery: LocalConversationContextResourceDeliveryFact): string[] => {
    if (!deliveredAndCompactedMessages.has(delivery.toolCallId)) return [];
    const message = deliveredAndCompactedByToolCallId.get(delivery.toolCallId);
    if (!message || typeof message.content !== "string") return [];
    const path = recoveryPathFromContent(message.content);
    return path ? [path] : [];
  };

  const visibleRanges = resourceFact.deliveries.flatMap((delivery) => {
    if (delivery.revisionDigest !== revisionDigest) return [];
    const fragment = fragments.get(delivery.fragmentId);
    if (!fragment || fragment.revisionDigest !== revisionDigest) return [];

    const record = completedRecords.get(delivery.toolCallId);
    if (!record) return [];

    const visibleResult = visibleResults.get(delivery.toolCallId);
    if (visibleResult !== undefined) {
      if (visibleResult !== record.outputText) return [];
      return [fragment.selection];
    }

    // The tool result was fully delivered (its ToolCallDomain record is
    // completed), but the current message content is a compacted/persisted
    // wrapper for that delivery. The wrapper's status is delivered_and_compacted:
    // the model already saw the full body, so the original delivery range (kept
    // append-only in resource fact deliveries) remains visible.
    if (deliveredAndCompactedMessages.has(delivery.toolCallId)) {
      return [fragment.selection];
    }

    return [];
  });

  const recoveryPaths = resourceFact.deliveries.flatMap((delivery) =>
    recoveryPathsForDelivery(delivery),
  );

  return { visibleRanges: normalizeLineRanges(visibleRanges), recoveryPaths };
}

export function decideContextResourceLoad({
  resourceFact,
  currentRevisionDigest,
  requestedRanges,
  materializedMessages,
  toolCallRecords,
}: LoadDecisionInput): ContextResourceLoadDecision {
  const normalizedRequested = normalizeLineRanges(requestedRanges);
  if (resourceFact.revision.digest !== currentRevisionDigest) {
    return {
      kind: "changed_revision",
      previousRevisionDigest: resourceFact.revision.digest,
      revisionDigest: currentRevisionDigest,
      requestedRanges: normalizedRequested,
      visibleRanges: [],
      missingRanges: normalizedRequested,
      recoveryPaths: [],
    };
  }

  const { visibleRanges, recoveryPaths } = deriveVisibleResourceCoverage({
    resourceFact,
    revisionDigest: currentRevisionDigest,
    materializedMessages,
    toolCallRecords,
  });
  const missingRanges = subtractLineRanges(normalizedRequested, visibleRanges);

  if (missingRanges.length === 0) {
    return {
      kind: "already_visible",
      revisionDigest: currentRevisionDigest,
      requestedRanges: normalizedRequested,
      visibleRanges,
      missingRanges: [],
      recoveryPaths,
    };
  }

  return {
    kind: "missing_ranges",
    revisionDigest: currentRevisionDigest,
    requestedRanges: normalizedRequested,
    visibleRanges,
    missingRanges,
    recoveryPaths: [],
  };
}
