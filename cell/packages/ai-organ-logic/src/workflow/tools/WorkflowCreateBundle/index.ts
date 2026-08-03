import type { ToolDef } from "@cell/ai-core-contract/types"
import {
  runByFuncStyleAdapter,
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { workflowCreateBundleCoreLogic } from "./Logic"
import briefPromptXnl from "./Tool.brief.xnl" with { type: "text" }
import detailPromptXnl from "./Tool.detail.xnl" with { type: "text" }
import type {
  WorkflowCreateBundleOuterConfig,
  WorkflowCreateBundleOuterInput,
  WorkflowCreateBundleOuterOutput,
} from "./OuterTypes"

export function buildWorkflowCreateBundleToolDef(): ToolDef<
  WorkflowCreateBundleOuterInput,
  WorkflowCreateBundleOuterOutput,
  WorkflowCreateBundleOuterConfig
> {
  return {
    schema: {
      type: "function",
      function: {
        name: "WorkflowCreateBundle",
        description: "Create a controlled AI workflow XNL bundle draft without writing host files.",
        parameters: {
          type: "object",
          properties: {
            form: {
              type: "string",
              enum: ["AICtrlWorkflow", "AIDataWorkflow", "ai-ctrl", "ai-data"],
              description: "Workflow form to create.",
            },
            name: {
              type: "string",
              description: "Human-readable workflow bundle name.",
            },
            fqn: {
              type: "string",
              description: "Optional resource FQN. Defaults to local.workflow.<PascalName>.",
            },
            description: {
              type: "string",
              description: "Optional workflow description embedded in the XNL draft.",
            },
          },
          required: ["form", "name"],
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
        workflowCreateBundleCoreLogic,
        stdMakeIdentityOuterOutput,
      ),
  }
}
