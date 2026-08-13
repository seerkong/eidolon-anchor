import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { fileToolScopeIntentSchema, readPromptFromDir } from "../_shared"
import {
  makeGlobOuterComputed,
  makeGlobInnerRuntime,
  makeGlobInnerInput,
  makeGlobInnerConfig,
  globCoreLogic,
  makeGlobOuterOutput,
} from "./Logic"
import type { GlobOuterConfig, GlobOuterInput, GlobOuterOutput } from "./OuterTypes"

export function buildGlobToolDef(): ToolDef<GlobOuterInput, GlobOuterOutput, GlobOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "glob",
        description: "Match files using a glob pattern. Omit path or use '.' for the current workspace; external paths require explicit scopeIntent.",
        parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string", default: "." }, scopeIntent: fileToolScopeIntentSchema() }, required: ["pattern"] },
      },
    },
    briefPromptXnl: readPromptFromDir("Glob", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("Glob", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeGlobOuterComputed,
        makeGlobInnerRuntime,
        makeGlobInnerInput,
        makeGlobInnerConfig,
        globCoreLogic,
        makeGlobOuterOutput,
      )
    },
  }
}
