import type {
  TaskArtifactBody,
  TaskArtifactRef,
  TaskClaimToken,
  TaskDefinition,
  TaskId,
  TaskNodeDefinition,
  TaskProfileEnvelope,
  TaskRecord,
  TaskSpaceDefinition,
  TaskSpaceSnapshot,
  TaskTimestamp,
} from 'task-manager-contract';
import { deepFrozenCanonicalOwnDataClone, sha256Hex } from 'task-manager-contract';
import { buildTaskCompletionGraph } from './completionGraph.js';
import { TaskManagerError } from './errors.js';

export interface TaskProcessorConfig {
  readonly maxTasks?: number;
  readonly maxRelations?: number;
  readonly maxLeaseDurationMs?: number;
}

export interface NormalizedTaskProcessorConfig {
  readonly maxTasks: number;
  readonly maxRelations: number;
  readonly maxLeaseDurationMs: number;
}

export function normalizeTaskProcessorConfig(config: TaskProcessorConfig): NormalizedTaskProcessorConfig {
  return {
    maxTasks: positiveInteger(config.maxTasks ?? 10_000, 'maxTasks'),
    maxRelations: positiveInteger(config.maxRelations ?? 50_000, 'maxRelations'),
    maxLeaseDurationMs: positiveInteger(config.maxLeaseDurationMs ?? 86_400_000, 'maxLeaseDurationMs'),
  };
}

export function validateTaskSpaceDefinition(
  definition: TaskSpaceDefinition,
  config: NormalizedTaskProcessorConfig,
): void {
  assertNonEmpty(definition.taskSpaceId, 'taskSpaceId');
  assertNonEmpty(definition.name, 'TaskSpace name');
  if (!Number.isSafeInteger(definition.schemaVersion) || definition.schemaVersion < 1) {
    invalid('schemaVersion must be a positive safe integer');
  }
  if (definition.allowEmpty !== undefined && definition.allowEmpty !== true) invalid('allowEmpty must be explicitly true');
  if (definition.tasks.length === 0 && definition.allowEmpty !== true) invalid('TaskSpace must contain at least one task');
  if (definition.tasks.length > config.maxTasks) invalid(`TaskSpace exceeds maxTasks=${config.maxTasks}`);
  if (definition.relations.length > config.maxRelations) invalid(`TaskSpace exceeds maxRelations=${config.maxRelations}`);

  const tasks = new Map<TaskId, TaskNodeDefinition>();
  for (const task of definition.tasks) {
    assertTaskDefinition(task);
    if (tasks.has(task.taskId)) {
      throw new TaskManagerError('duplicate-task-identity', `duplicate taskId ${task.taskId}`);
    }
    tasks.set(task.taskId, task);
  }

  const relationIds = new Set<string>();
  const parentByChild = new Map<TaskId, TaskId | null>();
  const childrenByParent = new Map<TaskId, TaskId[]>();
  const dependencyEdges = new Map<TaskId, TaskId[]>();
  for (const relation of definition.relations) {
    assertNonEmpty(relation.relationId, 'relationId');
    if (relationIds.has(relation.relationId)) invalid(`duplicate relationId ${relation.relationId}`);
    relationIds.add(relation.relationId);
    if (relation.kind === 'parent-child') {
      if (!tasks.has(relation.childTaskId)) invalid(`parent relation references missing child ${relation.childTaskId}`);
      if (parentByChild.has(relation.childTaskId)) invalid(`task ${relation.childTaskId} has multiple parents`);
      if (!Number.isSafeInteger(relation.order) || relation.order < 0) invalid(`invalid order for ${relation.relationId}`);
      if (relation.parentTaskId !== null) {
        const parent = tasks.get(relation.parentTaskId);
        if (!parent) invalid(`parent relation references missing parent ${relation.parentTaskId}`);
        if (parent.kind !== 'task-group') invalid(`parent ${relation.parentTaskId} is not a task-group`);
        if (relation.parentTaskId === relation.childTaskId) cyclic(`task ${relation.childTaskId} parents itself`);
        const children = childrenByParent.get(relation.parentTaskId) ?? [];
        children.push(relation.childTaskId);
        childrenByParent.set(relation.parentTaskId, children);
      }
      parentByChild.set(relation.childTaskId, relation.parentTaskId);
      continue;
    }
    if (!tasks.has(relation.predecessorTaskId) || !tasks.has(relation.successorTaskId)) {
      invalid(`dependency ${relation.relationId} references a missing task`);
    }
    if (relation.predecessorTaskId === relation.successorTaskId) cyclic(`task ${relation.successorTaskId} depends on itself`);
    const successors = dependencyEdges.get(relation.predecessorTaskId) ?? [];
    successors.push(relation.successorTaskId);
    dependencyEdges.set(relation.predecessorTaskId, successors);
  }

  for (const taskId of tasks.keys()) {
    if (!parentByChild.has(taskId)) invalid(`task ${taskId} has no parent-child relation`);
  }
  assertAcyclic(tasks.keys(), (id) => {
    const parent = parentByChild.get(id);
    return parent === null || parent === undefined ? [] : [parent];
  });
  assertAcyclic(tasks.keys(), (id) => dependencyEdges.get(id) ?? []);

  for (const task of tasks.values()) {
    if (task.kind === 'task-group' && (childrenByParent.get(task.taskId)?.length ?? 0) === 0) {
      invalid(`task-group ${task.taskId} must contain at least one child`);
    }
  }
  const completionGraph = buildTaskCompletionGraph(definition);
  assertAcyclic(tasks.keys(), (id) => completionGraph.authoritySuccessorIdsByTask.get(id) ?? []);
}

