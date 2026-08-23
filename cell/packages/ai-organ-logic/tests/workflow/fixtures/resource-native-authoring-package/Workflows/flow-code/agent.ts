import type {
  AIAgentEffectConfig,
  AIWorkflowAuthoredRuntimeContext,
  FlowClosedValue,
} from "ai-workflow-contract"

type AuthoredAgentRuntime = { readonly ai: AIWorkflowAuthoredRuntimeContext }

export async function invokeAgent<
  Input extends FlowClosedValue,
  Output extends FlowClosedValue,
>(runtime: AuthoredAgentRuntime, input: Input, config: AIAgentEffectConfig) {
  const result = await runtime.ai.effects.runAgent<Input, Output>(input, config)
  return result.output
}
