import type {
  TurnEffect,
  TurnEvent,
  TurnReducerResult,
  TurnState,
} from "@cell/ai-core-contract/runtime/TurnState";

export function isTerminalTurnState(state: TurnState): state is Extract<TurnState, { kind: "completed" | "failed" }> {
  return state.kind === "completed" || state.kind === "failed";
}

export function turnReducer(state: TurnState, event: TurnEvent): TurnReducerResult {
  if (isTerminalTurnState(state)) {
    return { state, effects: [] };
  }

  if (event.kind === "cancelled") {
    return { state: { kind: "failed", turn: state.turn, error: event.reason }, effects: [] };
  }

  switch (state.kind) {
    case "drain":
      if (event.kind === "start_llm_requested") {
        const nextTurn = state.turn + 1;
        return {
          state: { kind: "start_llm", turn: nextTurn, reason: event.reason },
          effects: [{ kind: "prepare_provider_call", turn: nextTurn, reason: event.reason }],
        };
      }
      if (event.kind === "tool_call_selected") {
        return startToolFromEvent(state.turn, event);
      }
      break;
    case "start_llm":
      if (event.kind === "provider_call_started") {
        return {
          state: { kind: "wait_llm", turn: state.turn, opId: event.opId, providerCallId: event.providerCallId },
          effects: [{ kind: "await_provider_call", opId: event.opId, providerCallId: event.providerCallId }],
        };
      }
      break;
    case "wait_llm":
      return reduceWaitLlm(state, event);
    case "start_tool":
      if (event.kind === "tool_gate_decided") {
        const effect: TurnEffect = {
          kind: "dispatch_tool_call",
          opId: event.opId,
          toolCallId: state.toolCallId,
          funcName: state.funcName,
          args: state.args,
          gateDecision: event.gateDecision,
        };
        return {
          state: {
            kind: "wait_tool",
            turn: state.turn,
            opId: event.opId,
            toolCallId: state.toolCallId,
            funcName: state.funcName,
            gateDecision: event.gateDecision,
          },
          effects: [effect],
        };
      }
      break;
    case "wait_tool":
      return reduceWaitTool(state, event);
    case "wait_questionnaire_parse":
      if (event.kind === "questionnaire_parse_completed" && event.opId === state.opId) {
        return { state: { kind: "drain", turn: state.turn }, effects: [] };
      }
      break;
    case "wait_compress":
      if (event.kind === "compression_completed" && event.opId === state.opId) {
        return { state: { kind: "start_llm", turn: state.turn, reason: "compress_followup" }, effects: [] };
      }
      break;
    case "wait_human":
      break;
  }

  return { state, effects: [] };
}

function startToolFromEvent(turn: number, event: Extract<TurnEvent, { kind: "tool_call_selected" }>): TurnReducerResult {
  return {
    state: {
      kind: "start_tool",
      turn,
      toolCallId: event.toolCallId,
      funcName: event.funcName,
      args: event.args,
    },
    effects: [],
  };
}

function reduceWaitLlm(state: Extract<TurnState, { kind: "wait_llm" }>, event: TurnEvent): TurnReducerResult {
  if (event.kind === "provider_completed" && event.opId === state.opId) {
    if (event.hasToolCalls) {
      return { state: { kind: "drain", turn: state.turn }, effects: [] };
    }
    return { state: { kind: "completed", turn: state.turn, stopReason: "no_tool_calls" }, effects: [] };
  }
  if (event.kind === "provider_failed" && event.opId === state.opId) {
    return { state: { kind: "failed", turn: state.turn, error: event.error }, effects: [] };
  }
  if (event.kind === "tool_call_selected") {
    return startToolFromEvent(state.turn, event);
  }
  return { state, effects: [] };
}

function reduceWaitTool(state: Extract<TurnState, { kind: "wait_tool" }>, event: TurnEvent): TurnReducerResult {
  if (event.kind === "tool_completed" && event.opId === state.opId) {
    return { state: { kind: "drain", turn: state.turn }, effects: [] };
  }
  if (event.kind === "tool_failed" && event.opId === state.opId) {
    return { state: { kind: "failed", turn: state.turn, error: event.error }, effects: [] };
  }
  if (event.kind === "questionnaire_parse_started") {
    return {
      state: {
        kind: "wait_questionnaire_parse",
        turn: state.turn,
        opId: event.opId,
        toolCallId: event.toolCallId,
        questionnaireId: event.questionnaireId,
        rawText: event.rawText,
      },
      effects: [{ kind: "await_questionnaire_parse", opId: event.opId, questionnaireId: event.questionnaireId, toolCallId: event.toolCallId }],
    };
  }
  if (event.kind === "compression_started") {
    return {
      state: { kind: "wait_compress", turn: state.turn, opId: event.opId, reason: event.reason },
      effects: [{ kind: "await_compression", opId: event.opId, reason: event.reason }],
    };
  }
  if (event.kind === "human_wait_requested") {
    return { state: { kind: "wait_human", turn: state.turn, reason: event.reason }, effects: [{ kind: "await_human", reason: event.reason }] };
  }
  return { state, effects: [] };
}
