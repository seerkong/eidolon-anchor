import type { StdInnerLogic } from "depa-processor"
import { createWorkflowComponentForRuntime } from "../../component"
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
> = async (runtime, input, _config) => {
  return JSON.stringify(createWorkflowComponentForRuntime(runtime).queries.validateResourceRef(input.ref), null, 2)
}
