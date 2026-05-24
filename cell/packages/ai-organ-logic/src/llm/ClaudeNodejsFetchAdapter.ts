import type { LlmAdapter, LlmGenerateOptions, LlmStreamResult } from "@cell/ai-core-contract/LlmTypes";
import type { ToolSchema } from "@cell/ai-core-contract/types";
import type { ProviderOptions } from "./ProviderPlugins";

export type ClaudeNodejsFetchAdapterSettings = {
  apiKey: string;
  baseUrl?: string;
  providerOptions?: ProviderOptions;
  maxTokens?: number;
};

type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: { type: "text"; text: string }[]; is_error?: boolean };

type ToolUseState = {
  id: string;
  name: string;
  inputText: string;
  inputValue?: unknown;
  receivedDelta: boolean;
};

const TOOL_PREFIX = "ext_srv_tool__";
const DEFAULT_BETAS = "oauth-2025-04-20,interleaved-thinking-2025-05-14,claude-code-20250219";

function buildClaudeUrl(baseUrl?: string): string {
  const base = baseUrl || "https://api.anthropic.com";
  const trimmed = base.replace(/\/+$/, "");
  const withVersion = trimmed.endsWith("/v1/messages") ? trimmed : trimmed.endsWith("/v1") ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
  try {
    const url = new URL(withVersion);
    if (!url.searchParams.has("beta")) {
      url.searchParams.set("beta", "true");
    }
    return url.toString();
  } catch {
    return withVersion;
  }
}

function prefixToolName(name: string): string {
  if (!name) return name;
  return name.startsWith(TOOL_PREFIX) ? name : `${TOOL_PREFIX}${name}`;
}

