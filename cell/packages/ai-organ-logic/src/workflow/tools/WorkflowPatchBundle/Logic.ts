import type { StdInnerLogic } from "depa-processor"
import { createWorkflowComponentForRuntime } from "../../component"
import type {
  WorkflowPatchBundleInnerConfig,
  WorkflowPatchBundleInnerInput,
  WorkflowPatchBundleInnerOutput,
  WorkflowPatchBundleInnerRuntime,
} from "./InnerTypes"

export const workflowPatchBundleCoreLogic: StdInnerLogic<
  WorkflowPatchBundleInnerRuntime,
  WorkflowPatchBundleInnerInput,
  WorkflowPatchBundleInnerConfig,
  WorkflowPatchBundleInnerOutput
> = async (runtime, input, _config) => {
  return JSON.stringify(createWorkflowComponentForRuntime(runtime).commands.createPatchPlan(input), null, 2)
}
