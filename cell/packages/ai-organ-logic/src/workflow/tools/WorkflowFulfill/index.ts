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
            route: { type: "string", enum: ["direct", "ai-ctrl", "ai-data", "composite"], description: "Optional expert route override." },
            scenario: { type: "string", enum: ["research", "local-digest", "fan-out-reduce", "routing", "adversarial-verify", "loop-until-dry", "generate-and-filter", "tournament", "approval-process", "generic"], description: "Optional expert scenario override." },
            expert: { type: "boolean", description: "Include internal evidence in the result for expert/debug use." },
            agent_type: { type: "string", description: "Optional Eidolon coordinator actor type." },
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
