import type { ControlTaskRootCommand, PrepareTaskCommand, TaskRootControl, TaskSpaceSnapshot, TaskRecord, TaskSpaceDefinition, TaskId } from 'task-manager-contract';
import { canonicalOwnDataDigest } from 'task-manager-contract';
import { TaskManagerError } from './errors.js';
import { isTerminal } from './statusMachine.js';
import { assertProfile, validateTaskSpaceDefinition } from './validation.js';
import { buildTaskCompletionGraph } from './completionGraph.js';
function invalid(message: string): never { throw new TaskManagerError('invalid-task-definition', message); }
function keys(value: object, allowed: readonly string[]) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== allowed.length || Object.keys(value).some(key => !allowed.includes(key)))
        invalid('root control fields are not closed');
}
function text(value: string) { if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value))
    invalid('root binding reference is invalid'); }
export function validateRootControl(value: TaskRootControl): void {
    keys(value, ['revision', 'paused', 'binding']);
    if (!Number.isSafeInteger(value.revision) || value.revision < 1 || value.revision > 4096 || typeof value.paused !== 'boolean')
        invalid('root control revision or pause state is invalid');
    if (value.binding) {
        keys(value.binding, ['bindingId', 'authorityRef', 'executionRef', 'digest']);
        text(value.binding.bindingId);
        text(value.binding.authorityRef);
        text(value.binding.executionRef);
        if (!/^sha256:[a-f0-9]{64}$/.test(value.binding.digest))
            invalid('root binding digest is invalid');
    }
    else if (value.binding !== null || !value.paused)
        invalid('unbound root must remain paused');
}
export function taskRoot(snapshot: TaskSpaceSnapshot, taskId: string): TaskRecord {
    let current = taskId;
    const seen = new Set<string>();
    while (true) {
        if (seen.has(current))
            invalid('cyclic root ancestry');
        seen.add(current);
        const relation = snapshot.definition.relations.find(item => item.kind === 'parent-child' && item.childTaskId === current);
        if (!relation || relation.kind !== 'parent-child')
            invalid('root ancestry is missing');
        if (relation.parentTaskId === null) {
            const root = snapshot.tasks.find(item => item.taskId === current);
            if (!root)
                invalid('root record is missing');
            return root;
        }
        current = relation.parentTaskId;
    }
}
export function reduceTaskRootControl(snapshot: TaskSpaceSnapshot, input: ControlTaskRootCommand): TaskRootControl {
    const root = taskRoot(snapshot, input.taskId);
    if (root.taskId !== input.taskId)
        throw new TaskManagerError('task-not-root', 'control requires an exact root');
    const prior = root.rootControl ?? { revision: 0, paused: true, binding: null };
    if (root.rootControl)
        validateRootControl(root.rootControl);
    if (input.expectedControlRevision !== prior.revision)
        throw new TaskManagerError('root-control-revision-conflict', 'root control revision changed');
    const action = input.action;
    let next: TaskRootControl;
    const base = { ...prior, revision: prior.revision + 1 };
    if (action.kind === 'bind') {
        keys(action, ['kind', 'binding']);
        if (prior.binding)
            throw new TaskManagerError('root-binding-conflict', 'root already has an execution binding');
        if (isTerminal(root.status))
            throw new TaskManagerError('terminal-task-immutable', 'terminal root cannot bind');
        if (snapshot.tasks.some(task => taskRoot(snapshot, task.taskId).taskId === root.taskId && (task.attempt > 0 || task.activeClaim || task.preparationReceiptId)))
            throw new TaskManagerError('root-busy', 'execution binding must precede dispatch');
        next = { ...base, paused: true, binding: action.binding };
    }
    else if (action.kind === 'pause') {
        keys(action, ['kind']);
        next = { ...base, paused: true };
    }
    else {
        if (action.kind !== 'resume' && action.kind !== 'release' && action.kind !== 'record')
            invalid('unsupported root control action');
        keys(action, ['kind', 'bindingId']);
        text(action.bindingId);
        if (!prior.binding || prior.binding.bindingId !== action.bindingId)
            throw new TaskManagerError('root-binding-conflict', 'root binding identity changed');
        if (action.kind === 'record') {
            if (!input.artifactBodies?.length) invalid('root record requires canonical evidence material');
            next = base;
        }
        else if (action.kind === 'resume') {
            if (isTerminal(root.status))
                throw new TaskManagerError('terminal-task-immutable', 'terminal root cannot resume');
            next = { ...base, paused: false };
        }
        else {
            if (!prior.paused || snapshot.tasks.some(task => taskRoot(snapshot, task.taskId).taskId === root.taskId
                && (task.activeClaim || task.preparationReceiptId && !isTerminal(task.status) || ['Claimed', 'Running', 'Waiting'].includes(task.status))))
                throw new TaskManagerError('root-busy', 'root must be paused and have no outstanding execution');
            next = { ...base, paused: true, binding: null };
        }
    }
    validateRootControl(next);
    return next;
}
export function assertRootDispatchOpen(snapshot: TaskSpaceSnapshot, taskId: string): void {
    const root = taskRoot(snapshot, taskId), control = root.rootControl;
    if (!control)
        return;
    validateRootControl(control);
    if (control.paused)
        throw new TaskManagerError('root-paused', 'root dispatch is paused');
    const task = snapshot.tasks.find(task => task.taskId === taskId)!;
    if (isTerminal(root.status) || task.attempt > 0 && !task.activeClaim && !isTerminal(task.status))
        throw new TaskManagerError('root-execution-unknown', 'managed dispatch cannot replace an expired or unresolved execution');
}
export function sameRootControl(left: TaskRootControl | undefined, right: TaskRootControl | undefined): boolean {
    return left === undefined ? right === undefined : right !== undefined && canonicalOwnDataDigest(left) === canonicalOwnDataDigest(right);
}
export function reduceTaskPreparation(snapshot: TaskSpaceSnapshot, input: PrepareTaskCommand): TaskRecord {
    const root = taskRoot(snapshot, input.taskId), task = snapshot.tasks.find(t => t.taskId === input.taskId);
    if (!root.rootControl?.binding || root.rootControl.binding.bindingId !== input.rootBindingId)
        throw new TaskManagerError('root-binding-conflict', 'preparation requires exact managed root binding');
    assertRootDispatchOpen(snapshot, input.taskId);
    if (!task || task.definition.kind !== 'task' || task.status !== 'Ready' || task.activeClaim || task.attempt > 0 || task.preparationReceiptId)
        throw new TaskManagerError('task-not-ready', 'only an unprepared Ready leaf can be admitted');
    keys(input.profile, ['kind', 'profileKind', 'schemaVersion', 'facts']);
    assertProfile(input.profile, input.taskId);
    if (!input.profile.facts || typeof input.profile.facts !== 'object' || Array.isArray(input.profile.facts))
        invalid('prepared profile facts must be an object');
    if (!Number.isFinite(Date.parse(input.preparedAt)) || new Date(input.preparedAt).toISOString() !== input.preparedAt)
        invalid('preparation timestamp is invalid');
    return { ...task, profile: input.profile, preparationReceiptId: `receipt:${encodeURIComponent(input.commandId)}`, updatedAt: input.preparedAt };
}
export function assertReplanDurableTasksImmutable(snapshot: TaskSpaceSnapshot, nextDefinition: TaskSpaceDefinition): void {
    if (canonicalOwnDataDigest(snapshot.definition) === canonicalOwnDataDigest(nextDefinition)) return;
    // Validate containment before the shared graph traverses descendants, including raw owner admissions.
    validateTaskSpaceDefinition(nextDefinition, {maxTasks: Math.max(1, nextDefinition.tasks.length), maxRelations: Math.max(1, nextDefinition.relations.length), maxLeaseDurationMs: 86400000});
    const priorGraph = buildTaskCompletionGraph(snapshot.definition), nextGraph = buildTaskCompletionGraph(nextDefinition);
    for (const prior of snapshot.tasks) {
        const next = nextDefinition.tasks.find(({ taskId }) => taskId === prior.taskId);
        const root = taskRoot(snapshot, prior.taskId);
        if (!next) {
            if (root.rootControl && !root.rootControl.paused)
                throw new TaskManagerError('root-busy', 'bound root must pause before removing tasks');
            if (isTerminal(prior.status) || prior.activeClaim || prior.attempt > 0 || prior.rootControl || prior.preparationReceiptId) {
                throw new TaskManagerError('terminal-task-immutable', `replan cannot remove durable task ${prior.taskId}`);
            }
            continue;
        }
        const changed = canonicalOwnDataDigest(prior.definition) !== canonicalOwnDataDigest(next)
            || canonicalOwnDataDigest(incidentRelations(snapshot.definition, prior.taskId)) !== canonicalOwnDataDigest(incidentRelations(nextDefinition, prior.taskId));
        if (changed && root.rootControl && !root.rootControl.paused)
            throw new TaskManagerError('root-busy', 'bound root must pause before plan editing');
        if (!isTerminal(prior.status) && !prior.activeClaim && prior.attempt === 0 && !prior.preparationReceiptId)
            continue;
        const priorRelations = incidentRelations(snapshot.definition, prior.taskId);
        const nextRelations = incidentRelations(nextDefinition, prior.taskId);
        if (canonicalOwnDataDigest(prior.definition) !== canonicalOwnDataDigest(next)
            || canonicalOwnDataDigest(priorRelations) !== canonicalOwnDataDigest(nextRelations)
            || canonicalOwnDataDigest([...(priorGraph.predecessorIdsByTask.get(prior.taskId) ?? [])].sort()) !== canonicalOwnDataDigest([...(nextGraph.predecessorIdsByTask.get(prior.taskId) ?? [])].sort())) {
            throw new TaskManagerError('terminal-task-immutable', `replan cannot rewrite terminal task ${prior.taskId} definition, profile, identity or relations`);
        }
    }
}
function incidentRelations(definition: TaskSpaceDefinition, taskId: TaskId): TaskSpaceDefinition['relations'] {
    return definition.relations.filter((relation) => relation.kind === 'parent-child'
        ? relation.parentTaskId === taskId || relation.childTaskId === taskId
        : relation.predecessorTaskId === taskId || relation.successorTaskId === taskId);
}
