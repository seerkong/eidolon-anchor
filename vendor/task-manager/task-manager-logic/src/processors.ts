import type {
  CancelTaskCommand,
  ClaimTaskCommand,
  CreateTaskSpaceCommand,
  ExpireTaskClaimCommand,
  FailTaskCommand,
  HeartbeatTaskClaimCommand,
  PatchTaskSpaceCommand,
  ReplanTaskCommand,
  SettleTaskCommand,
  StartTaskCommand,
  TaskArtifactBody,
  TaskArtifactRef,
  TaskClaimReceipt,
  TaskClaimToken,
  TaskCommand,
  TaskCommandReceipt,
  TaskHistoryEvent,
  TaskId,
  TaskNodeDefinition,
  TaskProfileEnvelope,
  TaskRecord,
  TaskReplanReceipt,
  TaskSettlementReceipt,
  TaskSpaceDefinition,
  TaskSpaceOwnerPort,
  TaskSpaceSnapshot,
  TaskStatus,
  TaskTimestamp,
  TaskTransitionReceipt,
  WaitTaskCommand,
  ControlTaskRootCommand,
  PrepareTaskCommand,
  TaskRootControlReceipt,
} from 'task-manager-contract';
import { canonicalOwnDataDigest } from 'task-manager-contract';
import { buildTaskCompletionGraph, type TaskCompletionGraph } from './completionGraph.js';
import { TaskManagerError } from './errors.js';
import { assertTaskTransition, isTerminal } from './statusMachine.js';
import {assertRootDispatchOpen,reduceTaskRootControl,reduceTaskPreparation,taskRoot,assertReplanDurableTasksImmutable} from './root-control.js';
import {
  assertClaimIdentity,
  assertClaimLive,
  assertArtifactBody,
  assertArtifactRef,
  deepImmutableClone,
  normalizeTaskProcessorConfig,
  taskRecordById,
  validateTaskSpaceDefinition,
  validateTimestamp,
  type TaskProcessorConfig,
} from './validation.js';

export interface TaskManagerRuntime {
  readonly owner: TaskSpaceOwnerPort;
}

export interface TaskProcessorResult<Receipt extends TaskCommandReceipt = TaskCommandReceipt> {
  readonly snapshot: TaskSpaceSnapshot;
  readonly receipt: Receipt;
  readonly replayed: boolean;
}

