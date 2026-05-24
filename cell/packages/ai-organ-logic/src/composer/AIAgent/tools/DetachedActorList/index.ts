import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeDetachedActorListOuterComputed,
  makeDetachedActorListInnerRuntime,
  makeDetachedActorListInnerInput,
  makeDetachedActorListInnerConfig,
  detachedActorListCoreLogic,
  makeDetachedActorListOuterOutput,
} from "./Logic"
import type { DetachedActorListOuterConfig, DetachedActorListOuterInput, DetachedActorListOuterOutput } from "./OuterTypes"

export function buildDetachedActorListToolDef(): ToolDef<DetachedActorListOuterInput, DetachedActorListOuterOutput, DetachedActorListOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
      name: "DetachedActorList",
      description: "List detached actors in the current runtime.",
      parameters: { type: "object", properties: {} },
      },
    },
    briefPromptXnl: readPromptFromDir("DetachedActorList", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("DetachedActorList", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeDetachedActorListOuterComputed,
        makeDetachedActorListInnerRuntime,
        makeDetachedActorListInnerInput,
        makeDetachedActorListInnerConfig,
        detachedActorListCoreLogic,
        makeDetachedActorListOuterOutput,
      )
    },
  }
}
