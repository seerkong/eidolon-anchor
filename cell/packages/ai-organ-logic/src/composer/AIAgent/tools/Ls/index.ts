import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeLsOuterComputed,
  makeLsInnerRuntime,
  makeLsInnerInput,
  makeLsInnerConfig,
  lsCoreLogic,
  makeLsOuterOutput,
} from "./Logic"
import type { LsOuterConfig, LsOuterInput, LsOuterOutput } from "./OuterTypes"

export function buildLsToolDef(): ToolDef<LsOuterInput, LsOuterOutput, LsOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "ls",
        description: "List directory contents.",
        parameters: { type: "object", properties: { path: { type: "string" }, ignore: { type: "array", items: { type: "string" } } } },
      },
    },
    briefPromptXnl: readPromptFromDir("Ls", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("Ls", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeLsOuterComputed,
        makeLsInnerRuntime,
        makeLsInnerInput,
        makeLsInnerConfig,
        lsCoreLogic,
        makeLsOuterOutput,
      )
    },
  }
}
