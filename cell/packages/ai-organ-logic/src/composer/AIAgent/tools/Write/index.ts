import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeWriteOuterComputed,
  makeWriteInnerRuntime,
  makeWriteInnerInput,
  makeWriteInnerConfig,
  writeCoreLogic,
  makeWriteOuterOutput,
} from "./Logic"
import type { WriteOuterConfig, WriteOuterInput, WriteOuterOutput } from "./OuterTypes"

export function buildWriteToolDef(): ToolDef<WriteOuterInput, WriteOuterOutput, WriteOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "write",
        description: "Write content to a file at an accessible path. Supports relative, absolute, and ~/ home-directory paths.",
        parameters: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" } }, required: ["filePath", "content"] },
      },
    },
    briefPromptXnl: readPromptFromDir("Write", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("Write", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeWriteOuterComputed,
        makeWriteInnerRuntime,
        makeWriteInnerInput,
        makeWriteInnerConfig,
        writeCoreLogic,
        makeWriteOuterOutput,
      )
    },
  }
}
