import type { ToolDef } from "@cell/ai-core-contract/types"
import {
  runByFuncStyleAdapter,
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { workflowValidateResourceRefCoreLogic } from "./Logic"
import briefPromptXnl from "./Tool.brief.xnl" with { type: "text" }
import detailPromptXnl from "./Tool.detail.xnl" with { type: "text" }
import type {
  WorkflowValidateResourceRefOuterConfig,
  WorkflowValidateResourceRefOuterInput,
  WorkflowValidateResourceRefOuterOutput,
} from "./OuterTypes"

export function buildWorkflowValidateResourceRefToolDef(): ToolDef<
  WorkflowValidateResourceRefOuterInput,
  WorkflowValidateResourceRefOuterOutput,
  WorkflowValidateResourceRefOuterConfig
> {
  return {
    schema: {
      type: "function",
      function: {
        name: "WorkflowValidateResourceRef",
        description: "Validate an AI workflow resource reference and reject unsafe host/path refs.",
        parameters: {
          type: "object",
          properties: {
            ref: {
              type: "string",
              description: "Workflow resource ref such as vfs://./workflow/manifest.xnl or resource://package.Workflow",
            },
          },
          required: ["ref"],
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
        workflowValidateResourceRefCoreLogic,
        stdMakeIdentityOuterOutput,
      ),
  }
}
