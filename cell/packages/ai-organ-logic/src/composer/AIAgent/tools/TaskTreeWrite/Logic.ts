import type { StdInnerLogic } from "depa-processor"
import type {
  TaskTreeWriteInnerConfig,
  TaskTreeWriteInnerInput,
  TaskTreeWriteInnerOutput,
  TaskTreeWriteInnerRuntime,
} from "./InnerTypes"
import { TaskTreeManager } from "@cell/ai-organ-logic/plan/TaskTreeManager"

export const taskTreeWriteCoreLogic: StdInnerLogic<
  TaskTreeWriteInnerRuntime,
  TaskTreeWriteInnerInput,
  TaskTreeWriteInnerConfig,
  TaskTreeWriteInnerOutput
> = async (runtime, input, _config) => {
  try {
    if (_config.mode === "flat" && input.op === "expand") {
      return "Error: flat task mode does not support expand"
    }
    return TaskTreeManager.apply(runtime.actor.taskTree, input)
  } catch (e: any) {
    return `Error: ${e.message}`
  }
}
