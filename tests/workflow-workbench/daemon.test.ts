import { expect, test } from 'bun:test';
import { fixture, client, workerCommand, security } from '../daemon/helpers';
import { seedWorkflowResources } from './fixtures/runtime';
import { serveDaemon } from '../../backend/packages/elysia/src/daemonServe';
test('original daemon child runs ctrl/data over typed HTTP, preserves parent policy and restores original receipts', async () => {
    const f = await fixture();
    await seedWorkflowResources(f.a);
    let deny = false;
    const open = () => serveDaemon({ globalRoot: f.globalRoot, workerCommand, runtimeConfig: { mcp: false }, listen: { port: 0 }, security: { ...security, authorization: { ...security.authorization, permits: (_p, target) => !(deny && target.kind === 'workflows') } } });
    let server = await open();
    try {
        const registration = await server.daemon.register(f.a), key = registration.workspaceKey;
        let request = client(server), generation = (await server.daemon.open(key)).serverInstanceId!;
        const path = (suffix: string) => `/workspaces/${key}/workflows${suffix}`;
        const get = async (suffix: string) => { const response = await request(path(suffix), {}, generation); if (response.status !== 200)
            throw new Error('workflow_http_' + response.status + ' ' + await response.text()); return response.json(); };
        const post = async (command: unknown) => request(path('/commands'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(command) }, generation);
        const definitions = (await get('/definitions')).definitions, receipts = [];
        for (const fqn of ['eidolon.fixture.SummaryWorkflow', 'eidolon.fixture.DataWorkflow']) {
            const definition = definitions.find((item: any) => item.fqn === fqn);
            const command = { kind: 'start', commandId: 'http-' + fqn, expectedServerInstanceId: generation, workflowRef: definition.workflowRef, definitionRevision: definition.revision, input: { value: 'original HTTP' }, source: { kind: 'independent', channelId: 'workflow-center', label: 'Workflow center' }, confirmed: true };
            const response = await post(command);
            expect(response.status).toBe(200);
            const receipt = await response.json();
            receipts.push(receipt);
            const deadline = Date.now() + 15000;
            let view = await get('/runs/' + receipt.runId);
            while (!view.run.terminal) {
                if (Date.now() > deadline)
                    throw new Error('workflow_http_terminal_timeout');
                await Bun.sleep(10);
                view = await get('/runs/' + receipt.runId);
            }
            expect(view.run.terminal).toBe(true);
            expect((await get('/runs/' + receipt.runId + '/events')).entries.length).toBeGreaterThan(0);
            expect((await (await post(command)).json()).replayed).toBe(true);
            expect((await post({ ...command, commandId: 'invalid', workDir: '/tmp' })).status).toBe(400);
        }
        expect((await get('/runs')).runs).toHaveLength(2);
        expect((await request(path('/definitions') + '?path=/tmp/private', {}, generation)).status).toBe(400);
        deny = true;
        expect((await request(path('/definitions'), {}, generation)).status).toBe(403);
        expect((await request(path('/runs/' + receipts[0].runId + '/events'), {}, generation)).status).toBe(403);
        deny = false;
        expect((await (await request(`/workspaces/${key}/sessions`, {}, generation)).json()).sessions).toEqual([]);
        await server.close();
        server = await open();
        request = client(server);
        generation = (await server.daemon.open(key)).serverInstanceId!;
        for (const receipt of receipts) {
            expect((await get('/commands/' + encodeURIComponent(receipt.commandId))).replayed).toBe(true);
            expect((await get('/runs/' + receipt.runId)).run.terminal).toBe(true);
        }
        const globalKey = server.daemon.capabilities().globalWorkspaceKey, globalGeneration = (await server.daemon.open(globalKey)).serverInstanceId!;
        expect((await request(`/workspaces/${globalKey}/workflows/definitions`, {}, globalGeneration)).status).toBe(409);
    }
    finally {
        await server.close();
        await f.cleanup();
    }
}, 60000);
