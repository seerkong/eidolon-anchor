import { describe, expect, it } from "bun:test"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { hydrateActor, serializeActor } from "@cell/ai-core-logic/runtime/snapshot/actorSnapshot"
import {
  beginWorkflowActorTurn,
  enterWorkflowActorStage,
  recordWorkflowActorToolOutcome,
  runWithinWorkflowStageDeadline,
  WorkflowActorBudgetError,
  type WorkflowActorBudgetConfig,
} from "../../src/workflow/runtime/WorkflowActorProgress"

const budget: WorkflowActorBudgetConfig = {
  stageDeadlineMs: 100,
  maxNoProgressTurns: 2,
  maxProofRepairAttempts: 2,
}

function workflowActor() {
  return createActor({ key: "workflow-budget", agentName: "workflow" })
}

describe("workflow actor progress budget", () => {
  it("fails closed after consecutive turns without workspace, proof, lifecycle, or result progress", () => {
    const actor = workflowActor()
    enterWorkflowActorStage({ actor, stageId: "coding", now: 1_000, config: budget })

    beginWorkflowActorTurn({ actor, now: 1_001, config: budget })
    beginWorkflowActorTurn({ actor, now: 1_002, config: budget })
    expect(() => beginWorkflowActorTurn({ actor, now: 1_003, config: budget })).toThrow(
      new WorkflowActorBudgetError("workflow_no_progress", "stage=coding produced no workspace/proof/lifecycle/result progress for 3 turns"),
    )
  })

  it("resets no-progress turns only for an explicit progress fact", () => {
    const actor = workflowActor()
    enterWorkflowActorStage({ actor, stageId: "coding", now: 1_000, config: budget })
    beginWorkflowActorTurn({ actor, now: 1_001, config: budget })
    recordWorkflowActorToolOutcome({
      actor,
      toolName: "WorkflowWorkspace",
      args: { operation: "read", path: "/base/manifest.xnl" },
      isError: false,
      now: 1_002,
      config: budget,
    })
    expect(actor.workflowProgress?.turnsSinceProgress).toBe(1)

    recordWorkflowActorToolOutcome({
      actor,
      toolName: "WorkflowWorkspace",
      args: { operation: "write", path: "/work/manifest.xnl" },
      isError: false,
      now: 1_003,
      config: budget,
    })
    expect(actor.workflowProgress).toMatchObject({
      turnsSinceProgress: 0,
      lastOutcome: "workspace_changed",
      lastProgressAt: 1_003,
    })

    beginWorkflowActorTurn({ actor, now: 1_004, config: budget })
    recordWorkflowActorToolOutcome({
      actor,
      toolName: "WorkflowWorkspace",
      args: {
        operation: "patch",
        expected_revision: "sha256:before",
        operations: [{ operation: "update", path: "workflow.xnl", content: "<Flow/>" }],
      },
      isError: false,
      now: 1_005,
      config: budget,
    })
    expect(actor.workflowProgress).toMatchObject({
      turnsSinceProgress: 0,
      lastOutcome: "workspace_changed",
      lastProgressAt: 1_005,
    })
  })

  it("does not reset a stage deadline by reloading the same stage", () => {
    const actor = workflowActor()
    enterWorkflowActorStage({ actor, stageId: "testing", now: 1_000, config: budget })
    enterWorkflowActorStage({ actor, stageId: "testing", now: 1_099, config: budget })
    expect(actor.workflowProgress?.deadlineAt).toBe(1_100)
    expect(() => beginWorkflowActorTurn({ actor, now: 1_100, config: budget })).toThrow(/workflow_stage_deadline/)
  })

  it("bounds proof repair attempts while preserving the last diagnostic and workspace state", () => {
    const actor = workflowActor()
    enterWorkflowActorStage({ actor, stageId: "testing", now: 1_000, config: budget })
    actor.workContext.summary = "workspace revision 7"

    for (const diagnostic of ["invalid edge", "missing return"]) {
      recordWorkflowActorToolOutcome({
        actor,
        toolName: "WorkflowValidateAuthoringSession",
        outputText: diagnostic,
        isError: true,
        now: 1_001,
        config: budget,
      })
    }
    expect(() => recordWorkflowActorToolOutcome({
      actor,
      toolName: "WorkflowValidateAuthoringSession",
      outputText: "still invalid",
      isError: true,
      now: 1_002,
      config: budget,
    })).toThrow(/workflow_proof_repair_exhausted/)
    expect(actor.workflowProgress?.lastDiagnostic).toBe("still invalid")
    expect(actor.workContext.summary).toBe("workspace revision 7")
  })

  it("persists the active budget across actor snapshots", () => {
    const actor = workflowActor()
    enterWorkflowActorStage({ actor, stageId: "building", now: 1_000, config: budget })
    beginWorkflowActorTurn({ actor, now: 1_001, config: budget })

    const restored = hydrateActor(serializeActor(actor))
    expect(restored.workflowProgress).toEqual(actor.workflowProgress)
  })

  it("aborts a provider request at the workflow stage deadline", async () => {
    const actor = workflowActor()
    const controller = new AbortController()
    enterWorkflowActorStage({ actor, stageId: "coding", now: Date.now(), config: { ...budget, stageDeadlineMs: 5 } })

    await expect(runWithinWorkflowStageDeadline({
      actor,
      abortController: controller,
      run: () => new Promise<never>(() => {}),
    })).rejects.toThrow(/workflow_stage_deadline/)
    expect(controller.signal.aborted).toBe(true)
  })
})
