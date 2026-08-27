export const AI_WORKFLOW_STAGE_TOOL_POLICY = Object.freeze({
  planning: Object.freeze([
    "WorkflowLoadStageContext", "WorkflowListApps", "WorkflowGetApp", "WorkflowGetAuthoringContext",
    "WorkflowListAuthoringTemplates", "WorkflowListPrebuiltWorkflows", "WorkflowListReusableAgents",
    "WorkflowListAuthoringSessions", "WorkflowGetAuthoringSummary", "WorkflowInspectCapability",
    "WorkflowListTypes", "WorkflowListInstances", "WorkflowGetInstance", "WorkflowGetFlowSummary",
  ]),
  coding: Object.freeze([
    "WorkflowLoadStageContext", "Skill", "WorkflowListApps", "WorkflowGetApp", "WorkflowGetAuthoringContext",
    "WorkflowListAuthoringTemplates", "WorkflowListPrebuiltWorkflows", "WorkflowListReusableAgents",
    "WorkflowListAuthoringSessions", "WorkflowGetAuthoringSummary", "WorkflowOpenAuthoringSession",
    "WorkflowCreateResourcePackageSession", "WorkflowWorkspace", "WorkflowInspectCapability",
    "WorkflowValidateResourceRef", "WorkflowCreateBundle", "WorkflowPatchBundle",
  ]),
  building: Object.freeze([
    "WorkflowLoadStageContext", "Skill", "WorkflowGetAuthoringSummary", "WorkflowValidateAuthoringSession",
    "WorkflowValidateResourceRef", "WorkflowInspectCapability",
  ]),
  testing: Object.freeze([
    "WorkflowLoadStageContext", "Skill", "WorkflowGetAuthoringSummary", "WorkflowValidateAuthoringSession",
    "WorkflowDryRunAuthoringSession", "WorkflowPreparePublication", "WorkflowCompleteAuthoring",
    "WorkflowInspectCapability",
  ]),
  releasing: Object.freeze([
    "WorkflowLoadStageContext", "Skill", "WorkflowGetAuthoringSummary", "WorkflowValidateAuthoringSession",
    "WorkflowDryRunAuthoringSession", "WorkflowPreparePublication", "WorkflowCompleteAuthoring",
    "WorkflowPublishAuthoringSession",
  ]),
  deploying: Object.freeze([
    "WorkflowLoadStageContext", "Skill", "WorkflowListApps", "WorkflowGetApp", "WorkflowListTypes",
    "WorkflowGetType", "WorkflowCreateInstance", "WorkflowCreateInstanceFromPrebuilt", "WorkflowListInstances",
    "WorkflowGetInstance", "WorkflowMaterialImport", "WorkflowMaterialInspect", "WorkflowMaterialBind",
  ]),
  operating: Object.freeze([
    "WorkflowLoadStageContext", "Skill", "WorkflowGetInstance", "WorkflowUpdateRunVars", "WorkflowRun",
    "WorkflowStatus", "WorkflowResume", "WorkflowResolve", "WorkflowReject", "WorkflowApplyGraphPatch",
    "WorkflowMutateStepExtension", "WorkflowProcessHolonTask", "WorkflowReplanHolonTask",
  ]),
  monitoring: Object.freeze([
    "WorkflowLoadStageContext", "Skill", "WorkflowStatus", "WorkflowEvents", "WorkflowResult",
    "WorkflowGetFlowSummary", "WorkflowListSessionFlows", "WorkflowMaterialInspect", "WorkflowMaterialExport",
    "WorkflowMaterialReplay", "WorkflowMaterialCleanup",
  ]),
  improving: Object.freeze([
    "WorkflowLoadStageContext", "Skill", "WorkflowGetAuthoringSummary", "WorkflowStatus", "WorkflowEvents",
    "WorkflowResult", "WorkflowGetFlowSummary",
  ]),
} as const)

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export const AI_WORKFLOW_PROVIDER_TOOL_SURFACE: readonly string[] = Object.freeze(
  [...new Set(Object.values(AI_WORKFLOW_STAGE_TOOL_POLICY).flat())].sort(compareCodeUnits),
)
