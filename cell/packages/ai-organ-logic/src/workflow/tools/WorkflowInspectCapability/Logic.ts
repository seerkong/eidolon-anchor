import type { StdInnerLogic } from "depa-processor"
import { createWorkflowComponent } from "../../component"
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
  return JSON.stringify(createWorkflowComponent().queries.inspectCapability(runtime), null, 2)
}
