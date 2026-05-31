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
import { runDetachedBashCoreLogic } from "./Logic"

import type {
  RunDetachedBashOuterConfig,
  RunDetachedBashOuterInput,
  RunDetachedBashOuterOutput,
} from "./OuterTypes"

export function buildRunDetachedBashToolDef(): ToolDef<
  RunDetachedBashOuterInput,
  RunDetachedBashOuterOutput,
  RunDetachedBashOuterConfig
> {
  const schema = {
    type: "function" as const,
    function: {
      name: "RunDetachedBash",
      description: "Run a bash command in a detached background task.",
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
    briefPromptXnl: readPromptFromDir("RunDetachedBash", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("RunDetachedBash", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        stdMakeNullOuterComputed,
        stdMakeIdentityInnerRuntime,
        stdMakeIdentityInnerInput,
        stdMakeIdentityInnerConfig,
        runDetachedBashCoreLogic,
        stdMakeIdentityOuterOutput,
      )
    },
  }
}
