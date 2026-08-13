import { describe, expect, it } from "bun:test"

import { projectWorkflowAuthoringTelemetry } from "../../src/workflow/runtime"

describe("workflow authoring telemetry projection", () => {
  it("derives provider wait, generation, tool duration, payload, and first mutation from domain facts", () => {
    const report = projectWorkflowAuthoringTelemetry({
      actorKey: "main:workflow:1",
      startedAt: 1_000,
      publishedAt: 1_220,
      providerCalls: [
        {
          providerCallId: "p1",
          actorKey: "main:workflow:1",
          turnId: 1,
          modelRef: "fixture",
          modelParams: {},
          toolSchemas: [],
          startedAt: 1_010,
          firstTokenAt: 1_030,
          completedAt: 1_080,
          reasoning: { text: "think", segments: [{ startAt: 1_030, endAt: 1_035, text: "think" }] },
          toolCallIds: ["t1"],
          status: "completed",
        },
        {
          providerCallId: "other",
          actorKey: "another-actor",
          turnId: 1,
          modelRef: "fixture",
          modelParams: {},
          toolSchemas: [],
          startedAt: 0,
          firstTokenAt: 100,
          completedAt: 200,
          status: "completed",
        },
      ],
      toolCalls: [{
        toolCallId: "t1",
        actorKey: "main:workflow:1",
        turnId: 1,
        funcName: "WorkflowWorkspace",
        args: { operation: "patch", operations: [{ kind: "add", path: "/work/a.ts", content: "x" }] },
        plannedAt: 1_080,
        executedAt: 1_090,
        resultAt: 1_110,
        outputText: "{\"revision\":\"sha256:next\"}",
        status: "completed",
      }],
      authoringAudit: [
        { seq: 1, at: new Date(1_000).toISOString(), operation: "open", detail: {} },
        { seq: 2, at: new Date(1_105).toISOString(), operation: "patch", detail: { revision: "sha256:next" } },
        { seq: 3, at: new Date(1_180).toISOString(), operation: "prepare-publication", detail: {} },
        { seq: 4, at: new Date(1_220).toISOString(), operation: "publish", detail: {} },
      ],
    })

    expect(report).toMatchObject({
      actorKey: "main:workflow:1",
      completionCount: 1,
      providerWaitMs: 20,
      generationMs: 50,
      toolDurationMs: 20,
      reasoningDeltaCount: 1,
      reasoningCharacterCount: 5,
      totalMs: 220,
      firstMutation: { elapsedMs: 105, operation: "patch", revision: "sha256:next" },
      publication: { elapsedMs: 220 },
    })
    expect(report.inputPayloadBytes).toBeGreaterThan(0)
    expect(report.outputPayloadBytes).toBe(26)
    expect(report.turns).toEqual([expect.objectContaining({
      turnId: 1,
      providerWaitMs: 20,
      generationMs: 50,
      toolDurationMs: 20,
      toolCallCount: 1,
    })])
  })

  it("keeps incomplete and failed calls observable without inventing negative durations", () => {
    const report = projectWorkflowAuthoringTelemetry({
      actorKey: "workflow",
      startedAt: 100,
      providerCalls: [{
        providerCallId: "failed",
        actorKey: "workflow",
        turnId: 2,
        modelRef: "fixture",
        modelParams: {},
        toolSchemas: [],
        startedAt: 200,
        completedAt: 190,
        failureKind: "timeout",
        status: "failed",
      }],
      toolCalls: [],
      authoringAudit: [],
    })

    expect(report.providerWaitMs).toBe(0)
    expect(report.generationMs).toBe(0)
    expect(report.failedProviderCallCount).toBe(1)
  })
})
