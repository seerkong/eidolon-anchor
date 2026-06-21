import { describe, expect, it } from "bun:test";

import { buildRuntimeSemanticBase } from "@cell/ai-core-logic/stream/runtime/SemanticRuntimeSupport";
import {
  MessageHistoryGraph,
  type AnomalyEvent,
  type CommittedHistoryMessageEvent,
  type MessageHistoryEvent,
} from "@cell/ai-core-logic/stream/MessageHistoryGraph";
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";

import { load_history_records } from "./history_fixture";

type EventRecord = {
  stream: string;
  payload: string;
};

const SCENARIOS = ["msg-history-default", "msg-history-actor-switch"] as const;

describe("MessageHistoryGraph transcript fixtures", () => {
  for (const scenario of SCENARIOS) {
    it(`replays scenario: ${scenario}`, () => {
      const actual = run_scenario(scenario).map(project_history_record);
      const expected = load_expected_history_records(scenario);

      assert_record_sequence(actual, expected);
    });
  }

  it("flushes actor switch into separate think entries", () => {
    const actual = run_scenario("msg-history-actor-switch");
    const thinkRecords = actual.filter((event) => event.stream === "think");

    expect(thinkRecords.length).toBe(2);
    expect(thinkRecords.map((event) => event.payload)).toEqual(["A", "B"]);
  });

  it("preserves full questionnaire structure in history payloads", () => {
    const graph = new MessageHistoryGraph();
    const historyEvents: MessageHistoryEvent[] = [];

    graph.onHistoryEvent((event) => historyEvents.push(event));

    const base = createSemanticBuilder()("main", "actor-1");
    graph.consumeSemanticEvent({
      ...base,
      event_type: "semantic_questionnaire_request",
      questionnaire_request: {
        questionnaire_id: "travel-q",
        question: "Travel Intake",
        input_kind: "choice",
        options: [],
        payload_text: "Answer by label",
        title_text: "Travel Intake",
        intro_text: "Answer by label",
        response_protocol: "ask-multi-question-free",
        questions: [
          {
            question_id: "timing",
            prompt: "When are you traveling?",
            question_type: "single_select",
            required: true,
            help_text: "",
            options: [
              { option_id: "soon", label: "Soon", value_text: "soon", description: "" },
              { option_id: "later", label: "Later", value_text: "later", description: "" },
            ],
          },
          {
            question_id: "preferences",
            prompt: "What do you care about most?",
            question_type: "text",
            required: true,
            help_text: "Examples: food, nature, quiet pace",
            options: [],
          },
        ],
      },
      tool_call: {
        tool_call_id: "tc-structured-q",
        tool_name: "questionnaire",
        arguments_text: "",
        protocol: "unknown",
        call_kind: "unknown",
        raw_payload_text: "",
      },
    });

    const requestEvent = historyEvents.find((event) => event.stream === "questionnaire_request");
    expect(requestEvent).toBeDefined();

    const payload = JSON.parse(String(requestEvent?.payload ?? "{}")) as {
      title?: string;
      intro?: string;
      questions?: Array<{ id: string; prompt: string; type: string; helpText?: string }>;
    };

    expect(payload.title).toBe("Travel Intake");
    expect(payload.intro).toBe("Answer by label");
    expect(payload.questions).toHaveLength(2);
    expect(payload.questions?.[0]).toMatchObject({
      id: "timing",
      prompt: "When are you traveling?",
      type: "single_select",
    });
    expect(payload.questions?.[1]).toMatchObject({
      id: "preferences",
      prompt: "What do you care about most?",
      type: "text",
      helpText: "Examples: food, nature, quiet pace",
    });
  });

  it("emits message start/end timestamps from semantic stream boundaries", () => {
    const graph = new MessageHistoryGraph();
    const historyEvents: MessageHistoryEvent[] = [];

    graph.onHistoryEvent((event) => historyEvents.push(event));

    const base = createSemanticBuilder()("main", "actor-1");
    const semantic = (event_type: SemanticEvent["event_type"], emittedAt: number, extra: Record<string, unknown> = {}) => ({
      ...base,
      ...extra,
      trace: {
        ...base.trace,
        emitted_at: emittedAt,
      },
      event_type,
    }) as SemanticEvent;

    graph.consumeSemanticEvent(semantic("semantic_content_start", 100));
    graph.consumeSemanticEvent(semantic("semantic_content_delta", 110, { text: "hel" }));
    graph.consumeSemanticEvent(semantic("semantic_content_delta", 120, { text: "lo" }));
    graph.consumeSemanticEvent(semantic("semantic_content_end", 130));
    graph.consumeSemanticEvent(semantic("semantic_user_input", 200, { text: "hi", input_source: "tui" }));

    const assistantEvent = historyEvents.find((event) => event.stream === "content");
    const userEvent = historyEvents.find((event) => event.stream === "user_input");

    expect(assistantEvent).toMatchObject({
      stream: "content",
      payload: "hello",
      startAt: 100,
      endAt: 130,
    });
    expect(userEvent).toMatchObject({
      stream: "user_input",
      payload: "hi",
      startAt: 200,
      endAt: 200,
    });
  });

  it("emits committed messages from semantic commit boundaries", () => {
    const graph = new MessageHistoryGraph();
    const committed: CommittedHistoryMessageEvent[] = [];

    graph.onCommittedMessage((event) => committed.push(event));

    const base = createSemanticBuilder()("main", "actor-1");
    const semantic = (event_type: SemanticEvent["event_type"], emittedAt: number, extra: Record<string, unknown> = {}) => ({
      ...base,
      ...extra,
      trace: {
        ...base.trace,
        emitted_at: emittedAt,
      },
      event_type,
    }) as SemanticEvent;

    graph.consumeSemanticEvent(semantic("semantic_think_start", 100));
    graph.consumeSemanticEvent(semantic("semantic_think_delta", 110, { text: "plan " }));
    graph.consumeSemanticEvent(semantic("semantic_think_end", 120));
    graph.consumeSemanticEvent(semantic("semantic_content_start", 130));
    graph.consumeSemanticEvent(semantic("semantic_content_delta", 140, { text: "answer" }));
    graph.consumeSemanticEvent(semantic("semantic_content_end", 150));
    graph.consumeSemanticEvent(
      semantic("semantic_tool_call_planned", 160, {
        tool_call: {
          tool_call_id: "tc-1",
          tool_name: "read_file",
          arguments_text: "{\"path\":\"README.md\"}",
          protocol: "openai",
          call_kind: "json_function",
          raw_payload_text: "",
        },
      }),
    );
    graph.consumeSemanticEvent(
      semantic("semantic_tool_call_result", 170, {
        tool_call: {
          tool_call_id: "tc-1",
          tool_name: "read_file",
          arguments_text: "{\"path\":\"README.md\"}",
          protocol: "openai",
          call_kind: "json_function",
          raw_payload_text: "",
        },
        output_text: "done",
        is_error: false,
      }),
    );
    graph.consumeSemanticEvent(semantic("semantic_user_input", 200, { text: "next step", input_source: "tui" }));
    graph.complete();

    expect(committed).toHaveLength(3);
    expect(committed[0]?.message).toMatchObject({
      role: "assistant",
      content: "answer",
      reasoning_content: "plan ",
      startAt: 100,
      endAt: 160,
      toolCalls: [{ id: "tc-1", name: "read_file", input: { path: "README.md" } }],
    });
    expect(committed[1]?.message).toMatchObject({
      role: "tool",
      content: "done",
      toolCallId: "tc-1",
      startAt: 170,
      endAt: 170,
    });
    expect(committed[2]?.message).toMatchObject({
      role: "user",
      content: "next step",
      startAt: 200,
      endAt: 200,
    });
  });

  it("deduplicates planned and started tool calls in committed assistant messages", () => {
    const graph = new MessageHistoryGraph();
    const committed: CommittedHistoryMessageEvent[] = [];

    graph.onCommittedMessage((event) => committed.push(event));

    const base = createSemanticBuilder()("main", "actor-1");
    const semantic = (event_type: SemanticEvent["event_type"], emittedAt: number, extra: Record<string, unknown> = {}) => ({
      ...base,
      ...extra,
      trace: {
        ...base.trace,
        emitted_at: emittedAt,
      },
      event_type,
    }) as SemanticEvent;
    const tool_call = {
      tool_call_id: "tc-dup",
      tool_name: "read_file",
      arguments_text: "{\"path\":\"README.md\"}",
      protocol: "openai",
      call_kind: "json_function",
      raw_payload_text: "",
    };

    graph.consumeSemanticEvent(semantic("semantic_tool_call_planned", 100, { tool_call }));
    graph.consumeSemanticEvent(semantic("semantic_tool_call_start", 110, { tool_call }));
    graph.consumeSemanticEvent(semantic("semantic_tool_call_result", 120, {
      tool_call,
      output_text: "done",
      is_error: false,
    }));
    graph.complete();

    expect(committed[0]?.message.toolCalls).toEqual([
      { id: "tc-dup", name: "read_file", input: { path: "README.md" } },
    ]);
    expect(committed[1]?.message).toMatchObject({
      role: "tool",
      toolCallId: "tc-dup",
      content: "done",
    });
  });
});

