import type { AnyToolDef } from "@cell/ai-core-contract/types"
import { buildWorkflowCreateBundleToolDef } from "./WorkflowCreateBundle"
import { buildWorkflowInspectCapabilityToolDef } from "./WorkflowInspectCapability"
import { buildWorkflowPatchBundleToolDef } from "./WorkflowPatchBundle"
import {
  buildWorkflowEventsToolDef,
  buildWorkflowResultToolDef,
  buildWorkflowResumeToolDef,
  buildWorkflowRunToolDef,
  buildWorkflowStatusToolDef,
} from "./WorkflowRuntimeTools"
import { buildWorkflowValidateResourceRefToolDef } from "./WorkflowValidateResourceRef"

export { buildWorkflowCreateBundleToolDef } from "./WorkflowCreateBundle"
export { buildWorkflowInspectCapabilityToolDef } from "./WorkflowInspectCapability"
export { buildWorkflowPatchBundleToolDef } from "./WorkflowPatchBundle"
export {
  buildWorkflowEventsToolDef,
  buildWorkflowResultToolDef,
  buildWorkflowResumeToolDef,
  buildWorkflowRunToolDef,
  buildWorkflowStatusToolDef,
} from "./WorkflowRuntimeTools"
export { buildWorkflowValidateResourceRefToolDef } from "./WorkflowValidateResourceRef"

export const WORKFLOW_NATIVE_TOOL_NAMES = [
  "WorkflowInspectCapability",
  "WorkflowValidateResourceRef",
  "WorkflowCreateBundle",
  "WorkflowPatchBundle",
  "WorkflowRun",
  "WorkflowStatus",
  "WorkflowEvents",
  "WorkflowResult",
  "WorkflowResume",
] as const

export function buildWorkflowNativeToolDefs(): AnyToolDef[] {
  return [
    buildWorkflowInspectCapabilityToolDef(),
    buildWorkflowValidateResourceRefToolDef(),
    buildWorkflowCreateBundleToolDef(),
    buildWorkflowPatchBundleToolDef(),
    buildWorkflowRunToolDef(),
    buildWorkflowStatusToolDef(),
    buildWorkflowEventsToolDef(),
    buildWorkflowResultToolDef(),
    buildWorkflowResumeToolDef(),
  ]
}
