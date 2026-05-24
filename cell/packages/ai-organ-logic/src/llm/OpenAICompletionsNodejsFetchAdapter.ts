import type { LlmAdapter, LlmGenerateOptions, LlmStreamResult } from "@cell/ai-core-contract/LlmTypes";
import type { ToolSchema } from "@cell/ai-core-contract/types";
import { normalizeOpenAIChatMessages } from "./OpenAIChatHelpers";
import type { ProviderOptions } from "./ProviderPlugins";

type OpenAICompletionsNodejsFetchAdapterSettings = {
  apiKey: string;
  baseUrl?: string;
  providerOptions?: ProviderOptions;
};

function buildCompletionsUrl(baseUrl?: string): string {
  const base = baseUrl || "https://api.openai.com/v1";
  const trimmed = base.replace(/\/+$/, "");
  const hasVersion = /\/v\d+($|\/)/.test(trimmed);
  const withVersion = hasVersion ? trimmed : `${trimmed}/v1`;
  return `${withVersion}/chat/completions`;
}

async function* streamToOpenAIChunks(response: Response): AsyncIterable<any> {
  if (!response.body) {
    const payload = await response.json().catch(() => null);
    if (payload) {
      yield payload;
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const flushLine = (line: string): any | "DONE" | undefined => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) return;
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.replace(/^data:\s*/, "");
    if (payload === "[DONE]") return "DONE";
    try {
      return JSON.parse(payload);
    } catch {
      return;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const result = flushLine(line);
        if (result === "DONE") return;
        if (result) yield result;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
    }
  }

  if (buffer.trim()) {
    const result = flushLine(buffer);
    if (result && result !== "DONE") {
      yield result;
    }
  }
}

function toOpenAITools(tools: ToolSchema[]): ToolSchema[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools;
}

export class OpenAICompletionsNodejsFetchLlmAdapter implements LlmAdapter {
  readonly type = "openai" as const;
  private apiKey: string;
  private baseUrl?: string;
  private providerOptions: ProviderOptions;

  constructor(settings: OpenAICompletionsNodejsFetchAdapterSettings) {
    this.apiKey = settings.apiKey;
    this.baseUrl = settings.baseUrl;
    this.providerOptions = settings.providerOptions ?? {};
  }

  async createStream(options: LlmGenerateOptions): Promise<LlmStreamResult> {
    const { model, messages, tools, extraBody, signal } = options;
    const toolset = toOpenAITools(tools);

    const body: Record<string, unknown> = {
      model,
      messages: normalizeOpenAIChatMessages(messages, {
        preserveReasoningContent: isDeepseekRequest(model, this.baseUrl, this.providerOptions),
      }),
      stream: true,
      tools: toolset,
    };

    const extra = extraBody && typeof extraBody === "object" ? { ...extraBody } : {};
    const providerOptions = this.providerOptions;
    const isDeepseek = isDeepseekRequest(model, this.baseUrl, providerOptions);

    if (!isDeepseek && !("reasoning_split" in extra)) {
      extra.reasoning_split = true;
    }
    Object.assign(body, extra);
    body.stream = true;

    const url = buildCompletionsUrl((providerOptions.baseURL as string | undefined) || this.baseUrl);
    const apiKey = (providerOptions.apiKey as string | undefined) || this.apiKey;
    if (!apiKey) {
      throw new Error("OpenAI API key missing");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(providerOptions.headers || {}),
    };

    if (process.env.MINIMAX_DEBUG === "1") {
      console.log("[openai] request", JSON.stringify({ url, body }, null, 2));
    }

    const fetchFn = providerOptions.fetch || fetch;
    const res = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      throw new Error(`OpenAI fetch error ${res.status}: ${errorText || res.statusText}`);
    }

    return { stream: streamToOpenAIChunks(res) };
  }
}

function isDeepseekRequest(model: unknown, baseUrl: string | undefined, providerOptions: ProviderOptions): boolean {
  const resolvedBaseUrl = String((providerOptions.baseURL as string | undefined) || baseUrl || "").toLowerCase();
  const modelName = String(model || "").toLowerCase();
  return resolvedBaseUrl.includes("deepseek") || modelName.startsWith("deepseek");
}