describe("MessageHistoryGraph orphaned tool-result anomaly", () => {
  const semanticFactory = () => {
    const base = createSemanticBuilder()("main", "actor-1");
    return (event_type: SemanticEvent["event_type"], emittedAt: number, extra: Record<string, unknown> = {}) =>
      ({
        ...base,
        ...extra,
        trace: {
          ...base.trace,
          emitted_at: emittedAt,
        },
        event_type,
      }) as SemanticEvent;
  };

  const toolCall = (tool_call_id: string) => ({
    tool_call_id,
    tool_name: "read_file",
    arguments_text: "{\"path\":\"README.md\"}",
    protocol: "openai",
    call_kind: "json_function",
    raw_payload_text: "",
  });

  it("warns on a tool result whose tool_call_id was never seen (orphaned)", () => {
    const graph = new MessageHistoryGraph();
    const anomalies: AnomalyEvent[] = [];
    graph.onAnomaly((event) => anomalies.push(event));

    const semantic = semanticFactory();
    // Consume some events but NEVER an assistant tool-call for tc-orphan.
    graph.consumeSemanticEvent(semantic("semantic_content_start", 100));
    graph.consumeSemanticEvent(semantic("semantic_content_delta", 110, { text: "hi" }));
    graph.consumeSemanticEvent(semantic("semantic_content_end", 120));
    graph.consumeSemanticEvent(
      semantic("semantic_tool_call_result", 170, {
        tool_call: toolCall("tc-orphan"),
        output_text: "done",
        is_error: false,
      }),
    );
    graph.complete();

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      kind: "anomaly",
      reason: "orphaned_tool_result",
      toolCallId: "tc-orphan",
      agentKey: "main",
      agentActorId: "actor-1",
    });
  });

  it("does not warn when the tool result is paired with a seen assistant tool-call", () => {
    const graph = new MessageHistoryGraph();
    const anomalies: AnomalyEvent[] = [];
    graph.onAnomaly((event) => anomalies.push(event));

    const semantic = semanticFactory();
    graph.consumeSemanticEvent(semantic("semantic_tool_call_start", 110, { tool_call: toolCall("tc-paired") }));
    graph.consumeSemanticEvent(
      semantic("semantic_tool_call_result", 170, {
        tool_call: toolCall("tc-paired"),
        output_text: "done",
        is_error: false,
      }),
    );
    graph.complete();

    expect(anomalies).toHaveLength(0);
  });

  it("does not warn when the tool result is paired via semantic_tool_call_planned", () => {
    const graph = new MessageHistoryGraph();
    const anomalies: AnomalyEvent[] = [];
    graph.onAnomaly((event) => anomalies.push(event));

    const semantic = semanticFactory();
    graph.consumeSemanticEvent(semantic("semantic_tool_call_planned", 110, { tool_call: toolCall("tc-planned") }));
    graph.consumeSemanticEvent(
      semantic("semantic_tool_call_result", 170, {
        tool_call: toolCall("tc-planned"),
        output_text: "done",
        is_error: false,
      }),
    );
    graph.complete();

    expect(anomalies).toHaveLength(0);
  });

  it("commits the orphaned tool message unchanged and does not throw when the anomaly fires", () => {
    // Committed-message set must be byte-identical to the pre-anomaly behavior:
    // run the SAME event sequence on two graphs, one observing anomalies and one
    // not, and assert the committed batches are equal (observability-only).
    const semanticA = semanticFactory();
    const semanticB = semanticFactory();

    const runOrphanSequence = (
      semantic: ReturnType<typeof semanticFactory>,
      onAnomaly: ((event: AnomalyEvent) => void) | null,
    ): CommittedHistoryMessageEvent[] => {
      const graph = new MessageHistoryGraph();
      const committed: CommittedHistoryMessageEvent[] = [];
      graph.onCommittedMessage((event) => committed.push(event));
      if (onAnomaly) graph.onAnomaly(onAnomaly);

      expect(() => {
        graph.consumeSemanticEvent(semantic("semantic_content_start", 100));
        graph.consumeSemanticEvent(semantic("semantic_content_delta", 110, { text: "hi" }));
        graph.consumeSemanticEvent(semantic("semantic_content_end", 120));
        graph.consumeSemanticEvent(
          semantic("semantic_tool_call_result", 170, {
            tool_call: toolCall("tc-orphan"),
            output_text: "done",
            is_error: false,
          }),
        );
        graph.complete();
      }).not.toThrow();

      return committed;
    };

    const anomalies: AnomalyEvent[] = [];
    const withAnomaly = runOrphanSequence(semanticA, (event) => anomalies.push(event));
    const withoutAnomaly = runOrphanSequence(semanticB, null);

    // The anomaly fired (precondition for this assertion).
    expect(anomalies).toHaveLength(1);

    // The committed-message set is unchanged vs not observing the anomaly.
    expect(withAnomaly.map((event) => event.message)).toEqual(
      withoutAnomaly.map((event) => event.message),
    );
    // And the orphaned tool message is still committed exactly as today.
    const toolMessage = withAnomaly.find((event) => event.message.role === "tool");
    expect(toolMessage?.message).toMatchObject({
      role: "tool",
      content: "done",
      toolCallId: "tc-orphan",
    });
  });
});

