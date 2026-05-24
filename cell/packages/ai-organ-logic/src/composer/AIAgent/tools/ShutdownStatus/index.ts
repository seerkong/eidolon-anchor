import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeShutdownStatusOuterComputed,
  makeShutdownStatusInnerRuntime,
  makeShutdownStatusInnerInput,
  makeShutdownStatusInnerConfig,
  shutdownStatusCoreLogic,
  makeShutdownStatusOuterOutput,
} from "./Logic"
import type { ShutdownStatusOuterConfig, ShutdownStatusOuterInput, ShutdownStatusOuterOutput } from "./OuterTypes"

export function buildShutdownStatusToolDef(): ToolDef<ShutdownStatusOuterInput, ShutdownStatusOuterOutput, ShutdownStatusOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
      name: "ShutdownStatus",
      description: "Check the status of a shutdown coordination request by request_id.",
      parameters: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"] },
      },
    },
    briefPromptXnl: readPromptFromDir("ShutdownStatus", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("ShutdownStatus", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeShutdownStatusOuterComputed,
        makeShutdownStatusInnerRuntime,
        makeShutdownStatusInnerInput,
        makeShutdownStatusInnerConfig,
        shutdownStatusCoreLogic,
        makeShutdownStatusOuterOutput,
      )
    },
  }
}
