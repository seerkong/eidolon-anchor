export type TaskStatus = "pending" | "in_progress" | "completed"

export const TASK_STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "completed"]

export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === "pending" || value === "in_progress" || value === "completed"
}

export type TaskNode = {
  id: string
  content: string
  status: TaskStatus
  activeForm: string
  children: TaskNode[]
}

export type TaskNodeDraft = {
  id?: string
  content: string
  status: TaskStatus
  activeForm?: string
}

export type TaskTreeWriteOp =
  | {
      op: "replace_root"
      tasks: TaskNodeDraft[]
    }
  | {
      op: "expand"
      parent_id: string
      tasks: TaskNodeDraft[]
    }
  | {
      op: "update_status"
      task_id: string
      status: TaskStatus
    }

export type TaskTree = {
  root: TaskNode
  nextId: number
}

export type FlatTaskNodeView = {
  id: string
  content: string
  status: TaskStatus
  activeForm: string
  depth: number
  parentId: string | null
}

export function createTaskNode(params: {
  id: string
  content: string
  status: TaskStatus
  activeForm?: string
  children?: TaskNode[]
}): TaskNode {
  return {
    id: params.id,
    content: params.content,
    status: params.status,
    activeForm: params.activeForm ?? "general",
    children: params.children ?? [],
  }
}

export function createEmptyTaskTree(): TaskTree {
  return {
    root: createTaskNode({ id: "root", content: "root", status: "pending", activeForm: "root", children: [] }),
    nextId: 1,
  }
}