describe("MessageHistoryGraph hollow assistant-commit anomaly", () => {
  const semanticFactory = () => {
    const base = createSemanticBuilder()("main", "actor-1");
    return (event_type: SemanticEvent["event_type"], emittedAt: number, extra: Record<string, unknown> = {}) =>
      ({
        ...base,
        ...extra,
        trace: {
          ...base.trace,
          emitted_at: emittedAt,
        },
        event_type,
      }) as SemanticEvent;
  };

  const toolCall = (tool_call_id: string) => ({
    tool_call_id,
    tool_name: "read_file",
    arguments_text: "{\"path\":\"README.md\"}",
    protocol: "openai",
    call_kind: "json_function",
    raw_payload_text: "",
  });

  it("warns when flushCommittedAssistant flushes a hollow pending (no content/reasoning/tool calls)", () => {
    const graph = new MessageHistoryGraph();
    const anomalies: AnomalyEvent[] = [];
    graph.onAnomaly((event) => anomalies.push(event));

    const semantic = semanticFactory();
    // think_start/think_end create an EMPTY pending assistant (no reasoning text,
    // no content, no tool calls). user_input then forces flushCommittedAssistant.
    graph.consumeSemanticEvent(semantic("semantic_think_start", 100));
    graph.consumeSemanticEvent(semantic("semantic_think_end", 110));
    graph.consumeSemanticEvent(semantic("semantic_user_input", 200, { text: "hi", input_source: "tui" }));
    graph.complete();

    const hollow = anomalies.filter((event) => event.reason === "hollow_assistant_commit");
    expect(hollow).toHaveLength(1);
    expect(hollow[0]).toMatchObject({
      kind: "anomaly",
      reason: "hollow_assistant_commit",
      agentKey: "main",
      agentActorId: "actor-1",
    });
    expect(hollow[0]?.toolCallId).toBeUndefined();
  });

  it("does not warn when the flushed pending has content (non-hollow)", () => {
    const graph = new MessageHistoryGraph();
    const anomalies: AnomalyEvent[] = [];
    graph.onAnomaly((event) => anomalies.push(event));

    const semantic = semanticFactory();
    graph.consumeSemanticEvent(semantic("semantic_content_start", 100));
    graph.consumeSemanticEvent(semantic("semantic_content_delta", 110, { text: "answer" }));
    graph.consumeSemanticEvent(semantic("semantic_content_end", 120));
    graph.consumeSemanticEvent(semantic("semantic_user_input", 200, { text: "hi", input_source: "tui" }));
    graph.complete();

    expect(anomalies.filter((event) => event.reason === "hollow_assistant_commit")).toHaveLength(0);
  });

  it("does not warn when the flushed pending has at least one tool call (non-hollow)", () => {
    const graph = new MessageHistoryGraph();
    const anomalies: AnomalyEvent[] = [];
    graph.onAnomaly((event) => anomalies.push(event));

    const semantic = semanticFactory();
    graph.consumeSemanticEvent(semantic("semantic_tool_call_start", 110, { tool_call: toolCall("tc-1") }));
    graph.consumeSemanticEvent(semantic("semantic_user_input", 200, { text: "hi", input_source: "tui" }));
    graph.complete();

    expect(anomalies.filter((event) => event.reason === "hollow_assistant_commit")).toHaveLength(0);
  });

  it("does not warn when the flushed pending has reasoning only (non-hollow)", () => {
    const graph = new MessageHistoryGraph();
    const anomalies: AnomalyEvent[] = [];
    graph.onAnomaly((event) => anomalies.push(event));

    const semantic = semanticFactory();
    // think_delta pushes text into pendingAssistant.reasoning (no content, no
    // tool calls). user_input then forces flushCommittedAssistant. A pending
    // with reasoning text only is NON-hollow and must NOT warn.
    graph.consumeSemanticEvent(semantic("semantic_think_start", 100));
    graph.consumeSemanticEvent(semantic("semantic_think_delta", 110, { text: "reasoning" }));
    graph.consumeSemanticEvent(semantic("semantic_think_end", 120));
    graph.consumeSemanticEvent(semantic("semantic_user_input", 200, { text: "hi", input_source: "tui" }));
    graph.complete();

    expect(anomalies.filter((event) => event.reason === "hollow_assistant_commit")).toHaveLength(0);
  });

  it("commits the hollow flush unchanged and does not throw when the anomaly fires", () => {
    // Observability-only: the committed-message set must be identical whether or
    // not the anomaly is observed. Today a hollow pending commits NOTHING (the
    // assembled message is null) — that must remain true.
    const semanticA = semanticFactory();
    const semanticB = semanticFactory();

    const runHollowSequence = (
      semantic: ReturnType<typeof semanticFactory>,
      onAnomaly: ((event: AnomalyEvent) => void) | null,
    ): CommittedHistoryMessageEvent[] => {
      const graph = new MessageHistoryGraph();
      const committed: CommittedHistoryMessageEvent[] = [];
      graph.onCommittedMessage((event) => committed.push(event));
      if (onAnomaly) graph.onAnomaly(onAnomaly);

      expect(() => {
        graph.consumeSemanticEvent(semantic("semantic_think_start", 100));
        graph.consumeSemanticEvent(semantic("semantic_think_end", 110));
        graph.consumeSemanticEvent(semantic("semantic_user_input", 200, { text: "hi", input_source: "tui" }));
        graph.complete();
      }).not.toThrow();

      return committed;
    };

    const anomalies: AnomalyEvent[] = [];
    const withAnomaly = runHollowSequence(semanticA, (event) => anomalies.push(event));
    const withoutAnomaly = runHollowSequence(semanticB, null);

    // The hollow anomaly fired (precondition for this assertion).
    expect(anomalies.filter((event) => event.reason === "hollow_assistant_commit")).toHaveLength(1);

    // The committed-message set is unchanged vs not observing the anomaly: a
    // hollow pending commits no assistant message; only the user message lands.
    expect(withAnomaly.map((event) => event.message)).toEqual(
      withoutAnomaly.map((event) => event.message),
    );
    expect(withAnomaly.some((event) => event.message.role === "assistant")).toBe(false);
    expect(withAnomaly.map((event) => event.message.role)).toEqual(["user"]);
  });
});

