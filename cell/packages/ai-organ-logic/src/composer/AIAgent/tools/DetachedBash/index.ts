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
import { detachedBashCoreLogic } from "./Logic"

import type {
  DetachedBashOuterConfig,
  DetachedBashOuterInput,
  DetachedBashOuterOutput,
} from "./OuterTypes"

export function buildDetachedBashToolDef(): ToolDef<
  DetachedBashOuterInput,
  DetachedBashOuterOutput,
  DetachedBashOuterConfig
> {
  const schema = {
    type: "function" as const,
    function: {
      name: "DetachedBash",
      description: "Run a bash command in a detached actor.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          agent_type: { type: "string" },
        },
        required: ["command", "agent_type"],
      },
    },
  }

  return {
    schema,
    briefPromptXnl: readPromptFromDir("DetachedBash", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("DetachedBash", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        stdMakeNullOuterComputed,
        stdMakeIdentityInnerRuntime,
        stdMakeIdentityInnerInput,
        stdMakeIdentityInnerConfig,
        detachedBashCoreLogic,
        stdMakeIdentityOuterOutput,
      )
    },
  }
}
