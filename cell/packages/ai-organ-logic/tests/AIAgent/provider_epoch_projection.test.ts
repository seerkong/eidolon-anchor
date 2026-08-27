import { describe, expect, it } from "bun:test";

import {
  computeProviderEpochConversationProjectionDigests,
  computeProviderEpochReceiptIntegrityDigest,
  projectProviderEpochConversationMessages,
  ProviderEpochProjectionError,
} from "@cell/ai-organ-logic";
import type { ProviderEpochReceipt } from "@cell/ai-organ-contract";

function receipt(
  targetProfileId: ProviderEpochReceipt["targetProfileId"],
  messages: readonly any[],
  pendingToolCallIds: readonly string[] = [],
): ProviderEpochReceipt {
  const createdAt = "2026-08-24T18:00:00.000Z";
  const digests = computeProviderEpochConversationProjectionDigests({
    messages,
    targetProviderId: "siliconflow",
    targetProfileId,
    createdAt,
    pendingToolCallIds,
  });
  const facts: Omit<ProviderEpochReceipt, "integrityDigest"> = {
    schemaVersion: "provider.epoch-receipt/v1",
    sessionId: "session-1",
    actorKey: "main",
    actorId: "actor-1",
    epoch: 1,
    targetProviderId: "siliconflow",
    targetProfileId,
    pendingToolCallIds,
    ...digests,
    reason: "model_control",
    createdAt,
  };
  return { ...facts, integrityDigest: computeProviderEpochReceiptIntegrityDigest(facts) };
}

