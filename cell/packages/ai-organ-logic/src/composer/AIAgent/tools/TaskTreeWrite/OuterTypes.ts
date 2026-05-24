import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import type { TaskNodeDraft, TaskStatus, TaskTreeWriteOp } from "@cell/ai-core-contract/plan/TaskTree"

export type TaskTreeWriteMode = "tree" | "flat"

export type TaskTreeWriteReplaceRootInput = {
  op: "replace_root"
  tasks: TaskNodeDraft[]
}

export type TaskTreeWriteExpandInput = {
  op: "expand"
  parent_id: string
  tasks: TaskNodeDraft[]
}

export type TaskTreeWriteUpdateStatusInput = {
  op: "update_status"
  task_id: string
  status: TaskStatus
}

export type TaskTreeWriteOuterRuntime = AiAgentOneActorRuntime
export type TaskTreeWriteOuterInput =
  | TaskTreeWriteOp
  | TaskTreeWriteReplaceRootInput
  | TaskTreeWriteExpandInput
  | TaskTreeWriteUpdateStatusInput
export type TaskTreeWriteOuterConfig = {
  mode?: TaskTreeWriteMode
}
export type TaskTreeWriteOuterDerived = null
export type TaskTreeWriteOuterOutput = string
