import { describe, expect, test } from "bun:test";

import { runRetentionAudit } from "./audit-session-memory-retention";

describe("session memory retention audit", () => {
  const cases = [
    ["ingress-timeline", 0],
    ["semantic-stream-graph", 0],
    ["observable-trace-log", 1_000],
    ["agent-event-graph", 0],
    ["message-history-graph", 0],
    ["rx-semantic-log", 0],
    ["rx-history-log", 0],
    ["rx-prompt-log", 0],
    ["rx-session-log", 0],
    ["rx-observability-log", 0],
    ["rx-observability-error-log", 0],
    ["rx-control-signal-log", 0],
    ["rx-all-logs", 0],
  ] as const;
  for (const [owner, expectedRetainedCount] of cases) {
    test(`${owner} remains bounded across 50k inputs`, () => {
      const result = runRetentionAudit({ owner, count: 50_000, payloadChars: 96 });
      expect(result.inputCount).toBe(50_000);
      expect(result.retainedCount).toBe(expectedRetainedCount);
      expect(result.serializedBytes).toBeGreaterThan(0);
    });
  }

  test("session semantic chain does not retain duplicate live copies", () => {
    const result = runRetentionAudit({
      owner: "session-semantic-chain",
      count: 50_000,
      payloadChars: 96,
    });
    expect(result.inputCount).toBe(50_000);
    expect(result.retainedCount).toBe(0);
    expect(result.serializedBytes).toBeGreaterThan(0);
  });
});
