import { describe, expect, it } from "bun:test";

import type { TurnState } from "@cell/ai-core-contract/runtime/TurnState";
import {
  isTerminalTurnState,
  turnReducer,
} from "@cell/ai-organ-logic/runtime/TurnReducer";

describe("TurnState ADT and turnReducer", () => {
  it("constructs serializable variants with variant-local fields", () => {
    const variants: TurnState[] = [
      { kind: "drain", turn: 0 },
      { kind: "start_llm", turn: 1, reason: "fresh" },
      { kind: "wait_llm", turn: 1, opId: "llm-1", providerCallId: "provider-1" },
      { kind: "start_tool", turn: 1, toolCallId: "tool-1", funcName: "read", args: { filePath: "README.md" } },
      {
        kind: "wait_tool",
        turn: 1,
        opId: "tool-1-op",
        toolCallId: "tool-1",
        funcName: "read",
        gateDecision: { kind: "allow" },
      },
      {
        kind: "wait_questionnaire_parse",
        turn: 1,
        opId: "questionnaire-1",
        toolCallId: "tool-1",
        questionnaireId: "q-1",
        rawText: "answer",
      },
      { kind: "wait_compress", turn: 1, opId: "compress-1", reason: "token_threshold" },
      { kind: "wait_human", turn: 1, reason: "approval" },
      { kind: "completed", turn: 1, stopReason: "no_tool_calls" },
      { kind: "failed", turn: 1, error: "provider failed" },
    ];

    expect(JSON.parse(JSON.stringify(variants))).toEqual(variants);
    expect(variants.map((variant) => variant.kind)).toEqual([
      "drain",
      "start_llm",
      "wait_llm",
      "start_tool",
      "wait_tool",
      "wait_questionnaire_parse",
      "wait_compress",
      "wait_human",
      "completed",
      "failed",
    ]);
    expect(isTerminalTurnState(variants[8])).toBe(true);
    expect(isTerminalTurnState(variants[9])).toBe(true);
    expect(isTerminalTurnState(variants[2])).toBe(false);
  });

  it("moves drain to start_llm with a data-only effect", () => {
    const result = turnReducer({ kind: "drain", turn: 0 }, { kind: "start_llm_requested", reason: "fresh" });

    expect(result).toEqual({
      state: { kind: "start_llm", turn: 1, reason: "fresh" },
      effects: [{ kind: "prepare_provider_call", turn: 1, reason: "fresh" }],
    });
  });

  it("moves start_llm to wait_llm and records the providerCallId", () => {
    const result = turnReducer(
      { kind: "start_llm", turn: 2, reason: "tool_continuation" },
      { kind: "provider_call_started", opId: "llm-op-2", providerCallId: "provider-2" },
    );

    expect(result.state).toEqual({
      kind: "wait_llm",
      turn: 2,
      opId: "llm-op-2",
      providerCallId: "provider-2",
    });
    expect(result.effects).toEqual([{ kind: "await_provider_call", opId: "llm-op-2", providerCallId: "provider-2" }]);
  });

  it("moves start_tool to wait_tool with the gate decision embedded in state", () => {
    const result = turnReducer(
      { kind: "start_tool", turn: 3, toolCallId: "tool-3", funcName: "bash", args: { command: "pwd" } },
      { kind: "tool_gate_decided", opId: "tool-op-3", gateDecision: { kind: "deny", reason: "network_disabled", message: "blocked" } },
    );

    expect(result.state).toEqual({
      kind: "wait_tool",
      turn: 3,
      opId: "tool-op-3",
      toolCallId: "tool-3",
      funcName: "bash",
      gateDecision: { kind: "deny", reason: "network_disabled", message: "blocked" },
    });
    expect(result.effects).toEqual([
      {
        kind: "dispatch_tool_call",
        opId: "tool-op-3",
        toolCallId: "tool-3",
        funcName: "bash",
        args: { command: "pwd" },
        gateDecision: { kind: "deny", reason: "network_disabled", message: "blocked" },
      },
    ]);
  });

  it("moves wait states to terminal variants without side effects", () => {
    expect(
      turnReducer(
        { kind: "wait_llm", turn: 4, opId: "llm-op-4", providerCallId: "provider-4" },
        { kind: "provider_completed", opId: "llm-op-4", hasToolCalls: false },
      ),
    ).toEqual({ state: { kind: "completed", turn: 4, stopReason: "no_tool_calls" }, effects: [] });

    expect(
      turnReducer(
        {
          kind: "wait_tool",
          turn: 4,
          opId: "tool-op-4",
          toolCallId: "tool-4",
          funcName: "read",
          gateDecision: { kind: "allow" },
        },
        { kind: "tool_failed", opId: "tool-op-4", error: "boom" },
      ),
    ).toEqual({ state: { kind: "failed", turn: 4, error: "boom" }, effects: [] });
  });

  it("is pure for identical state and event inputs", () => {
    const state: TurnState = { kind: "start_llm", turn: 5, reason: "compress_followup" };
    const event = { kind: "provider_call_started" as const, opId: "llm-op-5", providerCallId: "provider-5" };

    expect(turnReducer(state, event)).toEqual(turnReducer(state, event));
    expect(state).toEqual({ kind: "start_llm", turn: 5, reason: "compress_followup" });
  });
});

