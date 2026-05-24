import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeGrepOuterComputed,
  makeGrepInnerRuntime,
  makeGrepInnerInput,
  makeGrepInnerConfig,
  grepCoreLogic,
  makeGrepOuterOutput,
} from "./Logic"
import type { GrepOuterConfig, GrepOuterInput, GrepOuterOutput } from "./OuterTypes"

export function buildGrepToolDef(): ToolDef<GrepOuterInput, GrepOuterOutput, GrepOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "grep",
        description: "Search file contents with a regex pattern.",
        parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, include: { type: "string" } }, required: ["pattern"] },
      },
    },
    briefPromptXnl: readPromptFromDir("Grep", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("Grep", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeGrepOuterComputed,
        makeGrepInnerRuntime,
        makeGrepInnerInput,
        makeGrepInnerConfig,
        grepCoreLogic,
        makeGrepOuterOutput,
      )
    },
  }
}
