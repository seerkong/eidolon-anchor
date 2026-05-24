import {
  createTaskNode,
  isTaskStatus,
  type TaskNode,
  type TaskNodeDraft,
  type TaskStatus,
  type FlatTaskNodeView,
  type TaskTree,
  type TaskTreeWriteOp,
} from "@cell/ai-core-contract/plan/TaskTree"

const MAX_ROOT_TASKS = 20
const MAX_CHILDREN_PER_EXPANSION = 8
const MAX_TOTAL_TASKS = 120
const MAX_DEPTH = 4

function statusMark(status: TaskStatus): string {
  if (status === "completed") return "[x]"
  if (status === "in_progress") return "[>]"
  return "[ ]"
}

function collectAllNodes(root: TaskNode): TaskNode[] {
  const out: TaskNode[] = []
  const stack: TaskNode[] = [...root.children]
  while (stack.length > 0) {
    const node = stack.pop() as TaskNode
    out.push(node)
    for (const child of node.children) {
      stack.push(child)
    }
  }
  return out
}

function findNodeWithDepth(root: TaskNode, id: string): { node: TaskNode; depth: number } | null {
  const stack: Array<{ node: TaskNode; depth: number }> = root.children.map((node) => ({ node, depth: 1 }))
  while (stack.length > 0) {
    const current = stack.pop() as { node: TaskNode; depth: number }
    if (current.node.id === id) return current
    for (const child of current.node.children) {
      stack.push({ node: child, depth: current.depth + 1 })
    }
  }
  return null
}

function makeNextId(taskTree: TaskTree, existing: Set<string>): string {
  while (true) {
    const candidate = `task-${taskTree.nextId}`
    taskTree.nextId += 1
    if (!existing.has(candidate)) {
      return candidate
    }
  }
}

function normalizeDrafts(
  taskTree: TaskTree,
  drafts: TaskNodeDraft[],
  scope: string,
  options?: { seedIds?: Set<string> },
): TaskNode[] {
  if (!Array.isArray(drafts) || drafts.length === 0) {
    throw new Error(`${scope}: tasks required`)
  }

  const existingIds = options?.seedIds ?? new Set(collectAllNodes(taskTree.root).map((n) => n.id))
  const out: TaskNode[] = []
  for (let i = 0; i < drafts.length; i++) {
    const raw = drafts[i] as any
    const content = String(raw?.content ?? "").trim()
    const activeForm = String(raw?.activeForm ?? "general").trim() || "general"
    const rawStatus = raw?.status

    if (!content) {
      throw new Error(`${scope}: task ${i} content required`)
    }
    if (!isTaskStatus(rawStatus)) {
      throw new Error(`${scope}: task ${i} invalid status`)
    }

    let id = String(raw?.id ?? "").trim()
    if (!id) {
      id = makeNextId(taskTree, existingIds)
    }
    if (existingIds.has(id)) {
      throw new Error(`${scope}: duplicate task id '${id}'`)
    }
    existingIds.add(id)

    out.push(createTaskNode({ id, content, status: rawStatus, activeForm, children: [] }))
  }
  return out
}

function assertInProgressConstraint(taskTree: TaskTree): void {
  const assertOneInProgressPerSiblings = (siblings: TaskNode[], scope: string): void => {
    const count = siblings.filter((n) => n.status === "in_progress").length
    if (count > 1) {
      throw new Error(`Only one task can be in_progress under ${scope}`)
    }
    for (const node of siblings) {
      assertOneInProgressPerSiblings(node.children, `parent '${node.id}'`)
    }
  }

  assertOneInProgressPerSiblings(taskTree.root.children, "root")
}

function assertTotalTaskLimit(taskTree: TaskTree): void {
  const total = collectAllNodes(taskTree.root).length
  if (total > MAX_TOTAL_TASKS) {
    throw new Error(`Task tree exceeds max size (${MAX_TOTAL_TASKS})`)
  }
}

