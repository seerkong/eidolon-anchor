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
    }).visibleRanges).toEqual([range(1, 5)]);

    expect(deriveVisibleResourceCoverage({
      resourceFact: fact,
      revisionDigest: REVISION_A,
      materializedMessages: [toolMessage("delivery-1", "truncated result")],
      toolCallRecords: records,
    }).visibleRanges).toEqual([]);
  });

  it("treats compacted and persisted delivered wrappers as visible over their original delivery range", () => {
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
    }).visibleRanges).toEqual([range(1, 5), range(8, 10)]);
  });

  it("treats a compacted delivered wrapper as visible only over its fragment selection range, not the whole file", () => {
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
      toolMessage("delivery-2", "full result two"),
    ];

    expect(deriveVisibleResourceCoverage({
      resourceFact: fact,
      revisionDigest: REVISION_A,
      materializedMessages: messages,
      toolCallRecords: records,
    }).visibleRanges).toEqual([range(1, 5), range(8, 10)]);
  });

  it("treats a compacted delivered wrapper as invisible when its completed record is absent", () => {
    const fact = makeFact();
    const records = [completedRecord("delivery-2", "full result two")];
    const messages = [
      toolMessage(
        "delivery-1",
        '<compacted-tool-result status="delivered_and_compacted">\n<preview>full result one</preview>\n</compacted-tool-result>',
      ),
      toolMessage("delivery-2", "full result two"),
    ];

    expect(deriveVisibleResourceCoverage({
      resourceFact: fact,
      revisionDigest: REVISION_A,
      materializedMessages: messages,
      toolCallRecords: records,
    }).visibleRanges).toEqual([range(8, 10)]);
  });

  it("does not treat a pending_first_delivery_compacted wrapper as visible over its delivery range", () => {
    const fact = makeFact();
    const records = [
      completedRecord("delivery-1", "full result one"),
      completedRecord("delivery-2", "full result two"),
    ];
    const messages = [
      // delivery-1's body was spilled to an artifact before its first delivery:
      // the model never saw it, so its range must NOT contribute visible coverage.
      toolMessage(
        "delivery-1",
        [
          '<persisted-tool-result status="pending_first_delivery_compacted">',
          "Tool call id: delivery-1",
          "Full output persisted at: /artifacts/tool-results/main/delivery-1.txt",
          "<preview>full result one</preview>",
          "</persisted-tool-result>",
        ].join("\n"),
      ),
      // Contrast: a delivered_and_compacted wrapper (body fully delivered before)
      // still contributes visible coverage over its original delivery range.
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
    }).visibleRanges).toEqual([range(8, 10)]);
  });

  it("does not treat a compacted-tag pending_first_delivery_compacted wrapper as visible", () => {
    const fact = makeFact();
    const records = [completedRecord("delivery-1", "full result one")];
    const messages = [
      toolMessage(
        "delivery-1",
        [
          '<compacted-tool-result status="pending_first_delivery_compacted">',
          "Full output persisted at: /artifacts/tool-results/main/delivery-1.txt",
          "<preview>full result one</preview>",
          "</compacted-tool-result>",
        ].join("\n"),
      ),
    ];

    expect(deriveVisibleResourceCoverage({
      resourceFact: fact,
      revisionDigest: REVISION_A,
      materializedMessages: messages,
      toolCallRecords: records,
    }).visibleRanges).toEqual([]);
  });

  it("returns missing_ranges (re-delivery) when only a pending_first_delivery_compacted wrapper remains", () => {
    const fact = makeFact();
    const records = [completedRecord("delivery-1", "full result one")];
    const pending = toolMessage(
      "delivery-1",
      [
        '<persisted-tool-result status="pending_first_delivery_compacted">',
        "Tool call id: delivery-1",
        "Full output persisted at: /artifacts/tool-results/main/delivery-1.txt",
        "<preview>full result one</preview>",
        "</persisted-tool-result>",
      ].join("\n"),
    );

    expect(decideContextResourceLoad({
      resourceFact: fact,
      currentRevisionDigest: REVISION_A,
      requestedRanges: [range(1, 5)],
      materializedMessages: [pending],
      toolCallRecords: records,
    })).toEqual({
      kind: "missing_ranges",
      revisionDigest: REVISION_A,
      requestedRanges: [range(1, 5)],
      visibleRanges: [],
      missingRanges: [range(1, 5)],
      recoveryPaths: [],
    });
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
      recoveryPaths: [],
    });
  });

  it("re-delivers the original range after a delivered delivery is compacted", () => {
    const fact = makeFact();
    const records = [
      completedRecord("delivery-1", "full result one"),
      completedRecord("delivery-2", "full result two"),
    ];
    const compacted = toolMessage(
      "delivery-1",
      [
        '<compacted-tool-result status="delivered_and_compacted">',
        "Tool call id: delivery-1",
        "Full output persisted at: /artifacts/tool-results/main/delivery-1.txt",
        '<preview>full result one</preview>',
        "</compacted-tool-result>",
      ].join("\n"),
    );

    expect(decideContextResourceLoad({
      resourceFact: fact,
      currentRevisionDigest: REVISION_A,
      requestedRanges: [range(2, 4)],
      materializedMessages: [compacted, toolMessage("delivery-2", "full result two")],
      toolCallRecords: records,
    })).toEqual({
       kind: "missing_ranges",
      revisionDigest: REVISION_A,
      requestedRanges: [range(2, 4)],
      visibleRanges: [range(1, 5), range(8, 10)],
       missingRanges: [range(2, 4)],
       recoveryPaths: [],
    });
  });

  it("keeps recovery paths as fallback metadata while requiring body re-delivery", () => {
    const fact = makeFact();
    const records = [
      completedRecord("delivery-1", "full result one"),
      completedRecord("delivery-2", "full result two"),
    ];
    const messages = [
      // delivery-1's wrapper carries a persisted path.
      toolMessage(
        "delivery-1",
        [
          '<compacted-tool-result status="delivered_and_compacted">',
          "Tool call id: delivery-1",
          "Full output persisted at: /artifacts/tool-results/main/delivery-1.txt",
          "<preview>full result one</preview>",
          "</compacted-tool-result>",
        ].join("\n"),
      ),
      // delivery-2's wrapper is a plain compacted form without any persisted path.
      toolMessage(
        "delivery-2",
        [
          '<compacted-tool-result status="delivered_and_compacted">',
          "Tool call id: delivery-2",
          "Original characters: 42",
          "<preview>full result two</preview>",
          "</compacted-tool-result>",
        ].join("\n"),
      ),
    ];

    expect(decideContextResourceLoad({
      resourceFact: fact,
      currentRevisionDigest: REVISION_A,
      // The second wrapper has no recovery path, so only its range is
      // re-delivered even though the resource fact records prior coverage.
      requestedRanges: [range(2, 4), range(9, 10)],
      materializedMessages: messages,
      toolCallRecords: records,
    })).toEqual({
       kind: "missing_ranges",
       revisionDigest: REVISION_A,
       requestedRanges: [range(2, 4), range(9, 10)],
       visibleRanges: [range(1, 5), range(8, 10)],
       missingRanges: [range(2, 4), range(9, 10)],
       recoveryPaths: [],
     });
  });

  it("excludes pending_first_delivery_compacted wrappers from the recovery paths", () => {
    const fact = makeFact();
    const records = [completedRecord("delivery-1", "full result one")];
    const pending = toolMessage(
      "delivery-1",
      [
        '<persisted-tool-result status="pending_first_delivery_compacted">',
        "Tool call id: delivery-1",
        "Full output persisted at: /artifacts/tool-results/main/delivery-1.txt",
        "<preview>full result one</preview>",
        "</persisted-tool-result>",
      ].join("\n"),
    );

    expect(decideContextResourceLoad({
      resourceFact: fact,
      currentRevisionDigest: REVISION_A,
      requestedRanges: [range(1, 5)],
      materializedMessages: [pending],
      toolCallRecords: records,
    })).toEqual({
      kind: "missing_ranges",
      revisionDigest: REVISION_A,
      requestedRanges: [range(1, 5)],
      visibleRanges: [],
      missingRanges: [range(1, 5)],
      recoveryPaths: [],
    });
  });

  it("still delivers ranges outside the compacted delivery coverage", () => {
    const fact = makeFact();
    const records = [
      completedRecord("delivery-1", "full result one"),
      completedRecord("delivery-2", "full result two"),
    ];
    const compacted = toolMessage(
      "delivery-1",
      '<compacted-tool-result status="delivered_and_compacted">\n<preview>full result one</preview>\n</compacted-tool-result>',
    );

    expect(decideContextResourceLoad({
      resourceFact: fact,
      currentRevisionDigest: REVISION_A,
      requestedRanges: [range(1, 10)],
      materializedMessages: [compacted, toolMessage("delivery-2", "full result two")],
      toolCallRecords: records,
    })).toEqual({
      kind: "missing_ranges",
      revisionDigest: REVISION_A,
      requestedRanges: [range(1, 10)],
      visibleRanges: [range(1, 5), range(8, 10)],
      missingRanges: [range(6, 7)],
      recoveryPaths: [],
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
      recoveryPaths: [],
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
      recoveryPaths: [],
    });
  });
});
