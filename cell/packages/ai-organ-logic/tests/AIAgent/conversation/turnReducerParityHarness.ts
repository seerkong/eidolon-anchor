import type { TurnEvent, TurnState } from "@cell/ai-core-contract/runtime/TurnState";
import { turnReducer } from "@cell/ai-organ-logic/runtime/TurnReducer";

export type ScriptedTurnStep =
  | { kind: "start_llm"; reason?: "fresh" | "tool_continuation" | "compress_followup"; opId: string; providerCallId: string }
  | { kind: "provider_done"; opId: string; hasToolCalls: boolean }
  | { kind: "tool"; toolCallId: string; funcName: string; args: unknown; opId: string; gateDecision?: { kind: "allow" } }
  | { kind: "tool_done"; opId: string }
  | { kind: "provider_failed"; opId: string; error: string };

export type TurnTransitionSnapshot = {
  state: TurnState["kind"];
  turn: number;
  effectKinds: string[];
  toolCallId?: string;
  providerCallId?: string;
};

export type TurnParityRun = {
  legacy: TurnTransitionSnapshot[];
  reducer: TurnTransitionSnapshot[];
};

export type StreamingReducerParityRun = {
  cooperative: TurnTransitionSnapshot[];
  streaming: TurnTransitionSnapshot[];
};

export function runCooperativeViaReducerParityHarness(steps: ScriptedTurnStep[]): TurnParityRun {
  return {
    legacy: runLegacyCooperativeProjection(steps),
    reducer: runReducerProjection(steps),
  };
}

export function runStreamingViaReducerParityHarness(steps: ScriptedTurnStep[]): StreamingReducerParityRun {
  return {
    cooperative: runReducerProjection(steps),
    streaming: runStreamingReducerProjection(steps),
  };
}

function runReducerProjection(steps: ScriptedTurnStep[]): TurnTransitionSnapshot[] {
  let state: TurnState = { kind: "drain", turn: 0 };
  const snapshots: TurnTransitionSnapshot[] = [snapshot(state, [])];

  for (const event of expandScriptToReducerEvents(steps)) {
    const result = turnReducer(state, event);
    state = result.state;
    snapshots.push(snapshot(state, result.effects.map((effect) => effect.kind)));
  }
  return snapshots;
}

function runStreamingReducerProjection(steps: ScriptedTurnStep[]): TurnTransitionSnapshot[] {
  // This harness is a MODEL-level check that the reducer projection is
  // deterministic (streaming and cooperative both drive the same reducer).
  // The REAL behavior-equivalence test — same scripted provider script through
  // the two production entrypoints (aiAgentLoopStreaming + aiAgentCooperativeStep)
  // asserting an identical conversation — lives in
  // tests/AIAgent/conversation/entry_equivalence.test.ts.
  return runReducerProjection(steps);
}

function runLegacyCooperativeProjection(steps: ScriptedTurnStep[]): TurnTransitionSnapshot[] {
  let state: TurnState = { kind: "drain", turn: 0 };
  const snapshots: TurnTransitionSnapshot[] = [snapshot(state, [])];

  for (const step of steps) {
    switch (step.kind) {
      case "start_llm": {
        const turn = state.turn + 1;
        state = { kind: "start_llm", turn, reason: step.reason ?? "fresh" };
        snapshots.push(snapshot(state, ["prepare_provider_call"]));
        state = { kind: "wait_llm", turn, opId: step.opId, providerCallId: step.providerCallId };
        snapshots.push(snapshot(state, ["await_provider_call"]));
        break;
      }
      case "provider_done":
        if (state.kind !== "wait_llm" || state.opId !== step.opId) {
          snapshots.push(snapshot(state, []));
          break;
        }
        state = step.hasToolCalls
          ? { kind: "drain", turn: state.turn }
          : { kind: "completed", turn: state.turn, stopReason: "no_tool_calls" };
        snapshots.push(snapshot(state, []));
        break;
      case "tool":
        state = {
          kind: "start_tool",
          turn: state.turn,
          toolCallId: step.toolCallId,
          funcName: step.funcName,
          args: step.args,
        };
        snapshots.push(snapshot(state, []));
        state = {
          kind: "wait_tool",
          turn: state.turn,
          opId: step.opId,
          toolCallId: step.toolCallId,
          funcName: step.funcName,
          gateDecision: step.gateDecision ?? { kind: "allow" },
        };
        snapshots.push(snapshot(state, ["dispatch_tool_call"]));
        break;
      case "tool_done":
        if (state.kind === "wait_tool" && state.opId === step.opId) {
          state = { kind: "drain", turn: state.turn };
        }
        snapshots.push(snapshot(state, []));
        break;
      case "provider_failed":
        if (state.kind === "wait_llm" && state.opId === step.opId) {
          state = { kind: "failed", turn: state.turn, error: step.error };
        }
        snapshots.push(snapshot(state, []));
        break;
    }
  }

  return snapshots;
}

function expandScriptToReducerEvents(steps: ScriptedTurnStep[]): TurnEvent[] {
  const events: TurnEvent[] = [];
  for (const step of steps) {
    switch (step.kind) {
      case "start_llm":
        events.push({ kind: "start_llm_requested", reason: step.reason ?? "fresh" });
        events.push({ kind: "provider_call_started", opId: step.opId, providerCallId: step.providerCallId });
        break;
      case "provider_done":
        events.push({ kind: "provider_completed", opId: step.opId, hasToolCalls: step.hasToolCalls });
        break;
      case "tool":
        events.push({ kind: "tool_call_selected", toolCallId: step.toolCallId, funcName: step.funcName, args: step.args });
        events.push({ kind: "tool_gate_decided", opId: step.opId, gateDecision: step.gateDecision ?? { kind: "allow" } });
        break;
      case "tool_done":
        events.push({ kind: "tool_completed", opId: step.opId });
        break;
      case "provider_failed":
        events.push({ kind: "provider_failed", opId: step.opId, error: step.error });
        break;
    }
  }
  return events;
}

function snapshot(state: TurnState, effectKinds: string[]): TurnTransitionSnapshot {
  const base: TurnTransitionSnapshot = {
    state: state.kind,
    turn: state.turn,
    effectKinds,
  };
  if ("toolCallId" in state && typeof state.toolCallId === "string") base.toolCallId = state.toolCallId;
  if ("providerCallId" in state && typeof state.providerCallId === "string") base.providerCallId = state.providerCallId;
  return base;
}