export function taskDefinitionById(
  definition: TaskSpaceDefinition,
  taskId: TaskId,
): TaskNodeDefinition | undefined {
  return definition.tasks.find((task) => task.taskId === taskId);
}

export function taskRecordById(snapshot: TaskSpaceSnapshot, taskId: TaskId): TaskRecord | undefined {
  return snapshot.tasks.find((task) => task.taskId === taskId);
}

export function predecessorIds(definition: TaskSpaceDefinition, taskId: TaskId): readonly TaskId[] {
  return buildTaskCompletionGraph(definition).predecessorIdsByTask.get(taskId) ?? [];
}

export function validateTimestamp(value: TaskTimestamp, field: string): number {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    invalid(`${field} must be a canonical ISO-8601 timestamp`);
  }
  return millis;
}

export function assertClaimIdentity(
  snapshot: TaskSpaceSnapshot,
  claim: TaskClaimToken,
  taskId?: TaskId,
): TaskRecord {
  if (claim.taskSpaceId !== snapshot.taskSpaceId) {
    throw new TaskManagerError('cross-space-identity', `claim belongs to ${claim.taskSpaceId}, not ${snapshot.taskSpaceId}`);
  }
  if (taskId !== undefined && claim.taskId !== taskId) {
    throw new TaskManagerError('cross-space-identity', `claim task ${claim.taskId} does not match ${taskId}`);
  }
  const record = taskRecordById(snapshot, claim.taskId);
  if (!record) throw new TaskManagerError('task-not-found', `task ${claim.taskId} not found`);
  if (!record.activeClaim || !sameClaim(record.activeClaim, claim)) {
    throw new TaskManagerError('claim-token-mismatch', `claim ${claim.claimId} is not the exact live token`);
  }
  return record;
}

export function assertClaimLive(claim: TaskClaimToken, at: TaskTimestamp): void {
  const atMs = validateTimestamp(at, 'occurredAt');
  const expiresAtMs = validateTimestamp(claim.expiresAt, 'claim.expiresAt');
  if (atMs >= expiresAtMs) {
    throw new TaskManagerError('claim-expired', `claim ${claim.claimId} expired at ${claim.expiresAt}`);
  }
}

