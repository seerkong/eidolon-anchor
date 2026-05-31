import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import { runReferenceAlignedStageScenarioDetailed } from "@cell/ai-core-logic/stream/testing/referenceAlignedStageScenario";
import { TuiCardGraph } from "@terminal/organ/stream/TuiCardGraph";
import { TuiTextGraph } from "@terminal/organ/stream/TuiTextGraph";
import type { TuiActorEvent, TuiTextSnapshot } from "@terminal/organ/stream/TuiCardTypes";

const FIXTURE_ROOT = path.resolve(import.meta.dir, "../../resources/projection");
const SCENARIOS = [
  "default",
  "chunked-markers",
  "content-unquote",
  "quote-chunked",
  "toolcall-delta",
  "toolcall-multiple",
  "toolcall-alt-format",
  "tui-turn-events",
  "questionnaire",
  "plan-approval",
  "shutdown",
  "background-result",
] as const;

describe("reference aligned tui card/text graphs", () => {
  for (const scenario of SCENARIOS) {
    test(`TuiCardGraph replays fixture ${scenario}`, async () => {
      const semanticEvents = await loadScenarioSemanticEvents(scenario);
      const graph = new TuiCardGraph();

      for (const event of semanticEvents) {
        graph.consumeSemanticEvent(event);
      }

      expect(graph.getEvents()).toEqual(loadCardFixture(scenario));
    });

    test(`TuiTextGraph replays fixture ${scenario}`, async () => {
      const semanticEvents = await loadScenarioSemanticEvents(scenario);
      const graph = new TuiTextGraph();

      for (const event of semanticEvents) {
        graph.consumeSemanticEvent(event);
      }

      expect(graph.getSnapshots()).toEqual(loadTextFixture(scenario));
    });
  }

  test("default card/text fixtures still preserve quote and planned-tool semantics", async () => {
    const semanticEvents = await loadScenarioSemanticEvents("default");
    const cardGraph = new TuiCardGraph();
    const textGraph = new TuiTextGraph();

    for (const event of semanticEvents) {
      cardGraph.consumeSemanticEvent(event);
      textGraph.consumeSemanticEvent(event);
    }

    const cardEvents = cardGraph.getEvents().map((entry) => entry.event.event_type);
    expect(cardEvents).toEqual([
      "notice",
      "notice",
      "notice",
      "notice",
      "assistant_stream_start",
      "assistant_stream_chunk",
      "assistant_stream_end",
      "assistant_message",
      "notice",
    ]);

    const snapshot = textGraph.getSnapshot("primary");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.text).toContain("[ASSISTANT]\n[quote:thinking]");
    expect(snapshot!.text).toContain("Planned tool call: queryOrder [query_order_xxx]");
  });

  test("card and text projections cap retained in-memory state", () => {
    const cardGraph = new TuiCardGraph();
    const textGraph = new TuiTextGraph();

    for (let index = 0; index < 1_100; index += 1) {
      cardGraph.consumeSemanticEvent({
        event_type: "semantic_notice",
        actor: { actor_id: "primary", actor_name: "Primary", actor_kind: "primary" },
        message: `notice ${index}`,
        level: "info",
      } as SemanticEvent);
    }
    expect(cardGraph.getEvents()).toHaveLength(1_000);
    expect((cardGraph.getEvents()[0]?.event as any).message).toBe("notice 100");

    textGraph.consumeSemanticEvent({
      event_type: "semantic_content_delta",
      actor: { actor_id: "primary", actor_name: "Primary", actor_kind: "primary" },
      text: "x".repeat(220_000),
    } as SemanticEvent);
    const snapshot = textGraph.getSnapshot("primary");
    expect(snapshot?.text.length).toBeLessThanOrEqual(200_000);
    expect(snapshot?.text.startsWith("[older output trimmed]")).toBe(true);
  });
});

async function loadScenarioSemanticEvents(scenario: string): Promise<SemanticEvent[]> {
  const semanticFixturePath = path.join(FIXTURE_ROOT, scenario, "semantic-events.json");
  if (fs.existsSync(semanticFixturePath)) {
    return JSON.parse(fs.readFileSync(semanticFixturePath, "utf-8")) as SemanticEvent[];
  }

  const detail = await runReferenceAlignedStageScenarioDetailed(scenario);
  return detail.semanticEvents;
}

function loadCardFixture(scenario: string): TuiActorEvent[] {
  const text = fs.readFileSync(path.join(FIXTURE_ROOT, "card-events.json"), "utf-8");
  const fixtures = JSON.parse(text) as Record<string, TuiActorEvent[]>;
  return fixtures[scenario] ?? [];
}

function loadTextFixture(scenario: string): TuiTextSnapshot[] {
  const text = fs.readFileSync(path.join(FIXTURE_ROOT, "text-snapshots.json"), "utf-8");
  const fixtures = JSON.parse(text) as Record<string, TuiTextSnapshot[]>;
  return fixtures[scenario] ?? [];
}
