import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makeActorAssignOuterComputed,
  makeActorAssignInnerRuntime,
  makeActorAssignInnerInput,
  makeActorAssignInnerConfig,
  actorAssignCoreLogic,
  makeActorAssignOuterOutput,
} from "./Logic"
import type { ActorAssignOuterConfig, ActorAssignOuterInput, ActorAssignOuterOutput } from "./OuterTypes"

export function buildActorAssignToolDef(): ToolDef<ActorAssignOuterInput, ActorAssignOuterOutput, ActorAssignOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: "ActorAssign",
        description: "Assign work to an actor.",
        parameters: {
          type: "object",
          properties: {
            target: { type: "string" },
            mode: { type: "string", enum: ["final", "none", "stream"] },
            content: { type: "string" },
          },
          required: ["target", "mode", "content"],
        },
      },
    },
    briefPromptXnl: readPromptFromDir("ActorAssign", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("ActorAssign", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makeActorAssignOuterComputed,
        makeActorAssignInnerRuntime,
        makeActorAssignInnerInput,
        makeActorAssignInnerConfig,
        actorAssignCoreLogic,
        makeActorAssignOuterOutput,
      )
    },
  }
}
