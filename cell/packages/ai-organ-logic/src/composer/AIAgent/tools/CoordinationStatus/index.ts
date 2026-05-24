import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeCoordinationStatusOuterComputed,
  makeCoordinationStatusInnerRuntime,
  makeCoordinationStatusInnerInput,
  makeCoordinationStatusInnerConfig,
  coordinationStatusCoreLogic,
  makeCoordinationStatusOuterOutput,
} from "./Logic"
import type { CoordinationStatusOuterConfig, CoordinationStatusOuterInput, CoordinationStatusOuterOutput } from "./OuterTypes"

export function buildCoordinationStatusToolDef(): ToolDef<CoordinationStatusOuterInput, CoordinationStatusOuterOutput, CoordinationStatusOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
      name: "CoordinationStatus",
      description: "Get the current coordination record for a request_id.",
      parameters: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"] },
      },
    },
    briefPromptXnl: readPromptFromDir("CoordinationStatus", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("CoordinationStatus", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeCoordinationStatusOuterComputed,
        makeCoordinationStatusInnerRuntime,
        makeCoordinationStatusInnerInput,
        makeCoordinationStatusInnerConfig,
        coordinationStatusCoreLogic,
        makeCoordinationStatusOuterOutput,
      )
    },
  }
}
