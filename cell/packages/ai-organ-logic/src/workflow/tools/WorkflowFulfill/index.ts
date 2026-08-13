import type { ToolDef } from "@cell/ai-core-contract/types"
import {
  runByFuncStyleAdapter,
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { workflowFulfillCoreLogic } from "./Logic"
import briefPromptXnl from "./Tool.brief.xnl" with { type: "text" }
import detailPromptXnl from "./Tool.detail.xnl" with { type: "text" }
import type {
  WorkflowFulfillOuterConfig,
  WorkflowFulfillOuterInput,
  WorkflowFulfillOuterOutput,
} from "./OuterTypes"

export function buildWorkflowFulfillToolDef(): ToolDef<
  WorkflowFulfillOuterInput,
  WorkflowFulfillOuterOutput,
  WorkflowFulfillOuterConfig
> {
  return {
    schema: {
      type: "function",
      function: {
        name: "WorkflowFulfill",
        description: "Fulfill an ordinary business goal through the Eidolon workflow journey, choosing direct work when a workflow is unnecessary.",
        parameters: {
          type: "object",
          properties: {
            request: { type: "string", description: "The person's complete ordinary-language business goal." },
            operation: { type: "string", enum: ["auto", "create", "edit", "run", "continue"] },
            workflow_ref: { type: "string", description: "Optional existing logical workflow reference for expert edit/run/continue use." },
            publish: { type: "boolean", description: "Independent explicit publication authorization." },
            execute: { type: "boolean", description: "Independent explicit execution authorization." },
          },
          required: ["request"],
          additionalProperties: false,
        },
      },
    },
    briefPromptXnl,
    detailPromptXnl,
    run: async (runtime, input, config) => runByFuncStyleAdapter(
      runtime,
      input,
      config,
      stdMakeNullOuterComputed,
      stdMakeIdentityInnerRuntime,
      stdMakeIdentityInnerInput,
      stdMakeIdentityInnerConfig,
      workflowFulfillCoreLogic,
      stdMakeIdentityOuterOutput,
    ),
  }
}

export type { WorkflowFulfillOuterInput } from "./OuterTypes"
