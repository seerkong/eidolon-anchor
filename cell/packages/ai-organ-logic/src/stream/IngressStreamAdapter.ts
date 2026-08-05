import { AnthropicStreamAdapter } from "@cell/ai-organ-logic/llm";
import type {
  LlmAdapter,
  LlmAdapterType,
} from "@cell/ai-core-contract/LlmTypes";
import type {
  ChatCompletionsEffectBundle,
  NormalizedChatCompletionsStreamBinding,
} from "@cell/ai-organ-contract/llm/ChatCompletionsEffectBundle";
import { IngressStreamRuntime } from "@cell/symbiont-logic/stream/IngressStreamRuntime";
import { openAIOfficialChatEffectBundle } from "../llm/ChatCompletionsEffectBundles";
import { OpenAICompletionsNodejsFetchStreamAdapter } from "./OpenAICompletionsNodejsFetchStreamAdapter";

type DriverBoundLlmAdapter = LlmAdapter & {
  chatCompletionsEffectBundle?: ChatCompletionsEffectBundle;
  driver?: {
    chatCompletionsEffectBundle?: ChatCompletionsEffectBundle;
    normalizedChatCompletionsStreamBinding?: NormalizedChatCompletionsStreamBinding;
  };
};

function resolveLlmAdapterType(
  llmAdapter: LlmAdapter | LlmAdapterType,
): LlmAdapterType {
  return typeof llmAdapter === "string" ? llmAdapter : llmAdapter.type;
}

function resolveChatCompletionsEffectBundle(
  llmAdapter: LlmAdapter | LlmAdapterType,
): NormalizedChatCompletionsStreamBinding {
  if (typeof llmAdapter === "object") {
    const binding = llmAdapter as DriverBoundLlmAdapter;
    if (binding.driver?.normalizedChatCompletionsStreamBinding) {
      return binding.driver.normalizedChatCompletionsStreamBinding;
    }
    if (binding.driver?.chatCompletionsEffectBundle) {
      return binding.driver.chatCompletionsEffectBundle;
    }
    if (binding.chatCompletionsEffectBundle) {
      return binding.chatCompletionsEffectBundle;
    }
  }
  return openAIOfficialChatEffectBundle;
}

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
  llmAdapter: LlmAdapter | LlmAdapterType = "openai",
  options?: { signal?: AbortSignal },
) {
  const llmAdapterType = resolveLlmAdapterType(llmAdapter);
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
        streamBinding: resolveChatCompletionsEffectBundle(llmAdapter),
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
