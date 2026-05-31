type TextStats = {
  chars: number;
  whitespace: number;
};

function emptyStats(): TextStats {
  return { chars: 0, whitespace: 0 };
}

function mergeStats(left: TextStats, right: TextStats): TextStats {
  return {
    chars: left.chars + right.chars,
    whitespace: left.whitespace + right.whitespace,
  };
}

function stringStats(value: string): TextStats {
  const whitespace = value.match(/\s/g)?.length ?? 0;
  return {
    chars: value.length,
    whitespace,
  };
}

function countTextStats(value: unknown): TextStats {
  if (typeof value === "string") {
    return stringStats(value);
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => mergeStats(total, countTextStats(item)), emptyStats());
  }
  if (value && typeof value === "object") {
    const maybeText = (value as { text?: unknown }).text;
    if (typeof maybeText === "string") {
      return stringStats(maybeText);
    }
  }
  return emptyStats();
}

function estimateTokensFromTextStats(stats: TextStats): number {
  if (stats.chars <= 0) {
    return 0;
  }

  const baseline = Math.ceil(stats.chars / 4);
  const whitespaceRatio = stats.whitespace / stats.chars;
  if (stats.chars >= 10_000 && whitespaceRatio < 0.12) {
    return Math.max(baseline, Math.ceil(stats.chars / 2.5));
  }

  return baseline;
}

export function estimateTokens(messages: any[]): number {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 0;
  }

  let stats = emptyStats();
  for (const message of messages) {
    stats = mergeStats(stats, countTextStats(message?.content));
    stats = mergeStats(stats, countTextStats(message?.reasoningContent));
    stats = mergeStats(stats, countTextStats(message?.reasoning_content));

    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    for (const toolCall of toolCalls) {
      const argumentsValue = toolCall?.function?.arguments;
      if (typeof argumentsValue === "string") {
        stats = mergeStats(stats, stringStats(argumentsValue));
      } else if (argumentsValue !== undefined && argumentsValue !== null) {
        stats = mergeStats(stats, stringStats(JSON.stringify(argumentsValue)));
      }
    }

    const camelToolCalls = Array.isArray(message?.toolCalls) ? message.toolCalls : [];
    for (const toolCall of camelToolCalls) {
      const inputValue = toolCall?.input;
      if (typeof inputValue === "string") {
        stats = mergeStats(stats, stringStats(inputValue));
      } else if (inputValue !== undefined && inputValue !== null) {
        stats = mergeStats(stats, stringStats(JSON.stringify(inputValue)));
      }
    }

    const contentParts = Array.isArray(message?.content_parts) ? message.content_parts : [];
    for (const part of contentParts) {
      if (typeof part?.text === "string") {
        stats = mergeStats(stats, stringStats(part.text));
      }
    }
  }

  return estimateTokensFromTextStats(stats);
}

export function estimateUsageRatio(messages: any[], inputLimit: number): number {
  if (inputLimit <= 0) {
    return 0;
  }
  return estimateTokens(messages) / inputLimit;
}
