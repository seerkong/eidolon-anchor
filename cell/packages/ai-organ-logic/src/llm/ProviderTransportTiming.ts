import type { ProviderTransportOutcomeObserver, ProviderTransportTiming } from "@cell/ai-organ-contract/llm/ProviderRuntime";

type TimedTransportObservation = {
  headers(): void;
  chunk(chunk: unknown): void;
  observer: ProviderTransportOutcomeObserver;
};

function containsContent(chunk: unknown): boolean {
  const delta = (chunk as { choices?: Array<{ delta?: {
    content?: unknown;
    tool_calls?: unknown;
  } }> })?.choices?.[0]?.delta;
  return (typeof delta?.content === "string" && delta.content.length > 0)
    || Boolean(Array.isArray(delta?.tool_calls) && delta.tool_calls.some(call => call?.function?.name || call?.function?.arguments));
}

// One timer per actual send. Observation cannot replay or alter execution.
export function createProviderTransportTiming(
  observer?: ProviderTransportOutcomeObserver,
  clock = () => performance.now(),
  wall = () => Date.now(),
): TimedTransportObservation {
  const start = clock(), startedAt = wall();
  let headersMs: number | null = null;
  let firstEventMs: number | null = null;
  let firstContentMs: number | null = null;
  let firstReasoningMs: number | null = null, lastReasoningMs: number | null = null;
  let lastContentMs: number | null = null, lastEventMs: number | null = null;
  let eventCount = 0, reasoningEventCount = 0, contentEventCount = 0;
  let maxInterEventGapMs: number | null = null, longInterEventGapCount = 0, longInterEventGapTotalMs = 0;
  let closed = false;
  const elapsed = () => Math.max(0, clock() - start);
  const snapshot = (): ProviderTransportTiming => ({ startedAt, headersMs, firstEventMs, firstContentMs,
    firstReasoningMs, lastReasoningMs, lastContentMs, lastEventMs, eventCount, reasoningEventCount, contentEventCount,
    maxInterEventGapMs, longInterEventGapCount, longInterEventGapTotalMs, elapsedMs: elapsed() });
  return {
    headers() { if (!closed) headersMs ??= elapsed(); },
    chunk(chunk) {
      if (closed) return;
      const at = elapsed();
      firstEventMs ??= at;
      if (lastEventMs !== null) {
        const gap = Math.max(0, at - lastEventMs);
        maxInterEventGapMs = Math.max(maxInterEventGapMs ?? 0, gap);
        if (gap >= 1000) { longInterEventGapCount++; longInterEventGapTotalMs += gap; }
      }
      lastEventMs = at; eventCount++;
      if (containsContent(chunk)) { firstContentMs ??= at; lastContentMs = at; contentEventCount++; }
      const delta = (chunk as any)?.choices?.[0]?.delta;
      if ([delta?.reasoning_content, delta?.reasoning].some(value => typeof value === 'string' && value.length > 0)) {
        firstReasoningMs ??= at; lastReasoningMs = at; reasoningEventCount++;
      }
    },
    observer: {
      appendOutcome(input) {
        if (closed) return;
        closed = true;
        try { observer?.appendOutcome({ ...input, timing: snapshot() }); }
        catch { /* Diagnostics never fail the provider. */ }
      },
    },
  };
}