function stripToolName(name: string): string {
  if (!name) return name;
  if (name.startsWith("mcp__")) return name;
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function toClaudeTools(tools: ToolSchema[]): Array<{ name: string; description?: string; input_schema: any }> {
  return tools.map((tool) => ({
    name: prefixToolName(tool.function.name),
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function extractAssistantBlocks(msg: any): ClaudeContentBlock[] {
  const blocks: ClaudeContentBlock[] = [];
  const parts = Array.isArray(msg?.content_parts) ? msg.content_parts : null;
  if (parts && parts.length) {
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && part.text) {
        blocks.push({ type: "text", text: String(part.text) });
      } else if (part.type === "reasoning" && part.text) {
        blocks.push({ type: "thinking", thinking: String(part.text) });
      } else if (part.type === "tool-call" && part.toolCallId && part.toolName) {
        blocks.push({
          type: "tool_use",
          id: String(part.toolCallId),
          name: prefixToolName(String(part.toolName)),
          input: (part.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    return blocks;
  }
  if (Array.isArray(msg?.content)) {
    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && part.text) {
        blocks.push({ type: "text", text: String(part.text) });
      } else if (part.type === "thinking" && part.thinking) {
        blocks.push({ type: "thinking", thinking: String(part.thinking) });
      } else if (part.type === "tool_use" && part.id && part.name) {
        blocks.push({
          type: "tool_use",
          id: String(part.id),
          name: prefixToolName(String(part.name)),
          input: (part.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    return blocks;
  }
  if (Array.isArray(msg?.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (!tc?.id || !tc?.function?.name) continue;
      const input = safeParseJson(tc.function.arguments || "{}");
      blocks.push({
        type: "tool_use",
        id: String(tc.id),
        name: prefixToolName(String(tc.function.name)),
        input: (input ?? {}) as Record<string, unknown>,
      });
    }
  }
  if (msg?.content) {
    const text = String(msg.content);
    if (text.trim()) blocks.push({ type: "text", text });
  }
  return blocks;
}

function toClaudeMessages(messages: any[]): { system: string[]; claudeMessages: any[] } {
  const system: string[] = [];
  const claudeMessages: any[] = [];
  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === "system") {
      const text = String(msg.content ?? "").trim();
      if (text) system.push(text);
      continue;
    }
    if (msg.role === "assistant") {
      const blocks = extractAssistantBlocks(msg);
      if (blocks.length) claudeMessages.push({ role: "assistant", content: blocks });
      continue;
    }
    if (msg.role === "tool") {
      const toolUseId = msg.tool_call_id || msg.toolCallId || msg.tool_call_id;
      if (!toolUseId) continue;
      const text = typeof msg.content === "string" ? msg.content : msg.content === undefined ? "" : JSON.stringify(msg.content);
      claudeMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: String(toolUseId),
            content: [{ type: "text", text }],
            is_error: false,
          },
        ],
      });
      continue;
    }
    if (msg.role === "user") {
      const content = msg.content;
      if (Array.isArray(content)) {
        if (content.length) claudeMessages.push({ role: "user", content });
        continue;
      }
      const text = String(content ?? "");
      if (!text.trim()) continue;
      claudeMessages.push({ role: "user", content: text });
    }
  }
  return { system, claudeMessages };
}

function buildHeaders(apiKey: string, baseHeaders?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(baseHeaders || {}),
  };
  if (!headers.Authorization && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (!headers["anthropic-version"]) {
    headers["anthropic-version"] = "2023-06-01";
  }
  if (!headers["anthropic-beta"]) {
    headers["anthropic-beta"] = DEFAULT_BETAS;
  }
  if (!headers["user-agent"]) {
    headers["user-agent"] = "claude-cli/2.1.2 (external, cli)";
  }
  if (!headers["x-app"]) {
    headers["x-app"] = "cli";
  }
  return headers;
}

async function* streamToParts(response: Response): AsyncIterable<any> {
  if (!response.body) {
    const payload = await response.json().catch(() => null);
    if (payload) {
      yield { type: "raw", rawValue: payload };
    }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCalls = new Map<number, ToolUseState>();
  const toolIdMap = new Map<string, number>();

  const handleEvent = (event: any): any[] => {
    if (!event || typeof event !== "object") return [];
    if (event.type === "content_block_start") {
      const block = event.content_block || {};
      if (block.type === "tool_use" && block.id) {
        const index = Number(event.index ?? toolCalls.size);
        toolIdMap.set(String(block.id), index);
        toolCalls.set(index, {
          id: String(block.id),
          name: String(block.name || ""),
          inputText: "",
          inputValue: block.input,
          receivedDelta: false,
        });
        return [{ type: "tool-input-start", id: String(block.id), toolName: stripToolName(String(block.name || "")) }];
      }
      if (block.type === "text" && block.text) {
        return [{ type: "text-delta", text: String(block.text) }];
      }
      return [];
    }
    if (event.type === "content_block_delta") {
      const delta = event.delta || {};
      if (delta.type === "text_delta" && delta.text) {
        return [{ type: "text-delta", text: String(delta.text) }];
      }
      if (delta.type === "input_json_delta") {
        const toolIndex = event.index !== undefined
          ? Number(event.index)
          : delta.id && toolIdMap.has(String(delta.id))
          ? toolIdMap.get(String(delta.id))
          : undefined;
        if (toolIndex !== undefined) {
          const state = toolCalls.get(toolIndex);
          if (state) {
            const part = String(delta.partial_json || "");
            if (part) {
              state.receivedDelta = true;
              state.inputText += part;
            }
          }
        }
      }
    }
    if (event.type === "content_block_stop") {
      const toolIndex = event.index !== undefined
        ? Number(event.index)
        : event.id && toolIdMap.has(String(event.id))
        ? toolIdMap.get(String(event.id))
        : undefined;
      if (toolIndex !== undefined) {
        const state = toolCalls.get(toolIndex);
        if (state && state.receivedDelta) {
          const parsed = safeParseJson(state.inputText || "{}");
          state.inputValue = parsed && typeof parsed === "object" ? parsed : state.inputText;
        }
        if (state) {
          const input = state.inputValue ?? (state.receivedDelta ? safeParseJson(state.inputText || "{}") : state.inputValue);
          return [
            { type: "tool-input-end", id: state.id },
            { type: "tool-call", toolCallId: state.id, toolName: stripToolName(state.name), input: input ?? {} },
          ];
        }
      }
    }
    if (event.delta && typeof event.delta.text === "string") {
      return [{ type: "text-delta", text: String(event.delta.text) }];
    }
    if (typeof event.completion === "string") {
      return [{ type: "text-delta", text: String(event.completion) }];
    }
    return [];
  };

  const flushLine = (line: string): any[] | "DONE" | undefined => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) return;
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.replace(/^data:\s*/, "");
    if (payload === "[DONE]") return "DONE";
    try {
      const event = JSON.parse(payload);
      return handleEvent(event);
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
        if (Array.isArray(result)) {
          for (const part of result) yield part;
        }
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
    if (Array.isArray(result)) {
      for (const part of result) yield part;
    }
  }
}

export class ClaudeNodejsFetchLlmAdapter implements LlmAdapter {
  readonly type = "claude" as const;
  private apiKey: string;
  private baseUrl?: string;
  private providerOptions: ProviderOptions;
  private maxTokens: number;

  constructor(settings: ClaudeNodejsFetchAdapterSettings) {
    this.apiKey = settings.apiKey;
    this.baseUrl = settings.baseUrl;
    this.providerOptions = settings.providerOptions ?? {};
    this.maxTokens = settings.maxTokens ?? 1024;
  }

  async createStream(options: LlmGenerateOptions): Promise<LlmStreamResult> {
    const { model, messages, tools } = options;
    const { system, claudeMessages } = toClaudeMessages(messages);
    const toolset = toClaudeTools(tools);
    const url = buildClaudeUrl((this.providerOptions.baseURL as string | undefined) || this.baseUrl);
    const apiKey = (this.providerOptions.apiKey as string | undefined) || this.apiKey;
    const headers = buildHeaders(apiKey, this.providerOptions.headers);

    const body: Record<string, unknown> = {
      model,
      max_tokens: this.maxTokens,
      stream: true,
      system: system.length ? system.join("\n") : undefined,
      messages: claudeMessages,
      tools: toolset.length ? toolset : undefined,
    };

    const fetchFn = this.providerOptions.fetch || fetch;
    const signal = this.providerOptions.signal as AbortSignal | undefined;
    const res = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Claude fetch error ${res.status}: ${text || res.statusText}`);
    }

    return { stream: streamToParts(res) };
  }
}
