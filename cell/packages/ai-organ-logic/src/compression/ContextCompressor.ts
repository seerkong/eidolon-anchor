import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
  tokenBudget?: number;
  recentKeep?: number;
  logger?: LoggerLike;
  processStream?: (stream: AsyncIterable<any>) => Promise<any>;
};

type ToolResultRef = {
  messageIndex: number;
  blockIndex?: number;
  toolCallId: string;
  getContent: () => unknown;
  setContent: (content: string) => void;
};

export type CheapCompactionStats = {
  persistedToolResults: number;
  microCompactedToolResults: number;
  tokensBefore: number;
  tokensAfter: number;
};

export type CheapCompactionResult = {
  messages: any[];
  changed: boolean;
  stats: CheapCompactionStats;
};

export type CheapCompactionOptions = {
  artifactDir?: string | null;
  toolResultBudgetBytes?: number;
  toolResultPersistThresholdBytes?: number;
  toolResultPreviewChars?: number;
  microKeepRecentToolResults?: number;
  microMinContentChars?: number;
  microPreviewChars?: number;
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

function cloneMessages(messages: any[]): any[] {
  try {
    return structuredClone(messages);
  } catch {
    return JSON.parse(JSON.stringify(messages));
  }
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeToolCallId(message: any, block?: any): string {
  const raw =
    block?.tool_use_id
    ?? block?.toolUseId
    ?? block?.tool_call_id
    ?? block?.toolCallId
    ?? message?.tool_call_id
    ?? message?.toolCallId
    ?? message?.toolCallID
    ?? "";
  return typeof raw === "string" && raw ? raw : "unknown";
}

function collectToolResultRefs(messages: any[]): ToolResultRef[] {
  const refs: ToolResultRef[] = [];
  messages.forEach((message, messageIndex) => {
    if (!message || typeof message !== "object") return;
    if (message.role === "tool") {
      refs.push({
        messageIndex,
        toolCallId: normalizeToolCallId(message),
        getContent: () => message.content,
        setContent: (content) => {
          message.content = content;
        },
      });
    }

    if (!Array.isArray(message.content)) return;
    message.content.forEach((block: any, blockIndex: number) => {
      if (!block || typeof block !== "object" || block.type !== "tool_result") return;
      refs.push({
        messageIndex,
        blockIndex,
        toolCallId: normalizeToolCallId(message, block),
        getContent: () => block.content,
        setContent: (content) => {
          block.content = content;
        },
      });
    });
  });
  return refs;
}

function sanitizeArtifactName(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe.slice(0, 80) || "tool-result";
}

function persistToolResult(params: {
  artifactDir: string;
  toolCallId: string;
  content: string;
  previewChars: number;
}): string {
  fs.mkdirSync(params.artifactDir, { recursive: true });
  const hash = crypto.createHash("sha256").update(params.content).digest("hex").slice(0, 16);
  const fileName = `${sanitizeArtifactName(params.toolCallId)}-${hash}.txt`;
  const filePath = path.join(params.artifactDir, fileName);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, params.content);
  }
  const preview = params.content.slice(0, params.previewChars);
  return [
    "<persisted-tool-result status=\"delivered_and_compacted\">",
    `Full output persisted at: ${filePath}`,
    `Original characters: ${params.content.length}`,
    "The model already received this tool result in an earlier turn. Do not repeat the same tool call solely because the full text is compacted.",
    "Preview:",
    preview,
    "</persisted-tool-result>",
  ].join("\n");
}

function extractPersistedPath(content: string): string | null {
  const match = content.match(/Full output persisted at:\s*(.+)/);
  return match?.[1]?.trim() || null;
}

export function applyToolResultBudget(
  messages: any[],
  options: Pick<CheapCompactionOptions, "artifactDir" | "toolResultBudgetBytes" | "toolResultPersistThresholdBytes" | "toolResultPreviewChars"> = {},
): { changed: boolean; persisted: number } {
  const artifactDir = typeof options.artifactDir === "string" && options.artifactDir ? options.artifactDir : null;
  if (!artifactDir) {
    return { changed: false, persisted: 0 };
  }

  const maxBytes = options.toolResultBudgetBytes ?? 200_000;
  const persistThreshold = options.toolResultPersistThresholdBytes ?? 30_000;
  const previewChars = options.toolResultPreviewChars ?? 2_000;
  const refs = collectToolResultRefs(messages);
  let total = refs.reduce((sum, ref) => sum + stringifyContent(ref.getContent()).length, 0);
  if (total <= maxBytes) {
    return { changed: false, persisted: 0 };
  }

  let persisted = 0;
  const ranked = refs
    .map((ref) => ({ ref, content: stringifyContent(ref.getContent()) }))
    .sort((a, b) => b.content.length - a.content.length);
  for (const item of ranked) {
    if (total <= maxBytes) break;
    if (item.content.length <= persistThreshold) continue;
    if (item.content.includes("<persisted-tool-result>")) continue;
    const replacement = persistToolResult({
      artifactDir,
      toolCallId: item.ref.toolCallId,
      content: item.content,
      previewChars,
    });
    item.ref.setContent(replacement);
    persisted += 1;
    total = refs.reduce((sum, ref) => sum + stringifyContent(ref.getContent()).length, 0);
  }

  return { changed: persisted > 0, persisted };
}

