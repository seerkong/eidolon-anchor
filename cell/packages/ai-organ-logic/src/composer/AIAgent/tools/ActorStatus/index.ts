import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeActorStatusOuterComputed,
  makeActorStatusInnerRuntime,
  makeActorStatusInnerInput,
  makeActorStatusInnerConfig,
  actorStatusCoreLogic,
  makeActorStatusOuterOutput,
} from "./Logic"
import type { ActorStatusOuterConfig, ActorStatusOuterInput, ActorStatusOuterOutput } from "./OuterTypes"

export function buildActorStatusToolDef(): ToolDef<ActorStatusOuterInput, ActorStatusOuterOutput, ActorStatusOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "ActorStatus",
        description: "Show the status of an actor.",
        parameters: {
          type: "object",
          properties: { target: { type: "string" } },
          required: ["target"],
        },
      },
    },
    briefPromptXnl: readPromptFromDir("ActorStatus", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("ActorStatus", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeActorStatusOuterComputed,
        makeActorStatusInnerRuntime,
        makeActorStatusInnerInput,
        makeActorStatusInnerConfig,
        actorStatusCoreLogic,
        makeActorStatusOuterOutput,
      )
    },
  }
}
