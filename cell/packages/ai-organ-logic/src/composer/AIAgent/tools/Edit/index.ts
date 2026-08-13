import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { fileToolScopeIntentSchema, readPromptFromDir } from "../_shared"
import {
  makeEditOuterComputed,
  makeEditInnerRuntime,
  makeEditInnerInput,
  makeEditInnerConfig,
  editCoreLogic,
  makeEditOuterOutput,
} from "./Logic"
import type { EditOuterConfig, EditOuterInput, EditOuterOutput } from "./OuterTypes"

export function buildEditToolDef(): ToolDef<EditOuterInput, EditOuterOutput, EditOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "edit",
        description: "Replace exact text in a file. Prefer workspace-relative paths; external paths require explicit scopeIntent.",
        parameters: { type: "object", properties: { filePath: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" }, replaceAll: { type: "boolean" }, scopeIntent: fileToolScopeIntentSchema() }, required: ["filePath", "oldString", "newString"] },
      },
    },
    briefPromptXnl: readPromptFromDir("Edit", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("Edit", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeEditOuterComputed,
        makeEditInnerRuntime,
        makeEditInnerInput,
        makeEditInnerConfig,
        editCoreLogic,
        makeEditOuterOutput,
      )
    },
  }
}
