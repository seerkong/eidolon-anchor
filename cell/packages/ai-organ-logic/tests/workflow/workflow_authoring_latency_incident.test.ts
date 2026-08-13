import { describe, expect, it } from "bun:test"

import incident from "./fixtures/workflow-authoring-latency-incident.json" with { type: "json" }
import {
  summarizeWorkflowAuthoringLatency,
  type WorkflowAuthoringLatencySample,
} from "./authoringLatencyHarness"

const baseline = incident as WorkflowAuthoringLatencySample

describe("AI Workflow authoring latency incident baseline", () => {
  it("freezes the 142.956 second request-to-publication boundary", () => {
    const report = summarizeWorkflowAuthoringLatency(baseline)

    expect(report.totalMs).toBe(142_956)
    expect(baseline.measurement.publishedAtEpochMs - baseline.measurement.startedAtEpochMs).toBe(report.totalMs)
    expect(report.outerDispatchMs + report.authoringActorMs).toBe(report.totalMs)
    expect(baseline.measurement.postPublicationReportExcluded).toBe(true)
  })

  it("reports every completion and tool transition in stage order", () => {
    const report = summarizeWorkflowAuthoringLatency(baseline)

    expect(baseline.turns.map((turn) => turn.completion)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(report.completionCount).toBe(12)
    expect(report.transitionCount).toBe(19)
    expect(report.transitionCount).toBe(baseline.outcomes.authoringToolTransitionCount)
    expect(report.phases).toEqual([
      {
        stage: "coding",
        completionCount: 7,
        transitionCount: 14,
        providerWaitMs: 30_508,
        generationMs: 73_618,
        toolWallMs: 319,
        measuredMs: 104_445,
      },
      {
        stage: "testing",
        completionCount: 2,
        transitionCount: 2,
        providerWaitMs: 6_949,
        generationMs: 4_815,
        toolWallMs: 47,
        measuredMs: 11_811,
      },
      {
        stage: "releasing",
        completionCount: 3,
        transitionCount: 3,
        providerWaitMs: 10_403,
        generationMs: 9_013,
        toolWallMs: 64,
        measuredMs: 19_480,
      },
    ])
  })

  it("keeps first mutation, proof, and publication milestones machine comparable", () => {
    const report = summarizeWorkflowAuthoringLatency(baseline)

    expect(report.firstMutation).toEqual({ elapsedMs: 95_359, completion: 5 })
    expect(report.publication).toEqual({ elapsedMs: 142_956, completion: 12 })
    expect(baseline.milestones.map((milestone) => milestone.kind)).toEqual([
      "request_accepted",
      "authoring_actor_started",
      "first_workspace_mutation",
      "diff_proof_recorded",
      "validation_proof_recorded",
      "static_dry_run_recorded",
      "publication_recorded",
    ])
    expect(baseline.turns.flatMap((turn) => turn.transitions).filter((transition) => transition.proof).map((transition) => transition.proof)).toEqual([
      "diff",
      "validation",
      "static_projection",
    ])
    expect(baseline.turns.flatMap((turn) => turn.transitions).filter((transition) => transition.publication)).toHaveLength(1)
  })

  it("characterizes model generation rather than tool failures as the incident bottleneck", () => {
    const report = summarizeWorkflowAuthoringLatency(baseline)

    expect(report.providerWaitMs).toBe(47_860)
    expect(report.generationMs).toBe(87_446)
    expect(report.toolWallMs).toBe(430)
    expect(report.slowestGeneration).toMatchObject({
      completion: 5,
      generationMs: 50_847,
      reasoningDeltaCount: 5_810,
      reasoningCharacterCount: 22_409,
    })
    expect(baseline.outcomes).toMatchObject({
      toolFailureCount: 0,
      retryCount: 0,
      workspaceMutationCount: 2,
    })
  })
})
