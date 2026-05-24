import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeMultieditOuterComputed,
  makeMultieditInnerRuntime,
  makeMultieditInnerInput,
  makeMultieditInnerConfig,
  multieditCoreLogic,
  makeMultieditOuterOutput,
} from "./Logic"
import type { MultieditOuterConfig, MultieditOuterInput, MultieditOuterOutput } from "./OuterTypes"

export function buildMultieditToolDef(): ToolDef<MultieditOuterInput, MultieditOuterOutput, MultieditOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "multiedit",
        description: "Apply multiple exact-text edit operations sequentially on one file. Read the file first and copy the exact oldString snippets.",
        parameters: { type: "object", properties: { filePath: { type: "string" }, edits: { type: "array", items: { type: "object", properties: { filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" }, replaceAll: { type: "boolean" } }, required: ["oldString", "newString"] } } }, required: ["filePath", "edits"] },
      },
    },
    briefPromptXnl: readPromptFromDir("Multiedit", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("Multiedit", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeMultieditOuterComputed,
        makeMultieditInnerRuntime,
        makeMultieditInnerInput,
        makeMultieditInnerConfig,
        multieditCoreLogic,
        makeMultieditOuterOutput,
      )
    },
  }
}
