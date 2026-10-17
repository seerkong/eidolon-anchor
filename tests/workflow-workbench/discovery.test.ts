import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, request } from './fixtures/runtime';
test('workspace discovery freezes original ctrl/data sources without executing models or registering Sessions', async () => {
    const f = await fixture();
    try {
        const directory = await f.host.workflowDefinitions!(request);
        expect(f.host.capabilities(request).features.workflowWorkbench).toBe(true);
        expect(directory.workspaceId).toBe(f.workDir);
        expect(directory.definitions.map(definition => definition.form)).toContain('AIDataWorkflow');
        expect(directory.definitions.map(definition => definition.form)).toContain('AICtrlWorkflow');
        expect(directory.definitions.find(definition => definition.fqn === 'eidolon.fixture.DataWorkflow')?.definition).toHaveProperty('nodes');
        expect(directory.definitions.every(definition => definition.revision.startsWith('sha256:'))).toBe(true);
        expect(f.calls).toBe(0);
        expect(existsSync(join(f.workDir, '.eidolon', 'sessions'))).toBe(false);
        expect((await f.host.sessions(request, {})).sessions).toEqual([]);
        expect(JSON.stringify(directory.definitions)).not.toContain(f.root);
        expect(directory.unsupported).toContain('human_node_protocol');
    }
    finally {
        await f.close();
    }
}, 30000);
