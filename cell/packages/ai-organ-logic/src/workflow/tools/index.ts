import type { AnyToolDef } from "@cell/ai-core-contract/types"
import { buildWorkflowFulfillToolDef } from "./WorkflowFulfill"
import { buildWorkflowAuthorToolDef } from "./WorkflowAuthor"
import { buildWorkflowAuthoringToolDefs } from "./WorkflowAuthoringTools"
import { buildWorkflowAppToolDefs } from "./WorkflowAppTools"
import { buildWorkflowCreateBundleToolDef } from "./WorkflowCreateBundle"
import { buildWorkflowInspectCapabilityToolDef } from "./WorkflowInspectCapability"
import { buildWorkflowPatchBundleToolDef } from "./WorkflowPatchBundle"
import {
  buildWorkflowEventsToolDef,
  buildWorkflowApplyGraphPatchToolDef,
  buildWorkflowMutateStepExtensionToolDef,
  buildWorkflowResultToolDef,
  buildWorkflowResumeToolDef,
  buildWorkflowResolveToolDef,
  buildWorkflowRejectToolDef,
  buildWorkflowRunToolDef,
  buildWorkflowStatusToolDef,
} from "./WorkflowRuntimeTools"
import { buildWorkflowValidateResourceRefToolDef } from "./WorkflowValidateResourceRef"
import { buildWorkflowWorkspaceToolDef } from "./WorkflowWorkspace"
import { buildWorkflowLifecycleToolDefs } from "./WorkflowLifecycleTools"
import { buildWorkflowLoadStageContextToolDef } from "./WorkflowLoadStageContext"

export { buildWorkflowCreateBundleToolDef } from "./WorkflowCreateBundle"
export { buildWorkflowFulfillToolDef } from "./WorkflowFulfill"
export { buildWorkflowAuthorToolDef } from "./WorkflowAuthor"
export * from "./WorkflowAuthoringTools"
export { buildWorkflowAppToolDefs } from "./WorkflowAppTools"
export { buildWorkflowInspectCapabilityToolDef } from "./WorkflowInspectCapability"
export { buildWorkflowPatchBundleToolDef } from "./WorkflowPatchBundle"
export {
  buildWorkflowEventsToolDef,
  buildWorkflowApplyGraphPatchToolDef,
  buildWorkflowMutateStepExtensionToolDef,
  buildWorkflowResultToolDef,
  buildWorkflowResumeToolDef,
  buildWorkflowResolveToolDef,
  buildWorkflowRejectToolDef,
  buildWorkflowRunToolDef,
  buildWorkflowStatusToolDef,
} from "./WorkflowRuntimeTools"
export { buildWorkflowValidateResourceRefToolDef } from "./WorkflowValidateResourceRef"
export { buildWorkflowWorkspaceToolDef } from "./WorkflowWorkspace"
export { buildWorkflowLifecycleToolDefs } from "./WorkflowLifecycleTools"
export { buildWorkflowLoadStageContextToolDef } from "./WorkflowLoadStageContext"

export const WORKFLOW_NATIVE_TOOL_NAMES = [
  "WorkflowFulfill",
  "WorkflowLoadStageContext",
  "WorkflowAuthor",
  "WorkflowListApps",
  "WorkflowGetApp",
  "WorkflowGetAuthoringContext",
  "WorkflowListAuthoringTemplates",
  "WorkflowListPrebuiltWorkflows",
  "WorkflowListReusableAgents",
  "WorkflowOpenAuthoringSession",
  "WorkflowCreateResourcePackageSession",
  "WorkflowValidateAuthoringSession",
  "WorkflowDryRunAuthoringSession",
  "WorkflowPreparePublication",
  "WorkflowCompleteAuthoring",
  "WorkflowPublishAuthoringSession",
  "WorkflowListAuthoringSessions",
  "WorkflowGetAuthoringSummary",
  "WorkflowWorkspace",
  "WorkflowInspectCapability",
  "WorkflowValidateResourceRef",
  "WorkflowCreateBundle",
  "WorkflowPatchBundle",
  "WorkflowListTypes",
  "WorkflowGetType",
  "WorkflowCreateInstance",
  "WorkflowCreateInstanceFromPrebuilt",
  "WorkflowListInstances",
  "WorkflowListSessionFlows",
  "WorkflowGetInstance",
  "WorkflowUpdateRunVars",
  "WorkflowGetFlowSummary",
  "WorkflowMaterialImport",
  "WorkflowMaterialInspect",
  "WorkflowMaterialBind",
  "WorkflowMaterialExport",
  "WorkflowMaterialReplay",
  "WorkflowMaterialCleanup",
  "WorkflowRun",
  "WorkflowStatus",
  "WorkflowEvents",
  "WorkflowResult",
  "WorkflowResume",
  "WorkflowResolve",
  "WorkflowReject",
  "WorkflowApplyGraphPatch",
  "WorkflowMutateStepExtension",
] as const

export function buildWorkflowNativeToolDefs(): AnyToolDef[] {
  return [
    buildWorkflowFulfillToolDef(),
    buildWorkflowLoadStageContextToolDef(),
    buildWorkflowAuthorToolDef(),
    ...buildWorkflowAppToolDefs(),
    ...buildWorkflowAuthoringToolDefs(),
    buildWorkflowWorkspaceToolDef(),
    buildWorkflowInspectCapabilityToolDef(),
    buildWorkflowValidateResourceRefToolDef(),
    buildWorkflowCreateBundleToolDef(),
    buildWorkflowPatchBundleToolDef(),
    ...buildWorkflowLifecycleToolDefs(),
    buildWorkflowRunToolDef(),
    buildWorkflowStatusToolDef(),
    buildWorkflowEventsToolDef(),
    buildWorkflowResultToolDef(),
    buildWorkflowResumeToolDef(),
    buildWorkflowResolveToolDef(),
    buildWorkflowRejectToolDef(),
    buildWorkflowApplyGraphPatchToolDef(),
    buildWorkflowMutateStepExtensionToolDef(),
  ]
}
