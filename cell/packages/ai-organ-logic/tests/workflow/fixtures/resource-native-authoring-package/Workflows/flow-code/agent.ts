export async function invokeAgent(runtime: any, input: unknown, config: Record<string, unknown> = {}) {
  return runtime.ai.effects.invoke({
    effectId: "summary-agent",
    operation: "ai.agent",
    input,
    config,
    run: runtime.ai.metadata.run,
    nodeId: "summarize",
  })
}
