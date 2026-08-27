import type { StdInnerLogic } from "depa-processor"
import {
  loadFrozenAiWorkflowStageContext,
} from "@cell/ai-support/system-skill/SystemSkillInstaller"
import type {
  WorkflowLoadStageContextInnerConfig,
  WorkflowLoadStageContextInnerInput,
  WorkflowLoadStageContextInnerOutput,
  WorkflowLoadStageContextInnerRuntime,
} from "./InnerTypes"
import { applyAiWorkflowStageSystemContext, applyAiWorkflowStageToolPolicy } from "./StageToolPolicy"
import {
  enterWorkflowActorStage,
  resolveWorkflowActorBudgetConfig,
} from "../../runtime/WorkflowActorProgress"
import {
  WORKFLOW_LIFECYCLE_FACET_ID,
  readWorkflowLifecycleFacet,
  readWorkflowLifecycleFrozenResourcePackage,
} from "../../runtime/WorkflowLifecycleFacet"

export const workflowLoadStageContextCoreLogic: StdInnerLogic<
  WorkflowLoadStageContextInnerRuntime,
  WorkflowLoadStageContextInnerInput,
  WorkflowLoadStageContextInnerConfig,
  WorkflowLoadStageContextInnerOutput
> = async (runtime, input) => {
  const facet = readWorkflowLifecycleFacet(runtime.actor)
  if (!facet) throw new Error("Workflow stage context requires lifecycle facet proof")
  const context = loadFrozenAiWorkflowStageContext({
    resourcePackage: readWorkflowLifecycleFrozenResourcePackage({ actor: runtime.actor, facet }),
    stage: input.stage,
  })
  enterWorkflowActorStage({
    actor: runtime.actor,
    runtime: runtime.vm,
    stageId: input.stage,
    config: resolveWorkflowActorBudgetConfig(runtime.vm.outerCtx),
  })
  const stageContext = applyAiWorkflowStageSystemContext(runtime.actor, input.stage, context)
  const allowedTools = applyAiWorkflowStageToolPolicy(runtime.actor, input.stage)
  const currentFacet = readWorkflowLifecycleFacet(runtime.actor)
  if (!currentFacet) throw new Error("Workflow stage context lost lifecycle facet proof")
  const facetRevision = runtime.actor.runtimeFacets[WORKFLOW_LIFECYCLE_FACET_ID]?.revision
  if (!Number.isSafeInteger(facetRevision)) throw new Error("Workflow stage context requires a durable facet revision")
  const output = JSON.stringify({
    ...stageContext,
    allowedTools,
    stageActive: true,
    sameStageReloadAllowed: false,
  }, null, 2)
  return {
    output,
    contextEffects: [{
      kind: "append_provider_context_fact",
      namespace: "workflow-stage-context",
      logicalKey: "workflow-stage-context",
      revision: `${input.stage}:${currentFacet.resourcePackage.packageDigest}:facet-${facetRevision}`,
      payload: {
        stage: input.stage,
        context,
        allowedTools,
        facetRevision,
        packageRevision: currentFacet.resourcePackage.revision,
        packageDigest: currentFacet.resourcePackage.packageDigest,
        packageProvenanceDigest: currentFacet.resourcePackage.provenanceDigest,
      },
    }],
  }
}
