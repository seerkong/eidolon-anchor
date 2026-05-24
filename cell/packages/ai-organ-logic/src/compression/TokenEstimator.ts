function countTextLength(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countTextLength(item), 0);
  }
  if (value && typeof value === "object") {
    const maybeText = (value as { text?: unknown }).text;
    if (typeof maybeText === "string") {
      return maybeText.length;
    }
  }
  return 0;
}

export function estimateTokens(messages: any[]): number {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 0;
  }

  let chars = 0;
  for (const message of messages) {
    chars += countTextLength(message?.content);

    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    for (const toolCall of toolCalls) {
      const argumentsValue = toolCall?.function?.arguments;
      if (typeof argumentsValue === "string") {
        chars += argumentsValue.length;
      } else if (argumentsValue !== undefined && argumentsValue !== null) {
        chars += JSON.stringify(argumentsValue).length;
      }
    }

    const contentParts = Array.isArray(message?.content_parts) ? message.content_parts : [];
    for (const part of contentParts) {
      if (typeof part?.text === "string") {
        chars += part.text.length;
      }
    }
  }

  return Math.ceil(chars / 4);
}

export function estimateUsageRatio(messages: any[], inputLimit: number): number {
  if (inputLimit <= 0) {
    return 0;
  }
  return estimateTokens(messages) / inputLimit;
}
