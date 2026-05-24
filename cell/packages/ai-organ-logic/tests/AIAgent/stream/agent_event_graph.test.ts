import { describe, expect, it } from "bun:test";

import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph";

const actor = { key: "main", id: "actor-1" };

function makeInvalidSemanticEvent(): SemanticEvent {
  return {
    trace: {
      event_id: "e1",
      actor_id: "",
      session_id: "",
      request_id: "",
      conversation_id: "",
      stream_id: "",
      parent_event_id: "",
      causation_event_id: "",
      correlation_id: "",
      turn_id: "",
      turn_index: 0,
      sequence: 1,
      emitted_at: Date.now(),
      surface: "tui",
    },
    actor: {
      actor_id: "",
      actor_name: "",
      actor_kind: "primary",
      agent_definition_name: null,
      agent_manifest_type: "unknown",
      role_label: null,
      actor_projection: null,
      parent_actor_id: null,
      root_actor_id: null,
    },
    team: {
      team_id: "",
      team_name: "",
      coordinator_actor_id: "",
      teammate_name: "",
      teammate_role: "",
      task_id: "",
    },
    event_type: "semantic_think_start",
  };
}

describe("AgentEventGraph", () => {
  it("emits events to consumers", () => {
    const graph = new AgentEventGraph();
    const received: SemanticEvent[] = [];

    graph.addConsumer((event) => received.push(event));
    graph.emitThinkStart(actor);
    graph.emitThinkDelta(actor, "hello");
    graph.emitThinkEnd(actor);

    expect(received.length).toBe(3);
    expect(received[0].event_type).toBe("semantic_think_start");
    expect(received[1].event_type).toBe("semantic_think_delta");
    expect(received[2].event_type).toBe("semantic_think_end");
  });

  it("delivers events to multiple consumers", () => {
    const graph = new AgentEventGraph();
    const received1: SemanticEvent[] = [];
    const received2: SemanticEvent[] = [];

    graph.addConsumer((event) => received1.push(event));
    graph.addConsumer((event) => received2.push(event));

    graph.emitContentStart(actor);
    graph.emitContentDelta(actor, "text");
    graph.emitContentEnd(actor);

    expect(received1.length).toBe(3);
    expect(received2.length).toBe(3);
  });

  it("completes and stops emissions", () => {
    const graph = new AgentEventGraph();
    const received: SemanticEvent[] = [];
    let completed = false;

    graph.addConsumer(
      (event) => received.push(event),
      () => {},
      () => { completed = true; }
    );

    graph.emitThinkStart(actor);
    graph.complete();
    graph.emitThinkEnd(actor);

    expect(received.length).toBe(1);
    expect(completed).toBe(true);
  });

  it("signals error and stops emissions", () => {
    const graph = new AgentEventGraph();
    const received: SemanticEvent[] = [];
    let errored = false;

    graph.addConsumer(
      (event) => received.push(event),
      () => { errored = true; }
    );

    graph.emitThinkStart(actor);
    graph.error(new Error("boom"));
    graph.emitThinkEnd(actor);

    expect(received.length).toBe(1);
    expect(errored).toBe(true);
  });

  it("throws if event is missing metadata", () => {
    const graph = new AgentEventGraph();

    expect(() => graph.emit(makeInvalidSemanticEvent())).toThrow("SemanticEvent missing actor metadata");
  });

  it("emits user-input and questionnaire-result events", () => {
    const graph = new AgentEventGraph();
    const received: SemanticEvent[] = [];

    graph.addConsumer((event) => received.push(event));
    graph.emitUserInput(actor, "hello");
    graph.emitQuestionnaireResult(actor, {
      questionnaireId: "q-1",
      toolCallId: "call-1",
      rawText: "yes",
      status: "ok",
      answers: { q1: true },
    });

    expect(received[0].event_type).toBe("semantic_user_input");
    expect(received[1].event_type).toBe("semantic_questionnaire_result");
  });

  it("emits tool-call-start and tool-call-result events", () => {
    const graph = new AgentEventGraph();
    const received: SemanticEvent[] = [];

    graph.addConsumer((event) => received.push(event));
    graph.emitToolCallStart(actor, "read_file", "tc-1", '{"path":"foo"}');
    graph.emitToolCallResult(actor, "read_file", "tc-1", "content", false);

    expect(received[0].event_type).toBe("semantic_tool_call_start");
    expect(received[1].event_type).toBe("semantic_tool_call_result");
  });

  it("emits agent turn start/end events", () => {
    const graph = new AgentEventGraph();
    const received: SemanticEvent[] = [];

    graph.addConsumer((event) => received.push(event));
    graph.emitAgentTurnStart(actor, 1);
    graph.emitAgentTurnEnd(actor, "done");

    expect(received[0].event_type).toBe("semantic_turn_start");
    expect(received[1].event_type).toBe("semantic_turn_end");
  });

  it("emits autonomous holon claim and idle-exit events with member identity", () => {
    const graph = new AgentEventGraph();
    const received: SemanticEvent[] = [];

    graph.addConsumer((event) => received.push(event));
    graph.emitAutonomousHolonClaim(actor, { taskId: "task-1", memberId: "member-1" });
    graph.emitAutonomousHolonIdleExit(actor, { memberId: "member-1", idleTimeoutMs: 30000 });

    expect(received[0]).toMatchObject({
      event_type: "semantic_notice",
      message: "Autonomous holon claim: task-1 -> member-1",
    });
    expect(received[1]).toMatchObject({
      event_type: "semantic_notice",
      message: "Autonomous holon idle exit: member-1 (30000ms)",
    });
  });

  it("does not expose legacy collective event aliases", () => {
    const graph = new AgentEventGraph();
    expect(typeof (graph as any).emitCollectiveClaim).toBe("undefined");
    expect(typeof (graph as any).emitCollectiveIdleExit).toBe("undefined");
  });

  it("dispose stops all consumers", () => {
    const graph = new AgentEventGraph();
    const received: SemanticEvent[] = [];

    graph.addConsumer((event) => received.push(event));
    graph.emitThinkStart(actor);
    graph.dispose();
    graph.emitThinkEnd(actor);

    expect(received.length).toBe(1);
  });

  it("handles consecutive identical events via sequence tracking", () => {
    const graph = new AgentEventGraph();
    const received: SemanticEvent[] = [];

    graph.addConsumer((event) => received.push(event));
    graph.emitContentDelta(actor, "a");
    graph.emitContentDelta(actor, "a");

    expect(received.length).toBe(2);
    expect(received[0].event_type).toBe("semantic_content_delta");
    expect(received[1].event_type).toBe("semantic_content_delta");
  });

  it("unsubscribe removes a single consumer", () => {
    const graph = new AgentEventGraph();
    const received1: SemanticEvent[] = [];
    const received2: SemanticEvent[] = [];

    const sub1 = graph.addConsumer((event) => received1.push(event));
    graph.addConsumer((event) => received2.push(event));

    graph.emitThinkStart(actor);
    sub1.unsubscribe();
    graph.emitThinkEnd(actor);

    expect(received1.length).toBe(1);
    expect(received2.length).toBe(2);
  });

  it("does not replay historical events to late subscribers", () => {
    const graph = new AgentEventGraph();
    const received: SemanticEvent[] = [];

    graph.emitThinkStart(actor);
    graph.emitThinkDelta(actor, "before-subscribe");

    graph.addConsumer((event) => received.push(event));
    graph.emitThinkEnd(actor);

    expect(received.length).toBe(1);
    expect(received[0]?.event_type).toBe("semantic_think_end");
  });
});