export function microCompactToolResults(
  messages: any[],
  options: Pick<CheapCompactionOptions, "microKeepRecentToolResults" | "microMinContentChars" | "microPreviewChars"> = {},
): { changed: boolean; compacted: number } {
  const keepRecent = Math.max(0, Math.floor(options.microKeepRecentToolResults ?? 3));
  const minChars = Math.max(0, Math.floor(options.microMinContentChars ?? 120));
  const previewChars = Math.max(0, Math.floor(options.microPreviewChars ?? 800));
  const refs = collectToolResultRefs(messages);
  if (refs.length <= keepRecent) {
    return { changed: false, compacted: 0 };
  }

  let compacted = 0;
  for (const ref of refs.slice(0, refs.length - keepRecent)) {
    const content = stringifyContent(ref.getContent());
    if (content.length <= minChars) continue;
    const persistedPath = extractPersistedPath(content);
    const preview = content.slice(0, previewChars);
    const lines = [
      "<compacted-tool-result status=\"delivered_and_compacted\">",
      `Tool call id: ${ref.toolCallId}`,
      `Original characters: ${content.length}`,
    ];
    if (persistedPath) {
      lines.push(`Full output persisted at: ${persistedPath}`);
    }
    lines.push(
      "This is a compacted form of a tool result that was already delivered. Do not repeat the same tool call solely because older output was compacted.",
    );
    if (preview) {
      lines.push("Preview:", preview);
    }
    lines.push("</compacted-tool-result>");
    ref.setContent(lines.join("\n"));
    compacted += 1;
  }
  return { changed: compacted > 0, compacted };
}

export function applyCheapCompactionPipeline(
  messages: any[],
  options: CheapCompactionOptions = {},
): CheapCompactionResult {
  const tokensBefore = estimateTokens(messages);
  let next = cloneMessages(messages);
  const budget = applyToolResultBudget(next, options);
  const micro = microCompactToolResults(next, options);
  const tokensAfter = estimateTokens(next);
  return {
    messages: next,
    changed: budget.changed || micro.changed,
    stats: {
      persistedToolResults: budget.persisted,
      microCompactedToolResults: micro.compacted,
      tokensBefore,
      tokensAfter,
    },
  };
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

function fitMessagesWithinTokenBudget(messages: any[], tokenBudget: number): any[] {
  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
    return [];
  }

  let fitted = [...messages];
  while (fitted.length > 1 && estimateTokens(fitted) > tokenBudget) {
    fitted.shift();
  }

  if (estimateTokens(fitted) <= tokenBudget) {
    return fitted;
  }

  const single = fitted[0];
  if (!single) {
    return [];
  }

  const next = { ...single };
  const content = typeof next.content === "string" ? next.content : "";
  if (!content) {
    return estimateTokens([next]) <= tokenBudget ? [next] : [];
  }

  let low = 0;
  let high = content.length;
  let best = "";
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = { ...next, content: content.slice(0, mid) };
    if (estimateTokens([candidate]) <= tokenBudget) {
      best = candidate.content;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best ? [{ ...next, content: best }] : [];
}

export async function compressHistory(params: CompressHistoryParams): Promise<any[] | null> {
  const { messages, llmAdapter, model, inputLimit, logger, processStream } = params;

  if (!Array.isArray(messages) || messages.length === 0 || inputLimit <= 0) {
    return null;
  }

  const splitPoint = findSplitPoint(messages, params.recentKeep ?? 4);
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
    const requestOverheadTokens = estimateTokens([
      { role: "system", content: prompt },
      { role: "user", content: "[]" },
    ]);
    const safeInputLimit = Math.max(1, Math.floor(inputLimit * 0.9));
    const tokenBudget = Math.floor(Math.min(params.tokenBudget ?? safeInputLimit, safeInputLimit) - requestOverheadTokens);
    if (tokenBudget <= 0) {
      warn(logger, "compressHistory failed: compression prompt overhead exceeds request budget");
      return null;
    }
    const oldMessagesForCompression = fitMessagesWithinTokenBudget(oldMessages, tokenBudget);
    if (oldMessagesForCompression.length === 0) {
      warn(logger, "compressHistory failed: no old messages fit within compression request budget");
      return null;
    }
    const serializedOld = JSON.stringify(oldMessagesForCompression, null, 2);
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
