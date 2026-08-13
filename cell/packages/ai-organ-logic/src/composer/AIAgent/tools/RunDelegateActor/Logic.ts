import { spawnChildExecutionActor } from "@cell/ai-organ-logic/agent/DelegateActor"
import type { StdInnerLogic } from "depa-processor"
import type {
  RunDelegateActorInnerConfig,
  RunDelegateActorInnerInput,
  RunDelegateActorInnerOutput,
  RunDelegateActorInnerRuntime,
} from "./InnerTypes"

export const runDelegateActorCoreLogic: StdInnerLogic<
  RunDelegateActorInnerRuntime,
  RunDelegateActorInnerInput,
  RunDelegateActorInnerConfig,
  RunDelegateActorInnerOutput
> = async (runtime, input, _config) => {
  try {
    return await spawnChildExecutionActor(runtime.vm, runtime.actor, {
      description: input.description,
      prompt: input.prompt,
      agentType: input.agent_type,
      mode: input.mode,
      taskKey: input.task_key,
      toolCallId: (runtime as any)?.toolCallId,
      parentToolName: "RunDelegateActor",
    })
  } catch (e: any) {
    return `Error: ${e.message}`
  }
}
