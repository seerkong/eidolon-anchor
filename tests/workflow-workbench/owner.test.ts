import { expect, test } from 'bun:test';
import { fixture, request, startCommand, waitForRun } from './fixtures/runtime';
test('public native owner executes both original flow forms and replays only the canonical command result', async () => {
    const f = await fixture();
    try {
        const directory = await f.host.workflowDefinitions!(request);
        for (const [form, fqn] of [['AICtrlWorkflow', 'eidolon.fixture.SummaryWorkflow'], ['AIDataWorkflow', 'eidolon.fixture.DataWorkflow']] as const) {
            const definition = directory.definitions.find(item => item.fqn === fqn)!, command = startCommand(f, definition, form);
            const receipt = await f.host.commandWorkflow!(request, command);
            expect(receipt.state).toBe('completed');
            const view = await waitForRun(f, receipt.runId!);
            expect(view.run).toMatchObject({ form, status: form === 'AIDataWorkflow' ? 'Succeeded' : 'Completed', terminal: true, definitionRevision: definition.revision, generation: 0 });
            expect(view.nodes.length).toBeGreaterThan(1);
            expect(view.definition).toEqual(definition);
            expect(view.input).toEqual({ value: 'native original' });
            expect(await f.host.commandWorkflow!(request, command)).toEqual({ ...receipt, replayed: true });
            await expect(f.host.commandWorkflow!(request, { ...command, source: { kind: 'independent', channelId: 'changed', label: 'Changed' } } as any)).rejects.toMatchObject({ status: 409 });
            const events = await f.host.workflowEvents!(request, { runId: receipt.runId!, limit: 1 });
            expect(events.entries.length).toBe(1);
            expect(events.entries[0]!.eventId.length).toBeGreaterThan(0);
            if (events.nextCursor)
                expect((await f.host.workflowEvents!(request, { runId: receipt.runId!, after: events.nextCursor })).entries[0]?.seq).toBe(1);
        }
        expect(f.calls).toBe(0);
        expect((await f.host.workflowRuns!(request, {})).runs).toHaveLength(2);
    }
    finally {
        await f.close();
    }
}, 30000);
test('revision, generation, principal and authorization boundaries reject before native effects', async () => {
    let allowed = true;
    const f = await fixture({ permits: () => allowed, currentGrantsVersion: () => '1' });
    try {
        const definition = (await f.host.workflowDefinitions!(request)).definitions[0]!;
        const wrong = { ...startCommand(f, definition), definitionRevision: 'sha256:stale' };
        expect(await f.host.commandWorkflow!(request, wrong)).toMatchObject({ state: 'rejected', errorCode: 'workflow_definition_revision_conflict' });
        expect((await f.host.workflowRuns!(request, {})).runs).toEqual([]);
        await expect(f.host.commandWorkflow!(request, { ...startCommand(f, definition, 'other'), cwd: '/tmp' } as any)).rejects.toMatchObject({ status: 400 });
        await expect(f.host.workflowRun!({ ...request, principal: { principalId: 'other', grantsVersion: '1' } }, { runId: 'foreign' })).rejects.toMatchObject({ status: 404 });
        allowed = false;
        await expect(f.host.workflowDefinitions!(request)).rejects.toMatchObject({ status: 403 });
        expect(f.calls).toBe(0);
    }
    finally {
        await f.close();
    }
}, 30000);
