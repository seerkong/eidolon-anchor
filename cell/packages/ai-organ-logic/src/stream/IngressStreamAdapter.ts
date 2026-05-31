import { AnthropicStreamAdapter } from "@cell/ai-organ-logic/llm";
import { IngressStreamRuntime } from "@cell/symbiont-logic/stream/IngressStreamRuntime";
import { OpenAICompletionsNodejsFetchStreamAdapter } from "@cell/symbiont-logic/stream/OpenAICompletionsNodejsFetchStreamAdapter";

async function* abortableStream<T>(stream: AsyncIterable<T>, signal?: AbortSignal): AsyncIterable<T> {
  if (!signal) {
    yield* stream;
    return;
  }

  const iterator = stream[Symbol.asyncIterator]();
  try {
    while (!signal.aborted) {
      const next = iterator.next();
      const abort = new Promise<IteratorResult<T>>((resolve) => {
        if (signal.aborted) {
          resolve({ done: true, value: undefined as T });
          return;
        }
        signal.addEventListener(
          "abort",
          () => resolve({ done: true, value: undefined as T }),
          { once: true },
        );
      });
      const result = await Promise.race([next, abort]);
      if (signal.aborted || result.done) return;
      yield result.value;
    }
  } finally {
    void iterator.return?.();
  }
}

export function createIngressStreamAdapter(
  stream: AsyncIterable<any>,
  runtime: IngressStreamRuntime,
  llmAdapterType: "openai" | "anthropic" | "codex" | "claude" | "deepseek" = "openai",
  options?: { signal?: AbortSignal },
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
    try {
      if (options?.signal?.aborted) {
        return { role: "assistant", content: "" };
      }
      const result = await (adapter as any).processStream(abortableStream(stream, options?.signal));
      if (options?.signal?.aborted) {
        return { role: "assistant", content: "" };
      }
      return result;
    } finally {
      await ingressStreams.control.close();
      await ingressStreams.think.close();
      await ingressStreams.content.close();
      await ingressStreams.tool.close();
      await ingressStreams.timeline.close();
    }
  };
  return [ingressStreams, runAdapter] as const;
}
