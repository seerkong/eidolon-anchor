import {
  runByFuncStyleAdapter,
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"

import { readPromptFromDir } from "../_shared"
import { detachedToolCallCoreLogic } from "./Logic"

import type {
  DetachedToolCallOuterConfig,
  DetachedToolCallOuterInput,
  DetachedToolCallOuterOutput,
} from "./OuterTypes"

export function buildDetachedToolCallToolDef(): ToolDef<
  DetachedToolCallOuterInput,
  DetachedToolCallOuterOutput,
  DetachedToolCallOuterConfig
> {
  const schema = {
    type: "function" as const,
    function: {
      name: "DetachedToolCall",
      description: "Run a single tool call in a detached actor.",
      parameters: {
        type: "object",
        properties: {
          tool_name: { type: "string" },
          arguments: {},
          agent_type: { type: "string" },
        },
        required: ["tool_name", "agent_type"],
      },
    },
  }

  return {
    schema,
    briefPromptXnl: readPromptFromDir("DetachedToolCall", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("DetachedToolCall", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        stdMakeNullOuterComputed,
        stdMakeIdentityInnerRuntime,
        stdMakeIdentityInnerInput,
        stdMakeIdentityInnerConfig,
        detachedToolCallCoreLogic,
        stdMakeIdentityOuterOutput,
      )
    },
  }
}
