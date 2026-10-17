import { createGoalContinuationHookHandlerComponent, type ThreadGoalContinuationAdmission } from "../goals/ThreadGoalRuntime"
import {
  createRuntimeHookHandlerComponent,
  type RuntimeHookHandlerComponent,
} from "./RuntimeHookDispatcher"

export function createDefaultRuntimeHookHandlers(options: { goalContinuationAdmission?: ThreadGoalContinuationAdmission } = {}): Record<string, RuntimeHookHandlerComponent> {
  return {
    "mod-ai-kernel.goal-continuation": createGoalContinuationHookHandlerComponent({ admit: options.goalContinuationAdmission }),
    "mod-ai-coding.actor-idle-observer": createRuntimeHookHandlerComponent({
      coreLogic: async () => ({ action: "continue" }),
    }),
  }
}