export function sameClaim(left: TaskClaimToken, right: TaskClaimToken): boolean {
  return left.kind === right.kind
    && left.claimId === right.claimId
    && left.taskSpaceId === right.taskSpaceId
    && left.taskId === right.taskId
    && left.assigneeRef === right.assigneeRef
    && left.attempt === right.attempt
    && left.leaseEpoch === right.leaseEpoch
    && left.claimedAt === right.claimedAt
    && left.heartbeatAt === right.heartbeatAt
    && left.expiresAt === right.expiresAt;
}

export function deepImmutableClone<Value>(value: Value): Value {
  try {
    return deepFrozenCanonicalOwnDataClone(value);
  } catch (error) {
    throw new TaskManagerError('canonical-data-invalid', String(error));
  }
}

function assertTaskDefinition(task: TaskNodeDefinition): asserts task is TaskDefinition | Exclude<TaskNodeDefinition, TaskDefinition> {
  assertNonEmpty(task.taskId, 'taskId');
  assertNonEmpty(task.name, `task ${task.taskId} name`);
  if (!Number.isSafeInteger(task.order) || task.order < 0) invalid(`task ${task.taskId} has invalid order`);
  if (task.kind === 'task-group' && !['sequential', 'all', 'any'].includes(task.mode)) {
    invalid(`task-group ${task.taskId} has invalid mode`);
  }
  assertProfile(task.profile, task.taskId);
  for (const artifact of task.inputArtifacts) assertArtifactRef(artifact, `task ${task.taskId} input artifact`);
}

export function assertArtifactRef(artifact: TaskArtifactRef, field: string): void {
  if (artifact.kind !== 'task-artifact-ref' || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) {
    invalid(`${field} has invalid digest`);
  }
  assertNonEmpty(artifact.mediaType, `${field} mediaType`);
  if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) invalid(`${field} has invalid size`);
  if (artifact.name !== undefined) assertNonEmpty(artifact.name, `${field} name`);
}

export function assertArtifactBody(body: TaskArtifactBody, field: string): void {
  if (body.kind !== 'task-artifact-body' || body.encoding !== 'base64') invalid(`${field} has invalid encoding`);
  assertNonEmpty(body.mediaType, `${field} mediaType`);
  if (!Number.isSafeInteger(body.sizeBytes) || body.sizeBytes < 0) invalid(`${field} has invalid size`);
  let binary: string;
  try {
    binary = atob(body.data);
  } catch {
    invalid(`${field} has invalid base64`);
  }
  if (btoa(binary) !== body.data) invalid(`${field} base64 is not canonical`);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== body.sizeBytes || `sha256:${sha256Hex(bytes)}` !== body.digest) {
    invalid(`${field} digest or size mismatch`);
  }
}

export function assertProfile(profile: TaskProfileEnvelope, taskId: string): void {
  if (profile.kind !== 'task-profile') invalid(`task ${taskId} has invalid profile envelope`);
  assertNonEmpty(profile.profileKind, `task ${taskId} profileKind`);
  if (!Number.isSafeInteger(profile.schemaVersion) || profile.schemaVersion < 1) {
    invalid(`task ${taskId} has invalid profile schemaVersion`);
  }
}

function assertAcyclic(ids: Iterable<TaskId>, outgoing: (id: TaskId) => readonly TaskId[]): void {
  const visiting = new Set<TaskId>();
  const visited = new Set<TaskId>();
  const visit = (id: TaskId): void => {
    if (visiting.has(id)) cyclic(`cycle includes task ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const successor of outgoing(id)) visit(successor);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) invalid(`${field} must be a positive safe integer`);
  return value;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.length === 0 || value.trim() !== value) invalid(`${field} must be non-empty and trimmed`);
}

function invalid(message: string): never {
  throw new TaskManagerError('invalid-task-definition', message);
}

function cyclic(message: string): never {
  throw new TaskManagerError('cyclic-task-forest', message);
}
