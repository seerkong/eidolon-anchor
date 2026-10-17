import { test, expect } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, workerCommand, security, principal } from './helpers';
import { serveDaemon } from '../../backend/packages/elysia/src/daemonServe';
import { prepareSkillDrivenOrganizationWorkspace } from '../../cell/packages/ai-organ-logic/tests/workflow/prepareSkillDrivenOrganizationWorkspace';
import type { DaemonScheduleView, HostParticipantDirectory } from '@cell/ai-runtime-host-contract';
test('real daemon HTTP owner persists plans, dispatches original member task, and restart never replays', async () => {
    const f = await fixture();
    let native: Awaited<ReturnType<typeof serveDaemon>> | undefined, time = 1000, calls = 0;
    const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) { await request.json(); if (++calls > 1)
            return new Response('budget exceeded', { status: 429 }); const event = (delta: unknown, finish_reason: string | null = null) => 'data: ' + JSON.stringify({ id: 'schedule-fixture', object: 'chat.completion.chunk', created: 1, model: 'a', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n'; return new Response(event({ role: 'assistant', content: JSON.stringify({ value: 'Original schedule complete result' }) }) + event({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }); } });
    const start = () => serveDaemon({ globalRoot: f.globalRoot, workerCommand, security, listen: { port: 0 }, runtimeConfig: { mcp: false }, scheduleNow: () => time });
    try {
        const dir = join(f.globalRoot, 'daemon');
        await mkdir(dir, { recursive: true });
        await prepareSkillDrivenOrganizationWorkspace(dir, { tools: ['Questionnaire'] });
        await writeFile(join(f.globalRoot, 'llm-provider.json'), JSON.stringify({ providers: [{ id: 'fixture', adapter: 'openai', options: { apiKey: 'controlled-test-only', baseURL: `http://127.0.0.1:${provider.port}/v1` }, models: [{ id: 'a', limits: { context: 32000, output: 4096 } }] }] }));
        native = await start();
        const get = (route: string, method = 'GET', body?: unknown, instance = native!.daemon.capabilities().daemonInstanceId) => fetch(native!.address + '/v1/daemon/schedules' + route, { method, headers: { Authorization: 'Bearer ' + 'D'.repeat(43), 'X-Eidolon-Daemon-Instance': instance, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        expect((await get('', 'GET', undefined, 'stale')).status).toBe(409);
        const cap = native.daemon.capabilities();
        await native.daemon.open(cap.globalWorkspaceKey);
        const directory = await native.daemon.scope(cap.globalWorkspaceKey).port.participantDirectory!({ principal, requestId: 'catalog' }) as HostParticipantDirectory;
        const member = directory.contacts.find(c => c.available && c.recipient.kind === 'member')!;
        expect(member).toBeDefined();
        let response = await get('/commands', 'POST', { kind: 'create', scheduleId: 'periodic', commandId: 'create', expectedRevision: 0, name: '本机原成员', everyMinutes: 1, action: { recipient: member.recipient, text: 'Return a short complete result' } });
        expect(response.status).toBe(200);
        response = await get('/commands', 'POST', { kind: 'enable', scheduleId: 'periodic', commandId: 'enable', expectedRevision: 1 });
        expect(response.status).toBe(200);
        expect(calls).toBe(0);
        time = 61000;
        await native.daemon.schedules!.tick();
        const until = Date.now() + 30000;
        let view: DaemonScheduleView;
        while (true) {
            await native.daemon.schedules!.tick();
            view = await (await get('/periodic')).json() as DaemonScheduleView;
            if (view.attempts.some(a => a.state === 'completed'))
                break;
            if (Date.now() > until)
                throw Error('schedule_result_timeout:' + JSON.stringify(view));
            await Bun.sleep(150);
        }
        expect(calls).toBe(1);
        expect(view.attempts[0]?.task?.taskSpaceId).toBeTruthy();
        expect(view.attempts[0]?.result?.execution?.actorId).toBeTruthy();
        expect(view.attempts[0]?.result?.text).toContain('Original schedule complete result');
        const originalTask = view.attempts[0]?.task;
        await native.close();
        time = 361000;
        native = await start();
        view = await (await get('/periodic')).json() as DaemonScheduleView;
        expect(view.attempts.find(a => a.state === 'missed')?.missedCount).toBe(5);
        expect(view.attempts[0]?.task).toEqual(originalTask);
        await native.daemon.schedules!.tick();
        expect(calls).toBe(1);
        expect((await get('/commands/create')).status).toBe(200);
        response = await get('/commands', 'POST', { kind: 'disable', scheduleId: 'periodic', commandId: 'disable', expectedRevision: 2 });
        expect(response.status).toBe(200);
        time = 1000000;
        await native.daemon.schedules!.tick();
        expect(calls).toBe(1);
    }
    finally {
        await native?.close();
        provider.stop(true);
        await f.cleanup();
    }
}, 60000);
