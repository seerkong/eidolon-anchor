/**
 * LLM Module - Data Transfer Objects
 *
 * Shared types for LLM invocation across backend and frontend layers.
 */

export type LLMRole = "user" | "assistant" | "tool" | "system";

export type InputTextContentPart = {
  type: "text";
  text: string;
  filename?: string;
  sourceDigest?: string;
};

export type InputImageContentPart = {
  type: "image";
  mime: string;
  dataUrl: string;
  filename?: string;
  sourceDigest?: string;
  size?: number;
};

export type InputFileReferenceContentPart = {
  type: "file_reference";
  path: string;
  filename?: string;
  mime?: string;
};

export type InputContentPart = InputTextContentPart | InputImageContentPart | InputFileReferenceContentPart;
export type InputContent = string | InputContentPart[];

export function normalizeInputContent(content: InputContent): InputContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.map((part) => ({ ...part }));
}

export function projectInputContentText(content: InputContent): string {
  return normalizeInputContent(content)
    .filter((part): part is InputTextContentPart => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export interface ChatMessage {
  /**
   * Conversation-domain identity. Runtime materialization uses this to track
   * delivery without exposing the identifier to provider request bodies.
   */
  messageId?: string;
  role: LLMRole;
  name?: string;
  content: string | InputContentPart[];
  reasoning_content?: string;
  startAt?: number;
  endAt?: number;
  toolCallId?: string;
  tool_call_id?: string;
  /** Durable, provider-ignored typed projection metadata for a tool result. */
  resultMetadata?: Record<string, unknown>;
  toolCalls?: ToolCall[];
  tool_calls?: OpenAIToolCall[];
  rawToolCalls?: ToolCall[];
  rawToolCallsStr?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface OpenAIToolCall {
  id: string;
  type?: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LLMResponse {
  text?: string;
  reasoning_content?: string;
  toolCalls?: ToolCall[];
  rawToolCallsStr?: string;
  usage?: TokenUsage;
}

export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export type LLMApiKind = "anthropic" | "openai" | "openai_completions" | "openai_responses" | "gemini" | "mock" | "claude_code";

export interface ModelProfile {
  provider: string;
  apiKind: LLMApiKind;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  maxInputTokens?: number;
}

/** Simple logger function type */
export type LoggerFn = (line: string) => void;

/** Extended logger interface with log level methods */
export interface Logger {
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
}
