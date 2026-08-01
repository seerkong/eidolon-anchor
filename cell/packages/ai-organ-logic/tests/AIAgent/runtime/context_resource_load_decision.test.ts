import { describe, expect, it } from "bun:test";

import type {
  LocalConversationContextResourceFact,
  LocalConversationContextResourceFragmentSelection,
} from "@cell/ai-organ-contract";
import type { ToolCallRecord } from "@cell/ai-core-contract";
import type { ChatMessage } from "@shared/composer";

import {
  computeTextResourceRevision,
  decideContextResourceLoad,
  deriveVisibleResourceCoverage,
  normalizeLineRanges,
  subtractLineRanges,
} from "../../../src/runtime/ContextResourceLoadDecision";

const REVISION_A = "a".repeat(64);
const REVISION_B = "b".repeat(64);

function range(startLine: number, endLine: number): LocalConversationContextResourceFragmentSelection {
  return { kind: "line_range", startLine, endLine };
}

function makeFact(): LocalConversationContextResourceFact {
  return {
    canonicalResourceId: "file:///workspace/guide.md",
    revision: { algorithm: "sha256", digest: REVISION_A },
    fragments: [
      {
        fragmentId: "lines-1-5",
        revisionDigest: REVISION_A,
        selection: range(1, 5),
        contentDigest: { algorithm: "sha256", digest: "1".repeat(64) },
        observedAt: "2026-07-17T18:30:00.000Z",
      },
      {
        fragmentId: "lines-8-10",
        revisionDigest: REVISION_A,
        selection: range(8, 10),
        contentDigest: { algorithm: "sha256", digest: "2".repeat(64) },
        observedAt: "2026-07-17T18:31:00.000Z",
      },
    ],
    deliveries: [
      {
        toolCallId: "delivery-1",
        revisionDigest: REVISION_A,
        fragmentId: "lines-1-5",
        deliveredAt: "2026-07-17T18:32:00.000Z",
      },
      {
        toolCallId: "delivery-2",
        revisionDigest: REVISION_A,
        fragmentId: "lines-8-10",
        deliveredAt: "2026-07-17T18:33:00.000Z",
      },
    ],
    observedAt: "2026-07-17T18:30:00.000Z",
  };
}

function completedRecord(toolCallId: string, outputText: string): ToolCallRecord {
  return {
    toolCallId,
    actorKey: "main",
    turnId: 1,
    funcName: toolCallId === "delivery-1" ? "Read" : "AnyResolver",
    args: {},
    plannedAt: 1,
    resultAt: 2,
    outputText,
    status: "completed",
  };
}

function toolMessage(toolCallId: string, content: string): ChatMessage {
  return { role: "tool", toolCallId, tool_call_id: toolCallId, content };
}

describe("context resource load decisions", () => {
  it("computes deterministic SHA-256 revisions from the complete source text", () => {
    expect(computeTextResourceRevision("hello\n")).toEqual({
      algorithm: "sha256",
      digest: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
    });
  });

  it("normalizes, unions, and subtracts inclusive line ranges", () => {
    expect(normalizeLineRanges([
      range(8, 10),
      range(5, 3),
      range(6, 7),
      range(20, 20),
    ])).toEqual([range(3, 10), range(20, 20)]);

    expect(subtractLineRanges(
      [range(1, 12), range(20, 22)],
      [range(2, 4), range(7, 10), range(20, 21)],
    )).toEqual([range(1, 1), range(5, 6), range(11, 12), range(22, 22)]);
  });

  it("derives coverage only from completed deliveries with their full materialized result", () => {
    const fact = makeFact();
    const records = [
      completedRecord("delivery-1", "full result one"),
      { ...completedRecord("delivery-2", "full result two"), status: "executing" as const },
    ];
    const messages = [
      toolMessage("delivery-1", "full result one"),
      toolMessage("delivery-2", "full result two"),
    ];

    expect(deriveVisibleResourceCoverage({
      resourceFact: fact,
      revisionDigest: REVISION_A,
      materializedMessages: messages,
      toolCallRecords: records,
    })).toEqual([range(1, 5)]);

    expect(deriveVisibleResourceCoverage({
      resourceFact: fact,
      revisionDigest: REVISION_A,
      materializedMessages: [toolMessage("delivery-1", "truncated result")],
      toolCallRecords: records,
    })).toEqual([]);
  });

  it("treats compacted and persisted wrappers as invisible even when their preview contains source text", () => {
    const fact = makeFact();
    const records = [
      completedRecord("delivery-1", "full result one"),
      completedRecord("delivery-2", "full result two"),
    ];
    const messages = [
      toolMessage(
        "delivery-1",
        '<compacted-tool-result status="delivered_and_compacted">\n<preview>full result one</preview>\n</compacted-tool-result>',
      ),
      toolMessage(
        "delivery-2",
        '<persisted-tool-result status="delivered_and_compacted">\n<preview>full result two</preview>\n</persisted-tool-result>',
      ),
    ];

    expect(deriveVisibleResourceCoverage({
      resourceFact: fact,
      revisionDigest: REVISION_A,
      materializedMessages: messages,
      toolCallRecords: records,
    })).toEqual([]);
  });

  it("returns already-visible when same-revision coverage fully contains the request", () => {
    const fact = makeFact();
    const outputText = "full result one";

    expect(decideContextResourceLoad({
      resourceFact: fact,
      currentRevisionDigest: REVISION_A,
      requestedRanges: [range(2, 4)],
      materializedMessages: [toolMessage("delivery-1", outputText)],
      toolCallRecords: [completedRecord("delivery-1", outputText)],
    })).toEqual({
      kind: "already_visible",
      revisionDigest: REVISION_A,
      requestedRanges: [range(2, 4)],
      visibleRanges: [range(1, 5)],
      missingRanges: [],
    });
  });

  it("returns only missing ranges for partial, compacted, or removed deliveries", () => {
    const fact = makeFact();
    const records = [
      completedRecord("delivery-1", "full result one"),
      completedRecord("delivery-2", "full result two"),
    ];

    expect(decideContextResourceLoad({
      resourceFact: fact,
      currentRevisionDigest: REVISION_A,
      requestedRanges: [range(1, 10)],
      materializedMessages: [toolMessage("delivery-1", "full result one")],
      toolCallRecords: records,
    })).toEqual({
      kind: "missing_ranges",
      revisionDigest: REVISION_A,
      requestedRanges: [range(1, 10)],
      visibleRanges: [range(1, 5)],
      missingRanges: [range(6, 10)],
    });
  });

  it("invalidates all old coverage when the complete-content revision changes", () => {
    const fact = makeFact();

    expect(decideContextResourceLoad({
      resourceFact: fact,
      currentRevisionDigest: REVISION_B,
      requestedRanges: [range(3, 7)],
      materializedMessages: [toolMessage("delivery-1", "full result one")],
      toolCallRecords: [completedRecord("delivery-1", "full result one")],
    })).toEqual({
      kind: "changed_revision",
      previousRevisionDigest: REVISION_A,
      revisionDigest: REVISION_B,
      requestedRanges: [range(3, 7)],
      visibleRanges: [],
      missingRanges: [range(3, 7)],
    });
  });
});
