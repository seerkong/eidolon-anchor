import { OutputStream } from "@cell/symbiont-logic/stream/stream";
import type {
  ChatCompletionsEffectBundle,
  NormalizedChatCompletionsStreamBinding,
} from "@cell/ai-organ-contract/llm/ChatCompletionsEffectBundle";
import { openAIOfficialChatEffectBundle } from "../llm/ChatCompletionsEffectBundles";
import {
  buildChatCompletionsToolCalls,
  ToolCallAccumulator,
  type ChatCompletionsStreamState,
} from "./ChatCompletionsStreamCore";

export type OpenAICompletionsStreamAdapterParams =
  ({
      timeline: OutputStream;
      ingressControl?: undefined;
      ingressThink?: undefined;
      ingressContent?: undefined;
      ingressTool?: undefined;
    }
  | {
      timeline?: undefined;
      ingressControl: OutputStream;
      ingressThink: OutputStream;
      ingressContent: OutputStream;
      ingressTool: OutputStream;
    }) & {
      effectBundle?: ChatCompletionsEffectBundle;
      streamBinding?: NormalizedChatCompletionsStreamBinding;
    };

export { ToolCallAccumulator };

export class OpenAICompletionsNodejsFetchStreamAdapter {
  private readonly timeline?: OutputStream;
  private readonly ingressControl?: OutputStream;
  private readonly ingressThink?: OutputStream;
  private readonly ingressContent?: OutputStream;
  private readonly ingressTool?: OutputStream;
  private readonly streamBinding: NormalizedChatCompletionsStreamBinding;
  private state: unknown;

  constructor(params: OpenAICompletionsStreamAdapterParams) {
    this.streamBinding =
      params.streamBinding ?? params.effectBundle ?? openAIOfficialChatEffectBundle;
    this.state = this.streamBinding.streamCore.createState();
    if ("timeline" in params) {
      this.timeline = params.timeline;
    } else {
      this.ingressControl = params.ingressControl;
      this.ingressThink = params.ingressThink;
      this.ingressContent = params.ingressContent;
      this.ingressTool = params.ingressTool;
    }
  }

  async processStream(stream: AsyncIterable<any>) {
    await this.send("control", JSON.stringify({ event: "StreamStart" }));
    try {
      for await (const chunk of stream) {
        if (process.env.MINIMAX_DEBUG === "1") {
          const choice = chunk?.choices?.[0];
          console.log(
            "[openai] chunk",
            JSON.stringify(
              {
                finish_reason: choice?.finish_reason,
                delta: choice?.delta || {},
              },
              null,
              2,
            ),
          );
        }
        const reduced = this.streamBinding.streamCore.reduceChunk(
          this.state,
          chunk,
          this.streamBinding.streamReasoningPolicy,
        );
        this.state = reduced.state;
        for (const event of reduced.events) {
          await this.send(event.event, event.data);
        }
      }
      for (const toolCall of buildChatCompletionsToolCalls(
        this.state as ChatCompletionsStreamState,
      )) {
        await this.send("tool", JSON.stringify(toolCall));
      }
      return this.streamBinding.streamCore.buildAssistantMessage(this.state);
    } finally {
      await this.send("control", JSON.stringify({ event: "StreamEnd" }));
    }
  }

  private async send(
    event: "control" | "think" | "content" | "tool",
    data: string,
  ): Promise<void> {
    if (this.timeline) {
      await this.timeline.send(event, data);
      return;
    }
    const stream =
      event === "control"
        ? this.ingressControl
        : event === "think"
          ? this.ingressThink
          : event === "content"
            ? this.ingressContent
            : this.ingressTool;
    if (stream) await stream.send(event, data);
  }
}
