import { WireSchemaError } from './Schema';
import type { WorkflowCommand, WorkflowValue, WorkflowMaterialRead, WorkflowDirectory, WorkflowRunPage, WorkflowRunView, WorkflowEventPage, WorkflowCommandResult, WorkflowMaterialChunk } from './Workflow';
const encoder = new TextEncoder();
function invalid(field: string): never { throw new WireSchemaError(field); }
function object(value: unknown, keys: readonly string[], required: readonly string[] = keys): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        invalid('$');
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record))
        if (!keys.includes(key))
            invalid(key);
    for (const key of required)
        if (!Object.prototype.hasOwnProperty.call(record, key))
            invalid(key);
    return record;
}
function text(value: unknown, field: string, max = 1024): string {
    if (typeof value !== 'string' || !value.length || encoder.encode(value).length > max)
        invalid(field);
    return value;
}
function integer(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
        invalid(field);
    return value;
}
export function parseWorkflowValue(value: unknown, maxBytes = 262144): WorkflowValue {
    let nodes = 16384;
    function visit(item: unknown, depth: number): void {
        if (--nodes < 0 || depth > 32)
            invalid('value_budget');
        if (item === null || typeof item === 'boolean' || typeof item === 'string')
            return;
        if (typeof item === 'number' && Number.isFinite(item))
            return;
        if (Array.isArray(item)) {
            if (item.length > 4096)
                invalid('array_budget');
            for (const nested of item)
                visit(nested, depth + 1);
            return;
        }
        if (!item || typeof item !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
            invalid('value');
        for (const [key, nested] of Object.entries(item)) {
            if (['__proto__', 'prototype', 'constructor'].includes(key) || encoder.encode(key).length > 512)
                invalid('key');
            visit(nested, depth + 1);
        }
    }
    visit(value, 0);
    if (encoder.encode(JSON.stringify(value)).length > maxBytes)
        invalid('value_bytes');
    return value as WorkflowValue;
}
export function parseWorkflowCommand(value: unknown): WorkflowCommand {
    const kind = (value as any)?.kind;
    const common = ['kind', 'commandId', 'expectedServerInstanceId', 'confirmed'];
    const keys = kind === 'start' ? ['workflowRef', 'definitionRevision', 'input', 'source'] : kind === 'resume_ctrl' ? ['runId', 'expectedGeneration', 'signalKind', 'signalKey', 'resumeToken', 'outcome', 'payload'] : kind==='resume_tasktree'?['runId','expectedGeneration','nodeId','invocationKey']:kind === 'answer_question' ? ['runId', 'expectedGeneration', 'sourceRef', 'nodeId', 'actorId', 'questionnaireId', 'responseText'] : kind === 'resume_data' ? ['runId', 'expectedGeneration', 'nodeId', 'output'] : invalid('kind');
    const record = object(value, [...common, ...keys]);
    if (record.confirmed !== true)
        invalid('confirmed');
    text(record.commandId, 'commandId', 256);
    text(record.expectedServerInstanceId, 'expectedServerInstanceId', 256);
    if (kind === 'start') {
        const ref = text(record.workflowRef, 'workflowRef');
        if (!/^resource:\/\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..'))
            invalid('workflowRef');
        text(record.definitionRevision, 'definitionRevision', 256);
        parseWorkflowValue(record.input, 65536);
        const source = object(record.source, ['kind', 'channelId', 'label']);
        if (!['independent', 'session', 'participant'].includes(source.kind as string))
            invalid('source.kind');
        text(source.channelId, 'source.channelId', 512);
        text(source.label, 'source.label', 512);
    }
    else {
        text(record.runId, 'runId', 256);
        integer(record.expectedGeneration, 'expectedGeneration');
        if (kind === 'resume_ctrl') {
            for (const key of ['signalKind', 'signalKey', 'resumeToken'])
                text(record[key], key);
            if (!['Success', 'Failure'].includes(record.outcome as string))
                invalid('outcome');
            parseWorkflowValue(record.payload, 65536);
        }
        else if(kind==='resume_tasktree'){text(record.nodeId,'nodeId');text(record.invocationKey,'invocationKey')}
        else if (kind === 'answer_question') {
            for (const key of ['sourceRef', 'nodeId', 'actorId', 'questionnaireId'])
                text(record[key], key);
            text(record.responseText, 'responseText', 65536);
        }
        else {
            text(record.nodeId, 'nodeId');
            parseWorkflowValue(record.output, 65536);
        }
    }
    return value as WorkflowCommand;
}
export function parseWorkflowQuery(value: unknown): {
    after?: string;
    limit?: number;
} {
    const record = object(value, ['after', 'limit'], []);
    if (record.after !== undefined)
        text(record.after, 'after', 4096);
    if (record.limit !== undefined && integer(record.limit, 'limit', 100) < 1)
        invalid('limit');
    return value as {
        after?: string;
        limit?: number;
    };
}
export function parseWorkflowRunSelector(value: unknown): {
    runId: string;
} { const record = object(value, ['runId']); text(record.runId, 'runId', 256); return value as {
    runId: string;
}; }
export function parseWorkflowResultSelector(value: unknown): {
    commandId: string;
} { const record = object(value, ['commandId']); text(record.commandId, 'commandId', 256); return value as {
    commandId: string;
}; }
export function parseWorkflowMaterialRead(value: unknown): WorkflowMaterialRead {
    const required = ['runId', 'materialRef', 'revision', 'path'], record = object(value, [...required, 'offsetBytes', 'limitBytes'], required);
    for (const key of required)
        text(record[key], key);
    if (record.offsetBytes !== undefined)
        integer(record.offsetBytes, 'offsetBytes');
    if (record.limitBytes !== undefined && integer(record.limitBytes, 'limitBytes', 32768) < 1)
        invalid('limitBytes');
    return value as WorkflowMaterialRead;
}
type Validator = (value: unknown) => void;
const str: Validator = value => { text(value, 'string', 4096); }, id: Validator = value => { text(value, 'id', 1024); };
const num: Validator = value => { integer(value, 'number'); }, bool: Validator = value => { if (typeof value !== 'boolean')
    invalid('boolean'); };
const val: Validator = value => { parseWorkflowValue(value); };
const choices = (...values: readonly unknown[]): Validator => value => { if (!values.includes(value))
    invalid('enum'); };
const list = (child: Validator, max: number): Validator => value => { if (!Array.isArray(value) || value.length > max)
    invalid('array'); for (const item of value as unknown[])
    child(item); };
const shape = (fields: Record<string, Validator>, optional: readonly string[] = []): Validator => value => {
    const record = object(value, Object.keys(fields), Object.keys(fields).filter(key => !optional.includes(key)));
    for (const [key, validate] of Object.entries(fields))
        if (record[key] !== undefined || !optional.includes(key))
            validate(record[key]);
};
const source = shape({ kind: choices('independent', 'session', 'participant'), channelId: id, label: str });
const definition = shape({ workflowRef: id, revision: id, fqn: id, form: choices('AICtrlWorkflow', 'AIDataWorkflow'), definition: val });
const run = shape({ runId: id, instanceId: id, workflowRef: id, definitionRevision: id, form: choices('AICtrlWorkflow', 'AIDataWorkflow'), generation: num, status: id, terminal: bool, createdAt: num, source });
const node = shape({ nodeId: id, generation: num, status: id, output: val, error: str }, ['output', 'error']);
const wait = shape({ nodeId: id, signalKind: id, signalKey: id, resumeToken: id,taskTree:bool,canResume:bool }, ['nodeId','taskTree','canResume']);
const material = shape({ materialRef: id, revision: id, nodeId: id, port: id, direction: choices('input', 'output'), files: list(shape({ path: id, digest: id, size: num }), 256) }, ['nodeId', 'port']);
function reply<T>(validate: Validator, value: unknown, maxBytes: number): T {
    parseWorkflowValue(value, maxBytes);
    validate(value);
    return value as T;
}
export const parseWorkflowDirectory = (value: unknown) => reply<WorkflowDirectory>(shape({ workspaceId: id, definitions: list(definition, 128), unsupported: list(id, 64) }), value, 1048576);
export const parseWorkflowRunPage = (value: unknown) => reply<WorkflowRunPage>(shape({ workspaceId: id, runs: list(run, 100), nextCursor: str }, ['nextCursor']), value, 262144);
export const parseWorkflowRunView = (value: unknown) => reply<WorkflowRunView>(shape({ workspaceId: id, run, definition, structure: val, input: val, executionState: choices('active', 'idle', 'interrupted'), executionSources: list(shape({ sourceRef: id, nodeId: id, generation: num, actorId: id, actorKey: id, agentDefinitionRef: id, status: id, questions: list(shape({ questionnaireId: id, kind: choices('domain_question', 'backend_approval'), state: id, title: str, questions: val, canAnswer: bool, unavailableReason: id }, ['questions', 'unavailableReason']), 8) }), 128), taskTrees:list(shape({nodeId:id,generation:num,invocationKey:id,taskSpaceId:id,rootId:id,admitted:bool,canResume:bool}),128), nodes: list(node, 1024), waits: list(wait, 128), result: val, materials: list(material, 64), dataResumes: list(shape({ nodeId: id, outputs: list(id, 256), canResume: bool, unavailableReason: id }, ['unavailableReason']), 1024), unsupported: list(id, 64) }, ['result', 'structure','taskTrees']), value, 1048576);
export const parseWorkflowEventPage = (value: unknown) => reply<WorkflowEventPage>(shape({ runId: id, entries: list(shape({ eventId: id, seq: num, runId: id, generation: num, nodeId: id, kind: id, occurredAt: str, data: val }, ['nodeId', 'occurredAt']), 100), nextCursor: str, cursor: str, hasMore: bool }, ['nextCursor']), value, 1048576);
export const parseWorkflowCommandResult = (value: unknown) => reply<WorkflowCommandResult>(shape({ commandId: id, state: choices('completed', 'unknown', 'rejected'), runId: id, instanceId: id, errorCode: id, replayed: bool }, ['runId', 'instanceId', 'errorCode']), value, 8192);
export const parseWorkflowMaterialChunk = (value: unknown) => reply<WorkflowMaterialChunk>(shape({ runId: id, materialRef: id, revision: id, path: id, digest: id, sizeBytes: num, offsetBytes: num, bytesBase64: value => { if (typeof value !== 'string' || value.length > 43692 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
        invalid('base64'); }, nextOffsetBytes: num }, ['nextOffsetBytes']), value, 65536);
