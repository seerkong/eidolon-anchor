import type { StdInnerLogic } from "depa-processor"
import { TaskTreeManager } from "@cell/ai-organ-logic/plan/TaskTreeManager"
import type {
  TaskTreeReadInnerConfig,
  TaskTreeReadInnerInput,
  TaskTreeReadInnerOutput,
  TaskTreeReadInnerRuntime,
} from "./InnerTypes"

export const taskTreeReadCoreLogic: StdInnerLogic<
  TaskTreeReadInnerRuntime,
  TaskTreeReadInnerInput,
  TaskTreeReadInnerConfig,
  TaskTreeReadInnerOutput
> = async (runtime, _input, _config) => {
  try {
    if (_config.mode === "flat") {
      return TaskTreeManager.renderFlat(runtime.actor.taskTree)
    }
    return TaskTreeManager.renderFull(runtime.actor.taskTree)
  } catch (e: any) {
    return `Error: ${e.message}`
  }
}
