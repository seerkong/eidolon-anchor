import type {
  AgentContextPipelineExecution,
  AgentContextPipelineInput,
  AgentContextPipelineRuntime,
  AgentContextPipelineStage,
} from "@cell/ai-core-contract/runtime/AgentContextPipeline";

/** Invocation-local tokens keep mutable domain products inside their existing owners. */
export function runAgentContextPipeline<TPlan, TMessages, TResult>(
  processors: {
    plan: () => TPlan;
    materialize: (plan: TPlan) => TMessages;
    completeEstimate: (plan: TPlan, messages: TMessages) => TMessages;
    convert: (plan: TPlan, messages: TMessages) => TResult;
  },
  input: AgentContextPipelineInput,
  execution?: AgentContextPipelineExecution,
): TResult {
  let active = true;
  let current: AgentContextPipelineStage | undefined;
  let plan: TPlan;
  let messages: TMessages;
  let result: TResult;
  function advance(stage: AgentContextPipelineStage["stage"]): AgentContextPipelineStage {
    current = Object.freeze({ stage });
    return current;
  }
  function requireStage(token: AgentContextPipelineStage | undefined, expected: AgentContextPipelineStage["stage"] | undefined): void {
    if (!active || token !== current || current?.stage !== expected) {
      throw new Error("AGENT_CONTEXT_PIPELINE_STAGE_INVALID: expected invocation-local stage " + String(expected));
    }
  }
  const runtime: AgentContextPipelineRuntime = Object.freeze({
    plan: () => {
      requireStage(undefined, undefined);
      // Reserve before executing the effect so even a caught failure cannot repeat it.
      const token = advance("plan");
      plan = processors.plan();
      return token;
    },
    materialize: (token) => {
      requireStage(token, "plan");
      const next = advance("materialization");
      messages = processors.materialize(plan);
      return next;
    },
    completeEstimate: (token) => {
      requireStage(token, "materialization");
      if (input.mode !== "estimate") throw new Error("AGENT_CONTEXT_PIPELINE_STAGE_INVALID: estimate completion in record mode");
      const next = advance("estimate");
      messages = processors.completeEstimate(plan, messages);
      return next;
    },
    convert: (token) => {
      requireStage(token, input.mode === "estimate" ? "estimate" : "materialization");
      const next = advance("provider");
      result = processors.convert(plan, messages);
      return next;
    },
  });
  try {
    const immutableInput = Object.freeze({ ...input });
    let returned: unknown;
    if (execution) {
      returned = execution.execute(runtime, immutableInput);
    } else {
      let materialization = runtime.materialize(runtime.plan());
      if (input.mode === "estimate") materialization = runtime.completeEstimate(materialization);
      returned = runtime.convert(materialization);
    }
    if (!current || current.stage !== "provider" || returned !== current) {
      throw new Error("AGENT_CONTEXT_PIPELINE_RESULT_INVALID: resource must return the owner-produced provider result");
    }
    return result!;
  } finally {
    // Escaped callbacks and async resources cannot mutate a completed invocation.
    active = false;
  }
}
