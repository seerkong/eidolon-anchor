import type { LlmAdapter, LlmGenerateOptions, LlmStreamResult } from "@cell/ai-core-contract/LlmTypes";
import { normalizeOpenAIChatMessages } from "./OpenAIChatHelpers";

export class OpenAILlmAdapter implements LlmAdapter {
  readonly type = "openai" as const;
  private client: any;

  constructor(client: any) {
    this.client = client;
  }

  async createStream(options: LlmGenerateOptions): Promise<LlmStreamResult> {
    const { model, messages, tools, extraBody } = options;
    const stream = await this.client.chat.completions.create({
      model,
      messages: normalizeOpenAIChatMessages(messages),
      tools,
      stream: true,
      extra_body: extraBody || { reasoning_split: true },
    });
    return { stream };
  }
}
