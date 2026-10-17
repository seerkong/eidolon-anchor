import { expect, test } from 'bun:test';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, request, startCommand, waitForRun } from './fixtures/runtime';
import { openWorkflowWorkbenchStore } from '@cell/ai-runtime-host-support';
test('lost receipt recovery observes original facts after Host restart and retains the frozen definition', async () => {
    const f = await fixture();
    try {
        const definition = (await f.host.workflowDefinitions!(request)).definitions.find(item => item.fqn === 'eidolon.fixture.SummaryWorkflow')!, command = startCommand(f, definition);
        const receipt = await f.host.commandWorkflow!(request, command), before = await waitForRun(f, receipt.runId!), events = await f.host.workflowEvents!(request, { runId: receipt.runId! });
        const store = await openWorkflowWorkbenchStore(join(f.workDir, '.eidolon', 'web-host'), request.principal.principalId), record = (await store.read(command.commandId))!;
        const { result: _receipt, ...pending } = record;
        await store.save(pending);
        const file = join(f.workDir, '.eidolon', 'resources', 'Workflows', 'Summary.xnl'), source = await readFile(file, 'utf8');
        await writeFile(file, source.replace('<Run #prepare', '<Run #changed'));
        await f.restart();
        expect(await f.host.workflowCommandResult!(request, { commandId: command.commandId })).toEqual({ ...receipt, replayed: true });
        expect(await f.host.workflowRun!(request, { runId: receipt.runId! })).toEqual(before);
        expect((await f.host.workflowDefinitions!(request)).definitions.find(item => item.fqn === definition.fqn)?.revision).not.toBe(definition.revision);
        expect(await f.host.commandWorkflow!(request, command)).toEqual({ ...receipt, replayed: true });
        expect((await f.host.workflowEvents!(request, { runId: receipt.runId! })).entries).toEqual(events.entries);
        await expect(f.host.workflowEvents!(request, { runId: receipt.runId!, after: events.cursor })).rejects.toMatchObject({ status: 409 });
        expect(f.calls).toBe(0);
    }
    finally {
        await f.close();
    }
}, 30000);
test('pending intent without original run facts stays unknown and is never automatically dispatched', async () => {
    const f = await fixture();
    try {
        const definition = (await f.host.workflowDefinitions!(request)).definitions[0]!, command = startCommand(f, definition, 'interrupted-before-owner');
        const { workflowDigest } = await import('@cell/ai-runtime-host-support');
        const store = await openWorkflowWorkbenchStore(join(f.workDir, '.eidolon', 'web-host'), request.principal.principalId);
        await store.save({ commandId: command.commandId, fingerprint: workflowDigest(command), command, runId: 'workflow-not-admitted', instanceId: 'instance-not-admitted', source: command.kind === 'start' ? command.source : { kind: 'independent', channelId: 'workflow-center', label: 'Center' }, createdAt: Date.now() });
        expect(await f.host.commandWorkflow!(request, command)).toMatchObject({ state: 'unknown', replayed: true });
        await f.restart();
        expect(await f.host.workflowCommandResult!(request, { commandId: command.commandId })).toMatchObject({ state: 'unknown', replayed: true });
        expect((await f.host.workflowRuns!(request, {})).runs).toEqual([]);
        expect(f.calls).toBe(0);
    }
    finally {
        await f.close();
    }
}, 30000);
test('ctrl wait resumes only with the original generation and complete native signal identity', async () => {
    const f = await fixture();
    try {
        const definition = (await f.host.workflowDefinitions!(request)).definitions.find(item => item.fqn === 'eidolon.fixture.WaitWorkflow')!, receipt = await f.host.commandWorkflow!(request, startCommand(f, definition));
        const view = await waitForRun(f, receipt.runId!), wait = view.waits[0]!;
        expect(view.run.status).toBe('Waiting');
        expect(wait.resumeToken).toBeDefined();
        expect(wait.nodeId).toBe('review');
        const command = { kind: 'resume_ctrl' as const, commandId: 'resume', runId: receipt.runId!, expectedServerInstanceId: f.host.capabilities(request).serverInstanceId, expectedGeneration: view.run.generation, signalKind: wait.signalKind, signalKey: wait.signalKey, resumeToken: wait.resumeToken, outcome: 'Success' as const, payload: { result: 'explicit native resume' }, confirmed: true as const };
        await expect(f.host.commandWorkflow!(request, { ...command, expectedGeneration: 1 })).rejects.toMatchObject({ status: 409 });
        await expect(f.host.commandWorkflow!(request, { ...command, resumeToken: 'foreign' })).rejects.toMatchObject({ status: 409 });
        expect(await f.host.commandWorkflow!(request, command)).toMatchObject({ state: 'completed' });
        expect((await waitForRun(f, receipt.runId!, view => view.run.terminal)).run.status).toBe('Completed');
        expect(await f.host.commandWorkflow!(request, command)).toMatchObject({ state: 'completed', replayed: true });
        const events = await f.host.workflowEvents!(request, { runId: receipt.runId! });
        expect(events.entries.some(event => event.nodeId === 'review' && event.kind === 'workflow.node.observed')).toBe(true);
        expect(f.calls).toBe(0);
    }
    finally {
        await f.close();
    }
}, 30000);
test('data manual output uses the original declared ports, rejects malformed output and resumes once after restart', async () => {
    const f = await fixture();
    try {
        const definition = (await f.host.workflowDefinitions!(request)).definitions.find(item => item.fqn === 'eidolon.fixture.ManualDataWorkflow')!, receipt = await f.host.commandWorkflow!(request, startCommand(f, definition));
        let view = await waitForRun(f, receipt.runId!);
        expect(view.run.status).toBe('Waiting');
        expect(view.dataResumes).toContainEqual({ nodeId: 'transform', outputs: ['value'], canResume: true });
        await f.restart();
        view = await f.host.workflowRun!(request, { runId: receipt.runId! });
        const command = { kind: 'resume_data' as const, commandId: 'manual-output', runId: receipt.runId!, expectedServerInstanceId: f.host.capabilities(request).serverInstanceId, expectedGeneration: view.run.generation, nodeId: 'transform', output: { value: 'explicit result' }, confirmed: true as const };
        await expect(f.host.commandWorkflow!(request, { ...command, output: { unexpected: true } })).rejects.toMatchObject({ status: 400, error: { code: 'workflow_output_schema_invalid' } });
        expect((await f.host.workflowRun!(request, { runId: receipt.runId! })).run.status).toBe('Waiting');
        expect(await f.host.commandWorkflow!(request, command)).toMatchObject({ state: 'completed' });
        expect((await waitForRun(f, receipt.runId!, view => view.run.terminal)).run.status).toBe('Succeeded');
        expect(await f.host.commandWorkflow!(request, command)).toMatchObject({ state: 'completed', replayed: true });
        expect(f.calls).toBe(0);
    }
    finally {
        await f.close();
    }
}, 30000);

