import { expect, test } from 'bun:test';
import { parseWorkflowCommand, parseWorkflowValue, parseWorkflowRunView, parseWorkflowMaterialChunk } from '@cell/ai-runtime-host-contract';
import { workflowPublicValue } from '@cell/ai-runtime-host-logic';
test('closed workflow wire algebra bounds inputs and preserves ordinary business field names', () => {
    const command = { kind: 'start', commandId: 'c', expectedServerInstanceId: 'server', workflowRef: 'resource://fixture.Ctrl', definitionRevision: 'sha256:freeze', input: { dir: 'authored business', baseUri: 'business value' }, source: { kind: 'independent', channelId: 'workflow-center', label: 'Workflows' }, confirmed: true };
    expect(parseWorkflowCommand(command)).toEqual(command as any);
    expect(workflowPublicValue(command.input)).toEqual(command.input);
    for (const input of [{ ...command, unknown: true }, { ...command, confirmed: false }, { ...command, workflowRef: 'vfs://../outside' }, { ...command, input: { payload: 'x'.repeat(65536) } }])
        expect(() => parseWorkflowCommand(input)).toThrow();
    expect(() => parseWorkflowValue({ bad: Infinity })).toThrow();
    const cycle: any = {};
    cycle.nested = cycle;
    expect(() => parseWorkflowValue(cycle)).toThrow();
    expect(() => parseWorkflowRunView({ cwd: '/tmp', nodes: [] })).toThrow();
    expect(() => parseWorkflowMaterialChunk({ runId: 'run', materialRef: 'material://a', revision: 'sha256:b', path: 'a.txt', digest: 'sha256:c', sizeBytes: 1, offsetBytes: 0, bytesBase64: '!' })).toThrow();
});
