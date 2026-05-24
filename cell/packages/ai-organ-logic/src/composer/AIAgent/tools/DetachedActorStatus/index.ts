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
import { detachedActorStatusCoreLogic } from "./Logic"

import type {
  DetachedActorStatusOuterConfig,
  DetachedActorStatusOuterInput,
  DetachedActorStatusOuterOutput,
} from "./OuterTypes"

export function buildDetachedActorStatusToolDef(): ToolDef<
  DetachedActorStatusOuterInput,
  DetachedActorStatusOuterOutput,
  DetachedActorStatusOuterConfig
> {
  const schema = {
    type: "function" as const,
    function: {
      name: "DetachedActorStatus",
      description: "Query the status of a detached actor by task_id.",
      parameters: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "The detached actor id" },
        },
        required: ["task_id"],
      },
    },
  }

  return {
    schema,
    briefPromptXnl: readPromptFromDir("DetachedActorStatus", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("DetachedActorStatus", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        stdMakeNullOuterComputed,
        stdMakeIdentityInnerRuntime,
        stdMakeIdentityInnerInput,
        stdMakeIdentityInnerConfig,
        detachedActorStatusCoreLogic,
        stdMakeIdentityOuterOutput,
      )
    },
  }
}