describe("provider epoch conversation projection", () => {
  it("turns delivered and legacy source tool pairs into a bounded neutral handoff", () => {
    const canonical = [
      { role: "system", content: "current system" },
      { role: "user", content: "old question", endAt: Date.parse("2026-08-24T17:00:00Z") },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call-1", type: "function", function: { name: "bash", arguments: "{\"secret\":true}" } }],
        endAt: Date.parse("2026-08-24T17:01:00Z"),
      },
      { role: "tool", tool_call_id: "call-1", content: "completed output", endAt: Date.parse("2026-08-24T17:02:00Z") },
      { role: "user", content: "new question", endAt: Date.parse("2026-08-24T18:01:00Z") },
    ];
    const before = JSON.stringify(canonical);

    const projected = projectProviderEpochConversationMessages({
      messages: canonical,
      receipt: receipt("deepseek-compatible-chat@1", canonical),
    });

    expect(JSON.stringify(canonical)).toBe(before);
    expect(projected.some((message) => Array.isArray(message.tool_calls))).toBe(false);
    expect(projected.some((message) => message.role === "tool")).toBe(false);
    expect(projected.map((message) => String(message.content ?? "")).join("\n")).toContain("Completed tool outcome call-1");
    expect(projected.map((message) => String(message.content ?? "")).join("\n")).not.toContain("secret");
    expect(projected.at(-1)).toMatchObject({ role: "user", content: "new question" });
  });

  it("keeps an exact compatible pending pair for first delivery", () => {
    const messages = [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "pending-1", type: "function", function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "pending-1", content: "result" },
      ];
    const projected = projectProviderEpochConversationMessages({
      messages,
      receipt: receipt("deepseek-compatible-chat@1", messages, ["pending-1"]),
    });

    expect(projected.some((message) => message.role === "assistant" && message.tool_calls?.[0]?.id === "pending-1")).toBe(true);
    expect(projected.some((message) => message.role === "tool" && message.tool_call_id === "pending-1")).toBe(true);
  });

  it("fails closed when official DeepSeek cannot express a pending pair without fabricated reasoning", () => {
    let caught: ProviderEpochProjectionError | null = null;
    try {
      const messages = [
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "pending-1", type: "function", function: { name: "read", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "pending-1", content: "sensitive result" },
        ];
      projectProviderEpochConversationMessages({
        messages,
        receipt: (() => {
          const facts: Omit<ProviderEpochReceipt, "integrityDigest"> = {
          schemaVersion: "provider.epoch-receipt/v1",
          sessionId: "session-1",
          actorKey: "main",
          actorId: "actor-1",
          epoch: 1,
          targetProviderId: "siliconflow",
          targetProfileId: "deepseek-official-chat@1",
          sourceMessageCount: 2,
          pendingToolCallIds: ["pending-1"],
          sourceFrontierDigest: `sha256:${"a".repeat(64)}`,
          handoffDigest: `sha256:${"b".repeat(64)}`,
          reason: "model_control",
          createdAt: "2026-08-24T18:00:00.000Z",
          };
          return { ...facts, integrityDigest: computeProviderEpochReceiptIntegrityDigest(facts) };
        })(),
      });
    } catch (error) {
      caught = error as ProviderEpochProjectionError;
    }

    expect(caught).toBeInstanceOf(ProviderEpochProjectionError);
    expect(caught?.diagnostic).toEqual({
      code: "provider_epoch_pending_delivery_incompatible",
      path: "/tool-deliveries/pending-1/assistant/reasoning_content",
      valueKind: "missing_reasoning",
    });
    expect(JSON.stringify(caught)).not.toContain("sensitive result");
  });

  it("preserves a real official DeepSeek reasoning/tool pair", () => {
    const messages = [
        {
          role: "assistant",
          content: "",
          reasoning_content: "real reasoning",
          tool_calls: [{ id: "pending-1", type: "function", function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "pending-1", content: "result" },
      ];
    const projected = projectProviderEpochConversationMessages({
      messages,
      receipt: receipt("deepseek-official-chat@1", messages, ["pending-1"]),
    });

    expect(projected.some((message) => message.reasoning_content === "real reasoning")).toBe(true);
  });

  it("rejects a receipt whose handoff digest no longer binds the projected content", () => {
    const messages = [{ role: "user", content: "canonical source" }];
    const valid = receipt("deepseek-compatible-chat@1", messages);
    const tampered = { ...valid, handoffDigest: `sha256:${"0".repeat(64)}` as const };

    expect(() => projectProviderEpochConversationMessages({
      messages,
      receipt: tampered,
    })).toThrow("provider_epoch_receipt_incompatible");
  });

  it("rejects a self-consistent receipt when it does not address the current handoff", () => {
    const receiptMessages = [{ role: "user", content: "issued handoff" }];
    const valid = receipt("deepseek-compatible-chat@1", receiptMessages);

    expect(() => projectProviderEpochConversationMessages({
      messages: [{ role: "user", content: "different current handoff" }],
      receipt: valid,
    })).toThrow("provider_epoch_receipt_incompatible");
  });

  it("content-addresses the actual role-ordered bounded handoff", () => {
    const base = {
      targetProviderId: "siliconflow",
      targetProfileId: "deepseek-compatible-chat@1" as const,
      createdAt: "2026-08-24T18:00:00.000Z",
      pendingToolCallIds: [] as const,
    };
    const first = computeProviderEpochConversationProjectionDigests({
      ...base,
      messages: [{ role: "user", content: "first handoff" }],
    });
    const second = computeProviderEpochConversationProjectionDigests({
      ...base,
      messages: [{ role: "user", content: "different handoff" }],
    });

    expect(first.sourceFrontierDigest).not.toBe(second.sourceFrontierDigest);
    expect(first.handoffDigest).not.toBe(second.handoffDigest);
  });

  it("keeps a forward-only same-provider turn as an exact request prefix", () => {
    const firstCanonical = [
      { role: "system", content: "root authority" },
      { role: "user", content: "first question" },
    ];
    const stableReceipt = receipt("deepseek-compatible-chat@1", firstCanonical);
    const firstProjected = projectProviderEpochConversationMessages({
      messages: firstCanonical,
      receipt: stableReceipt,
    });
    const secondProjected = projectProviderEpochConversationMessages({
      messages: [
        ...firstCanonical,
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second question" },
      ],
      receipt: stableReceipt,
    });

    expect(secondProjected.slice(0, firstProjected.length)).toEqual(firstProjected);
    expect(secondProjected.length).toBe(firstProjected.length + 2);
  });
});
