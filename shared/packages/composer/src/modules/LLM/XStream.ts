/**
 * XStream - Reactive streaming abstraction for LLM responses
 *
 * Provides a unified streaming interface that can be consumed by
 * terminal (TUI), web (SSE), and desktop clients.
 */

import type { ToolCall, TokenUsage } from "./DTO";

/**
 * Subscription handle returned by XStream.subscribe()
 */
export interface XStreamSubscription {
  unsubscribe(): void;
}

/**
 * Observer interface for consuming XStream events
 */
export interface XStreamObserver<T> {
  onNext(value: T): void;
  onError(error: Error): void;
  onComplete(): void;
}

/**
 * Reactive stream abstraction for async data sequences
 */
export interface XStream<T> {
  subscribe(observer: XStreamObserver<T>): XStreamSubscription;
}

/**
 * LLM chunk types for streaming responses
 */
export type LLMChunkType = "text" | "tool_call" | "reasoning" | "done" | "error";

/**
 * Individual chunk emitted during LLM streaming
 */
export interface LLMChunk {
  /** Unique message ID for this response */
  msgId: string;
  /** Type of chunk */
  type: LLMChunkType;
  /** Text content (for 'text' and 'reasoning' types) */
  content?: string;
  /** Tool call data (for 'tool_call' type) */
  toolCall?: ToolCall;
  /** Token usage stats (typically in 'done' chunk) */
  usage?: TokenUsage;
  /** Error message (for 'error' type) */
  error?: string;
}
