import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeActorUnwatchOuterComputed,
  makeActorUnwatchInnerRuntime,
  makeActorUnwatchInnerInput,
  makeActorUnwatchInnerConfig,
  actorUnwatchCoreLogic,
  makeActorUnwatchOuterOutput,
} from "./Logic"
import type { ActorUnwatchOuterConfig, ActorUnwatchOuterInput, ActorUnwatchOuterOutput } from "./OuterTypes"

export function buildActorUnwatchToolDef(): ToolDef<ActorUnwatchOuterInput, ActorUnwatchOuterOutput, ActorUnwatchOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "ActorUnwatch",
        description: "Disable watched state for an actor.",
        parameters: {
          type: "object",
          properties: { target: { type: "string" } },
          required: ["target"],
        },
      },
    },
    briefPromptXnl: readPromptFromDir("ActorUnwatch", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("ActorUnwatch", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeActorUnwatchOuterComputed,
        makeActorUnwatchInnerRuntime,
        makeActorUnwatchInnerInput,
        makeActorUnwatchInnerConfig,
        actorUnwatchCoreLogic,
        makeActorUnwatchOuterOutput,
      )
    },
  }
}
