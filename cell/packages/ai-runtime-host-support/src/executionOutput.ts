import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { parseHostParticipantSendCommand, parseHostParticipantDelivery, parseHostExecutionOutputPage, type HostParticipantSendCommand, type HostParticipantDelivery, type HostParticipantTaskRef, type HostExecutionOutput, type HostParticipantExecutionSource } from '@cell/ai-runtime-host-contract';
type Scope = Readonly<{
    principalId: string;
    bindingKey: string;
}>;
export type StoredExecutionIntent = HostParticipantDelivery & Readonly<{
    command: HostParticipantSendCommand;
}>;
export type ExecutionOutputCandidate = Readonly<{
    key: string;
    message: Omit<HostExecutionOutput, 'outputId' | 'revision' | 'ordinal' | 'recordedAt'>;
}>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 48);
export const executionRequestRef = (scope: Scope, commandId: string) => `execution-${digest([scope.principalId, scope.bindingKey, commandId])}`;
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const validateMessage = (message: ExecutionOutputCandidate['message']) => parseHostExecutionOutputPage({ bindingKey: 'validation', sessionId: 'validation', deliveries: [],
    outputs: [{ ...message, outputId: 'validation', revision: 1, ordinal: 1, recordedAt: 0 }] });
/** Durable execution admission, supplied material and checkpoint-proven output ledger. No IM history or task state. */
export function createExecutionOutputStore(database: Database) {
    database.exec(`CREATE TABLE IF NOT EXISTS execution_intents (
    principalId TEXT NOT NULL, bindingKey TEXT NOT NULL, commandId TEXT NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY(principalId,bindingKey,commandId));
    CREATE TABLE IF NOT EXISTS execution_outputs (
    principalId TEXT NOT NULL, bindingKey TEXT NOT NULL, outputId TEXT NOT NULL, ordinal INTEGER NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY(principalId,bindingKey,outputId), UNIQUE(principalId,bindingKey,ordinal));
    CREATE TABLE IF NOT EXISTS execution_sources (
    principalId TEXT NOT NULL, bindingKey TEXT NOT NULL, commandId TEXT NOT NULL, actorId TEXT NOT NULL, claimId TEXT NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY(principalId,bindingKey,commandId,actorId,claimId));`);
    database.exec(`CREATE TABLE IF NOT EXISTS execution_output_candidates (
    principalId TEXT NOT NULL, bindingKey TEXT NOT NULL, candidateKey TEXT NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY(principalId,bindingKey,candidateKey));`);
    database.exec(`CREATE TABLE IF NOT EXISTS execution_question_sources (
    principalId TEXT NOT NULL,bindingKey TEXT NOT NULL,questionnaireId TEXT NOT NULL,value TEXT NOT NULL,
    PRIMARY KEY(principalId,bindingKey,questionnaireId));`);
    const intent = (scope: Scope, commandId: string): StoredExecutionIntent | undefined => {
        const row = database.query<{
            value: string;
        }, [
            string,
            string,
            string
        ]>('SELECT value FROM execution_intents WHERE principalId=? AND bindingKey=? AND commandId=?').get(scope.principalId, scope.bindingKey, commandId);
        return row ? JSON.parse(row.value) : undefined;
    };
    const validateSource = (scope: Scope, message: ExecutionOutputCandidate['message']) => {
        const origin = intent(scope, message.commandId);
        if (!origin || !same(origin.task, message.source))
            throw new Error('participant_source_mismatch');
        if (message.execution) {
            const source = message.execution;
            const stored = database.query<{
                value: string;
            }, [
                string,
                string,
                string,
                string,
                string
            ]>('SELECT value FROM execution_sources WHERE principalId=? AND bindingKey=? AND commandId=? AND actorId=? AND claimId=?')
                .get(scope.principalId, scope.bindingKey, message.commandId, source.actorId, source.claimId);
            if (!stored || !same(JSON.parse(stored.value), source))
                throw new Error('participant_source_mismatch');
        }
    };
    const append = (scope: Scope, key: string, message: Omit<HostExecutionOutput, 'outputId' | 'revision' | 'ordinal' | 'recordedAt'>, now: number) => {
        validateMessage(message);
        const outputId = `output-${digest([scope.principalId, scope.bindingKey, key])}`;
        const row = database.query<{
            value: string;
        }, [
            string,
            string,
            string
        ]>('SELECT value FROM execution_outputs WHERE principalId=? AND bindingKey=? AND outputId=?').get(scope.principalId, scope.bindingKey, outputId);
        if (row) {
            const existing: HostExecutionOutput = JSON.parse(row.value);
            const { outputId: _id, revision: _revision, ordinal: _ordinal, recordedAt: _at, ...facts } = existing;
            if (!same(facts, message))
                throw new Error('participant_publication_conflict');
            return existing;
        }
        const size = Buffer.byteLength(JSON.stringify(message));
        if (size > 768 * 1024)
            throw new Error('participant_publication_too_large');
        const count = database.query<{
            total: number;
        }, [
            string,
            string
        ]>('SELECT COUNT(*) AS total FROM execution_outputs WHERE principalId=? AND bindingKey=?').get(scope.principalId, scope.bindingKey)!.total;
        if (count >= 16384)
            throw new Error('participant_publication_capacity');
        const value: HostExecutionOutput = { ...message, outputId, revision: 1, ordinal: count + 1, recordedAt: now };
        database.query('INSERT INTO execution_outputs VALUES (?,?,?,?,?)').run(scope.principalId, scope.bindingKey, outputId, value.ordinal, JSON.stringify(value));
        return value;
    };
    const listIntents = (scope: Scope): StoredExecutionIntent[] => database.query<{
        value: string;
    }, [
        string,
        string
    ]>('SELECT value FROM execution_intents WHERE principalId=? AND bindingKey=? ORDER BY rowid').all(scope.principalId, scope.bindingKey).map(r => JSON.parse(r.value));
    return {
        intent, listIntents,
        completedCommandIds(scope:Scope):ReadonlySet<string>{
            const rows=database.query<{commandId:string},[string,string]>("SELECT json_extract(value,'$.commandId') AS commandId FROM execution_outputs WHERE principalId=? AND bindingKey=? AND json_extract(value,'$.kind')='result'").all(scope.principalId,scope.bindingKey)
            return new Set(rows.map(row=>row.commandId))
        },
        committedOutput(scope: Scope, key: string): HostExecutionOutput | undefined {
            const outputId = `output-${digest([scope.principalId, scope.bindingKey, key])}`;
            const row = database.query<{ value: string }, [string, string, string]>(
                'SELECT value FROM execution_outputs WHERE principalId=? AND bindingKey=? AND outputId=?'
            ).get(scope.principalId, scope.bindingKey, outputId);
            return row ? JSON.parse(row.value) : undefined;
        },
        material(scope: Scope, commandId: string) {
            const admitted = intent(scope, commandId);
            if (!admitted) throw new Error('execution_material_not_found');
            return structuredClone(admitted.command.contextCut);
        },
        output(scope: Scope, outputId: string): HostExecutionOutput | undefined {
            const row = database.query<{
                value: string;
            }, [
                string,
                string,
                string
            ]>('SELECT value FROM execution_outputs WHERE principalId=? AND bindingKey=? AND outputId=?').get(scope.principalId, scope.bindingKey, outputId);
            return row ? JSON.parse(row.value) : undefined;
        },
        questionSources: (scope: Scope): Readonly<{
            questionnaireId: string;
            commandId: string;
            execution: HostParticipantExecutionSource;
        }>[] => database.query<{
            value: string;
        }, [
            string,
            string
        ]>('SELECT value FROM execution_question_sources WHERE principalId=? AND bindingKey=? ORDER BY rowid').all(scope.principalId, scope.bindingKey).map(r => JSON.parse(r.value)),
        questionSource: database.transaction((scope: Scope, value: {
            questionnaireId: string;
            commandId: string;
            execution: HostParticipantExecutionSource;
        }) => {
            const origin = intent(scope, value.commandId);
            if (!origin)
                throw new Error('participant_origin_not_found');
            validateSource(scope, { commandId: value.commandId, kind: 'question', text: '', artifactRefs: [], source: origin.task, execution: value.execution, questionnaireId: value.questionnaireId });
            const old = database.query<{
                value: string;
            }, [
                string,
                string,
                string
            ]>('SELECT value FROM execution_question_sources WHERE principalId=? AND bindingKey=? AND questionnaireId=?').get(scope.principalId, scope.bindingKey, value.questionnaireId);
            if (old) {
                if (!same(JSON.parse(old.value), value))
                    throw new Error('participant_question_source_conflict');
                return;
            }
            database.query('INSERT INTO execution_question_sources VALUES (?,?,?,?)').run(scope.principalId, scope.bindingKey, value.questionnaireId, JSON.stringify(value));
        }).immediate,
        accept: database.transaction((scope: Scope, input: HostParticipantSendCommand, now: number, task: HostParticipantTaskRef, attachments?: HostExecutionOutput['attachments']) => {
            const command = parseHostParticipantSendCommand(input);
            if (command.bindingKey !== scope.bindingKey || !command.recipient.admissionRef)
                throw new Error('participant_binding_conflict');
            const old = intent(scope, command.commandId);
            if (old) {
                if (!same({ ...old.command, inputJson: old.command.inputJson === undefined ? undefined : JSON.parse(old.command.inputJson) }, { ...command, inputJson: command.inputJson === undefined ? undefined : JSON.parse(command.inputJson) }))
                    throw new Error('idempotency_conflict');
                return { intent: old, created: false };
            }
            if (listIntents(scope).length >= 4096)
                throw new Error('participant_intent_capacity');
            if (task.admissionId !== command.recipient.admissionRef)
                throw new Error('participant_source_mismatch');
            const value: StoredExecutionIntent = { command: structuredClone(command), commandId: command.commandId, requestRef: executionRequestRef(scope, command.commandId), task: structuredClone(task), state: 'accepted' };
            const { command: _command, ...check } = value;
            parseHostParticipantDelivery(check);
            database.query('INSERT INTO execution_intents VALUES (?,?,?,?)').run(scope.principalId, scope.bindingKey, command.commandId, JSON.stringify(value));
            return { intent: structuredClone(value), created: true };
        }).immediate,
        delivery: database.transaction((scope: Scope, commandId: string, state: HostParticipantDelivery['state'], errorCode?: string) => {
            const old = intent(scope, commandId);
            if (!old)
                throw new Error('participant_intent_not_found');
            // An acknowledged canonical submission cannot be downgraded by a late transport failure.
            if (old.state === 'submitted' && state === 'unknown')
                return old;
            const value = { ...old, state, ...(errorCode ? { errorCode } : {}) };
            if (!errorCode)
                delete value.errorCode;
            const { command: _command, ...delivery } = value;
            parseHostParticipantDelivery(delivery);
            database.query('UPDATE execution_intents SET value=? WHERE principalId=? AND bindingKey=? AND commandId=?')
                .run(JSON.stringify(value), scope.principalId, scope.bindingKey, commandId);
            return value;
        }).immediate,
        execution: database.transaction((scope: Scope, commandId: string, source: HostParticipantExecutionSource) => {
            const message = intent(scope, commandId);
            if (!message || !same(message.task, { admissionId: source.admissionId, taskSpaceId: source.taskSpaceId, taskId: source.taskId }))
                throw new Error('participant_source_mismatch');
            validateMessage({ commandId, kind: 'stage', text: '', artifactRefs: [], source: message.task, execution: source });
            const old = database.query<{
                value: string;
            }, [
                string,
                string,
                string,
                string,
                string
            ]>('SELECT value FROM execution_sources WHERE principalId=? AND bindingKey=? AND commandId=? AND actorId=? AND claimId=?')
                .get(scope.principalId, scope.bindingKey, commandId, source.actorId, source.claimId);
            if (old) {
                if (!same(JSON.parse(old.value), source))
                    throw new Error('participant_source_mismatch');
                return;
            }
            database.query('INSERT INTO execution_sources VALUES (?,?,?,?,?,?)')
                .run(scope.principalId, scope.bindingKey, commandId, source.actorId, source.claimId, JSON.stringify(source));
        }).immediate,
        sources: (scope: Scope, commandId: string): HostParticipantExecutionSource[] => database.query<{
            value: string;
        }, [
            string,
            string,
            string
        ]>('SELECT value FROM execution_sources WHERE principalId=? AND bindingKey=? AND commandId=? ORDER BY rowid')
            .all(scope.principalId, scope.bindingKey, commandId).map(r => JSON.parse(r.value)),
        publish: database.transaction((scope: Scope, key: string, message: Omit<HostExecutionOutput, 'outputId' | 'revision' | 'ordinal' | 'recordedAt'>, now: number) => {
            validateSource(scope, message);
            return append(scope, key, message, now);
        }).immediate,
        prepare: database.transaction((scope: Scope, candidate: ExecutionOutputCandidate) => {
            const old = database.query<{
                value: string;
            }, [
                string,
                string,
                string
            ]>('SELECT value FROM execution_output_candidates WHERE principalId=? AND bindingKey=? AND candidateKey=?').get(scope.principalId, scope.bindingKey, candidate.key);
            if (old) {
                if (!same(JSON.parse(old.value), candidate))
                    throw new Error('participant_publication_conflict');
                return;
            }
            validateSource(scope, candidate.message);
            validateMessage(candidate.message);
            if (Buffer.byteLength(JSON.stringify(candidate)) > 768 * 1024)
                throw new Error('participant_publication_too_large');
            const count = database.query<{
                total: number;
            }, [
                string,
                string
            ]>('SELECT COUNT(*) AS total FROM execution_output_candidates WHERE principalId=? AND bindingKey=?').get(scope.principalId, scope.bindingKey)!.total;
            if (count >= 4096)
                throw new Error('participant_publication_candidate_capacity');
            database.query('INSERT INTO execution_output_candidates VALUES (?,?,?,?)').run(scope.principalId, scope.bindingKey, candidate.key, JSON.stringify(candidate));
        }).immediate,
        candidates: (scope: Scope): ExecutionOutputCandidate[] => database.query<{
            value: string;
        }, [
            string,
            string
        ]>('SELECT value FROM execution_output_candidates WHERE principalId=? AND bindingKey=? ORDER BY rowid').all(scope.principalId, scope.bindingKey).map(r => JSON.parse(r.value)),
        confirm: database.transaction((scope: Scope, key: string, now: number) => {
            const row = database.query<{
                value: string;
            }, [
                string,
                string,
                string
            ]>('SELECT value FROM execution_output_candidates WHERE principalId=? AND bindingKey=? AND candidateKey=?').get(scope.principalId, scope.bindingKey, key);
            if (!row)
                return;
            const candidate: ExecutionOutputCandidate = JSON.parse(row.value);
            validateSource(scope, candidate.message);
            const publication = append(scope, candidate.key, candidate.message, now);
            database.query('DELETE FROM execution_output_candidates WHERE principalId=? AND bindingKey=? AND candidateKey=?').run(scope.principalId, scope.bindingKey, key);
            return publication;
        }).immediate,
        outputs(scope: Scope, after = 0, limit = 100): {
            outputs: HostExecutionOutput[];
            nextAfter?: number;
        } {
            if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
                throw new Error('invalid_schema');
            const rows = database.query<{
                value: string;
            }, [
                string,
                string,
                number,
                number
            ]>('SELECT value FROM execution_outputs WHERE principalId=? AND bindingKey=? AND ordinal>? ORDER BY ordinal LIMIT ?')
                .all(scope.principalId, scope.bindingKey, after, limit + 1);
            const outputs: HostExecutionOutput[] = [];
            let size = 0;
            for (const row of rows) {
                if (outputs.length === limit || outputs.length && size + Buffer.byteLength(row.value) > 800 * 1024)
                    break;
                outputs.push(JSON.parse(row.value));
                size += Buffer.byteLength(row.value);
            }
            return { outputs, ...(rows.length > outputs.length ? { nextAfter: outputs.at(-1)!.ordinal } : {}) };
        },
    };
}
export type ExecutionOutputStore = ReturnType<typeof createExecutionOutputStore>;
