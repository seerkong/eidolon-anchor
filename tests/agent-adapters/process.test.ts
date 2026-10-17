import { test, expect } from 'bun:test';
import { createAgentProcessEffects, createAgentRpc } from '../../cell/packages/ai-runtime-host-support/src/agentProcess';
const effects = createAgentProcessEffects();
test('owned child parses complete UTF8 frames, drains private stderr and keeps actual cwd', async () => {
    const cwd = import.meta.dirname, child = await effects.spawn([process.execPath, '-e', "process.stderr.write('private diagnostic');process.stdout.write(JSON.stringify({cwd:process.cwd(),value:'完整𝌆'})+'\\n')"], cwd);
    try {
        const values = [];
        for await (const value of child.lines)
            values.push(value);
        expect(values).toEqual([{ cwd, value: '完整𝌆' }]);
    }
    finally {
        await child.close();
    }
});
for (const [name, code, message] of [
    ['truncated', "process.stdout.write('{\"value\":1}')", 'agent_process_truncated_frame'],
    ['malformed', "process.stdout.write('not JSON\\n')", 'JSON'],
    ['invalid UTF8', "process.stdout.write(Buffer.from([255,10]))", 'Invalid byte sequence'],
] as const)
    test('owned child rejects ' + name + ' rather than publishing partial completion', async () => {
        const child = await effects.spawn([process.execPath, '-e', code], import.meta.dirname);
        try {
            await expect((async () => { for await (const _ of child.lines) { } })()).rejects.toThrow(message);
        }
        finally {
            await child.close();
        }
    });
test('unmatched response rejects pending RPC; close terminates an owned blocked child', async () => {
    const child = await effects.spawn([process.execPath, '-e', "process.stdin.once('data',()=>process.stdout.write('{\"id\":999,\"result\":{}}\\n'));setInterval(()=>{},1000)"], import.meta.dirname);
    try {
        const rpc = createAgentRpc(child, async () => { }, async () => { throw Error('unapproved'); });
        await expect(rpc.request('original', {}, 1000)).rejects.toThrow('unmatched');
        await expect(rpc.pump).rejects.toThrow('unmatched');
    }
    finally {
        await child.close();
    }
}, 5000);
