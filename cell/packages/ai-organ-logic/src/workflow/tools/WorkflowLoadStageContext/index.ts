import type { ToolDef } from "@cell/ai-core-contract/types"
import {
  runByFuncStyleAdapter,
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { AI_WORKFLOW_STAGE_IDS } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import { workflowLoadStageContextCoreLogic } from "./Logic"
import briefPromptXnl from "./Tool.brief.xnl" with { type: "text" }
import detailPromptXnl from "./Tool.detail.xnl" with { type: "text" }
import type {
  WorkflowLoadStageContextOuterConfig,
  WorkflowLoadStageContextOuterInput,
  WorkflowLoadStageContextOuterOutput,
} from "./OuterTypes"

export function buildWorkflowLoadStageContextToolDef(): ToolDef<
  WorkflowLoadStageContextOuterInput,
  WorkflowLoadStageContextOuterOutput,
  WorkflowLoadStageContextOuterConfig
> {
  return {
    schema: {
      type: "function",
      function: {
        name: "WorkflowLoadStageContext",
        description: "Load one explicit DevOps stage context from the canonical global sys-ai-workflow system skill.",
        parameters: {
          type: "object",
          properties: {
            stage: { type: "string", enum: [...AI_WORKFLOW_STAGE_IDS] },
          },
          required: ["stage"],
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
      workflowLoadStageContextCoreLogic,
      stdMakeIdentityOuterOutput,
    ),
  }
}

export * from "./StageToolPolicy"
