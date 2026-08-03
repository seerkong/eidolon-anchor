import type { StdInnerLogic } from "depa-processor"
import { createWorkflowComponent } from "../../component"
import type {
  WorkflowCreateBundleInnerConfig,
  WorkflowCreateBundleInnerInput,
  WorkflowCreateBundleInnerOutput,
  WorkflowCreateBundleInnerRuntime,
} from "./InnerTypes"

export const workflowCreateBundleCoreLogic: StdInnerLogic<
  WorkflowCreateBundleInnerRuntime,
  WorkflowCreateBundleInnerInput,
  WorkflowCreateBundleInnerConfig,
  WorkflowCreateBundleInnerOutput
> = async (_runtime, input, _config) => {
  return JSON.stringify(createWorkflowComponent().commands.createBundleDraft(input), null, 2)
}
