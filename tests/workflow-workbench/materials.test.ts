import { expect, test } from 'bun:test';
import {unlink,symlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {openWorkflowWorkbenchStore} from '@cell/ai-runtime-host-support';
import {WorkflowFactStore} from '@cell/ai-organ-logic/workflow';
import { fixture, request, startCommand, waitForRun } from './fixtures/runtime';
test('material reads use only the original run receipt and frozen manifest bytes', async () => {
    const f = await fixture();
    try {
        const definition = (await f.host.workflowDefinitions!(request)).definitions.find(item => item.fqn === 'eidolon.fixture.MaterialWorkflow')!, receipt = await f.host.commandWorkflow!(request, startCommand(f, definition, 'material', { path: 'materials/result.txt', content: 'original material 世界' }));
        const view = await waitForRun(f, receipt.runId!);
        if (view.run.status === 'Failed')
            throw new Error(JSON.stringify({ view, events: await f.host.workflowEvents!(request, { runId: receipt.runId! }) }));
        expect(view.run.status).toBe('Completed');
        expect(view.materials).toHaveLength(1);
        const material = view.materials[0]!, file = material.files[0]!;
        expect(material.direction).toBe('output');
        expect(material.nodeId).toBe('write');
        const read = { runId: receipt.runId!, materialRef: material.materialRef, revision: material.revision, path: file.path };
        const chunk = await f.host.workflowMaterial!(request, read);
        expect(chunk.digest).toBe(file.digest);
        expect(Buffer.from(chunk.bytesBase64, 'base64').toString()).toBe('original material 世界');
        await expect(f.host.workflowMaterial!(request, { ...read, path: '../secret' })).rejects.toMatchObject({ status: 404 });
        await expect(f.host.workflowMaterial!(request, { ...read, materialRef: 'material://foreign' })).rejects.toMatchObject({ status: 404 });
        await expect(f.host.workflowMaterial!(request, { ...read, revision: 'sha256:foreign' })).rejects.toMatchObject({ status: 404 });
        await expect(f.host.workflowMaterial!(request, { ...read, limitBytes: 32769 })).rejects.toMatchObject({ status: 400 });
        const store=await openWorkflowWorkbenchStore(join(f.workDir,'.eidolon','web-host'),request.principal.principalId),facts=new WorkflowFactStore(join(store.sessionDir,'workflow-runtime'))
        const physical=join(facts.materialContentRoot(material.revision),file.path)
        await writeFile(physical,'corrupted original material')
        await expect(f.host.workflowMaterial!(request,read)).rejects.toThrow('workflow_material_digest_mismatch')
        const outside=join(f.root,'outside.txt');await writeFile(outside,'outside fixture')
        await unlink(physical);await symlink(outside,physical)
        await expect(f.host.workflowMaterial!(request,read)).rejects.toThrow('workflow_material_symlink')
        expect(f.calls).toBe(0);
    }
    finally {
        await f.close();
    }
}, 30000);