function run_scenario(scenario: string): MessageHistoryEvent[] {
  const graph = new MessageHistoryGraph();
  const historyEvents: MessageHistoryEvent[] = [];

  graph.onHistoryEvent((event) => historyEvents.push(event));

  for (const event of load_semantic_events(scenario)) {
    graph.consumeSemanticEvent(event);
  }

  graph.complete();
  return historyEvents;
}

function load_semantic_events(scenario: string): SemanticEvent[] {
  if (scenario === "msg-history-default") {
    const next = createSemanticBuilder();
    return [
      { ...next("main", "actor-1"), event_type: "semantic_think_start" },
      { ...next("main", "actor-1"), event_type: "semantic_think_delta", text: "t1" },
      { ...next("main", "actor-1"), event_type: "semantic_think_delta", text: "t2" },
      { ...next("main", "actor-1"), event_type: "semantic_think_end" },
      { ...next("main", "actor-1"), event_type: "semantic_content_start" },
      { ...next("main", "actor-1"), event_type: "semantic_content_delta", text: "c1" },
      { ...next("main", "actor-1"), event_type: "semantic_content_delta", text: "c2" },
      { ...next("main", "actor-1"), event_type: "semantic_content_end" },
      {
        ...next("main", "actor-1"),
        event_type: "semantic_tool_call_planned",
        tool_call: {
          tool_call_id: "tc-1",
          tool_name: "read_file",
          arguments_text: "{}",
          protocol: "openai",
          call_kind: "json_function",
          raw_payload_text: "",
        },
      },
      {
        ...next("main", "actor-1"),
        event_type: "semantic_error",
        error: {
          code: "",
          message: "bad",
          retryable: false,
          provider_status: 0,
          detail_text: "",
        },
      },
      {
        ...next("main", "actor-1"),
        event_type: "semantic_tool_call_start",
        tool_call: {
          tool_call_id: "tc-1",
          tool_name: "read",
          arguments_text: "{}",
          protocol: "unknown",
          call_kind: "unknown",
          raw_payload_text: "",
        },
      },
      {
        ...next("main", "actor-1"),
        event_type: "semantic_tool_call_result",
        tool_call: {
          tool_call_id: "tc-1",
          tool_name: "read",
          arguments_text: "",
          protocol: "unknown",
          call_kind: "unknown",
          raw_payload_text: "",
        },
        output_text: "ok",
        is_error: false,
      },
      {
        ...next("main", "actor-1"),
        event_type: "semantic_questionnaire_request",
        questionnaire_request: {
          questionnaire_id: "q-1",
          question: "Confirm",
          input_kind: "approval",
          options: [],
          payload_text: "",
        },
        tool_call: {
          tool_call_id: "tc-1",
          tool_name: "questionnaire",
          arguments_text: "",
          protocol: "unknown",
          call_kind: "unknown",
          raw_payload_text: "",
        },
      },
      {
        ...next("main", "actor-1"),
        event_type: "semantic_questionnaire_result",
        questionnaire_id: "q-1",
        response_text: "yes",
        approved: true,
      },
      {
        ...next("main", "actor-1"),
        event_type: "semantic_user_input",
        text: "hello",
        input_source: "tui",
      },
      { ...next("main", "actor-1"), event_type: "semantic_turn_start", turn_label: "1" },
      { ...next("main", "actor-1"), event_type: "semantic_turn_end", reason: "no_tool_calls" },
    ];
  }

  if (scenario === "msg-history-actor-switch") {
    const next = createSemanticBuilder();
    return [
      { ...next("main", "main"), event_type: "semantic_think_start" },
      { ...next("main", "main"), event_type: "semantic_think_delta", text: "A" },
      { ...next("sub", "sub-1"), event_type: "semantic_think_delta", text: "B" },
      { ...next("sub", "sub-1"), event_type: "semantic_think_end" },
    ];
  }

  throw new Error(`unknown scenario: ${scenario}`);
}

