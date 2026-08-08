import type { StdInnerLogic } from "depa-processor"
import { createWorkflowComponentForRuntime } from "../../component"
import type {
  WorkflowInspectCapabilityInnerConfig,
  WorkflowInspectCapabilityInnerInput,
  WorkflowInspectCapabilityInnerOutput,
  WorkflowInspectCapabilityInnerRuntime,
} from "./InnerTypes"

export const workflowInspectCapabilityCoreLogic: StdInnerLogic<
  WorkflowInspectCapabilityInnerRuntime,
  WorkflowInspectCapabilityInnerInput,
  WorkflowInspectCapabilityInnerConfig,
  WorkflowInspectCapabilityInnerOutput
> = async (runtime, _input, _config) => {
  return JSON.stringify(createWorkflowComponentForRuntime(runtime).queries.inspectCapability(runtime), null, 2)
}