export async function createTaskSpace<Profile extends TaskProfileEnvelope>(
  runtime: TaskManagerRuntime,
  input: CreateTaskSpaceCommand<Profile>,
  config: TaskProcessorConfig,
): Promise<TaskProcessorResult<TaskTransitionReceipt>> {
  input = canonicalCommand(input);
  const replay = await replayed<TaskTransitionReceipt>(runtime, input, 'task-transition-receipt');
  if (replay) return replay;
  if (input.definition.taskSpaceId !== input.taskSpaceId) {
    throw new TaskManagerError('cross-space-identity', 'definition and command TaskSpace identities differ');
  }
  if (await runtime.owner.readSnapshot(input.taskSpaceId)) {
    throw new TaskManagerError('task-space-already-exists', `TaskSpace ${input.taskSpaceId} already exists`);
  }
  const normalized = normalizeTaskProcessorConfig(config);
  validateTaskSpaceDefinition(input.definition, normalized);
  validateTimestamp(input.createdAt, 'createdAt');

  const artifactBodies = input.artifactBodies ?? [];
  await assertArtifactAuthority(runtime.owner, input.taskSpaceId, input.definition.tasks.flatMap(({ inputArtifacts }) => inputArtifacts), artifactBodies);

  const provisional: TaskRecord[] = input.definition.tasks.map((definition) => ({
    kind: 'task-record',
    taskSpaceId: input.taskSpaceId,
    taskId: definition.taskId,
    definition,
    profile: definition.profile,
    status: 'Pending',
    attempt: 0,
    leaseEpoch: 0,
    activeClaim: null,
    outputArtifacts: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  }));
  const tasks = stabilizeTaskProjection(input.definition, provisional);
  const event = {
    ...eventBase(input, 0, 0, 0, input.createdAt),
    kind: 'task-space.created',
  } as const;
  const receipt: TaskTransitionReceipt = {
    ...receiptBase(input, 0, 0, input.createdAt, [event.eventId]),
    kind: 'task-transition-receipt',
  };
  const snapshot: TaskSpaceSnapshot = {
    kind: 'task-space-snapshot',
    taskSpaceId: input.taskSpaceId,
    revision: 0,
    definition: input.definition,
    tasks,
    historyEventIds: [event.eventId],
    issuedReceiptIds: [receipt.receiptId],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
  return admit(runtime, input, null, snapshot, [event], receipt, artifactBodies);
}

export async function patchTaskSpace<Profile extends TaskProfileEnvelope>(
  runtime: TaskManagerRuntime,
  input: PatchTaskSpaceCommand<Profile>,
  config: TaskProcessorConfig,
): Promise<TaskProcessorResult<TaskTransitionReceipt>> {
  input = canonicalCommand(input);
  const replay = await replayed<TaskTransitionReceipt>(runtime, input, 'task-transition-receipt');
  if (replay) return replay;
  const snapshot = await loadExpected(runtime, input);
  validateTimestamp(input.patchedAt, 'patchedAt');
  const patch = input.patch;
  const current = requireTask(snapshot, patch.taskId);
  if (patch.kind === 'replace-task-profile' && isTerminal(current.status)) {
    throw new TaskManagerError('terminal-task-immutable', `task ${current.taskId} is terminal (${current.status})`);
  }
  if (patch.kind === 'replace-task-profile') {
    throw new TaskManagerError(
      'invalid-task-transition',
      `task ${current.taskId} profile may change only through a kernel lifecycle Processor`,
    );
  }
  let nextDefinition: TaskNodeDefinition;
  if (patch.kind === 'rename-task') {
    nextDefinition = {
      ...current.definition,
      name: patch.name,
      ...(patch.description === undefined ? {} : { description: patch.description }),
    };
  } else {
    const priorArtifact = current.definition.inputArtifacts.find(({ digest }) => digest === patch.artifact.digest);
    if (priorArtifact && canonicalOwnDataDigest(priorArtifact) !== canonicalOwnDataDigest(patch.artifact)) {
      throw new TaskManagerError(
        'artifact-conflict',
        `artifact ${patch.artifact.digest} conflicts with the attached reference`,
      );
    }
    nextDefinition = {
      ...current.definition,
      inputArtifacts: priorArtifact
        ? current.definition.inputArtifacts
        : [...current.definition.inputArtifacts, patch.artifact],
    };
  }
  const definition: TaskSpaceDefinition = {
    ...snapshot.definition,
    tasks: snapshot.definition.tasks.map((task) => task.taskId === current.taskId ? nextDefinition : task),
  };
  if(snapshot.tasks.some(task=>task.rootControl))assertReplanDurableTasksImmutable(snapshot,definition);
  validateTaskSpaceDefinition(definition, normalizeTaskProcessorConfig(config));
  const artifactBodies = input.artifactBodies ?? [];
  await assertArtifactAuthority(runtime.owner, input.taskSpaceId, definition.tasks.flatMap(({ inputArtifacts }) => inputArtifacts), artifactBodies);
  const nextTasks = snapshot.tasks.map((task) => task.taskId === current.taskId
    ? { ...task, definition: nextDefinition, profile: nextDefinition.profile, updatedAt: input.patchedAt }
    : task);
  const event = {
    ...nextEventBase(snapshot, input, 0, input.patchedAt),
    kind: 'task-space.patched',
    taskId: current.taskId,
  } as const;
  const receipt: TaskTransitionReceipt = {
    ...nextReceiptBase(snapshot, input, input.patchedAt, [event.eventId]),
    kind: 'task-transition-receipt',
    taskId: current.taskId,
  };
  return admitExisting(runtime, input, snapshot, definition, nextTasks, [event], receipt, artifactBodies);
}

export async function claimTask(
  runtime: TaskManagerRuntime,
  input: ClaimTaskCommand,
  config: TaskProcessorConfig,
): Promise<TaskProcessorResult<TaskClaimReceipt>> {
  input = canonicalCommand(input);
  const replay = await replayed<TaskClaimReceipt>(runtime, input, 'task-claim-receipt');
  if (replay) return replay;
  const snapshot = await loadExpected(runtime, input);
  const task = requireTask(snapshot, input.taskId);
  if (task.definition.kind !== 'task' || task.status !== 'Ready') {
    throw new TaskManagerError('task-not-ready', `task ${task.taskId} is not a claimable Ready task`);
  }
  assertRootDispatchOpen(snapshot,input.taskId);
  const normalized = normalizeTaskProcessorConfig(config);
  if (!Number.isSafeInteger(input.leaseDurationMs)
    || input.leaseDurationMs <= 0
    || input.leaseDurationMs > normalized.maxLeaseDurationMs) {
    throw new TaskManagerError('lease-out-of-range', `leaseDurationMs must be within 1..${normalized.maxLeaseDurationMs}`);
  }
  const claimedAtMs = validateTimestamp(input.claimedAt, 'claimedAt');
  const attempt = task.attempt === 0 ? 1 : task.attempt;
  const leaseEpoch = task.leaseEpoch === 0 ? 1 : task.leaseEpoch;
  const claim: TaskClaimToken = {
    kind: 'task-claim-token',
    claimId: stableId('claim', input.commandId),
    taskSpaceId: input.taskSpaceId,
    taskId: input.taskId,
    assigneeRef: nonEmpty(input.assigneeRef, 'assigneeRef'),
    attempt,
    leaseEpoch,
    claimedAt: input.claimedAt,
    heartbeatAt: input.claimedAt,
    expiresAt: new Date(claimedAtMs + input.leaseDurationMs).toISOString(),
  };
  assertTaskTransition(task.taskId, task.status, 'Claimed');
  const nextTask: TaskRecord = {
    ...task,
    status: 'Claimed',
    attempt,
    leaseEpoch,
    activeClaim: claim,
    updatedAt: input.claimedAt,
  };
  const event = {
    ...stateEventBase(snapshot, input, 0, input.claimedAt, task, 'Claimed'),
    kind: 'task.claimed',
    claim,
  } as const;
  const receipt: TaskClaimReceipt = {
    ...nextReceiptBase(snapshot, input, input.claimedAt, [event.eventId]),
    kind: 'task-claim-receipt',
    taskId: task.taskId,
    claim,
  };
  return admitExisting(runtime, input, snapshot, snapshot.definition, replaceTask(snapshot, nextTask), [event], receipt);
}

export async function heartbeatTaskClaim(
  runtime: TaskManagerRuntime,
  input: HeartbeatTaskClaimCommand,
  config: TaskProcessorConfig,
): Promise<TaskProcessorResult<TaskClaimReceipt>> {
  input = canonicalCommand(input);
  const replay = await replayed<TaskClaimReceipt>(runtime, input, 'task-claim-receipt');
  if (replay) return replay;
  const snapshot = await loadExpected(runtime, input);
  const task = assertClaimIdentity(snapshot, input.claim);
  const heartbeatAtMs = validateTimestamp(input.heartbeatAt, 'heartbeatAt');
  const priorHeartbeatAtMs = validateTimestamp(input.claim.heartbeatAt, 'claim.heartbeatAt');
  const priorExpiresAtMs = validateTimestamp(input.claim.expiresAt, 'claim.expiresAt');
  if (heartbeatAtMs <= priorHeartbeatAtMs) {
    throw new TaskManagerError('claim-token-mismatch', 'heartbeat must advance the live token timestamp');
  }
  if (heartbeatAtMs >= priorExpiresAtMs) {
    throw new TaskManagerError('claim-expired', `claim ${input.claim.claimId} is already expired`);
  }
  const normalized = normalizeTaskProcessorConfig(config);
  if (!Number.isSafeInteger(input.extendByMs)
    || input.extendByMs <= 0
    || input.extendByMs > normalized.maxLeaseDurationMs) {
    throw new TaskManagerError('lease-out-of-range', `extendByMs must be within 1..${normalized.maxLeaseDurationMs}`);
  }
  const claim: TaskClaimToken = {
    ...input.claim,
    heartbeatAt: input.heartbeatAt,
    expiresAt: new Date(heartbeatAtMs + input.extendByMs).toISOString(),
  };
  const nextTask: TaskRecord = { ...task, activeClaim: claim, updatedAt: input.heartbeatAt };
  const event = {
    ...nextEventBase(snapshot, input, 0, input.heartbeatAt),
    kind: 'task.claim-heartbeat-recorded',
    taskId: task.taskId,
    previousClaim: input.claim,
    claim,
  } as const;
  const receipt: TaskClaimReceipt = {
    ...nextReceiptBase(snapshot, input, input.heartbeatAt, [event.eventId]),
    kind: 'task-claim-receipt',
    taskId: task.taskId,
    claim,
  };
  return admitExisting(runtime, input, snapshot, snapshot.definition, replaceTask(snapshot, nextTask), [event], receipt);
}

export async function expireTaskClaim(
  runtime: TaskManagerRuntime,
  input: ExpireTaskClaimCommand,
  _config: TaskProcessorConfig,
): Promise<TaskProcessorResult<TaskTransitionReceipt>> {
  input = canonicalCommand(input);
  const replay = await replayed<TaskTransitionReceipt>(runtime, input, 'task-transition-receipt');
  if (replay) return replay;
  const snapshot = await loadExpected(runtime, input);
  const task = assertClaimIdentity(snapshot, input.claim);
  const observedAtMs = validateTimestamp(input.observedAt, 'observedAt');
  const expiresAtMs = validateTimestamp(input.claim.expiresAt, 'claim.expiresAt');
  if (observedAtMs < expiresAtMs) {
    throw new TaskManagerError('claim-not-expired', `claim ${input.claim.claimId} remains live until ${input.claim.expiresAt}`);
  }
  assertTaskTransition(task.taskId, task.status, 'Ready');
  const nextAttempt = task.attempt + 1;
  const nextLeaseEpoch = task.leaseEpoch + 1;
  const nextTask: TaskRecord = {
    ...task,
    status: 'Ready',
    attempt: nextAttempt,
    leaseEpoch: nextLeaseEpoch,
    activeClaim: null,
    updatedAt: input.observedAt,
  };
  const event = {
    ...stateEventBase(snapshot, input, 0, input.observedAt, task, 'Ready'),
    kind: 'task.claim-expired',
    expiredClaim: input.claim,
    nextAttempt,
    nextLeaseEpoch,
  } as const;
  const receipt: TaskTransitionReceipt = {
    ...nextReceiptBase(snapshot, input, input.observedAt, [event.eventId]),
    kind: 'task-transition-receipt',
    taskId: task.taskId,
  };
  return admitExisting(runtime, input, snapshot, snapshot.definition, replaceTask(snapshot, nextTask), [event], receipt);
}

export async function startTask(
  runtime: TaskManagerRuntime,
  input: StartTaskCommand,
  _config: TaskProcessorConfig,
): Promise<TaskProcessorResult<TaskTransitionReceipt>> {
  input = canonicalCommand(input);
  return claimedStateTransition(runtime, input, 'Running', 'task.started', 'task-transition-receipt');
}

export async function waitTask(
  runtime: TaskManagerRuntime,
  input: WaitTaskCommand,
  _config: TaskProcessorConfig,
): Promise<TaskProcessorResult<TaskTransitionReceipt>> {
  input = canonicalCommand(input);
  const replay = await replayed<TaskTransitionReceipt>(runtime, input, 'task-transition-receipt');
  if (replay) return replay;
  const snapshot = await loadExpected(runtime, input);
  const task = assertClaimIdentity(snapshot, input.claim);
  assertClaimLive(input.claim, input.occurredAt);
  assertTaskTransition(task.taskId, task.status, 'Waiting');
  const nextTask: TaskRecord = {
    ...task,
    status: 'Waiting',
    profile: input.profile ?? task.profile,
    updatedAt: input.occurredAt,
  };
  const event = {
    ...stateEventBase(snapshot, input, 0, input.occurredAt, task, 'Waiting'),
    kind: 'task.waiting',
    claimId: input.claim.claimId,
    reason: nonEmpty(input.reason, 'reason'),
    ...(input.details === undefined ? {} : { details: input.details }),
  } as const;
  const receipt: TaskTransitionReceipt = {
    ...nextReceiptBase(snapshot, input, input.occurredAt, [event.eventId]),
    kind: 'task-transition-receipt',
    taskId: task.taskId,
  };
  return admitExisting(runtime, input, snapshot, snapshot.definition, replaceTask(snapshot, nextTask), [event], receipt);
}

export async function settleTask(
  runtime: TaskManagerRuntime,
  input: SettleTaskCommand,
  _config: TaskProcessorConfig,
): Promise<TaskProcessorResult<TaskSettlementReceipt>> {
  input = canonicalCommand(input);
  const replay = await replayed<TaskSettlementReceipt>(runtime, input, 'task-settlement-receipt');
  if (replay) return replay;
  const snapshot = await loadExpected(runtime, input);
  const task = assertClaimIdentity(snapshot, input.claim);
  assertClaimLive(input.claim, input.occurredAt);
  assertTaskTransition(task.taskId, task.status, 'Succeeded');
  const artifactBodies = input.artifactBodies ?? [];
  await assertArtifactAuthority(runtime.owner, input.taskSpaceId, input.outputArtifacts, artifactBodies);
  const settled: TaskRecord = {
    ...task,
    status: 'Succeeded',
    profile: input.profile ?? task.profile,
    activeClaim: null,
    outputArtifacts: input.outputArtifacts,
    updatedAt: input.occurredAt,
  };
  const tasks = replaceTask(snapshot, settled);
  const events: TaskHistoryEvent[] = [{
    ...stateEventBase(snapshot, input, 0, input.occurredAt, task, 'Succeeded'),
    kind: 'task.settled',
    claimId: input.claim.claimId,
    outputArtifacts: input.outputArtifacts,
    ...(input.result === undefined ? {} : { result: input.result }),
  }];
  const receipt: TaskSettlementReceipt = {
    ...nextReceiptBase(snapshot, input, input.occurredAt, events.map(({ eventId }) => eventId)),
    kind: 'task-settlement-receipt',
    taskId: task.taskId,
    claimId: input.claim.claimId,
    status: 'Succeeded',
  };
  return admitExisting(runtime, input, snapshot, snapshot.definition, tasks, events, receipt, artifactBodies);
}

export async function failTask(
  runtime: TaskManagerRuntime,
  input: FailTaskCommand,
  _config: TaskProcessorConfig,
): Promise<TaskProcessorResult<TaskSettlementReceipt>> {
  input = canonicalCommand(input);
  const replay = await replayed<TaskSettlementReceipt>(runtime, input, 'task-settlement-receipt');
  if (replay) return replay;
  const snapshot = await loadExpected(runtime, input);
  const task = assertClaimIdentity(snapshot, input.claim);
  assertClaimLive(input.claim, input.occurredAt);
  assertTaskTransition(task.taskId, task.status, 'Failed');
  const nextTask: TaskRecord = {
    ...task,
    status: 'Failed',
    profile: input.profile ?? task.profile,
    activeClaim: null,
    updatedAt: input.occurredAt,
  };
  const event = {
    ...stateEventBase(snapshot, input, 0, input.occurredAt, task, 'Failed'),
    kind: 'task.failed',
    claimId: input.claim.claimId,
    failure: input.failure,
  } as const;
  const receipt: TaskSettlementReceipt = {
    ...nextReceiptBase(snapshot, input, input.occurredAt, [event.eventId]),
    kind: 'task-settlement-receipt',
    taskId: task.taskId,
    claimId: input.claim.claimId,
    status: 'Failed',
  };
  return admitExisting(runtime, input, snapshot, snapshot.definition, replaceTask(snapshot, nextTask), [event], receipt);
}

export async function cancelTask(
  runtime: TaskManagerRuntime,
  input: CancelTaskCommand,
  _config: TaskProcessorConfig,
): Promise<TaskProcessorResult<TaskSettlementReceipt>> {
  input = canonicalCommand(input);
  const replay = await replayed<TaskSettlementReceipt>(runtime, input, 'task-settlement-receipt');
  if (replay) return replay;
  const snapshot = await loadExpected(runtime, input);
  const task = requireTask(snapshot, input.taskId);
  if (isTerminal(task.status) && !input.cascade) {
    throw new TaskManagerError('terminal-task-immutable', `task ${task.taskId} is terminal (${task.status})`);
  }
  validateTimestamp(input.cancelledAt, 'cancelledAt');
  if (input.claim) assertClaimIdentity(snapshot, input.claim, task.taskId);
  if (input.cascade !== undefined && input.cascade !== true) throw new TaskManagerError('invalid-task-transition', 'cascade must be explicitly true');
  if (input.cascade) {
    const selected = new Set([task.taskId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const relation of snapshot.definition.relations) if (relation.kind === 'parent-child' && relation.parentTaskId !== null && selected.has(relation.parentTaskId) && !selected.has(relation.childTaskId)) { selected.add(relation.childTaskId); grew = true; }
    }
    const events: TaskHistoryEvent[] = [];
    const tasks = snapshot.tasks.map(current => {
      if (!selected.has(current.taskId) || isTerminal(current.status)) return current;
      assertTaskTransition(current.taskId, current.status, 'Cancelled');
      events.push({...stateEventBase(snapshot,input,events.length,input.cancelledAt,current,'Cancelled'),kind:'task.cancelled',...(current.activeClaim ? {claimId:current.activeClaim.claimId} : {}),reason:nonEmpty(input.reason,'reason')});
      return {...current,status:'Cancelled' as const,activeClaim:null,updatedAt:input.cancelledAt,...(current.taskId===task.taskId && input.profile ? {profile:input.profile} : {})};
    });
    const receipt: TaskSettlementReceipt = {...nextReceiptBase(snapshot,input,input.cancelledAt,events.map(event=>event.eventId)),kind:'task-settlement-receipt',taskId:task.taskId,...(input.claim ? {claimId:input.claim.claimId} : {}),status:task.status==='Succeeded'||task.status==='Failed'?task.status:'Cancelled'};
    return admitExisting(runtime,input,snapshot,snapshot.definition,tasks,events,receipt);
  }
  assertTaskTransition(task.taskId, task.status, 'Cancelled');
  const nextTask: TaskRecord = {
    ...task,
    status: 'Cancelled',
    profile: input.profile ?? task.profile,
    activeClaim: null,
    updatedAt: input.cancelledAt,
  };
  const event = {
    ...stateEventBase(snapshot, input, 0, input.cancelledAt, task, 'Cancelled'),
    kind: 'task.cancelled',
    ...(input.claim === undefined ? {} : { claimId: input.claim.claimId }),
    reason: nonEmpty(input.reason, 'reason'),
  } as const;
  const receipt: TaskSettlementReceipt = {
    ...nextReceiptBase(snapshot, input, input.cancelledAt, [event.eventId]),
    kind: 'task-settlement-receipt',
    taskId: task.taskId,
    ...(input.claim === undefined ? {} : { claimId: input.claim.claimId }),
    status: 'Cancelled',
  };
  return admitExisting(runtime, input, snapshot, snapshot.definition, replaceTask(snapshot, nextTask), [event], receipt);
}

export async function replanTask(
  runtime: TaskManagerRuntime,
  input: ReplanTaskCommand,
  config: TaskProcessorConfig,
): Promise<TaskProcessorResult<TaskReplanReceipt>> {
  input = canonicalCommand(input);
  const replay = await replayed<TaskReplanReceipt>(runtime, input, 'task-replan-receipt');
  if (replay) return replay;
  const snapshot = await loadExpected(runtime, input);
  validateTimestamp(input.replannedAt, 'replannedAt');
  const definition: TaskSpaceDefinition = {
    ...snapshot.definition,
    tasks: input.plan.tasks,
    relations: input.plan.relations,
  };
  assertReplanDurableTasksImmutable(snapshot, definition);
  validateTaskSpaceDefinition(definition, normalizeTaskProcessorConfig(config));
  const artifactBodies = input.artifactBodies ?? [];
  await assertArtifactAuthority(runtime.owner, input.taskSpaceId, definition.tasks.flatMap(({ inputArtifacts }) => inputArtifacts), artifactBodies);
  const provisional: TaskRecord[] = definition.tasks.map((nextDefinition) => {
    const prior = taskRecordById(snapshot, nextDefinition.taskId);
    if (prior) return { ...prior, definition: nextDefinition,
      ...(!prior.activeClaim&&prior.attempt===0&&!prior.preparationReceiptId&&!isTerminal(prior.status)?{profile:nextDefinition.profile}:{}),updatedAt: input.replannedAt };
    return {
      kind: 'task-record',
      taskSpaceId: snapshot.taskSpaceId,
      taskId: nextDefinition.taskId,
      definition: nextDefinition,
      profile: nextDefinition.profile,
      status: 'Pending',
      attempt: 0,
      leaseEpoch: 0,
      activeClaim: null,
      outputArtifacts: [],
      createdAt: input.replannedAt,
      updatedAt: input.replannedAt,
    };
  });
  const completionGraph = buildTaskCompletionGraph(definition);
  const nextTasks: TaskRecord[] = provisional.map((task) => {
    if (isTerminal(task.status) || task.activeClaim || task.status === 'Running' || task.status === 'Waiting') return task;
    const status: TaskStatus = dependenciesSucceeded(completionGraph, provisional, task.taskId) ? 'Ready' : 'Pending';
    return { ...task, status };
  });
  const affectedTaskIds = [...new Set([...snapshot.tasks.map(({ taskId }) => taskId), ...nextTasks.map(({ taskId }) => taskId)])].sort();
  const event = {
    ...nextEventBase(snapshot, input, 0, input.replannedAt),
    kind: 'task.replanned',
    planId: input.plan.planId,
    affectedTaskIds,
  } as const;
  const receipt: TaskReplanReceipt = {
    ...nextReceiptBase(snapshot, input, input.replannedAt, [event.eventId]),
    kind: 'task-replan-receipt',
    planId: input.plan.planId,
    affectedTaskIds,
  };
  return admitExisting(runtime, input, snapshot, definition, nextTasks, [event], receipt, artifactBodies);
}

async function claimedStateTransition(
  runtime: TaskManagerRuntime,
  input: StartTaskCommand,
  toStatus: 'Running',
  eventKind: 'task.started',
  receiptKind: 'task-transition-receipt',
): Promise<TaskProcessorResult<TaskTransitionReceipt>> {
  const replay = await replayed<TaskTransitionReceipt>(runtime, input, receiptKind);
  if (replay) return replay;
  const snapshot = await loadExpected(runtime, input);
  const task = assertClaimIdentity(snapshot, input.claim);
  assertClaimLive(input.claim, input.occurredAt);
  assertTaskTransition(task.taskId, task.status, toStatus);
  const nextTask: TaskRecord = {
    ...task,
    status: toStatus,
    profile: input.profile ?? task.profile,
    updatedAt: input.occurredAt,
  };
  const event = {
    ...stateEventBase(snapshot, input, 0, input.occurredAt, task, toStatus),
    kind: eventKind,
    claimId: input.claim.claimId,
  } as const;
  const receipt: TaskTransitionReceipt = {
    ...nextReceiptBase(snapshot, input, input.occurredAt, [event.eventId]),
    kind: receiptKind,
    taskId: task.taskId,
  };
  return admitExisting(runtime, input, snapshot, snapshot.definition, replaceTask(snapshot, nextTask), [event], receipt);
}

export async function controlTaskRoot(runtime:TaskManagerRuntime,input:ControlTaskRootCommand,config:TaskProcessorConfig):Promise<TaskProcessorResult<TaskRootControlReceipt>>{
  input=canonicalCommand(input);
  const replay=await replayed<TaskRootControlReceipt>(runtime,input,'task-root-control-receipt');
  if(replay)return replay;
  const snapshot=await loadExpected(runtime,input);
  validateTimestamp(input.occurredAt,'occurredAt');
  validateTaskSpaceDefinition(snapshot.definition,normalizeTaskProcessorConfig(config));
  const control=reduceTaskRootControl(snapshot,input),task=requireTask(snapshot,input.taskId);
  const event={...nextEventBase(snapshot,input,0,input.occurredAt),kind:'task.root-controlled' as const,taskId:task.taskId,control};
  const receipt:TaskRootControlReceipt={...nextReceiptBase(snapshot,input,input.occurredAt,[event.eventId]),kind:'task-root-control-receipt',taskId:task.taskId,control};
  return admitExisting(runtime,input,snapshot,snapshot.definition,replaceTask(snapshot,{...task,rootControl:control,updatedAt:input.occurredAt}),[event],receipt,input.artifactBodies??[]);
}

export async function prepareTask(runtime:TaskManagerRuntime,input:PrepareTaskCommand,config:TaskProcessorConfig):Promise<TaskProcessorResult<TaskTransitionReceipt>>{
  input=canonicalCommand(input);
  const replay=await replayed<TaskTransitionReceipt>(runtime,input,'task-transition-receipt');if(replay)return replay;
  const snapshot=await loadExpected(runtime,input);validateTaskSpaceDefinition(snapshot.definition,normalizeTaskProcessorConfig(config));
  const task=reduceTaskPreparation(snapshot,input);
  const event={...nextEventBase(snapshot,input,0,input.preparedAt),kind:'task.prepared' as const,taskId:task.taskId,preparationReceiptId:task.preparationReceiptId!};
  const receipt:TaskTransitionReceipt={...nextReceiptBase(snapshot,input,input.preparedAt,[event.eventId]),kind:'task-transition-receipt',taskId:task.taskId};
  return admitExisting(runtime,input,snapshot,snapshot.definition,replaceTask(snapshot,task),[event],receipt);
}

async function replayed<Receipt extends TaskCommandReceipt>(
  runtime: TaskManagerRuntime,
  input: TaskCommand,
  receiptKind: Receipt['kind'],
): Promise<TaskProcessorResult<Receipt> | undefined> {
  const receipt = await runtime.owner.readReceiptByCommand(input.taskSpaceId, input.commandId);
  if (!receipt) return undefined;
  const commandDigest = canonicalOwnDataDigest(input);
  if (receipt.kind !== receiptKind || receipt.commandDigest !== commandDigest) {
    throw new TaskManagerError(
      'command-receipt-mismatch',
      `command ${input.commandId} was already used for a different canonical command`,
    );
  }
  const snapshot = await runtime.owner.readSnapshot(input.taskSpaceId);
  if (!snapshot) {
    throw new TaskManagerError('task-space-not-found', `receipt exists without TaskSpace ${input.taskSpaceId}`);
  }
  return deepImmutableClone({ snapshot, receipt: receipt as Receipt, replayed: true });
}

async function loadExpected(
  runtime: TaskManagerRuntime,
  input: Exclude<TaskCommand, CreateTaskSpaceCommand>,
): Promise<TaskSpaceSnapshot> {
  const snapshot = await runtime.owner.readSnapshot(input.taskSpaceId);
  if (!snapshot) throw new TaskManagerError('task-space-not-found', `TaskSpace ${input.taskSpaceId} not found`);
  if (snapshot.taskSpaceId !== input.taskSpaceId || snapshot.definition.taskSpaceId !== input.taskSpaceId) {
    throw new TaskManagerError('cross-space-identity', 'snapshot contains a cross-space identity');
  }
  if (snapshot.revision !== input.expectedRevision) {
    throw new TaskManagerError(
      'revision-conflict',
      `TaskSpace ${input.taskSpaceId} expected revision ${input.expectedRevision}, actual ${snapshot.revision}`,
    );
  }
  return snapshot;
}

async function admitExisting<Receipt extends TaskCommandReceipt>(
  runtime: TaskManagerRuntime,
  input: Exclude<TaskCommand, CreateTaskSpaceCommand>,
  prior: TaskSpaceSnapshot,
  definition: TaskSpaceDefinition,
  tasks: readonly TaskRecord[],
  events: readonly TaskHistoryEvent[],
  receipt: Receipt,
  artifacts: readonly TaskArtifactBody[] = [],
): Promise<TaskProcessorResult<Receipt>> {
  const occurredAt = events.at(-1)?.occurredAt ?? prior.updatedAt;
  const stabilizedTasks = stabilizeTaskProjection(definition, tasks, occurredAt);
  const projectedEvents: TaskHistoryEvent[] = [];
  for (const next of stabilizedTasks) {
    const previous = prior.tasks.find(({ taskId }) => taskId === next.taskId);
    if (!previous || previous.status === next.status) continue;
    if (events.some((event) => 'taskId' in event && event.taskId === next.taskId && 'toStatus' in event && event.toStatus === next.status)) {
      continue;
    }
    const index = events.length + projectedEvents.length;
    projectedEvents.push(next.definition.kind === 'task-group'
      ? {
        ...stateEventBase(prior, input, index, occurredAt, previous, next.status),
        kind: 'task.group-status-projected',
      }
      : {
        ...stateEventBase(prior, input, index, occurredAt, previous, next.status),
        kind: 'task.readied',
      });
  }
  const admittedEvents = [...events, ...projectedEvents];
  const admittedReceipt = {
    ...receipt,
    eventIds: admittedEvents.map(({ eventId }) => eventId),
  } as Receipt;
  const snapshot: TaskSpaceSnapshot = {
    ...prior,
    revision: prior.revision + 1,
    definition,
    tasks: stabilizedTasks,
    historyEventIds: [...prior.historyEventIds, ...admittedEvents.map(({ eventId }) => eventId)],
    issuedReceiptIds: [...prior.issuedReceiptIds, admittedReceipt.receiptId],
    updatedAt: occurredAt,
  };
  return admit(runtime, input, prior.revision, snapshot, admittedEvents, admittedReceipt, artifacts);
}

async function admit<Receipt extends TaskCommandReceipt>(
  runtime: TaskManagerRuntime,
  input: TaskCommand,
  expectedRevision: number | null,
  snapshot: TaskSpaceSnapshot,
  events: readonly TaskHistoryEvent[],
  receipt: Receipt,
  artifacts: readonly TaskArtifactBody[],
): Promise<TaskProcessorResult<Receipt>> {
  const result = await runtime.owner.compareAndSwap({
    kind: 'task-space-commit',
    taskSpaceId: input.taskSpaceId,
    expectedRevision,
    commandId: input.commandId,
    commandDigest: canonicalOwnDataDigest(input),
    command: input,
    snapshot,
    events,
    receipts: [receipt],
    artifacts,
  });
  if (result.kind === 'revision-conflict') {
    throw new TaskManagerError(
      'revision-conflict',
      `TaskSpace ${input.taskSpaceId} expected revision ${String(result.expectedRevision)}, actual ${String(result.actualRevision)}`,
    );
  }
  if (result.receipt.kind !== receipt.kind) {
    throw new TaskManagerError('command-receipt-mismatch', `owner returned ${result.receipt.kind}, expected ${receipt.kind}`);
  }
  return deepImmutableClone({
    snapshot: result.snapshot,
    receipt: result.receipt as Receipt,
    replayed: result.kind === 'command-replayed',
  });
}

function requireTask(snapshot: TaskSpaceSnapshot, taskId: TaskId): TaskRecord {
  const task = taskRecordById(snapshot, taskId);
  if (!task) throw new TaskManagerError('task-not-found', `task ${taskId} not found`);
  if (task.taskSpaceId !== snapshot.taskSpaceId) {
    throw new TaskManagerError('cross-space-identity', `task ${taskId} belongs to ${task.taskSpaceId}`);
  }
  return task;
}

function replaceTask(snapshot: TaskSpaceSnapshot, replacement: TaskRecord): TaskRecord[] {
  return snapshot.tasks.map((task) => task.taskId === replacement.taskId ? replacement : task);
}

function dependenciesSucceeded(
  completionGraph: TaskCompletionGraph,
  tasks: readonly TaskRecord[],
  taskId: TaskId,
): boolean {
  const predecessors = completionGraph.predecessorIdsByTask.get(taskId) ?? [];
  return predecessors.length === 0 || predecessors.every((predecessorId) =>
    tasks.find((task) => task.taskId === predecessorId)?.status === 'Succeeded');
}

function eventBase(
  input: TaskCommand,
  index: number,
  fromRevision: number,
  toRevision: number,
  occurredAt: TaskTimestamp,
) {
  return {
    eventId: stableId('event', input.commandId, index),
    commandId: input.commandId,
    taskSpaceId: input.taskSpaceId,
    sequence: index,
    fromRevision,
    toRevision,
    occurredAt,
  } as const;
}

function nextEventBase(
  snapshot: TaskSpaceSnapshot,
  input: TaskCommand,
  index: number,
  occurredAt: TaskTimestamp,
) {
  return {
    ...eventBase(input, index, snapshot.revision, snapshot.revision + 1, occurredAt),
    sequence: snapshot.historyEventIds.length + index,
  } as const;
}

function stateEventBase(
  snapshot: TaskSpaceSnapshot,
  input: TaskCommand,
  index: number,
  occurredAt: TaskTimestamp,
  task: TaskRecord,
  toStatus: TaskStatus,
) {
  return {
    ...nextEventBase(snapshot, input, index, occurredAt),
    taskId: task.taskId,
    fromStatus: task.status,
    toStatus,
  } as const;
}

function receiptBase(
  input: TaskCommand,
  fromRevision: number,
  toRevision: number,
  committedAt: TaskTimestamp,
  eventIds: readonly string[],
) {
  return {
    receiptId: stableId('receipt', input.commandId),
    commandId: input.commandId,
    commandDigest: canonicalOwnDataDigest(input),
    taskSpaceId: input.taskSpaceId,
    ...(input.intentDigest?{intentDigest:input.intentDigest}:{}),
    fromRevision,
    toRevision,
    eventIds,
    committedAt,
  } as const;
}

function nextReceiptBase(
  snapshot: TaskSpaceSnapshot,
  input: TaskCommand,
  committedAt: TaskTimestamp,
  eventIds: readonly string[],
) {
  return receiptBase(input, snapshot.revision, snapshot.revision + 1, committedAt, eventIds);
}

function stableId(namespace: string, commandId: string, index?: number): string {
  return `${namespace}:${encodeURIComponent(commandId)}${index === undefined ? '' : `:${index}`}`;
}

function nonEmpty(value: string, field: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new TaskManagerError('invalid-task-definition', `${field} must be non-empty and trimmed`);
  }
  return value;
}

