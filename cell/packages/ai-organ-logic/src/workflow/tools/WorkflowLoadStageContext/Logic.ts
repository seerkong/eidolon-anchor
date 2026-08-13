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

const STAGE_NEXT_ACTION: Readonly<Record<string, string>> = {
  planning: "If the invocation is already a concrete confirmed fresh create, transition directly to coding now without catalog/list/summary discovery. Otherwise use only the specific planning read needed to resolve a missing topology or authority decision. Do not reload planning.",
  coding: "Act now without explanatory content: for a fresh confirmed definition call WorkflowCreateBundle directly with concise paired manifest/code; for an identified session read only required detail and submit one expected-revision patch. After mutation transition to testing; do not validate/complete in coding, reload coding, or perform broad discovery.",
  building: "Run the deterministic build/validation action now. Do not reload building while this stage remains active.",
  testing: "Call WorkflowPreparePublication with session_id only for the exact working revision now; the component derives acceptance disposition from canonical authority. Then consume structured diagnostics. Do not reload testing or read a summary while this stage remains active.",
  releasing: "Consume the existing exact-revision proof set and publish only when publication authorization is true. Do not rerun proof tools or reload releasing.",
  deploying: "If a publication receipt is present, call WorkflowCreateInstance now with receipt.workflowRef and the requested input; do not list/get known Type identity. Create or resolve one instance without running it, then transition to operating. Do not reload deploying.",
  operating: "Run or resume the identified instance only when execution authorization is true. Do not reload operating while this stage remains active.",
  monitoring: "Read the identified run result/evidence now. Do not reload monitoring while this stage remains active.",
}

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
    authority: "global:sys-ai-workflow",
    allowedTools,
    stageActive: true,
    sameStageReloadAllowed: false,
    nextAction: STAGE_NEXT_ACTION[input.stage],
  }, null, 2)
}
