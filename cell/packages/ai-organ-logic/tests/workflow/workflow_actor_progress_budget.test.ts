import { describe, expect, it } from "bun:test"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { dispatchActorRuntimeFacetEvent } from "@cell/ai-core-logic/runtime/ActorRuntimeFacet"
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
  createWorkflowLifecycleFacetEnvelope,
  createWorkflowLifecycleFacetRegistry,
  readWorkflowLifecycleFacet,
  WORKFLOW_LIFECYCLE_FACET_ID,
} from "../../src/workflow/runtime/WorkflowLifecycleFacet"
import {
  createWorkflowDomainProgressFact,
} from "../../src/workflow/runtime/WorkflowDomainProgress"
import { digestToolCallRecord, ensureVmToolCallDomain } from "../../src/runtime/ToolCallDomainRuntime"

const budget: WorkflowActorBudgetConfig = {
  stageDeadlineMs: 100,
  maxNoProgressTurns: 2,
  maxProofRepairAttempts: 2,
}

function workflowActor() {
  const actor = createActor({
    key: "workflow-budget",
    agentName: "workflow",
    systemPrompts: ["name: sys-eidolon-anchor-devops\nrevision: test-v1"],
    runtimeFacets: [createWorkflowLifecycleFacetEnvelope({
      strategyRevision: "hybrid/v1",
      systemPrompts: ["name: sys-eidolon-anchor-devops\nrevision: test-v1"],
      toolNames: [],
      progress: {
        stageStartedAt: 1_000,
        deadlineAt: 1_000 + budget.stageDeadlineMs,
        turnsSinceProgress: 0,
        maxNoProgressTurns: budget.maxNoProgressTurns,
        proofRepairAttempts: 0,
        maxProofRepairAttempts: budget.maxProofRepairAttempts,
        lastProgressAt: 1_000,
      },
    })],
  })
  return actor
}