async function factBytes(root:string):Promise<Record<string,string>> {
    const {createHash}=await import('node:crypto'),files:Record<string,string>={}
    async function visit(directory:string){for(const item of await readdir(directory,{withFileTypes:true})){const path=join(directory,item.name);if(item.isDirectory())await visit(path);else if(item.isFile())files[path.slice(root.length)]=createHash('sha256').update(await readFile(path)).digest('hex')}}
    await visit(root);return files
}

test('restarted reads retain committed manual facts without restoring or preparing the original data driver',async()=>{
    const f=await fixture()
    try {
        const definition=(await f.host.workflowDefinitions!(request)).definitions.find(item=>item.fqn==='eidolon.fixture.ManualDataWorkflow')!,receipt=await f.host.commandWorkflow!(request,startCommand(f,definition,'read-only-facts'))
        await waitForRun(f,receipt.runId!);await f.restart()
        const store=await openWorkflowWorkbenchStore(join(f.workDir,'.eidolon','web-host'),request.principal.principalId),root=join(store.sessionDir,'workflow-runtime'),before=await factBytes(root)
        for(let count=0;count<3;count++) {
            expect((await f.host.workflowRun!(request,{runId:receipt.runId!})).run.status).toBe('Waiting')
            await f.host.workflowRuns!(request,{})
            await f.host.workflowEvents!(request,{runId:receipt.runId!})
            await f.host.workflowCommandResult!(request,{commandId:'read-only-facts'})
        }
        expect(await factBytes(root)).toEqual(before)
        expect(f.calls).toBe(0)
    }finally{await f.close()}
},30000)
