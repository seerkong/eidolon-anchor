import type { StdInnerLogic } from "depa-processor"
import {
  loadAiWorkflowStageContext,
  resolveEidolonGlobalRootFromOuterContext,
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

export const workflowLoadStageContextCoreLogic: StdInnerLogic<
  WorkflowLoadStageContextInnerRuntime,
  WorkflowLoadStageContextInnerInput,
  WorkflowLoadStageContextInnerConfig,
  WorkflowLoadStageContextInnerOutput
> = async (runtime, input) => {
  const context = await loadAiWorkflowStageContext({
    globalRoot: resolveEidolonGlobalRootFromOuterContext(runtime.vm.outerCtx),
    stage: input.stage,
  })
  enterWorkflowActorStage({
    actor: runtime.actor,
    stageId: input.stage,
    config: resolveWorkflowActorBudgetConfig(runtime.vm.outerCtx),
  })
  applyAiWorkflowStageSystemContext(runtime.actor, input.stage, context)
  const allowedTools = applyAiWorkflowStageToolPolicy(runtime.actor, input.stage)
  return JSON.stringify({
    kind: "eidolon.aiWorkflowStageContextLoaded",
    stage: input.stage,
    authority: "global:sys-eidolon-anchor-devops",
    allowedTools,
    stageActive: true,
    sameStageReloadAllowed: false,
  }, null, 2)
}
