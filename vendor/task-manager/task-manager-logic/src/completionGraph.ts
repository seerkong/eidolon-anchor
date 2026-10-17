import type { TaskId, TaskSpaceDefinition } from 'task-manager-contract';

export interface TaskCompletionGraph {
  readonly predecessorIdsByTask: ReadonlyMap<TaskId, readonly TaskId[]>;
  readonly authoritySuccessorIdsByTask: ReadonlyMap<TaskId, readonly TaskId[]>;
}

/**
 * Builds the one completion graph used by admission and runtime readiness.
 * Authority edges additionally include child -> parent containment because a
 * group cannot complete before its descendants.
 */
export function buildTaskCompletionGraph(definition: TaskSpaceDefinition): TaskCompletionGraph {
  const taskById = new Map(definition.tasks.map((task) => [task.taskId, task]));
  const childrenByParent = new Map<TaskId, { readonly taskId: TaskId; readonly order: number }[]>();
  for (const relation of definition.relations) {
    if (relation.kind !== 'parent-child' || relation.parentTaskId === null) continue;
    const children = childrenByParent.get(relation.parentTaskId) ?? [];
    children.push({ taskId: relation.childTaskId, order: relation.order });
    childrenByParent.set(relation.parentTaskId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) => left.order - right.order || left.taskId.localeCompare(right.taskId));
  }

  const descendantsByTask = new Map<TaskId, readonly TaskId[]>();
  const descendants = (taskId: TaskId): readonly TaskId[] => {
    const cached = descendantsByTask.get(taskId);
    if (cached) return cached;
    const result = (childrenByParent.get(taskId) ?? [])
      .flatMap((child) => [child.taskId, ...descendants(child.taskId)]);
    descendantsByTask.set(taskId, result);
    return result;
  };

  const runtimeSuccessors = new Map<TaskId, Set<TaskId>>();
  const addRuntimeEdge = (predecessor: TaskId, successor: TaskId): void => {
    const successors = runtimeSuccessors.get(predecessor) ?? new Set<TaskId>();
    successors.add(successor);
    runtimeSuccessors.set(predecessor, successors);
  };
  for (const relation of definition.relations) {
    if (relation.kind !== 'dependency') continue;
    addRuntimeEdge(relation.predecessorTaskId, relation.successorTaskId);
    if (taskById.get(relation.successorTaskId)?.kind === 'task-group') {
      for (const descendant of descendants(relation.successorTaskId)) {
        addRuntimeEdge(relation.predecessorTaskId, descendant);
      }
    }
  }
  for (const group of definition.tasks) {
    if (group.kind !== 'task-group' || group.mode !== 'sequential') continue;
    const children = childrenByParent.get(group.taskId) ?? [];
    for (let index = 1; index < children.length; index += 1) {
      const predecessor = children[index - 1]!.taskId;
      const successor = children[index]!.taskId;
      addRuntimeEdge(predecessor, successor);
      for (const descendant of descendants(successor)) addRuntimeEdge(predecessor, descendant);
    }
  }

  const predecessorSets = new Map<TaskId, Set<TaskId>>();
  for (const [predecessor, successors] of runtimeSuccessors) {
    for (const successor of successors) {
      const predecessors = predecessorSets.get(successor) ?? new Set<TaskId>();
      predecessors.add(predecessor);
      predecessorSets.set(successor, predecessors);
    }
  }
  const authoritySuccessors = new Map<TaskId, Set<TaskId>>(
    [...runtimeSuccessors].map(([taskId, successors]) => [taskId, new Set(successors)]),
  );
  for (const [parent, children] of childrenByParent) {
    for (const child of children) {
      const successors = authoritySuccessors.get(child.taskId) ?? new Set<TaskId>();
      successors.add(parent);
      authoritySuccessors.set(child.taskId, successors);
    }
  }
  return {
    predecessorIdsByTask: new Map(
      [...predecessorSets].map(([taskId, predecessors]) => [taskId, [...predecessors]]),
    ),
    authoritySuccessorIdsByTask: new Map(
      [...authoritySuccessors].map(([taskId, successors]) => [taskId, [...successors]]),
    ),
  };
}
