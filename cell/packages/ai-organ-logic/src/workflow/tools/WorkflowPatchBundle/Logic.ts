import type { StdInnerLogic } from "depa-processor"
import { createWorkflowComponent } from "../../component"
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
> = async (_runtime, input, _config) => {
  return JSON.stringify(createWorkflowComponent().commands.createPatchPlan(input), null, 2)
}
