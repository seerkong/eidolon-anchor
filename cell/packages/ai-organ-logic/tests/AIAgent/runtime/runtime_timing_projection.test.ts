import { describe, expect, it } from "bun:test"

import type { ProviderCallRecord } from "@cell/ai-core-contract/runtime/ProviderCallDomain"
import type { ToolCallRecord } from "@cell/ai-core-contract/runtime/ToolCallDomain"
import { projectRuntimeTiming } from "@cell/ai-organ-logic/runtime/RuntimeTimingProjection"

function provider(overrides: Partial<ProviderCallRecord> = {}): ProviderCallRecord {
  return {
    providerCallId: "provider-1",
    actorKey: "actor-main",
    turnId: 1,
    modelRef: "private-model-ref",
    modelParams: { reasoningEffort: "private-config" },
    toolSchemas: [{ name: "private-tool-schema", hash: "sha256:private" }],
    promptGenerationRef: "private-prompt-ref",
    startedAt: 110,
    firstTokenAt: 130,
    completedAt: 160,
    reasoning: { text: "private reasoning", segments: [] },
    content: { text: "private content", segments: [] },
    rawError: "private provider detail",
    status: "completed",
    ...overrides,
  }
}

function tool(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    toolCallId: "tool-1",
    actorKey: "actor-main",
    turnId: 1,
    funcName: "WorkflowFulfill",
    args: { privateInput: "value" },
    plannedAt: 104,
    dispatchedAt: 105,
    gateOutcome: "allow",
    executedAt: 105,
    resultAt: 190,
    outputText: "private tool output",
    status: "completed",
    ...overrides,
  }
}

describe("runtime timing projection", () => {
  it("uses interval union and deterministic precedence so exclusive components exactly cover wall time", () => {
    const report = projectRuntimeTiming({
      sessionId: "session-stable",
      startedAt: 100,
      endedAt: 200,
      callEntryLimit: 2,
      providerCalls: [
        provider(),
        provider({
          providerCallId: "provider-2",
          actorKey: "actor-child",
          startedAt: 120,
          firstTokenAt: 150,
          completedAt: 180,
        }),
        provider({
          providerCallId: "provider-3",
          actorKey: "actor-child",
          turnId: 2,
          startedAt: 185,
          firstTokenAt: undefined,
          completedAt: 195,
          failureKind: "timeout",
          status: "failed",
        }),
      ],
      toolCalls: [
        tool(),
        tool({
          toolCallId: "tool-2",
          plannedAt: 170,
          dispatchedAt: undefined,
          gateOutcome: "deny",
          executedAt: undefined,
          resultAt: 171,
          status: "denied",
        }),
      ],
      providerRetries: [{
        actorId: "actor-child-id",
        turnId: "2",
        traceId: "trace-stable",
        attemptNumber: 2,
        retryCount: 1,
        maxRetries: 2,
        error: "private retry detail",
        classificationReason: "transport_timeout_retryable",
        terminationReason: "retry_scheduled",
      }],
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      sessionId: "session-stable",
      window: { startedAt: 100, endedAt: 200, wallMs: 100 },
      attribution: {
        intervalMode: "exclusive_union",
        precedence: ["provider_generation", "provider_wait", "tool", "product_owned"],
        missingFirstTokenPolicy: "entire_provider_interval_is_wait",
      },
      components: {
        providerWaitMs: 30,
        providerGenerationMs: 50,
        toolMs: 10,
        productOwnedMs: 10,
      },
      counts: {
        providerCalls: 3,
        providerFailures: 1,
        providerRetries: 1,
        toolCalls: 2,
        toolFailures: 0,
        toolDenied: 1,
      },
      providerCalls: {
        entryLimit: 2,
        omittedCount: 1,
      },
      retries: {
        entryLimit: 2,
        omittedCount: 0,
        entries: [{
          actorId: "actor-child-id",
          turnId: "2",
          traceId: "trace-stable",
          attemptNumber: 2,
          retryCount: 1,
          maxRetries: 2,
          reason: "transport_timeout_retryable",
          terminalCause: "retry_scheduled",
        }],
      },
    })
    expect(report.providerCalls.entries.map((entry) => entry.providerCallId)).toEqual([
      "provider-2",
      "provider-3",
    ])
    expect(report.providerCalls.entries[1]).toMatchObject({
      status: "failed",
      failureKind: "timeout",
      terminalCause: "timeout",
      observedWaitMs: 10,
      observedGenerationMs: 0,
    })
    expect(
      report.components.providerWaitMs
      + report.components.providerGenerationMs
      + report.components.toolMs
      + report.components.productOwnedMs,
    ).toBe(report.window.wallMs)
  })

  it("projects only bounded stable lifecycle facts and never provider or tool payloads", () => {
    const serialized = JSON.stringify(projectRuntimeTiming({
      sessionId: "session-stable",
      startedAt: 100,
      endedAt: 200,
      providerCalls: [provider()],
      toolCalls: [tool()],
      providerRetries: [{
        actorId: "actor-main-id",
        turnId: "1",
        traceId: "trace-stable",
        attemptNumber: 2,
        retryCount: 1,
        maxRetries: 3,
        error: "private retry detail",
        classificationReason: "private classification",
      }],
    }))

    expect(serialized).not.toContain("private-model-ref")
    expect(serialized).not.toContain("private-config")
    expect(serialized).not.toContain("private-tool-schema")
    expect(serialized).not.toContain("private-prompt-ref")
    expect(serialized).not.toContain("private reasoning")
    expect(serialized).not.toContain("private content")
    expect(serialized).not.toContain("private provider detail")
    expect(serialized).not.toContain("privateInput")
    expect(serialized).not.toContain("private tool output")
    expect(serialized).not.toContain("private retry detail")
    expect(serialized).not.toContain("private classification")
  })

  it("keeps timeout and user cancellation as distinct typed terminal causes", () => {
    const report = projectRuntimeTiming({
      sessionId: "session-stable",
      startedAt: 100,
      endedAt: 160,
      providerCalls: [
        provider({
          providerCallId: "provider-timeout",
          startedAt: 100,
          firstTokenAt: undefined,
          completedAt: 120,
          status: "failed",
          failureKind: "timeout",
        }),
        provider({
          providerCallId: "provider-cancelled",
          startedAt: 130,
          firstTokenAt: undefined,
          completedAt: 150,
          status: "failed",
          failureKind: "aborted_by_user",
        }),
      ],
      toolCalls: [],
    })

    expect(report.providerCalls.entries.map((entry) => entry.terminalCause)).toEqual([
      "timeout",
      "aborted_by_user",
    ])
  })
})
