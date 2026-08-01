import { createHash } from "node:crypto";

import type {
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
    }
  | {
      kind: "missing_ranges";
      revisionDigest: string;
      requestedRanges: LineRange[];
      visibleRanges: LineRange[];
      missingRanges: LineRange[];
    }
  | {
      kind: "changed_revision";
      previousRevisionDigest: string;
      revisionDigest: string;
      requestedRanges: LineRange[];
      visibleRanges: [];
      missingRanges: LineRange[];
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

function messageToolCallId(message: ChatMessage): string | undefined {
  return message.toolCallId ?? message.tool_call_id;
}

export function deriveVisibleResourceCoverage({
  resourceFact,
  revisionDigest,
  materializedMessages,
  toolCallRecords,
}: VisibilityInput): LineRange[] {
  const completedRecords = new Map(
    toolCallRecords
      .filter((record) => record.status === "completed" && typeof record.outputText === "string")
      .map((record) => [record.toolCallId, record]),
  );
  const visibleResults = new Map(
    materializedMessages
      .filter(
        (message): message is ChatMessage & { content: string } =>
          message.role === "tool" && typeof message.content === "string" && !isCompactedResult(message.content),
      )
      .map((message) => [messageToolCallId(message), message.content]),
  );
  const fragments = new Map(resourceFact.fragments.map((fragment) => [fragment.fragmentId, fragment]));

  const visibleRanges = resourceFact.deliveries.flatMap((delivery) => {
    if (delivery.revisionDigest !== revisionDigest) return [];
    const fragment = fragments.get(delivery.fragmentId);
    if (!fragment || fragment.revisionDigest !== revisionDigest) return [];

    const record = completedRecords.get(delivery.toolCallId);
    const visibleResult = visibleResults.get(delivery.toolCallId);
    if (!record || visibleResult === undefined || visibleResult !== record.outputText) return [];
    return [fragment.selection];
  });

  return normalizeLineRanges(visibleRanges);
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
    };
  }

  const visibleRanges = deriveVisibleResourceCoverage({
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
    };
  }

  return {
    kind: "missing_ranges",
    revisionDigest: currentRevisionDigest,
    requestedRanges: normalizedRequested,
    visibleRanges,
    missingRanges,
  };
}