export class TaskTreeManager {
  static apply(taskTree: TaskTree, input: TaskTreeWriteOp): string {
    const op = input?.op
    if (op === "replace_root") {
      const tasks = normalizeDrafts(taskTree, input.tasks, "replace_root", { seedIds: new Set<string>() })
      if (tasks.length > MAX_ROOT_TASKS) {
        throw new Error(`replace_root: at most ${MAX_ROOT_TASKS} root tasks allowed`)
      }
      taskTree.root.children = tasks
    } else if (op === "expand") {
      const parentId = String(input.parent_id ?? "").trim()
      if (!parentId) throw new Error("expand: parent_id required")
      if (parentId === "root") throw new Error("expand: use replace_root to update root tasks")

      const found = findNodeWithDepth(taskTree.root, parentId)
      if (!found) throw new Error(`expand: parent '${parentId}' not found`)
      if (found.node.status !== "in_progress") {
        throw new Error("expand: parent task must be in_progress")
      }
      if (found.depth >= MAX_DEPTH) {
        throw new Error(`expand: max task depth is ${MAX_DEPTH}`)
      }
      if (found.node.children.length > 0) {
        throw new Error("expand: parent already expanded; update existing nodes instead")
      }

      const tasks = normalizeDrafts(taskTree, input.tasks, "expand")
      if (tasks.length > MAX_CHILDREN_PER_EXPANSION) {
        throw new Error(`expand: at most ${MAX_CHILDREN_PER_EXPANSION} children per expansion`)
      }
      found.node.children = tasks
    } else if (op === "update_status") {
      const taskId = String(input.task_id ?? "").trim()
      const status = input.status
      if (!taskId) throw new Error("update_status: task_id required")
      if (!isTaskStatus(status)) throw new Error("update_status: invalid status")

      const found = findNodeWithDepth(taskTree.root, taskId)
      if (!found) throw new Error(`update_status: task '${taskId}' not found`)
      found.node.status = status
    } else {
      throw new Error("Invalid op: expected replace_root | expand | update_status")
    }

    assertInProgressConstraint(taskTree)
    assertTotalTaskLimit(taskTree)
    return TaskTreeManager.render(taskTree)
  }

  static render(taskTree: TaskTree): string {
    const rootTasks = taskTree.root.children
    if (rootTasks.length === 0) return "No tasks."

    const lines: string[] = []
    const renderNode = (node: TaskNode, depth: number): void => {
      const indent = "  ".repeat(depth)
      lines.push(`${indent}${statusMark(node.status)} ${node.content} [${node.id}]`)

      if (node.status !== "in_progress") {
        return
      }
      for (const child of node.children) {
        renderNode(child, depth + 1)
      }
    }

    for (const node of rootTasks) {
      renderNode(node, 0)
    }

    const allNodes = collectAllNodes(taskTree.root)
    const done = allNodes.filter((n) => n.status === "completed").length
    const inProgress = allNodes.filter((n) => n.status === "in_progress").length
    return `${lines.join("\n")}\n(${done}/${allNodes.length} done, ${inProgress} in_progress)`
  }

  static renderFull(taskTree: TaskTree): string {
    return JSON.stringify(taskTree, null, 2)
  }

  static flatten(taskTree: TaskTree): FlatTaskNodeView[] {
    const out: FlatTaskNodeView[] = []
    const stack = taskTree.root.children
      .slice()
      .reverse()
      .map((node) => ({ node, depth: 1, parentId: null as string | null }))

    while (stack.length > 0) {
      const current = stack.pop() as { node: TaskNode; depth: number; parentId: string | null }
      out.push({
        id: current.node.id,
        content: current.node.content,
        status: current.node.status,
        activeForm: current.node.activeForm,
        depth: current.depth,
        parentId: current.parentId,
      })

      for (let i = current.node.children.length - 1; i >= 0; i--) {
        stack.push({
          node: current.node.children[i] as TaskNode,
          depth: current.depth + 1,
          parentId: current.node.id,
        })
      }
    }

    return out
  }

  static renderFlat(taskTree: TaskTree): string {
    return JSON.stringify(TaskTreeManager.flatten(taskTree), null, 2)
  }
}
