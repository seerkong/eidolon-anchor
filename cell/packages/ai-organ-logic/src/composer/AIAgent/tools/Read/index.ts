import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeReadOuterComputed,
  makeReadInnerRuntime,
  makeReadInnerInput,
  makeReadInnerConfig,
  readCoreLogic,
  makeReadOuterOutput,
} from "./Logic"
import type { ReadOuterConfig, ReadOuterInput, ReadOuterOutput } from "./OuterTypes"

export function buildReadToolDef(): ToolDef<ReadOuterInput, ReadOuterOutput, ReadOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "read",
        description: "Read a file or directory listing from an accessible path. Supports relative, absolute, and ~/ home-directory paths.",
        parameters: { type: "object", properties: { filePath: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["filePath"] },
      },
    },
    briefPromptXnl: readPromptFromDir("Read", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("Read", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeReadOuterComputed,
        makeReadInnerRuntime,
        makeReadInnerInput,
        makeReadInnerConfig,
        readCoreLogic,
        makeReadOuterOutput,
      )
    },
  }
}
