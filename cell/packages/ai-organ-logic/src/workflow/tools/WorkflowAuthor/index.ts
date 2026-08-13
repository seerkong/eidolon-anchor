import type { ToolDef } from "@cell/ai-core-contract/types"
import {
  runByFuncStyleAdapter,
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { workflowAuthorCoreLogic } from "./Logic"
import briefPromptXnl from "./Tool.brief.xnl" with { type: "text" }
import detailPromptXnl from "./Tool.detail.xnl" with { type: "text" }
import type {
  WorkflowAuthorOuterConfig,
  WorkflowAuthorOuterInput,
  WorkflowAuthorOuterOutput,
} from "./OuterTypes"

export function buildWorkflowAuthorToolDef(): ToolDef<
  WorkflowAuthorOuterInput,
  WorkflowAuthorOuterOutput,
  WorkflowAuthorOuterConfig
> {
  return {
    schema: {
      type: "function",
      function: {
        name: "WorkflowAuthor",
        description: "Create or edit an AI workflow from an ordinary-language request using an Eidolon authoring actor.",
        parameters: {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["create", "edit"] },
            request: { type: "string", description: "The user's complete natural-language requirement or edit instruction." },
            workflow_ref: { type: "string", description: "Existing workflow ref for edit operations." },
            form: {
              type: "string",
              enum: ["auto", "ai-data", "ai-ctrl", "AIDataWorkflow", "AICtrlWorkflow"],
              description: "Optional form hint. Defaults to semantic auto-selection.",
            },
            publish: { type: "boolean", description: "Explicit publication authorization for this invocation. Defaults to false and never authorizes execution." },
          },
          required: ["operation", "request"],
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
      workflowAuthorCoreLogic,
      stdMakeIdentityOuterOutput,
    ),
  }
}

export type { WorkflowAuthorOuterInput } from "./OuterTypes"