// Spec ai-turn-execution-spine / gate G-ai-wait-message: the provider / tool /
// human / questionnaire / compress wait boundaries are DISTINCT owned turn-state
// facts (the formal turn.wait_boundary fact node), each carrying its own
// boundary fields — not one undifferentiated "waiting" flag.
describe("turn wait boundaries are distinct owned facts (G-ai-wait-message)", () => {
  const waitTool: TurnState = {
    kind: "wait_tool",
    turn: 2,
    opId: "tool-1",
    toolCallId: "tc-1",
    funcName: "read_file",
    gateDecision: { kind: "allow" },
  };

  it("provider wait (wait_llm) carries the provider_call_id boundary", () => {
    const { state } = turnReducer(
      { kind: "start_llm", turn: 2, reason: "fresh" },
      { kind: "provider_call_started", opId: "llm-1", providerCallId: "pc-1" },
    );
    expect(state).toEqual({ kind: "wait_llm", turn: 2, opId: "llm-1", providerCallId: "pc-1" });
  });

  it("tool wait (wait_tool) carries the tool_call_id + gate decision boundary", () => {
    const { state } = turnReducer(
      { kind: "start_tool", turn: 2, toolCallId: "tc-1", funcName: "read_file", args: {} },
      { kind: "tool_gate_decided", opId: "tool-1", gateDecision: { kind: "allow" } },
    );
    expect(state).toMatchObject({ kind: "wait_tool", toolCallId: "tc-1", gateDecision: { kind: "allow" } });
  });

  it("human wait (wait_human) carries the human-wait reason boundary", () => {
    const { state } = turnReducer(waitTool, { kind: "human_wait_requested", reason: "approval" });
    expect(state).toEqual({ kind: "wait_human", turn: 2, reason: "approval" });
  });

  it("questionnaire wait carries the questionnaire_id boundary", () => {
    const { state } = turnReducer(waitTool, {
      kind: "questionnaire_parse_started",
      opId: "q-op-1",
      questionnaireId: "q-1",
      toolCallId: "tc-1",
      rawText: "answer",
    });
    expect(state).toMatchObject({ kind: "wait_questionnaire_parse", questionnaireId: "q-1", toolCallId: "tc-1" });
  });

  it("compress wait carries the compression-trigger boundary", () => {
    const { state } = turnReducer(waitTool, { kind: "compression_started", opId: "c-1", reason: "token_threshold" });
    expect(state).toEqual({ kind: "wait_compress", turn: 2, opId: "c-1", reason: "token_threshold" });
  });

  it("the five wait boundaries are five distinct turn-state kinds", () => {
    const kinds = new Set([
      turnReducer({ kind: "start_llm", turn: 1, reason: "fresh" }, { kind: "provider_call_started", opId: "l", providerCallId: "p" }).state.kind,
      turnReducer({ kind: "start_tool", turn: 1, toolCallId: "t", funcName: "f", args: {} }, { kind: "tool_gate_decided", opId: "o", gateDecision: { kind: "allow" } }).state.kind,
      turnReducer(waitTool, { kind: "human_wait_requested", reason: "answer" }).state.kind,
      turnReducer(waitTool, { kind: "questionnaire_parse_started", opId: "q", questionnaireId: "qid", toolCallId: "tc", rawText: "" }).state.kind,
      turnReducer(waitTool, { kind: "compression_started", opId: "c", reason: "manual" }).state.kind,
    ]);
    expect(kinds).toEqual(new Set(["wait_llm", "wait_tool", "wait_human", "wait_questionnaire_parse", "wait_compress"]));
  });
});
