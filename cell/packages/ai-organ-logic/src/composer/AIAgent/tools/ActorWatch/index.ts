import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeActorWatchOuterComputed,
  makeActorWatchInnerRuntime,
  makeActorWatchInnerInput,
  makeActorWatchInnerConfig,
  actorWatchCoreLogic,
  makeActorWatchOuterOutput,
} from "./Logic"
import type { ActorWatchOuterConfig, ActorWatchOuterInput, ActorWatchOuterOutput } from "./OuterTypes"

export function buildActorWatchToolDef(): ToolDef<ActorWatchOuterInput, ActorWatchOuterOutput, ActorWatchOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "ActorWatch",
        description: "Enable watched state for an actor.",
        parameters: {
          type: "object",
          properties: { target: { type: "string" } },
          required: ["target"],
        },
      },
    },
    briefPromptXnl: readPromptFromDir("ActorWatch", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("ActorWatch", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeActorWatchOuterComputed,
        makeActorWatchInnerRuntime,
        makeActorWatchInnerInput,
        makeActorWatchInnerConfig,
        actorWatchCoreLogic,
        makeActorWatchOuterOutput,
      )
    },
  }
}
