import { AnthropicStreamAdapter } from "@cell/ai-organ-logic/llm";
import { IngressStreamRuntime } from "@cell/symbiont-logic/stream/IngressStreamRuntime";
import { OpenAICompletionsNodejsFetchStreamAdapter } from "@cell/symbiont-logic/stream/OpenAICompletionsNodejsFetchStreamAdapter";

export function createIngressStreamAdapter(
  stream: AsyncIterable<any>,
  runtime: IngressStreamRuntime,
  llmAdapterType: "openai" | "anthropic" | "codex" | "claude" | "deepseek" = "openai"
) {
  const ingressStreams = runtime.ingressStreams;
  const anthropicParams = {
    ingressControl: ingressStreams.control,
    ingressThink: ingressStreams.think,
    ingressContent: ingressStreams.content,
    ingressTool: ingressStreams.tool,
  };
  const adapter = llmAdapterType === "anthropic" || llmAdapterType === "claude"
    ? new AnthropicStreamAdapter(anthropicParams as any)
    : new OpenAICompletionsNodejsFetchStreamAdapter({
        timeline: (ingressStreams as any).timeline,
      });
  const runAdapter = async () => {
    const result = await (adapter as any).processStream(stream);
    await ingressStreams.control.close();
    await ingressStreams.think.close();
    await ingressStreams.content.close();
    await ingressStreams.tool.close();
    await ingressStreams.timeline.close();
    return result;
  };
  return [ingressStreams, runAdapter] as const;
}
