import type { ToolDef } from "@cell/ai-core-contract/types"
import {
  runByFuncStyleAdapter,
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { workflowInspectCapabilityCoreLogic } from "./Logic"
import briefPromptXnl from "./Tool.brief.xnl" with { type: "text" }
import detailPromptXnl from "./Tool.detail.xnl" with { type: "text" }
import type {
  WorkflowInspectCapabilityOuterConfig,
  WorkflowInspectCapabilityOuterInput,
  WorkflowInspectCapabilityOuterOutput,
} from "./OuterTypes"

export function buildWorkflowInspectCapabilityToolDef(): ToolDef<
  WorkflowInspectCapabilityOuterInput,
  WorkflowInspectCapabilityOuterOutput,
  WorkflowInspectCapabilityOuterConfig
> {
  return {
    schema: {
      type: "function",
      function: {
        name: "WorkflowInspectCapability",
        description: "Inspect the Eidolon-native AI workflow capability and its fact/resource boundaries.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    },
    briefPromptXnl,
    detailPromptXnl,
    run: async (runtime, input, config) =>
      await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        stdMakeNullOuterComputed,
        stdMakeIdentityInnerRuntime,
        stdMakeIdentityInnerInput,
        stdMakeIdentityInnerConfig,
        workflowInspectCapabilityCoreLogic,
        stdMakeIdentityOuterOutput,
      ),
  }
}
