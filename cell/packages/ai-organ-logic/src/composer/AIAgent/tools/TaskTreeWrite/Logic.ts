import type { StdInnerLogic } from "depa-processor"
import { createHash } from "node:crypto"
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
    TaskTreeManager.apply(runtime.actor.taskTree, input)
    const content = TaskTreeManager.renderFull(runtime.actor.taskTree)
    const revision = `sha256:${createHash("sha256").update(content).digest("hex")}`
    return {
      output: `Task tree updated: task_tree@${revision}`,
      contextEffects: [{
        kind: "append_provider_context_fact",
        namespace: "task-tree-context",
        logicalKey: "task_tree",
        revision,
        payload: {
          logicalKey: "task_tree",
          revision,
          content,
        },
      }],
    }
  } catch (e: any) {
    return `Error: ${e.message}`
  }
}
