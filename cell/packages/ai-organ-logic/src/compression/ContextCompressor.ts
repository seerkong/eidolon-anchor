import compressionPrompt from "./CompressionPrompt.md" with { type: "text" };
import type { LlmAdapter } from "@cell/ai-core-contract/LlmTypes";
import { estimateTokens } from "./TokenEstimator";

const ACK_MESSAGE = "Understood. I have the full context from the state snapshot and will continue from where we left off.";

type LoggerLike = {
  warn?: (...args: any[]) => void;
};

type CompressHistoryParams = {
  messages: any[];
  llmAdapter: LlmAdapter;
  model: string;
  inputLimit: number;
  logger?: LoggerLike;
  processStream?: (stream: AsyncIterable<any>) => Promise<any>;
};

function warn(logger: LoggerLike | undefined, message: string, error?: unknown): void {
  if (typeof logger?.warn === "function") {
    logger.warn(message, error);
  }
}

function toSummaryText(value: any): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }

  const parts: string[] = [];
  if (typeof value.content === "string") {
    parts.push(value.content);
  }

  if (Array.isArray(value.content)) {
    for (const part of value.content) {
      if (typeof part === "string") {
        parts.push(part);
      } else if (typeof part?.text === "string") {
        parts.push(part.text);
      }
    }
  }

  if (Array.isArray(value.content_parts)) {
    for (const part of value.content_parts) {
      if (typeof part?.text === "string") {
        parts.push(part.text);
      }
    }
  }

  if (typeof value.output_text === "string") {
    parts.push(value.output_text);
  }

  return parts.join("").trim();
}

async function collectStreamText(stream: AsyncIterable<any>): Promise<string> {
  let text = "";

  for await (const chunk of stream) {
    if (typeof chunk === "string") {
      text += chunk;
      continue;
    }

    const delta = chunk?.choices?.[0]?.delta;
    if (typeof delta?.content === "string") {
      text += delta.content;
      continue;
    }

    if (Array.isArray(delta?.content)) {
      for (const part of delta.content) {
        if (typeof part?.text === "string") {
          text += part.text;
        }
      }
      continue;
    }

    if (chunk?.type === "text-delta" && typeof chunk?.text === "string") {
      text += chunk.text;
      continue;
    }

    if (typeof chunk?.text === "string") {
      text += chunk.text;
    }
  }

  return text.trim();
}

export function findSplitPoint(messages: any[], recentKeep = 4): number {
  if (!Array.isArray(messages) || messages.length === 0) {
    return -1;
  }

  const safeRecentKeep = Number.isFinite(recentKeep) && recentKeep > 0 ? Math.floor(recentKeep) : 4;
  if (messages.length <= safeRecentKeep) {
    return -1;
  }

  const maxSplit = messages.length - safeRecentKeep;
  if (maxSplit <= 0) {
    return -1;
  }

  for (let i = maxSplit; i >= 1; i -= 1) {
    if (messages[i]?.role === "user") {
      return i;
    }
  }

  return -1;
}

export function loadCompressionPrompt(): string {
  return compressionPrompt;
}

export async function compressHistory(params: CompressHistoryParams): Promise<any[] | null> {
  const { messages, llmAdapter, model, inputLimit, logger, processStream } = params;

  if (!Array.isArray(messages) || messages.length === 0 || inputLimit <= 0) {
    return null;
  }

  const splitPoint = findSplitPoint(messages);
  if (splitPoint <= 0) {
    return null;
  }

  const oldMessages = messages.slice(0, splitPoint);
  const recentMessages = messages.slice(splitPoint);

  if (oldMessages.length === 0 || recentMessages.length === 0) {
    return null;
  }

  try {
    const prompt = loadCompressionPrompt();
    const serializedOld = JSON.stringify(oldMessages, null, 2);
    const { stream } = await llmAdapter.createStream({
      model,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: serializedOld },
      ],
      tools: [],
      extraBody: { reasoning_split: false },
    });

    const processed = processStream ? await processStream(stream) : await collectStreamText(stream);
    const summary = toSummaryText(processed);

    if (!summary) {
      warn(logger, "compressHistory failed: empty summary");
      return null;
    }

    const trimmedSummary = summary.trim();
    if (!trimmedSummary.startsWith("<state_snapshot") || !trimmedSummary.endsWith("</state_snapshot>")) {
      warn(logger, "compressHistory failed: summary is not a state_snapshot xml block");
      return null;
    }

    const compressedMessages = [
      {
        role: "user",
        content: trimmedSummary,
      },
      {
        role: "assistant",
        content: ACK_MESSAGE,
      },
      ...recentMessages,
    ];

    const originalTokens = estimateTokens(messages);
    const compressedTokens = estimateTokens(compressedMessages);

    if (compressedTokens >= originalTokens) {
      warn(logger, `compressHistory discarded: compression inflated tokens (${compressedTokens} >= ${originalTokens})`);
      return null;
    }

    return compressedMessages;
  } catch (error) {
    warn(logger, "compressHistory failed", error);
    return null;
  }
}
