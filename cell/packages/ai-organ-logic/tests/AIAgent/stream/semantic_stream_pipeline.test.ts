import { describe, expect, it } from "bun:test";

import { SemanticStreamGraph } from "@cell/ai-organ-logic/stream/SemanticStreamPipeline";

describe("SemanticStreamGraph", () => {
  it("emits semantic events from timeline input", () => {
    const graph = new SemanticStreamGraph({ agentKey: "main", agentActorId: "actor-1" });
    const eventTypes: string[] = [];

    graph.onSemanticEvent((event) => eventTypes.push(event.event_type));

    graph.consumeTimelineEvent({ event: "content", data: "hello" });
    graph.finish();

    expect(eventTypes).toEqual([
      "semantic_content_start",
      "semantic_content_delta",
      "semantic_content_end",
    ]);
  });

  it("does not replay historical semantic events to late subscribers", () => {
    const graph = new SemanticStreamGraph({ agentKey: "main", agentActorId: "actor-1" });
    const eventTypes: string[] = [];

    graph.consumeTimelineEvent({ event: "content", data: "before-subscribe" });

    graph.onSemanticEvent((event) => eventTypes.push(event.event_type));
    graph.finish();

    expect(eventTypes).toEqual(["semantic_content_end"]);
  });
});
