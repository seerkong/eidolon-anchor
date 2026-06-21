import { createGoalContinuationHookHandlerComponent } from "../goals/ThreadGoalRuntime"
import {
  createRuntimeHookHandlerComponent,
  type RuntimeHookHandlerComponent,
} from "./RuntimeHookDispatcher"

export function createDefaultRuntimeHookHandlers(): Record<string, RuntimeHookHandlerComponent> {
  return {
    "mod-ai-kernel.goal-continuation": createGoalContinuationHookHandlerComponent(),
    "mod-ai-coding.actor-idle-observer": createRuntimeHookHandlerComponent({
      coreLogic: async () => ({ action: "continue" }),
    }),
  }
}
