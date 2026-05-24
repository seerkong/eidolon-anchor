import { describe, expect, test } from "bun:test";

import { runReferenceAlignedStageScenarioDetailed } from "@cell/ai-core-logic/stream/testing/referenceAlignedStageScenario";
import { SemanticTerminalHub } from "@terminal/organ/stream/SemanticTerminalHub";

describe("reference aligned semantic terminal hub", () => {
  test("fans out one semantic stream into tui, textual, card, and text projections", async () => {
    const detail = await runReferenceAlignedStageScenarioDetailed("default");
    const hub = new SemanticTerminalHub();

    const tuiEvents: string[] = [];
    const textualEvents: string[] = [];
    const cardEvents: string[] = [];
    const snapshots: string[] = [];

    hub.onTuiEvent((event) => tuiEvents.push(event.kind === "control" ? `control:${event.payload.category ?? ""}` : `message:${String(event.payload)}`));
    hub.onTextualEvent((event) => textualEvents.push(event.kind === "control" ? `control:${event.payload.category ?? ""}` : `message:${String(event.payload)}`));
    hub.onCardEvent((event) => cardEvents.push(`${event.actor.actor_id}:${event.event.event_type}`));
    hub.onTextSnapshot((snapshot) => snapshots.push(`${snapshot.actor.actor_id}:${snapshot.text}`));

    for (const event of detail.semanticEvents) {
      hub.consumeSemanticEvent(event);
    }

    expect(tuiEvents.some((entry) => entry === "control:assist")).toBe(true);
    expect(tuiEvents.some((entry) => entry.includes("我先使用订单查询工具查询"))).toBe(true);

    expect(textualEvents.some((entry) => entry.includes("🤖 Assist: 我先使用订单查询工具查询"))).toBe(true);

    expect(cardEvents).toEqual([
      "primary:notice",
      "primary:notice",
      "primary:notice",
      "primary:notice",
      "primary:assistant_stream_start",
      "primary:assistant_stream_chunk",
      "primary:assistant_stream_end",
      "primary:assistant_message",
      "primary:notice",
    ]);

    expect(snapshots[snapshots.length - 1]).toContain("[ASSISTANT]\n我先使用订单查询工具查询");
    expect(snapshots[snapshots.length - 1]).toContain("Planned tool call: queryOrder [query_order_xxx]");
  });
});
