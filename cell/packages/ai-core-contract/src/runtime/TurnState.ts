export type TurnStartReason = "fresh" | "tool_continuation" | "compress_followup";

export type TurnStopReason =
  | "no_tool_calls"
  | "stop_after_tool"
  | "stop_after_first_tool"
  | "cancelled"
  | "max_iterations";

export type TurnCompressionReason = "token_threshold" | "reactive_prompt_too_long" | "manual";

export type TurnHumanWaitReason = "clarification" | "approval" | "answer";

export type TurnToolGateDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: "tool_disabled" | "network_disabled"; message: string }
  | { kind: "defer"; reason: "plan_approval"; message: string; waitingFor: { coordination: "plan_approval"; request_id: string } };

export type TurnState =
  | { kind: "drain"; turn: number }
  | { kind: "start_llm"; turn: number; reason: TurnStartReason }
  | { kind: "wait_llm"; turn: number; opId: string; providerCallId: string }
  | { kind: "start_tool"; turn: number; toolCallId: string; funcName: string; args: unknown }
  | {
      kind: "wait_tool";
      turn: number;
      opId: string;
      toolCallId: string;
      funcName: string;
      gateDecision: TurnToolGateDecision;
    }
  | {
      kind: "wait_questionnaire_parse";
      turn: number;
      opId: string;
      toolCallId: string;
      questionnaireId: string;
      rawText: string;
    }
  | { kind: "wait_compress"; turn: number; opId: string; reason: TurnCompressionReason }
  | { kind: "wait_human"; turn: number; reason: TurnHumanWaitReason }
  | { kind: "completed"; turn: number; stopReason: TurnStopReason }
  | { kind: "failed"; turn: number; error: string };

export type TurnEvent =
  | { kind: "start_llm_requested"; reason: TurnStartReason }
  | { kind: "provider_call_started"; opId: string; providerCallId: string }
  | { kind: "provider_completed"; opId: string; hasToolCalls: boolean }
  | { kind: "provider_failed"; opId: string; error: string }
  | { kind: "tool_call_selected"; toolCallId: string; funcName: string; args: unknown }
  | { kind: "tool_gate_decided"; opId: string; gateDecision: TurnToolGateDecision }
  | { kind: "tool_completed"; opId: string }
  | { kind: "tool_failed"; opId: string; error: string }
  | { kind: "questionnaire_parse_started"; opId: string; questionnaireId: string; toolCallId: string; rawText: string }
  | { kind: "questionnaire_parse_completed"; opId: string }
  | { kind: "compression_started"; opId: string; reason: TurnCompressionReason }
  | { kind: "compression_completed"; opId: string }
  | { kind: "human_wait_requested"; reason: TurnHumanWaitReason }
  | { kind: "cancelled"; reason: string };

export type TurnEffect =
  | { kind: "prepare_provider_call"; turn: number; reason: TurnStartReason }
  | { kind: "await_provider_call"; opId: string; providerCallId: string }
  | {
      kind: "dispatch_tool_call";
      opId: string;
      toolCallId: string;
      funcName: string;
      args: unknown;
      gateDecision: TurnToolGateDecision;
    }
  | { kind: "await_questionnaire_parse"; opId: string; questionnaireId: string; toolCallId: string }
  | { kind: "await_compression"; opId: string; reason: TurnCompressionReason }
  | { kind: "await_human"; reason: TurnHumanWaitReason };

export type TurnReducerResult = {
  state: TurnState;
  effects: TurnEffect[];
};
