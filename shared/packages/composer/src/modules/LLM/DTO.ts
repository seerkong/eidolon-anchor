/**
 * LLM Module - Data Transfer Objects
 *
 * Shared types for LLM invocation across backend and frontend layers.
 */

export type LLMRole = "user" | "assistant" | "tool" | "system";

export interface ChatMessage {
  role: LLMRole;
  name?: string;
  content: string;
  reasoning_content?: string;
  startAt?: number;
  endAt?: number;
  toolCallId?: string;
  tool_call_id?: string;
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
