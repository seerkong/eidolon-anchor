import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, sep, relative } from 'node:path';
import { canonicalOwnDataDigest } from 'task-manager-contract';
import type { WorkflowCommand, WorkflowSource, WorkflowCommandResult } from '@cell/ai-runtime-host-contract';
export type WorkflowAdmissionRecord = Readonly<{
    commandId: string;
    fingerprint: string;
    command: WorkflowCommand;
    runId: string;
    instanceId: string;
    source: WorkflowSource;
    createdAt: number;
    result?: WorkflowCommandResult;
}>;
export const workflowDigest = (value: unknown) => canonicalOwnDataDigest(value).slice('sha256:'.length);
/** Native command/source journal only. Canonical workflow facts remain in WorkflowFactStore. */
export async function openWorkflowWorkbenchStore(stateRoot: string, principalId: string) {
    const ownerId = workflowDigest(principalId), root = join(stateRoot, 'workflows', ownerId);
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    const boundary = await realpath(stateRoot);
    for (const component of ['workflows', ownerId, 'commands', 'runtime-session']) {
        const target = component === 'workflows' ? join(stateRoot, component) : component === ownerId ? root : join(root, component);
        try {
            await mkdir(target, { mode: 0o700 });
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
                throw error;
        }
        const info = await lstat(target);
        if (info.isSymbolicLink() || !info.isDirectory() || !(await realpath(target)).startsWith(boundary + sep))
            throw new Error('workflow_storage_invalid');
    }
    const file = (commandId: string) => join(root, 'commands', workflowDigest(commandId) + '.json');
    async function contained(target: string) {
        if (await realpath(stateRoot) !== boundary)
            throw new Error('workflow_storage_changed');
        const parts = relative(stateRoot, target).split(sep);
        if (parts.some(part => !part || part === '..'))
            throw new Error('workflow_storage_invalid');
        let current = stateRoot;
        for (const part of parts) {
            current = join(current, part);
            if ((await lstat(current)).isSymbolicLink())
                throw new Error('workflow_storage_symlink');
        }
    }
    async function boundedRead(target: string, maxBytes: number) {
        await contained(target);
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size > maxBytes)
                throw new Error('workflow_record_too_large');
            return await handle.readFile('utf8');
        }
        finally {
            await handle.close();
        }
    }
    async function read(commandId: string): Promise<WorkflowAdmissionRecord | undefined> {
        try {
            const content = await boundedRead(file(commandId), 262144);
            if (Buffer.byteLength(content) > 262144)
                throw new Error('workflow_record_too_large');
            const record = JSON.parse(content) as WorkflowAdmissionRecord;
            if (record.commandId !== commandId || workflowDigest(record.command) !== record.fingerprint)
                throw new Error('workflow_record_invalid');
            return record;
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                return undefined;
            throw error;
        }
    }
    async function list() {
        await contained(join(root, 'commands'));
        const names = (await readdir(join(root, 'commands'))).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
        if (names.length > 512)
            throw new Error('workflow_command_capacity');
        const records = await Promise.all(names.map(async (name) => {
            const text = await boundedRead(join(root, 'commands', name), 262144);
            if (Buffer.byteLength(text) > 262144)
                throw new Error('workflow_record_too_large');
            const record = JSON.parse(text) as WorkflowAdmissionRecord;
            if (workflowDigest(record.commandId) + '.json' !== name || workflowDigest(record.command) !== record.fingerprint)
                throw new Error('workflow_record_invalid');
            return record;
        }));
        return records.sort((a, b) => a.createdAt - b.createdAt || a.commandId.localeCompare(b.commandId));
    }
    async function save(record: WorkflowAdmissionRecord) {
        await contained(join(root, 'commands'));
        if (!await read(record.commandId) && (await list()).length >= 512)
            throw new Error('workflow_command_capacity');
        const content = JSON.stringify(record);
        if (Buffer.byteLength(content) > 262144)
            throw new Error('workflow_record_too_large');
        const target = file(record.commandId), temp = target + '.' + randomUUID() + '.tmp';
        const handle = await open(temp, 'wx', 0o600);
        try {
            await handle.writeFile(content);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        await rename(temp, target);
        const directory = await open(join(root, 'commands'), 'r');
        try {
            await directory.sync();
        }
        finally {
            await directory.close();
        }
    }
    async function materialBytes(contentRoot: string, path: string, expectedDigest: string, size: number, offset: number, limit: number) {
        if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..'))
            throw new Error('workflow_material_path_invalid');
        if (size > 1048576)
            throw new Error('workflow_material_too_large');
        await contained(contentRoot);
        let current = contentRoot;
        for (const part of path.split('/')) {
            current = join(current, part);
            if ((await lstat(current)).isSymbolicLink())
                throw new Error('workflow_material_symlink');
        }
        const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
        let bytes: Buffer;
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.size !== size)
                throw new Error('workflow_material_digest_mismatch');
            bytes = await handle.readFile();
        }
        finally {
            await handle.close();
        }
        if (bytes.byteLength !== size || 'sha256:' + createHash('sha256').update(bytes).digest('hex') !== expectedDigest)
            throw new Error('workflow_material_digest_mismatch');
        if (offset > size)
            throw new Error('workflow_material_offset_invalid');
        return bytes.subarray(offset, Math.min(size, offset + limit));
    }
    return { root, sessionDir: join(root, 'runtime-session'), read, list, save, materialBytes };
}
