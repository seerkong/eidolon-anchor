import { randomUUID } from "crypto";
import type { ToolSchema } from "@cell/ai-core-contract/types";
import type { LlmAdapter, LlmGenerateOptions, LlmStreamResult } from "@cell/ai-core-contract/LlmTypes";
import type { ProviderOptions } from "./ProviderPlugins";

const DEFAULT_THINKING_BUDGET = 8000;
const DEFAULT_MAX_TOKENS = 4096;

export type AnthropicNodejsFetchAdapterSettings = {
  apiKey: string;
  baseUrl: string;
  thinkingBudgetTokens?: number;
  maxTokens?: number;
  providerOptions?: ProviderOptions;
};

type AnthropicContentBlock =
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

type ToolCallPiece = {
  id: string;
  name: string;
  input: unknown;
};

type ToolCallBuffer = {
  id: string;
  name: string;
  inputText: string;
  input: unknown;
};

export type AnthropicToolContext = {
  toolCalls: ToolCallPiece[];
  assistantContentParts: any[];
  reasoningText: string;
  text: string;
};

function buildAnthropicUrl(baseUrl?: string): string {
  const base = baseUrl || "https://api.anthropic.com";
  const trimmed = base.replace(/\/+$/, "");
  const hasVersion = /\/v\d+($|\/)/.test(trimmed);
  const withVersion = hasVersion ? trimmed : `${trimmed}/v1`;
  return `${withVersion}/messages`;
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function toAnthropicTools(tools: ToolSchema[]): Array<{ name: string; description?: string; input_schema: any }> {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

function extractAssistantBlocks(msg: any): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
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
          name: String(part.toolName),
          input: (part.input ?? {}) as Record<string, unknown>,
        });
      } else if (part.type === "tool_use" && part.id && part.name) {
        blocks.push({
          type: "tool_use",
          id: String(part.id),
          name: String(part.name),
          input: (part.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    return blocks;
  }

  const contentBlocks = Array.isArray(msg?.content) ? msg.content : null;
  if (contentBlocks && contentBlocks.length) {
    for (const block of contentBlocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && block.text) {
        blocks.push({ type: "text", text: String(block.text) });
      } else if (block.type === "thinking" && block.thinking) {
        blocks.push({ type: "thinking", thinking: String(block.thinking) });
      } else if (block.type === "tool_use" && block.id && block.name) {
        blocks.push({
          type: "tool_use",
          id: String(block.id),
          name: String(block.name),
          input: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    return blocks;
  }

  if (msg?.reasoning_content) {
    blocks.push({ type: "thinking", thinking: String(msg.reasoning_content) });
  }
  if (msg?.content) {
    const text = String(msg.content);
    if (text.trim()) blocks.push({ type: "text", text });
  }
  if (Array.isArray(msg?.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (!tc?.id || !tc?.function?.name) continue;
      const input = safeParseJson(tc.function.arguments || "{}");
      blocks.push({
        type: "tool_use",
        id: String(tc.id),
        name: String(tc.function.name),
        input: (input ?? {}) as Record<string, unknown>,
      });
    }
  }
  return blocks;
}

function toAnthropicMessages(messages: any[]): { system: string[]; anthropicMessages: any[] } {
  const system: string[] = [];
  const anthropicMessages: any[] = [];

  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === "system") {
      const content = String(msg.content ?? "").trim();
      if (content) system.push(content);
      continue;
    }
    if (msg.role === "assistant") {
      const blocks = extractAssistantBlocks(msg);
      if (blocks.length) anthropicMessages.push({ role: "assistant", content: blocks });
      continue;
    }
    if (msg.role === "tool") {
      const toolUseId = msg.tool_call_id || msg.toolCallId || msg.tool_call_id;
      if (!toolUseId) continue;
      const text = String(msg.content ?? "");
      anthropicMessages.push({
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
        if (content.length) anthropicMessages.push({ role: "user", content });
        continue;
      }
      const text = String(content ?? "");
      if (!text.trim()) continue;
      anthropicMessages.push({ role: "user", content: [{ type: "text", text }] });
    }
  }

  return { system, anthropicMessages };
}

function finalizeToolInput(state: ToolUseState): Record<string, unknown> {
  if (state.receivedDelta) {
    const parsed = safeParseJson(state.inputText || "{}");
    return (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  }
  if (state.inputValue && typeof state.inputValue === "object") {
    return state.inputValue as Record<string, unknown>;
  }
  if (typeof state.inputValue === "string") {
    const parsed = safeParseJson(state.inputValue);
    return (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  }
  return {};
}

function parseToolInputText(state: ToolUseState): Record<string, unknown> {
  const parsed = safeParseJson(state.inputText || "{}");
  if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
  return {};
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
  const toolStates = new Map<number, ToolUseState>();
  const emittedToolCalls = new Set<string>();

  const emitToolCall = (state: ToolUseState) => {
    if (emittedToolCalls.has(state.id)) return [];
    emittedToolCalls.add(state.id);
    const input = state.receivedDelta ? parseToolInputText(state) : finalizeToolInput(state);
    return [
      { type: "tool-input-end", id: state.id },
      { type: "tool-call", toolCallId: state.id, toolName: state.name, input },
    ];
  };

  const handleEvent = (event: any): any[] => {
    if (!event || typeof event !== "object") return [];
    switch (event.type) {
      case "content_block_start": {
        const block = event.content_block;
        if (!block || event.index === undefined) return [];
        if (block.type === "tool_use") {
          const id = block.id || randomUUID();
          const name = block.name || "";
          toolStates.set(event.index, {
            id,
            name,
            inputText: "",
            inputValue: block.input,
            receivedDelta: false,
          });
          return [{ type: "tool-input-start", id, toolName: name }];
        }
        return [];
      }
      case "content_block_delta": {
        const delta = event.delta || {};
        if (delta.type === "text_delta" && delta.text) {
          return [{ type: "text-delta", text: String(delta.text) }];
        }
        if (delta.type === "thinking_delta" && delta.thinking) {
          return [{ type: "reasoning-delta", text: String(delta.thinking) }];
        }
        if (delta.type === "input_json_delta" && event.index !== undefined) {
          const state = toolStates.get(event.index);
          if (!state) return [];
          const part = String(delta.partial_json || "");
          if (!part) return [];
          state.receivedDelta = true;
          state.inputText += part;
          return [{ type: "tool-input-delta", id: state.id, delta: part }];
        }
        if (typeof delta.text === "string") {
          return [{ type: "text-delta", text: String(delta.text) }];
        }
        if (typeof delta.thinking === "string") {
          return [{ type: "reasoning-delta", text: String(delta.thinking) }];
        }
        return [];
      }
      case "content_block_stop": {
        if (event.index === undefined) return [];
        const state = toolStates.get(event.index);
        if (!state) return [];
        return emitToolCall(state);
      }
      default:
        return [];
    }
  };

  const flushLine = (line: string): any[] | "DONE" | undefined => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) return;
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.replace(/^data:\s*/, "");
    if (payload === "[DONE]") return "DONE";
    let event: any;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    return handleEvent(event);
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

  for (const state of toolStates.values()) {
    if (emittedToolCalls.has(state.id)) continue;
    for (const part of emitToolCall(state)) yield part;
  }
}

export class AnthropicNodejsFetchLlmAdapter implements LlmAdapter {
  readonly type = "anthropic" as const;
  private apiKey: string;
  private baseUrl: string;
  private thinkingBudgetTokens: number;
  private maxTokens: number;
  private providerOptions: ProviderOptions;

  constructor(settings: AnthropicNodejsFetchAdapterSettings) {
    this.apiKey = settings.apiKey;
    this.baseUrl = settings.baseUrl;
    this.thinkingBudgetTokens = settings.thinkingBudgetTokens ?? DEFAULT_THINKING_BUDGET;
    this.maxTokens = settings.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.providerOptions = settings.providerOptions ?? {};
  }

  async createStream(options: LlmGenerateOptions): Promise<LlmStreamResult> {
    const { model, messages, tools } = options;
    const { system, anthropicMessages } = toAnthropicMessages(messages);
    const toolset = toAnthropicTools(tools);

    const body: Record<string, unknown> = {
      model,
      max_tokens: this.maxTokens,
      messages: anthropicMessages,
      stream: true,
      tools: toolset.length ? toolset : undefined,
      system: system.length ? system.join("\n") : undefined,
      thinking: { type: "enabled", budget_tokens: this.thinkingBudgetTokens },
    };

    const providerOptions = this.providerOptions;
    const url = buildAnthropicUrl((providerOptions.baseURL as string | undefined) || this.baseUrl);
    const apiKey = (providerOptions.apiKey as string | undefined) || this.apiKey;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "user-agent": "claude-cli/2.1.2 (external, cli)",
      "anthropic-beta": "oauth-2025-04-20,interleaved-thinking-2025-05-14",
      "x-app": "cli",
      ...(providerOptions.headers || {}),
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    if (process.env.MINIMAX_DEBUG === "1") {
      console.log("[anthropic] request", JSON.stringify({ url, body }, null, 2));
    }

    const fetchFn = providerOptions.fetch || fetch;
    const signal = providerOptions.signal as AbortSignal | undefined;
    const res = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      throw new Error(`Anthropic fetch error ${res.status}: ${errorText || res.statusText}`);
    }

    return { stream: streamToParts(res) };
  }
}

export class AnthropicStreamAdapter {
  private ingressControl: any;
  private ingressThink: any;
  private ingressContent: any;
  private ingressTool: any;
  private reasoningBuffer = "";
  private contentBuffer = "";
  private toolBuffers = new Map<string, ToolCallBuffer>();
  private toolCalls: ToolCallPiece[] = [];
  private assistantContentParts: any[] = [];

  constructor({
    ingressControl,
    ingressThink,
    ingressContent,
    ingressTool,
  }: {
    ingressControl: any;
    ingressThink: any;
    ingressContent: any;
    ingressTool: any;
  }) {
    this.ingressControl = ingressControl;
    this.ingressThink = ingressThink;
    this.ingressContent = ingressContent;
    this.ingressTool = ingressTool;
  }

  async processStream(stream: AsyncIterable<any>) {
    await this.ingressControl.send("control", JSON.stringify({ event: "StreamStart" }));
    try {
      for await (const part of stream) {
        if (process.env.MINIMAX_DEBUG === "1") {
          console.log("[anthropic] part", JSON.stringify(part, null, 2));
        }
        await this.processPart(part);
      }
      await this.flushToolCalls();
      return this.buildMessage();
    } finally {
      await this.ingressControl.send("control", JSON.stringify({ event: "StreamEnd" }));
    }
  }


  getToolContext(): AnthropicToolContext {
    return {
      toolCalls: this.toolCalls,
      assistantContentParts: this.assistantContentParts,
      reasoningText: this.reasoningBuffer,
      text: this.contentBuffer,
    };
  }

  private async processPart(part: any) {
    if (!part || typeof part !== "object") return;
    switch (part.type) {
      case "reasoning-delta":
        await this.appendReasoning(String(part.text || ""));
        break;
      case "text-delta":
        await this.appendContent(String(part.text || ""));
        break;
      case "tool-input-start":
        if (part.id && part.toolName) {
          this.toolBuffers.set(part.id, {
            id: part.id,
            name: part.toolName,
            inputText: "",
            input: {},
          });
        }
        break;
      case "tool-input-delta":
        await this.appendToolInput(part.id, String(part.delta || ""));
        break;
      case "tool-input-end":
        await this.finishToolInput(part.id);
        break;
      case "tool-call":
        await this.captureToolCall(part);
        break;
      case "tool-result":
      case "tool-error":
      case "tool-output-denied":
        await this.recordToolPart(part);
        break;
      case "raw":
        await this.captureRawContent(part.rawValue);
        break;
      default:
        break;
    }
  }

  private async appendReasoning(text: string) {
    if (!text) return;
    this.reasoningBuffer += text;
    this.assistantContentParts.push({ type: "reasoning", text });
    await this.ingressThink.send("think", text);
  }

  private async appendContent(text: string) {
    if (!text) return;
    this.contentBuffer += text;
    this.assistantContentParts.push({ type: "text", text });
    await this.ingressContent.send("content", text);
  }

  private async appendToolInput(toolCallId: string, delta: string) {
    if (!toolCallId || !delta) return;
    const buffer = this.toolBuffers.get(toolCallId);
    if (!buffer) return;
    buffer.inputText += delta;
  }

  private async finishToolInput(toolCallId: string) {
    if (!toolCallId) return;
    const buffer = this.toolBuffers.get(toolCallId);
    if (!buffer) return;
    let parsed: unknown = buffer.inputText;
    try {
      parsed = JSON.parse(buffer.inputText || "{}");
    } catch {
      parsed = buffer.inputText;
    }
    buffer.input = parsed;
  }

  private async captureToolCall(part: any) {
    if (!part?.toolCallId || !part?.toolName) return;
    const input = part.input ?? this.toolBuffers.get(part.toolCallId)?.input ?? {};
    const toolCall = {
      id: part.toolCallId,
      type: "function",
      function: {
        name: part.toolName,
        arguments: JSON.stringify(input ?? {}),
      },
    };
    if (!this.toolCalls.find((tc) => tc.id === part.toolCallId)) {
      this.toolCalls.push({ id: part.toolCallId, name: part.toolName, input });
      this.assistantContentParts.push({
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: input ?? {},
      });
    }
    this.toolBuffers.delete(part.toolCallId);
    await this.ingressTool.send("tool", JSON.stringify(toolCall));
  }

  private async recordToolPart(part: any) {
    if (!part?.toolCallId || !part?.toolName) return;
    this.assistantContentParts.push({
      type: part.type,
      toolCallId: part.toolCallId,
      toolName: part.toolName,
      output: part.output,
      error: part.error,
    });
  }

  private async captureRawContent(raw: any) {
    const content = raw?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "thinking" && block.thinking) {
        await this.appendReasoning(String(block.thinking));
      } else if (block.type === "text" && block.text) {
        await this.appendContent(String(block.text));
      } else if (block.type === "tool_use") {
        const toolCall = {
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        };
        if (!this.toolCalls.find((tc) => tc.id === block.id)) {
          this.toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {} });
          this.assistantContentParts.push({
            type: "tool-call",
            toolCallId: block.id,
            toolName: block.name,
            input: block.input ?? {},
          });
        }
        this.toolBuffers.delete(block.id);
        await this.ingressTool.send("tool", JSON.stringify(toolCall));
      }
    }
  }

  private async flushToolCalls() {
    if (!this.toolBuffers.size) return;
    for (const buffer of this.toolBuffers.values()) {
      if (this.toolCalls.find((tc) => tc.id === buffer.id)) continue;
      const toolCall = {
        id: buffer.id,
        type: "function",
        function: {
          name: buffer.name,
          arguments: JSON.stringify(buffer.input ?? {}),
        },
      };
      this.toolCalls.push({ id: buffer.id, name: buffer.name, input: buffer.input ?? {} });
      this.assistantContentParts.push({
        type: "tool-call",
        toolCallId: buffer.id,
        toolName: buffer.name,
        input: buffer.input ?? {},
      });
      await this.ingressTool.send("tool", JSON.stringify(toolCall));
    }

    this.toolBuffers.clear();
  }

  private buildMessage() {
    const msg: any = { role: "assistant", content: this.contentBuffer || null };
    if (this.toolCalls.length) {
      msg.tool_calls = this.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.input ?? {}),
        },
      }));
    }
    if (this.reasoningBuffer) msg.reasoning_content = this.reasoningBuffer;
    msg.content = this.contentBuffer || null;
    msg.content_parts = this.assistantContentParts;
    return msg;
  }
}
