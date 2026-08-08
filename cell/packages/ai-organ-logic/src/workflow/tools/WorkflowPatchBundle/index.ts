import type { ToolDef } from "@cell/ai-core-contract/types"
import {
  runByFuncStyleAdapter,
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { workflowPatchBundleCoreLogic } from "./Logic"
import briefPromptXnl from "./Tool.brief.xnl" with { type: "text" }
import detailPromptXnl from "./Tool.detail.xnl" with { type: "text" }
import type {
  WorkflowPatchBundleOuterConfig,
  WorkflowPatchBundleOuterInput,
  WorkflowPatchBundleOuterOutput,
} from "./OuterTypes"

export function buildWorkflowPatchBundleToolDef(): ToolDef<
  WorkflowPatchBundleOuterInput,
  WorkflowPatchBundleOuterOutput,
  WorkflowPatchBundleOuterConfig
> {
  return {
    schema: {
      type: "function",
      function: {
        name: "WorkflowPatchBundle",
        description: "Plan a workflow manifest edit; mutations must occur inside a recoverable authoring session and this tool never writes.",
        parameters: {
          type: "object",
          properties: {
            manifestRef: {
              type: "string",
              description: "Workflow manifest ref such as vfs://./demo/manifest.xnl.",
            },
            intent: {
              type: "string",
              description: "Patch intent or summary.",
            },
          },
          required: ["manifestRef"],
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
        workflowPatchBundleCoreLogic,
        stdMakeIdentityOuterOutput,
      ),
  }
}
