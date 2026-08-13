import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { fileToolScopeIntentSchema, readPromptFromDir } from "../_shared"
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
        description: "Write content to a file. Prefer workspace-relative paths; external paths require explicit scopeIntent.",
        parameters: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" }, scopeIntent: fileToolScopeIntentSchema() }, required: ["filePath", "content"] },
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
