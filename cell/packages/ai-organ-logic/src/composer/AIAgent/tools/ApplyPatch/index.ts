import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeApplyPatchOuterComputed,
  makeApplyPatchInnerRuntime,
  makeApplyPatchInnerInput,
  makeApplyPatchInnerConfig,
  applyPatchCoreLogic,
  makeApplyPatchOuterOutput,
} from "./Logic"
import type { ApplyPatchOuterConfig, ApplyPatchOuterInput, ApplyPatchOuterOutput } from "./OuterTypes"

export function buildApplyPatchToolDef(): ToolDef<ApplyPatchOuterInput, ApplyPatchOuterOutput, ApplyPatchOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "apply_patch",
        description: "Apply a structured patch to accessible files. Supports relative, absolute, and ~/ home-directory paths inside permitted roots.",
        parameters: {
          type: "object",
          properties: { patchText: { type: "string" }, patch: { type: "string" } },
          anyOf: [{ required: ["patchText"] }, { required: ["patch"] }],
        },
      },
    },
    briefPromptXnl: readPromptFromDir("ApplyPatch", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("ApplyPatch", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeApplyPatchOuterComputed,
        makeApplyPatchInnerRuntime,
        makeApplyPatchInnerInput,
        makeApplyPatchInnerConfig,
        applyPatchCoreLogic,
        makeApplyPatchOuterOutput,
      )
    },
  }
}
