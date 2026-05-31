export type ToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: any;
  };
};

export type AiAgentOneActorRuntime<TVm = any, TActor = any> = {
  vm: TVm;
  actor: TActor;
  signal?: AbortSignal;
};

export type ToolDef<
  TOuterInput = any,
  TOuterOutput = string,
  TOuterConfig = Record<string, unknown>,
  TOuterDerived = null,
  TOuterRuntime = AiAgentOneActorRuntime,
  TInnerRuntime = TOuterRuntime,
  TInnerInput = TOuterInput,
  TInnerConfig = TOuterConfig,
  TInnerOutput = TOuterOutput,
> = {
  schema: ToolSchema;
  briefPromptXnl: string;
  detailPromptXnl?: string;
  run: (runtime: TOuterRuntime, input: TOuterInput, config: TOuterConfig) => Promise<TOuterOutput>;
};

export type AnyToolDef = ToolDef<any, any, any, any, AiAgentOneActorRuntime, any, any, any, any>;

export type AgentLoopStopReason =
  | "no_tool_calls"
  | "questionnaire_wait"
  | "child_wait"
  | "stop_after_tool"
  | "stop_agent"
  | "exit_after_tool_result"
  | "max_iterations";

export type AgentLoopResult = {
  messages: any[];
  stopReason: AgentLoopStopReason;
};