function load_expected_history_records(scenario: string): EventRecord[] {
  return load_history_records(scenario)
    .map((record) => ({
      stream: record.stream,
      payload: normalize_payload(record.payload),
    }));
}

function project_history_record(event: MessageHistoryEvent): EventRecord {
  return {
    stream: event.stream,
    payload: normalize_payload(event.payload),
  };
}

function assert_record_sequence(actual: EventRecord[], expected: EventRecord[]): void {
  expect(actual.length).toBe(expected.length);

  for (let i = 0; i < expected.length; i += 1) {
    expect(actual[i].stream).toBe(expected[i].stream);
    expect(parse_payload(actual[i].payload)).toEqual(parse_payload(expected[i].payload));
  }
}

function parse_payload(payload: string): unknown {
  const trimmed = payload.trim();
  if (!trimmed) {
    return normalize_payload(payload);
  }
  if (!looks_like_json(trimmed)) {
    return normalize_payload(payload);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return normalize_payload(payload);
  }
}

function normalize_payload(payload: string): string {
  return payload.replace(/\n$/, "");
}

function looks_like_json(payload: string): boolean {
  return (
    (payload.startsWith("{") && payload.endsWith("}")) ||
    (payload.startsWith("[") && payload.endsWith("]"))
  );
}

function createSemanticBuilder(): (agentKey: string, agentActorId: string) => Pick<SemanticEvent, "trace" | "actor" | "team"> {
  let sequence = 0;
  return (agentKey: string, agentActorId: string) => {
    sequence += 1;
    return buildRuntimeSemanticBase({ agentKey, agentActorId }, sequence);
  };
}
