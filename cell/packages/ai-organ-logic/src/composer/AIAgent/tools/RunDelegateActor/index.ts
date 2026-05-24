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
import { runDelegateActorCoreLogic } from "./Logic"
import type {
  RunDelegateActorOuterConfig,
  RunDelegateActorOuterInput,
  RunDelegateActorOuterOutput,
} from "./OuterTypes"

export function buildRunDelegateActorToolDef(): ToolDef<
  RunDelegateActorOuterInput,
  RunDelegateActorOuterOutput,
  RunDelegateActorOuterConfig
> {
  const schema = {
    type: "function" as const,
    function: {
      name: "RunDelegateActor",
      description: "Spawn a delegate actor for a focused delegated task.",
      parameters: {
        type: "object",
          properties: {
            description: { type: "string", description: "Short task description (3-5 words)" },
            prompt: { type: "string", description: "Detailed instructions for the delegate actor" },
            agent_type: { type: "string" },
            mode: {
              type: "string",
              enum: ["sync_wait", "detached"],
              description: "sync_wait: caller waits for completion; detached: caller continues while the delegate runs detached from the foreground turn",
            },
          },
          required: ["description", "prompt", "agent_type"],
        },
      },
    }
  const coreLogic = runDelegateActorCoreLogic

  return {
    schema,
    briefPromptXnl: readPromptFromDir("RunDelegateActor", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("RunDelegateActor", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        stdMakeNullOuterComputed,
        stdMakeIdentityInnerRuntime,
        stdMakeIdentityInnerInput,
        stdMakeIdentityInnerConfig,
        coreLogic,
        stdMakeIdentityOuterOutput,
      )
    },
  }
}
