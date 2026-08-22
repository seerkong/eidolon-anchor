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
import {
  createWorkflowDomainProgressFact,
} from "../../src/workflow/runtime/WorkflowDomainProgress"

const budget: WorkflowActorBudgetConfig = {
  stageDeadlineMs: 100,
  maxNoProgressTurns: 2,
  maxProofRepairAttempts: 2,
}

function workflowActor() {
  return createActor({ key: "workflow-budget", agentName: "workflow" })
}

function progressOutput(
  transition: Parameters<typeof createWorkflowDomainProgressFact>[0]["transition"],
  ok = true,
): string {
  return JSON.stringify({
    ok,
    workflow_progress: createWorkflowDomainProgressFact({
      owner: "workflow.authoring",
      transition,
      subjectId: "authoring-session-1",
      revision: "sha256:current",
    }),
  })
}

describe("workflow actor progress budget", () => {
  it("fails closed after consecutive turns without workspace, proof, lifecycle, or result progress", () => {
    const actor = workflowActor()
    enterWorkflowActorStage({ actor, stageId: "coding", now: 1_000, config: budget })

    beginWorkflowActorTurn({ actor, now: 1_001, config: budget })
    beginWorkflowActorTurn({ actor, now: 1_002, config: budget })
    expect(actor.systemPrompts.filter((prompt) => prompt.startsWith("<!-- eidolon:workflow-progress-budget -->")))
      .toEqual([expect.stringContaining("remaining_no_progress_turns: 0")])
    expect(() => beginWorkflowActorTurn({ actor, now: 1_003, config: budget })).toThrow(
      new WorkflowActorBudgetError("workflow_no_progress", "stage=coding produced no workspace/proof/lifecycle/result progress for 3 turns"),
    )
  })

  it("resets no-progress turns only for an owner-issued closed fact, independent of tool name", () => {
    const actor = workflowActor()
    enterWorkflowActorStage({ actor, stageId: "coding", now: 1_000, config: budget })
    beginWorkflowActorTurn({ actor, now: 1_001, config: budget })
    recordWorkflowActorToolOutcome({
      actor,
      toolName: "WorkflowWorkspace",
      args: { operation: "write", path: "/work/manifest.xnl" },
      isError: false,
      now: 1_002,
      config: budget,
    })
    expect(actor.workflowProgress?.turnsSinceProgress).toBe(1)

    recordWorkflowActorToolOutcome({
      actor,
      toolName: "AnyOwnerToolName",
      args: { operation: "read" },
      outputText: progressOutput("workspace_revision_changed"),
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
      toolName: "AnotherOwnerToolName",
      outputText: progressOutput("workspace_revision_changed"),
      isError: false,
      now: 1_005,
      config: budget,
    })
    expect(actor.workflowProgress).toMatchObject({
      turnsSinceProgress: 0,
      lastOutcome: "workspace_changed",
      lastProgressAt: 1_005,
    })

    beginWorkflowActorTurn({ actor, now: 1_006, config: budget })
    expect(actor.systemPrompts.filter((prompt) => prompt.startsWith("<!-- eidolon:workflow-progress-budget -->")))
      .toEqual([expect.stringContaining("remaining_no_progress_turns: 1")])
  })

  it("treats owner-issued proof and authoring lifecycle facts as progress", () => {
    const actor = workflowActor()
    enterWorkflowActorStage({ actor, stageId: "testing", now: 1_000, config: budget })
    beginWorkflowActorTurn({ actor, now: 1_001, config: budget })

    recordWorkflowActorToolOutcome({
      actor,
      toolName: "OwnerTool",
      outputText: progressOutput("proof_prepared"),
      isError: false,
      now: 1_002,
      config: budget,
    })
    expect(actor.workflowProgress).toMatchObject({ turnsSinceProgress: 0, lastOutcome: "proof" })

    beginWorkflowActorTurn({ actor, now: 1_003, config: budget })
    recordWorkflowActorToolOutcome({
      actor,
      toolName: "DifferentOwnerTool",
      outputText: progressOutput("lifecycle_completed"),
      isError: false,
      now: 1_004,
      config: budget,
    })
    expect(actor.workflowProgress).toMatchObject({ turnsSinceProgress: 0, lastOutcome: "lifecycle_changed" })
  })

  it("does not accept a structured failed mutation envelope as progress", () => {
    const actor = workflowActor()
    enterWorkflowActorStage({ actor, stageId: "coding", now: 1_000, config: budget })
    beginWorkflowActorTurn({ actor, now: 1_001, config: budget })

    recordWorkflowActorToolOutcome({
      actor,
      toolName: "WorkflowWorkspace",
      args: { operation: "patch" },
      outputText: progressOutput("workspace_revision_changed", false),
      isError: false,
      now: 1_002,
      config: budget,
    })

    expect(actor.workflowProgress).toMatchObject({
      turnsSinceProgress: 1,
      lastOutcome: "stage_selected",
    })
  })

  it("replays the optimized authoring trace within the unchanged four-turn budget", () => {
    const actor = workflowActor()
    const traceBudget = { ...budget, maxNoProgressTurns: 4 }
    const toolSequence: string[] = []
    const selectionPaths = [
      "/work/Apps/Summary.xnl",
      "/work/Workflows/Summary.xnl",
      "/work/KindDefinitions/AIWorkflowAppBundle/manifest.xnl",
      "/work/KindDefinitions/AICtrlWorkflow/manifest.xnl",
    ]
    enterWorkflowActorStage({ actor, stageId: "coding", now: 1_000, config: traceBudget })

    beginWorkflowActorTurn({ actor, now: 1_001, config: traceBudget })
    toolSequence.push("WorkflowOpenAuthoringSession")
    recordWorkflowActorToolOutcome({
      actor,
      toolName: "WorkflowOpenAuthoringSession",
      outputText: JSON.stringify({
        ok: true,
        selection: { files: selectionPaths.map((path) => ({ path })), truncated: false },
        workflow_progress: createWorkflowDomainProgressFact({
          owner: "workflow.authoring",
          transition: "workspace_opened",
          subjectId: "authoring-session-1",
          revision: "sha256:current",
        }),
      }),
      isError: false,
      now: 1_002,
      config: traceBudget,
    })

    beginWorkflowActorTurn({ actor, now: 1_003, config: traceBudget })
    toolSequence.push("Skill")
    recordWorkflowActorToolOutcome({
      actor,
      toolName: "Skill",
      outputText: JSON.stringify({ ok: true, loaded: ["batch", "proof", "flow-profile"] }),
      isError: false,
      now: 1_004,
      config: traceBudget,
    })
    expect(actor.workflowProgress?.turnsSinceProgress).toBe(1)

    beginWorkflowActorTurn({ actor, now: 1_005, config: traceBudget })
    toolSequence.push("WorkflowWorkspace:patch")
    recordWorkflowActorToolOutcome({
      actor,
      toolName: "WorkflowWorkspace",
      outputText: progressOutput("workspace_revision_changed"),
      isError: false,
      now: 1_006,
      config: traceBudget,
    })
    expect(actor.workflowProgress).toMatchObject({
      maxNoProgressTurns: 4,
      turnsSinceProgress: 0,
      lastOutcome: "workspace_changed",
    })
    expect(selectionPaths.filter((path) => path.includes("/KindDefinitions/"))).toHaveLength(2)
    expect(toolSequence).toEqual([
      "WorkflowOpenAuthoringSession",
      "Skill",
      "WorkflowWorkspace:patch",
    ])
    expect(toolSequence.some((toolName) => toolName.endsWith(":read") || toolName.endsWith(":search"))).toBe(false)
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
