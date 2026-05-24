import type { NormalizedLLMResponse, NormalizedToolCall } from "@cell/ai-organ-contract/llm/ProviderRuntime";

function parseToolInput(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  if (!value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const item = part as Record<string, unknown>;
          return typeof item.text === "string" ? item.text : "";
        }
        return "";
      })
      .join("");
  }
  if (value === null || value === undefined) return "";
  return String(value);
}

function normalizeToolCalls(raw: unknown): NormalizedToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: NormalizedToolCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const call = item as Record<string, any>;
    const id = String(call.id ?? call.call_id ?? "");
    const name = String(call.function?.name ?? call.name ?? "");
    const input = parseToolInput(call.function?.arguments ?? call.arguments ?? call.input);
    if (!id && !name) continue;
    calls.push({ id, name, input });
  }
  return calls;
}

function normalizeStopReason(value: unknown, toolCallCount: number): string {
  if (toolCallCount > 0) return "tool_use";
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "tool_use" || normalized === "tool_calls") return "tool_use";
  return "end_turn";
}

export function normalizeProviderResponse(raw: Record<string, unknown>): NormalizedLLMResponse {
  const toolCalls = normalizeToolCalls(raw.tool_calls ?? raw.toolCalls);
  const contentText = normalizeTextContent(raw.output_text ?? raw.content_text ?? raw.content ?? raw.text);
  return {
    contentText,
    assistantContent: Array.isArray(raw.content) ? raw.content : contentText ? [{ type: "text", text: contentText }] : [],
    toolCalls,
    usage: raw.usage && typeof raw.usage === "object" ? (raw.usage as Record<string, unknown>) : undefined,
    stopReason: normalizeStopReason(raw.stop_reason ?? raw.finish_reason ?? raw.stopReason, toolCalls.length),
    responseId: typeof raw.id === "string" ? raw.id : typeof raw.response_id === "string" ? raw.response_id : undefined,
    progressEvents: [],
  };
}