function canonicalCommand<Command extends TaskCommand>(input: Command): Command {
  return deepImmutableClone(input);
}

async function assertArtifactAuthority(
  owner: TaskSpaceOwnerPort,
  taskSpaceId: string,
  refs: readonly TaskArtifactRef[],
  bodies: readonly TaskArtifactBody[],
): Promise<void> {
  const supplied = new Map<string, TaskArtifactBody>();
  for (const body of bodies) {
    assertArtifactBody(body, `artifact body ${body.digest}`);
    const prior = supplied.get(body.digest);
    if (prior && canonicalOwnDataDigest(prior) !== canonicalOwnDataDigest(body)) {
      throw new TaskManagerError('artifact-conflict', `artifact ${body.digest} has conflicting bodies`);
    }
    supplied.set(body.digest, body);
  }
  for (const ref of refs) {
    assertArtifactRef(ref, `artifact ref ${ref.digest}`);
    const body = supplied.get(ref.digest) ?? await owner.readArtifact(taskSpaceId, ref.digest);
    if (!body) throw new TaskManagerError('artifact-not-found', `artifact ${ref.digest} is not present in this owner admission`);
    if (body.digest !== ref.digest || body.mediaType !== ref.mediaType || body.sizeBytes !== ref.sizeBytes) {
      throw new TaskManagerError('artifact-conflict', `artifact ${ref.digest} metadata disagrees with its body`);
    }
  }
}

