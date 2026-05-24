import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic";
import { StreamTranscript, type TranscriptRecord } from "@cell/symbiont-logic/stream/StreamTranscript";
import { runReferenceAlignedStageScenarioDetailed } from "@cell/ai-core-logic/stream/testing/referenceAlignedStageScenario";
import { TextualProjectionGraph } from "@terminal/organ/stream/TextualProjectionGraph";
import { TuiProjectionGraph } from "@terminal/organ/stream/TuiProjectionGraph";
import type { TuiEvent } from "@terminal/core/AIAgent/TuiStreamEvents";

const FIXTURE_ROOT = path.resolve(import.meta.dir, "../../resources/projection");
const PIPELINE_SCENARIOS = [
  "default",
  "chunked-markers",
  "quote-chunked",
  "content-unquote",
  "toolcall-delta",
  "toolcall-multiple",
  "toolcall-alt-format",
] as const;
const SEMANTIC_FIXTURE_SCENARIOS = [
  "tui-turn-events",
  "questionnaire",
  "plan-approval",
  "shutdown",
  "background-result",
] as const;

describe("reference aligned terminal projection", () => {
  for (const scenario of PIPELINE_SCENARIOS) {
    test(`TuiProjectionGraph matches ${scenario}`, async () => {
      const semanticEvents = await loadScenarioSemanticEvents(scenario);
      expect(normalizeEvents(runTuiProjection(semanticEvents))).toEqual(
        normalizeEvents(loadExpectedEvents(scenario, "tui.txt")),
      );
    });

    test(`TextualProjectionGraph matches ${scenario}`, async () => {
      const semanticEvents = await loadScenarioSemanticEvents(scenario);
      expect(normalizeEvents(runTextualProjection(semanticEvents))).toEqual(
        normalizeEvents(loadExpectedEvents(scenario, "textual.txt")),
      );
    });
  }

  for (const scenario of SEMANTIC_FIXTURE_SCENARIOS) {
    test(`TuiProjectionGraph matches semantic fixture ${scenario}`, async () => {
      const semanticEvents = await loadScenarioSemanticEvents(scenario);
      expect(normalizeEvents(runTuiProjection(semanticEvents))).toEqual(
        normalizeEvents(loadExpectedEvents(scenario, "tui.txt")),
      );
    });

    test(`TextualProjectionGraph matches semantic fixture ${scenario}`, async () => {
      const semanticEvents = await loadScenarioSemanticEvents(scenario);
      expect(normalizeEvents(runTextualProjection(semanticEvents))).toEqual(
        normalizeEvents(loadExpectedEvents(scenario, "textual.txt")),
      );
    });
  }

  test("projectors consume semantic control events directly", () => {
    const semanticEvents = buildManualControlScenario();
    const tuiEvents = normalizeEvents(runTuiProjection(semanticEvents));
    const textualEvents = normalizeEvents(runTextualProjection(semanticEvents));

    expect(tuiEvents).toEqual([
      { kind: "control", payload: { cmd: "NewMessage", category: "turn" } },
      { kind: "message", payload: "Starting turn turn-1" },
      { kind: "control", payload: { cmd: "NewMessage", category: "toolcall" } },
      { kind: "message", payload: "read_file [tc-1]" },
      { kind: "control", payload: { cmd: "NewMessage", category: "result" } },
      { kind: "message", payload: "read_file: ok" },
      { kind: "control", payload: { cmd: "NewMessage", category: "questionnaire" } },
      { kind: "message", payload: "Approve plan?\n1) Yes\n2) No" },
      { kind: "control", payload: { cmd: "NewMessage", category: "done" } },
      { kind: "message", payload: "Turn done" },
    ]);

    expect(textualEvents).toEqual([
      { kind: "control", payload: { cmd: "NewMessage", category: "turn" } },
      { kind: "message", payload: "🚀 Turn: Starting turn turn-1" },
      { kind: "control", payload: { cmd: "NewMessage", category: "toolcall" } },
      { kind: "message", payload: "🔧 ToolCall: read_file [tc-1]" },
      { kind: "control", payload: { cmd: "NewMessage", category: "result" } },
      { kind: "message", payload: "✅ Result: read_file: ok" },
      { kind: "control", payload: { cmd: "NewMessage", category: "questionnaire" } },
      { kind: "message", payload: "❓ Questionnaire: Approve plan?\n1) Yes\n2) No" },
      { kind: "control", payload: { cmd: "NewMessage", category: "done" } },
      { kind: "message", payload: "🏁 Done: Turn done" },
    ]);
  });

  test("projectors cover extended semantic control surfaces", () => {
    const semanticEvents = buildExtendedControlScenario();
    const tuiEvents = normalizeEvents(runTuiProjection(semanticEvents));
    const textualEvents = normalizeEvents(runTextualProjection(semanticEvents));

    expect(tuiEvents).toEqual([
      { kind: "control", payload: { cmd: "NewMessage", category: "questionnaire" } },
      { kind: "message", payload: "Plan approval plan-1\n1. do work" },
      { kind: "control", payload: { cmd: "NewMessage", category: "result" } },
      { kind: "message", payload: "Plan approval approved: looks good" },
      { kind: "control", payload: { cmd: "NewMessage", category: "notice" } },
      { kind: "message", payload: "Shutdown request shutdown-1 worker-1\nmaintenance" },
      { kind: "control", payload: { cmd: "NewMessage", category: "result" } },
      { kind: "message", payload: "job-1: completed" },
      { kind: "control", payload: { cmd: "NewMessage", category: "notice" } },
      { kind: "message", payload: "team green" },
    ]);

    expect(textualEvents).toEqual([
      { kind: "control", payload: { cmd: "NewMessage", category: "questionnaire" } },
      { kind: "message", payload: "❓ Questionnaire: Plan approval plan-1\n1. do work" },
      { kind: "control", payload: { cmd: "NewMessage", category: "result" } },
      { kind: "message", payload: "✅ Result: Plan approval approved: looks good" },
      { kind: "control", payload: { cmd: "NewMessage", category: "notice" } },
      { kind: "message", payload: "ℹ️ Notice: Shutdown request shutdown-1 worker-1\nmaintenance" },
      { kind: "control", payload: { cmd: "NewMessage", category: "result" } },
      { kind: "message", payload: "✅ Result: job-1: completed" },
      { kind: "control", payload: { cmd: "NewMessage", category: "notice" } },
      { kind: "message", payload: "ℹ️ Notice: team green" },
    ]);
  });

  test("projectors render structured questionnaires with protocol-aligned labels", () => {
    const semanticEvents = buildStructuredQuestionnaireScenario();
    const tuiEvents = normalizeEvents(runTuiProjection(semanticEvents));
    const textualEvents = normalizeEvents(runTextualProjection(semanticEvents));

    expect(tuiEvents).toEqual([
      { kind: "control", payload: { cmd: "NewMessage", category: "questionnaire" } },
      {
        kind: "message",
        payload:
          "Travel Intake\nAnswer by option label or add your own preference when needed.\nReply format: Q1: A ; Q2: B ; Q3: D your answer\n\nQ1. When are you planning to travel?\nA) Within 1 month\nB) 1-3 months\nC) More than 3 months away\nD) Other (type your answer)\n\nQ2. What do you care about most for this trip?\nA) Food\nB) Nature\nC) Museums\nD) Other (type your answer)",
      },
    ]);

    expect(textualEvents).toEqual([
      { kind: "control", payload: { cmd: "NewMessage", category: "questionnaire" } },
      {
        kind: "message",
        payload:
          "❓ Questionnaire: Travel Intake\nAnswer by option label or add your own preference when needed.\nReply format: Q1: A ; Q2: B ; Q3: D your answer\n\nQ1. When are you planning to travel?\nA) Within 1 month\nB) 1-3 months\nC) More than 3 months away\nD) Other (type your answer)\n\nQ2. What do you care about most for this trip?\nA) Food\nB) Nature\nC) Museums\nD) Other (type your answer)",
      },
    ]);
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

function runTuiProjection(events: SemanticEvent[]): TuiEvent[] {
  const graph = new TuiProjectionGraph();
  const output: TuiEvent[] = [];
  graph.onTuiEvent((event) => output.push(event));
  for (const event of events) {
    graph.consumeSemanticEvent(event);
  }
  return output;
}

function runTextualProjection(events: SemanticEvent[]): TuiEvent[] {
  const graph = new TextualProjectionGraph();
  const output: TuiEvent[] = [];
  graph.onTuiEvent((event) => output.push(event));
  for (const event of events) {
    graph.consumeSemanticEvent(event);
  }
  return output;
}

function loadExpectedEvents(
  scenario: string,
  fileName: "tui.txt" | "textual.txt",
): TuiEvent[] {
  const filePath = path.join(FIXTURE_ROOT, scenario, fileName);
  const text = fs.readFileSync(filePath, "utf-8");
  const records = StreamTranscript.parse(text).records;

  return records.map((record) => {
    if (record.stream === "tuiControl") {
      return { kind: "control", payload: JSON.parse(record.payload) };
    }
    return { kind: "message", payload: record.payload };
  });
}

function normalizeEvents(events: TuiEvent[]): TuiEvent[] {
  return events.map((event) => {
    if (event.kind === "control") {
      return event;
    }
    return {
      kind: "message",
      payload: event.payload.replace(/\n+$/, ""),
    };
  });
}

function buildManualControlScenario(): SemanticEvent[] {
  const base = {
    trace: {
      event_id: "",
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
      sequence: 0,
      emitted_at: 0,
      surface: "unknown" as const,
    },
    actor: {
      actor_id: "a1",
      actor_name: "main",
      actor_kind: "primary",
      agent_definition_name: null,
      agent_manifest_type: "unknown" as const,
      role_label: null,
      actor_projection: null,
      parent_actor_id: null,
      root_actor_id: null,
    },
    team: {
      team_id: "team-1",
      team_name: "Team",
      coordinator_actor_id: "",
      teammate_name: "",
      teammate_role: "",
      task_id: "",
    },
  };

  return [
    { ...base, event_type: "semantic_turn_start", turn_label: "turn-1" },
    {
      ...base,
      event_type: "semantic_tool_call_start",
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
      ...base,
      event_type: "semantic_tool_call_result",
      tool_call: {
        tool_call_id: "tc-1",
        tool_name: "read_file",
        arguments_text: "{}",
        protocol: "openai",
        call_kind: "json_function",
        raw_payload_text: "",
      },
      output_text: "ok",
      is_error: false,
    },
    {
      ...base,
      event_type: "semantic_questionnaire_request",
      questionnaire_request: {
        questionnaire_id: "q-1",
        question: "Approve plan?",
        input_kind: "choice",
        options: [
          { option_id: "yes", label: "Yes", value_text: "yes", description: "" },
          { option_id: "no", label: "No", value_text: "no", description: "" },
        ],
        payload_text: "",
      },
      tool_call: null,
    },
    { ...base, event_type: "semantic_turn_end", reason: "done" },
  ];
}

function buildExtendedControlScenario(): SemanticEvent[] {
  const base = buildManualControlScenario()[0]!;
  return [
    {
      ...base,
      event_type: "semantic_plan_approval_request",
      request_id: "plan-1",
      plan_text: "1. do work",
    },
    {
      ...base,
      event_type: "semantic_plan_approval_result",
      request_id: "plan-1",
      approved: true,
      feedback_text: "looks good",
    },
    {
      ...base,
      event_type: "semantic_shutdown_request",
      request_id: "shutdown-1",
      target_name: "worker-1",
      reason_text: "maintenance",
    },
    {
      ...base,
      event_type: "semantic_background_result",
      background_result: {
        task_id: "job-1",
        status: "done",
        result_text: "completed",
      },
    },
    {
      ...base,
      event_type: "semantic_team_status",
      team_status: {
        team_name: "green",
        members: [],
        summary_text: "team green",
      },
    },
  ];
}

function buildStructuredQuestionnaireScenario(): SemanticEvent[] {
  const base = {
    trace: {
      event_id: "",
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
      sequence: 0,
      emitted_at: 0,
      surface: "unknown" as const,
    },
    actor: {
      actor_id: "a1",
      actor_name: "main",
      actor_kind: "primary",
      agent_definition_name: null,
      agent_manifest_type: "unknown" as const,
      role_label: null,
      actor_projection: null,
      parent_actor_id: null,
      root_actor_id: null,
    },
    team: {
      team_id: "team-1",
      team_name: "Team",
      coordinator_actor_id: "",
      teammate_name: "",
      teammate_role: "",
      task_id: "",
    },
  };

  return [
    {
      ...base,
      event_type: "semantic_questionnaire_request",
      questionnaire_request: {
        questionnaire_id: "travel-q",
        question: "Travel Intake",
        input_kind: "choice",
        options: [],
        payload_text: "Answer by option label or add your own preference when needed.",
        title_text: "Travel Intake",
        intro_text: "Answer by option label or add your own preference when needed.",
        response_protocol: "ask-multi-question-free",
        questions: [
          {
            question_id: "timing",
            prompt: "When are you planning to travel?",
            question_type: "single_select",
            required: true,
            help_text: "",
            options: [
              { option_id: "soon", label: "Within 1 month", value_text: "Within 1 month", description: "" },
              { option_id: "later", label: "1-3 months", value_text: "1-3 months", description: "" },
              { option_id: "far", label: "More than 3 months away", value_text: "More than 3 months away", description: "" },
            ],
          },
          {
            question_id: "preferences",
            prompt: "What do you care about most for this trip?",
            question_type: "single_select",
            required: true,
            help_text: "",
            options: [
              { option_id: "food", label: "Food", value_text: "Food", description: "" },
              { option_id: "nature", label: "Nature", value_text: "Nature", description: "" },
              { option_id: "museum", label: "Museums", value_text: "Museums", description: "" },
            ],
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
    },
  ];
}
