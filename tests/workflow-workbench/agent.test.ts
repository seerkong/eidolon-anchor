import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, request, startCommand, waitForRun } from './fixtures/runtime';
import { __setLlmAdapterFactoryForTest } from '../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly';
import { createMockProviderCacheCostObservation } from '../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream';
async function seedAgent(f: Awaited<ReturnType<typeof fixture>>) {
    const resources = join(f.workDir, '.eidolon', 'resources'), agent = join(resources, 'Agents', 'Summary.xnl');
    await writeFile(agent, (await readFile(agent, 'utf8')).replace(/  <MaterialPortRefs \[[\s\S]*?\n  \]>/, '  <MaterialPortRefs []>'));
    await writeFile(join(resources, 'Workflows', 'Agent.xnl'), `<AICtrlWorkflow #eidolon.fixture.AgentWorkflow envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 (<FlowContract #eidolon.fixture.AgentWorkflow>) [
  <Run #agent { src = "vfs://./flow-code/agent.ts#invokeAgent" config = { agentDefinitionRef = "resource://eidolon.fixture.SummaryAgent" } }>
  <Return #done { src = "vfs://./flow-code/index.ts#identity" }>
]>`);
}
test('ordinary resource Agent uses the original workflow lifecycle without forcing a TaskSpace or navigable Session', async () => {
    const f = await fixture();
    let calls = 0;
    __setLlmAdapterFactoryForTest(async () => ({ type: 'openai', runtime: { adapterName: 'openai', providerId: 'fixture' }, async createStream(options: any) {
            if (++calls > 2)
                throw new Error('controlled_workflow_agent_budget');
            return { stream: (async function* () { yield { choices: [{ delta: { content: '{"value":"original workflow Agent"}' } }] }; yield { choices: [{ delta: {}, finish_reason: 'stop' }] }; })(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) };
        } }));
    try {
        await seedAgent(f);
        const definition = (await f.host.workflowDefinitions!(request)).definitions.find(item => item.fqn === 'eidolon.fixture.AgentWorkflow')!, receipt = await f.host.commandWorkflow!(request, startCommand(f, definition, 'ordinary-agent', { request: 'a small original Agent node' }));
        const view = await waitForRun(f, receipt.runId!);
        if (view.run.status !== 'Completed')
            throw new Error(JSON.stringify(view.result));
        expect(calls).toBe(1);
        expect(view.run.terminal).toBe(true);
        expect(view.executionSources).toHaveLength(1);
        expect(view.executionSources[0]).toMatchObject({ nodeId: 'agent', generation: 0, agentDefinitionRef: 'resource://eidolon.fixture.SummaryAgent' });
        const originalSource = view.executionSources[0]!;
        expect((await f.host.sessions(request, {})).sessions).toEqual([]);
        await f.restart();
        expect((await f.host.workflowRun!(request, { runId: receipt.runId! })).run.terminal).toBe(true);
        expect((await f.host.workflowRun!(request, { runId: receipt.runId! })).executionSources[0]).toMatchObject({ sourceRef: originalSource.sourceRef, actorId: originalSource.actorId, actorKey: originalSource.actorKey, nodeId: 'agent', generation: 0 });
        expect(calls).toBe(1);
    }
    finally {
        await f.close();
    }
}, 30000);
async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('read_waited_for_workflow_model')), 5000); })]);
    }
    finally {
        clearTimeout(timer);
    }
}
test('first canonical admission returns while an original Agent is live and queries never wait for its model', async () => {
    const f = await fixture();
    let release!: () => void, entered!: () => void, calls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; }), inside = new Promise<void>(resolve => { entered = resolve; });
    __setLlmAdapterFactoryForTest(async () => ({ type: 'openai', runtime: { adapterName: 'openai', providerId: 'fixture' }, async createStream(options: any) {
            if (++calls > 1)
                throw new Error('controlled_workflow_agent_budget');
            entered();
            return { stream: (async function* () { await gate; yield { choices: [{ delta: { content: '{"value":"released original Agent"}' } }] }; yield { choices: [{ delta: {}, finish_reason: 'stop' }] }; })(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) };
        } }));
    try {
        await seedAgent(f);
        const definition = (await f.host.workflowDefinitions!(request)).definitions.find(item => item.fqn === 'eidolon.fixture.AgentWorkflow')!, command = startCommand(f, definition, 'gated-agent', { request: 'controlled live original execution' });
        const receipt = await bounded(f.host.commandWorkflow!(request, command));
        await bounded(inside);
        expect(receipt.state).toBe('completed');
        const live = await bounded(f.host.workflowRun!(request, { runId: receipt.runId! }));
        expect(live.run.terminal).toBe(false);
        expect(live.executionState).toBe('active');
        expect(live.executionSources).toHaveLength(1);
        expect(live.executionSources[0]).toMatchObject({ nodeId: 'agent', generation: 0 });
        expect(await f.host.isBusy!()).toBe(true);
        expect((await bounded(f.host.workflowRuns!(request, {}))).runs).toHaveLength(1);
        expect((await bounded(f.host.workflowEvents!(request, { runId: receipt.runId! }))).entries.length).toBeGreaterThan(0);
        expect(await bounded(f.host.workflowCommandResult!(request, { commandId: command.commandId }))).toMatchObject({ state: 'completed', runId: receipt.runId, replayed: true });
        expect(await bounded(f.host.commandWorkflow!(request, command))).toMatchObject({ state: 'completed', replayed: true });
        expect((await bounded(f.host.sessions(request, {}))).sessions).toEqual([]);
        expect(calls).toBe(1);
        release();
        expect((await waitForRun(f, receipt.runId!)).run.status).toBe('Completed');
        expect(calls).toBe(1);
    }
    finally {
        release();
        await f.close();
    }
}, 30000);
async function seedQuestionAgent(f: Awaited<ReturnType<typeof fixture>>) {
    await seedAgent(f);
    const resources = join(f.workDir, '.eidolon', 'resources'), manifest = join(resources, 'manifest.xnl'), agent = join(resources, 'Agents', 'Summary.xnl');
    await writeFile(manifest, (await readFile(manifest, 'utf8')).replace('<Catalog #agents', '<Catalog #tools {kind="Tool" shape="single-file" root="vfs://./Tools/"}>\n    <Catalog #agents'));
    const { depaAIResourceKindContract } = await import('@cell/ai-workflow-contract');
    await mkdir(join(resources, 'KindDefinitions', 'Tool'), { recursive: true });
    await mkdir(join(resources, 'Tools'), { recursive: true });
    await writeFile(join(resources, 'KindDefinitions', 'Tool', 'manifest.xnl'), depaAIResourceKindContract('Tool').kindDefinitionSource);
    await writeFile(join(resources, 'Tools', 'Questionnaire.xnl'), '<Tool #Questionnaire envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {lifecycle="Active"}>');
    await writeFile(agent, (await readFile(agent, 'utf8')).replace('<ToolRefs []>', '<ToolRefs [<ToolRef #question {kind="Tool" ref="resource://Questionnaire"}>]>'));
}
test('original Questionnaire is exposed under its exact workflow Actor and only an explicit scoped answer continues it', async () => {
    const f = await fixture();
    let calls = 0, runId: string | undefined;
    __setLlmAdapterFactoryForTest(async () => ({ type: 'openai', runtime: { adapterName: 'openai', providerId: 'fixture' }, async createStream(options: any) {
            const call = ++calls;
            if (call > 2)
                throw new Error('controlled_workflow_question_budget');
            return { stream: (async function* () {
                    if (call === 1) {
                        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'original-question-tool', type: 'function', function: { name: 'Questionnaire', arguments: JSON.stringify({ questionnaireId: 'original-workflow-question', kind: 'clarification', suspendPolicy: 'continue_others', title: 'Original node input', questions: [{ id: 'value', prompt: 'Provide the result', type: 'text', required: true }] }) } }] } }] };
                        yield { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
                    }
                    else {
                        yield { choices: [{ delta: { content: '{"value":"explicit original answer"}' } }] };
                        yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
                    }
                })(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) };
        } }));
    try {
        await seedQuestionAgent(f);
        const definition = (await f.host.workflowDefinitions!(request)).definitions.find(item => item.fqn === 'eidolon.fixture.AgentWorkflow')!, receipt = await f.host.commandWorkflow!(request, startCommand(f, definition, 'question-agent', { request: 'original human input' }));
        runId = receipt.runId!;
        const waiting = await waitForRun(f, runId, view => view.run.terminal || view.executionSources.some(source => source.questions.some(q => q.canAnswer)));
        const original = waiting.executionSources.find(source => source.questions.some(q => q.canAnswer));
        if (!original)
            throw new Error('original_question_not_exposed ' + JSON.stringify(waiting));
        expect(calls).toBe(1);
        expect(original).toMatchObject({ nodeId: 'agent', generation: 0, status: 'waiting_for_human' });
        expect(original.questions[0]).toMatchObject({ questionnaireId: 'original-workflow-question', kind: 'domain_question', canAnswer: true, state: 'pending' });
        const command = { kind: 'answer_question' as const, commandId: 'explicit-answer', expectedServerInstanceId: f.host.capabilities(request).serverInstanceId, runId, expectedGeneration: waiting.run.generation, sourceRef: original.sourceRef, nodeId: original.nodeId, actorId: original.actorId, questionnaireId: original.questions[0]!.questionnaireId, responseText: 'Q1: A confirmed', confirmed: true as const };
        await expect(f.host.commandWorkflow!(request, { ...command, actorId: 'another-actor' })).rejects.toMatchObject({ status: 409 });
        await expect(f.host.commandWorkflow!(request, { ...command, expectedGeneration: 1 })).rejects.toMatchObject({ status: 409 });
        expect(await f.host.commandWorkflow!(request, command)).toMatchObject({ state: 'completed' });
        expect((await waitForRun(f, runId)).run.status).toBe('Completed');
        expect(calls).toBe(2);
        expect(await f.host.commandWorkflow!(request, command)).toMatchObject({ state: 'completed', replayed: true });
        await f.restart();
        const restored = await f.host.workflowRun!(request, { runId });
        expect(restored.executionSources[0]).toMatchObject({ sourceRef: original.sourceRef, actorId: original.actorId });
        expect(restored.executionSources[0]?.questions[0]).toMatchObject({ state: 'answered', canAnswer: false });
        expect((await f.host.sessions(request, {})).sessions).toEqual([]);
        expect(calls).toBe(2);
    }
    catch (error) {
        if (runId)
            console.error('original questionnaire failure', { calls, run: await f.host.workflowRun!(request, { runId }) });
        throw error;
    }
    finally {
        // Host shutdown must cancel the original suspended addressed owner on failures.
        await f.close();
    }
}, 30000);
