import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeBatchOuterComputed,
  makeBatchInnerRuntime,
  makeBatchInnerInput,
  makeBatchInnerConfig,
  batchCoreLogic,
  makeBatchOuterOutput,
} from "./Logic"
import type { BatchOuterConfig, BatchOuterInput, BatchOuterOutput } from "./OuterTypes"

export function buildBatchToolDef(): ToolDef<BatchOuterInput, BatchOuterOutput, BatchOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "batch",
        description: "Execute multiple tool calls in sequence.",
        parameters: { type: "object", properties: { tool_calls: { type: "array", items: { type: "object", properties: { tool: { type: "string" }, parameters: { type: "object" } }, required: ["tool", "parameters"] } } }, required: ["tool_calls"] },
      },
    },
    briefPromptXnl: readPromptFromDir("Batch", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("Batch", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeBatchOuterComputed,
        makeBatchInnerRuntime,
        makeBatchInnerInput,
        makeBatchInnerConfig,
        batchCoreLogic,
        makeBatchOuterOutput,
      )
    },
  }
}