function stabilizeTaskProjection(
  definition: TaskSpaceDefinition,
  inputTasks: readonly TaskRecord[],
  projectedAt?: TaskTimestamp,
): TaskRecord[] {
  const completionGraph = buildTaskCompletionGraph(definition);
  let tasks = inputTasks.map((task) => ({ ...task }));
  const childrenByParent = new Map<TaskId, TaskId[]>();
  for (const relation of definition.relations) {
    if (relation.kind !== 'parent-child' || relation.parentTaskId === null) continue;
    const children = childrenByParent.get(relation.parentTaskId) ?? [];
    children.push(relation.childTaskId);
    childrenByParent.set(relation.parentTaskId, children);
  }
  for (let iteration = 0; iteration <= tasks.length * 2; iteration += 1) {
    let changed = false;
    const next = tasks.map((task) => {
      let status = task.status;
      if (task.definition.kind === 'task') {
        if (status === 'Pending' || status === 'Ready') {
          status = dependenciesSucceeded(completionGraph, tasks, task.taskId) ? 'Ready' : 'Pending';
        }
      } else {
        // Explicit cancellation is an owner decision, not a derived child outcome.
        if (task.status === 'Cancelled') return task;
        const childStatuses = (childrenByParent.get(task.taskId) ?? [])
          .map((childId) => tasks.find(({ taskId }) => taskId === childId)!.status);
        status = projectGroupStatus(task.definition.mode, childStatuses,
          dependenciesSucceeded(completionGraph, tasks, task.taskId));
        if (isTerminal(task.status) && status !== task.status) {
          throw new TaskManagerError('terminal-task-immutable', `task-group ${task.taskId} is terminal (${task.status})`);
        }
      }
      if (status === task.status) return task;
      changed = true;
      return { ...task, status, ...(projectedAt === undefined ? {} : { updatedAt: projectedAt }) };
    });
    tasks = next;
    if (!changed) return tasks;
  }
  throw new TaskManagerError('cyclic-task-forest', 'TaskGroup projection did not converge');
}

function projectGroupStatus(
  mode: 'sequential' | 'all' | 'any',
  childStatuses: readonly TaskStatus[],
  dependenciesAreSatisfied: boolean,
): TaskStatus {
  if (!dependenciesAreSatisfied) return 'Pending';
  if (mode === 'any') {
    if (childStatuses.some((status) => status === 'Succeeded')) return 'Succeeded';
    if (childStatuses.every(isTerminal)) return 'Failed';
  } else {
    if (childStatuses.some((status) => status === 'Failed' || status === 'Cancelled')) return 'Failed';
    if (childStatuses.every((status) => status === 'Succeeded')) return 'Succeeded';
  }
  if (childStatuses.some((status) => status === 'Claimed' || status === 'Running')) return 'Running';
  if (childStatuses.some((status) => status === 'Waiting')) return 'Waiting';
  if (childStatuses.some((status) => status === 'Ready')) return 'Ready';
  return 'Pending';
}
