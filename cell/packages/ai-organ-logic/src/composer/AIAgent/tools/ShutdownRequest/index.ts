import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeShutdownRequestOuterComputed,
  makeShutdownRequestInnerRuntime,
  makeShutdownRequestInnerInput,
  makeShutdownRequestInnerConfig,
  shutdownRequestCoreLogic,
  makeShutdownRequestOuterOutput,
} from "./Logic"
import type { ShutdownRequestOuterConfig, ShutdownRequestOuterInput, ShutdownRequestOuterOutput } from "./OuterTypes"

export function buildShutdownRequestToolDef(): ToolDef<ShutdownRequestOuterInput, ShutdownRequestOuterOutput, ShutdownRequestOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
      name: "ShutdownRequest",
      description: "Request graceful shutdown for a member and return a request_id.",
      parameters: {
        type: "object",
        properties: { member_id: { type: "string" }, reason: { type: "string" } },
        required: ["member_id"],
      },
      },
    },
    briefPromptXnl: readPromptFromDir("ShutdownRequest", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("ShutdownRequest", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeShutdownRequestOuterComputed,
        makeShutdownRequestInnerRuntime,
        makeShutdownRequestInnerInput,
        makeShutdownRequestInnerConfig,
        shutdownRequestCoreLogic,
        makeShutdownRequestOuterOutput,
      )
    },
  }
}
