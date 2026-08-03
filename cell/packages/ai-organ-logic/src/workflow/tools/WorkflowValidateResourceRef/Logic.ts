import type { StdInnerLogic } from "depa-processor"
import { createWorkflowComponent } from "../../component"
import type {
  WorkflowValidateResourceRefInnerConfig,
  WorkflowValidateResourceRefInnerInput,
  WorkflowValidateResourceRefInnerOutput,
  WorkflowValidateResourceRefInnerRuntime,
} from "./InnerTypes"

export const workflowValidateResourceRefCoreLogic: StdInnerLogic<
  WorkflowValidateResourceRefInnerRuntime,
  WorkflowValidateResourceRefInnerInput,
  WorkflowValidateResourceRefInnerConfig,
  WorkflowValidateResourceRefInnerOutput
> = async (_runtime, input, _config) => {
  return JSON.stringify(createWorkflowComponent().queries.validateResourceRef(input.ref), null, 2)
}