function progress(actor: ReturnType<typeof workflowActor>) {
  return readWorkflowLifecycleFacet(actor)
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
  it("routes stage transitions through generic CAS and rejects a stale competing revision", () => {
    const actor = workflowActor()
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      runtimeContext: { actorFacetRuntime: createWorkflowLifecycleFacetRegistry() },
    })
    enterWorkflowActorStage({
      actor,
      runtime: vm,
      expectedRevision: 0,
      stageId: "coding",
      now: 1_001,
      config: budget,
    })
    expect(actor.runtimeFacets[WORKFLOW_LIFECYCLE_FACET_ID]?.revision).toBe(1)
    expect(() => enterWorkflowActorStage({
      actor,
      runtime: vm,
      expectedRevision: 0,
      stageId: "testing",
      now: 1_002,
      config: budget,
    })).toThrow(/ACTOR_RUNTIME_FACET_REVISION_CONFLICT/)
    expect(readWorkflowLifecycleFacet(actor)?.stageId).toBe("coding")
  })

  it("persists only closed terminal ToolCallDomain digest evidence after commit", () => {
    const actor = workflowActor()
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      runtimeContext: { actorFacetRuntime: createWorkflowLifecycleFacetRegistry() },
    })
    const domain = ensureVmToolCallDomain(vm)
    domain.planTool({
      toolCallId: "diagnostic-call",
      actorKey: actor.key,
      turnId: 1,
      funcName: "WorkflowValidateAuthoringSession",
      args: { secretArg: "must-not-enter-facet" },
      at: 1,
    })
    domain.recordGateDecision({ toolCallId: "diagnostic-call", gateOutcome: "allow", at: 2 })
    domain.markExecuting({ toolCallId: "diagnostic-call", at: 3 })
    const terminal = domain.recordFailure({
      toolCallId: "diagnostic-call",
      failureKind: "tool_error",
      outputText: "raw diagnostic must stay in ToolCallDomain",
      at: 4,
    })
    const recordDigest = digestToolCallRecord(terminal)
    dispatchActorRuntimeFacetEvent(vm, {
      actorKey: actor.key,
      facetId: WORKFLOW_LIFECYCLE_FACET_ID,
    }, {
      kind: "afterToolOutcome",
      operationId: "diagnostic-effect",
      occurredAt: 5,
      toolCallId: terminal.toolCallId,
      toolName: terminal.funcName,
      recordDigest,
      isError: true,
      outcome: "failed",
    }, {})
    expect(progress(actor)?.lastDiagnosticEvidence).toEqual({
      kind: "tool-call-digest",
      actorKey: actor.key,
      toolCallId: terminal.toolCallId,
      recordDigest,
    })
    expect(JSON.stringify(actor.runtimeFacets)).not.toContain("raw diagnostic")
    expect(JSON.stringify(actor.runtimeFacets)).not.toContain("must-not-enter-facet")
  })

  it("reduces turn and owner-issued tool progress through the neutral facet hook", () => {
    const actor = workflowActor()
    enterWorkflowActorStage({ actor, stageId: "coding", now: 1_000, config: budget })
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      runtimeContext: { actorFacetRuntime: createWorkflowLifecycleFacetRegistry() },
    })
    dispatchActorRuntimeFacetEvent(
      vm,
      { actorKey: actor.key, facetId: WORKFLOW_LIFECYCLE_FACET_ID },
      { kind: "beforeTurn", operationId: "turn-1", occurredAt: 1_001 },
      {},
    )
    expect(progress(actor)?.turnsSinceProgress).toBe(1)

    dispatchActorRuntimeFacetEvent(
      vm,
      { actorKey: actor.key, facetId: WORKFLOW_LIFECYCLE_FACET_ID },
      {
        kind: "afterToolOutcome",
        operationId: "tool-1",
        occurredAt: 1_002,
        toolCallId: "tool-1",
        toolName: "OwnerTool",
        recordDigest: "sha256:terminal-tool-call-1",
        isError: true,
        outcome: "failed",
      },
      {},
    )
    expect(progress(actor)).toMatchObject({
      turnsSinceProgress: 1,
      lastDiagnosticEvidence: {
        kind: "tool-call-digest",
        actorKey: actor.key,
        toolCallId: "tool-1",
        recordDigest: "sha256:terminal-tool-call-1",
      },
    })
    expect(actor.runtimeFacets[WORKFLOW_LIFECYCLE_FACET_ID]?.revision).toBe(3)
  })

  it("fails closed after consecutive turns without workspace, proof, lifecycle, or result progress", () => {
    const actor = workflowActor()
    const systemPrompts = structuredClone(actor.systemPrompts)
    enterWorkflowActorStage({ actor, stageId: "coding", now: 1_000, config: budget })

    beginWorkflowActorTurn({ actor, now: 1_001, config: budget })
    beginWorkflowActorTurn({ actor, now: 1_002, config: budget })
    expect(actor.systemPrompts).toEqual(systemPrompts)
    expect(() => beginWorkflowActorTurn({ actor, now: 1_003, config: budget })).toThrow(
      new WorkflowActorBudgetError("workflow_no_progress", "stage=coding produced no workspace/proof/lifecycle/result progress for 3 turns"),
    )
  })

  it("resets no-progress turns only for an owner-issued closed fact, independent of tool name", () => {
    const actor = workflowActor()
    const systemPrompts = structuredClone(actor.systemPrompts)
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
    expect(progress(actor)?.turnsSinceProgress).toBe(1)

    recordWorkflowActorToolOutcome({
      actor,
      toolName: "AnyOwnerToolName",
      args: { operation: "read" },
      outputText: progressOutput("workspace_revision_changed"),
      isError: false,
      now: 1_003,
      config: budget,
    })
    expect(progress(actor)).toMatchObject({
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
    expect(progress(actor)).toMatchObject({
      turnsSinceProgress: 0,
      lastOutcome: "workspace_changed",
      lastProgressAt: 1_005,
    })

    beginWorkflowActorTurn({ actor, now: 1_006, config: budget })
    expect(actor.systemPrompts).toEqual(systemPrompts)
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
    expect(progress(actor)).toMatchObject({ turnsSinceProgress: 0, lastOutcome: "proof" })

    beginWorkflowActorTurn({ actor, now: 1_003, config: budget })
    recordWorkflowActorToolOutcome({
      actor,
      toolName: "DifferentOwnerTool",
      outputText: progressOutput("lifecycle_completed"),
      isError: false,
      now: 1_004,
      config: budget,
    })
    expect(progress(actor)).toMatchObject({ turnsSinceProgress: 0, lastOutcome: "lifecycle_changed" })
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

    expect(progress(actor)).toMatchObject({
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
    expect(progress(actor)).toMatchObject({
      activeAuthoringSessionId: "authoring-session-1",
      activeAuthoringRevision: "sha256:current",
    })

    enterWorkflowActorStage({ actor, stageId: "testing", now: 1_002, config: traceBudget })
    expect(progress(actor)).toMatchObject({
      stageId: "testing",
      activeAuthoringSessionId: "authoring-session-1",
      activeAuthoringRevision: "sha256:current",
    })
    enterWorkflowActorStage({ actor, stageId: "coding", now: 1_002, config: traceBudget })

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
    expect(progress(actor)?.turnsSinceProgress).toBe(1)

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
    expect(progress(actor)).toMatchObject({
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
    expect(progress(actor)?.deadlineAt).toBe(1_100)
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
      diagnosticEvidence: {
        kind: "tool-call-digest",
        actorKey: actor.key,
        toolCallId: `proof-${diagnostic}`,
        recordDigest: `sha256:${diagnostic}`,
      },
        isError: true,
        now: 1_001,
        config: budget,
      })
    }
    expect(() => recordWorkflowActorToolOutcome({
      actor,
      toolName: "WorkflowValidateAuthoringSession",
      outputText: "still invalid",
      diagnosticEvidence: {
        kind: "tool-call-digest",
        actorKey: actor.key,
        toolCallId: "proof-still-invalid",
        recordDigest: "sha256:still-invalid",
      },
      isError: true,
      now: 1_002,
      config: budget,
    })).toThrow(/workflow_proof_repair_exhausted/)
    expect(progress(actor)?.lastDiagnosticEvidence).toMatchObject({
      kind: "tool-call-digest",
      toolCallId: "proof-still-invalid",
    })
    expect(JSON.stringify(progress(actor))).not.toContain("still invalid")
    expect(actor.workContext.summary).toBe("workspace revision 7")
  })

  it("treats owner-issued fresh-package diagnostics as bounded repair progress without claiming a session", () => {
    const actor = workflowActor()
    enterWorkflowActorStage({ actor, stageId: "coding", now: 1_000, config: budget })
    beginWorkflowActorTurn({ actor, now: 1_001, config: budget })
    recordWorkflowActorToolOutcome({
      actor,
      toolName: "WorkflowCreateResourcePackageSession",
      outputText: progressOutput("candidate_diagnostic"),
      isError: false,
      now: 1_002,
      config: budget,
    })
    expect(progress(actor)).toMatchObject({
      turnsSinceProgress: 0,
      proofRepairAttempts: 1,
      lastOutcome: "candidate_diagnostic",
    })
    expect(progress(actor)?.activeAuthoringSessionId).toBeUndefined()
    recordWorkflowActorToolOutcome({
      actor,
      toolName: "WorkflowCreateResourcePackageSession",
      outputText: progressOutput("candidate_diagnostic"),
      isError: false,
      now: 1_003,
      config: budget,
    })
    expect(() => recordWorkflowActorToolOutcome({
      actor,
      toolName: "WorkflowCreateResourcePackageSession",
      outputText: progressOutput("candidate_diagnostic"),
      isError: false,
      now: 1_004,
      config: budget,
    })).toThrow(/workflow_proof_repair_exhausted/)
  })

  it("persists the active budget across actor snapshots", () => {
    const actor = workflowActor()
    enterWorkflowActorStage({ actor, stageId: "building", now: 1_000, config: budget })
    beginWorkflowActorTurn({ actor, now: 1_001, config: budget })

    const restored = hydrateActor(serializeActor(actor), { actorFacetRuntime: createWorkflowLifecycleFacetRegistry() })
    expect(readWorkflowLifecycleFacet(restored)).toEqual(progress(actor))
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
