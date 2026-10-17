import { cp, mkdir, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost } from '../../../cell/packages/ai-runtime-host-capsule/src/host';
import { __setLlmAdapterFactoryForTest } from '../../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly';
import { installBundledSystemSkills } from '@cell/ai-support/system-skill/SystemSkillInstaller';
import { depaAIResourceKindContract } from '@cell/ai-workflow-contract';
import type { HostAuthorizationEffects, WorkflowCommand, WorkflowDefinition, WorkflowRunView } from '@cell/ai-runtime-host-contract';
export const request = { principal: { principalId: 'owner', grantsVersion: '1' }, requestId: 'workflow-owner-fixture' };
export async function seedWorkflowResources(workDir: string) {
    const target = join(workDir, '.eidolon', 'resources');
    await cp(join(import.meta.dir, '../../../cell/packages/ai-organ-logic/tests/workflow/fixtures/resource-native-authoring-package'), target, { recursive: true });
    const manifest = join(target, 'manifest.xnl');
    const { readFile } = await import('node:fs/promises');
    await writeFile(manifest, (await readFile(manifest, 'utf8')).replace('<Catalog #agents', '<Catalog #data { kind = "AIDataWorkflow" shape = "single-file" root = "vfs://./Data/" }>\n    <Catalog #agents'));
    await mkdir(join(target, 'KindDefinitions', 'AIDataWorkflow'), { recursive: true });
    await writeFile(join(target, 'KindDefinitions', 'AIDataWorkflow', 'manifest.xnl'), depaAIResourceKindContract('AIDataWorkflow').kindDefinitionSource);
    await mkdir(join(target, 'Data', 'flow-code'), { recursive: true });
    const code = `export function identity(_runtime: unknown, input: any) { return input }\nexport function transform(_runtime: unknown, inputs: any, _config: unknown) { return { value: inputs.value } }\nexport function writeMaterial(runtime: any, input: any, config: any) { return runtime.ai.effects.writeMaterial(input, config) }\n`;
    await writeFile(join(target, 'Workflows', 'flow-code', 'index.ts'), code);
    await writeFile(join(target, 'Data', 'flow-code', 'index.ts'), code);
    await writeFile(join(target, 'Workflows', 'Summary.xnl'), `<AICtrlWorkflow #eidolon.fixture.SummaryWorkflow envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 (<FlowContract #eidolon.fixture.SummaryWorkflow>) [
  <Run #prepare { src = "vfs://./flow-code/index.ts#identity" }>
  <Return #done { src = "vfs://./flow-code/index.ts#identity" }>
]>`);
    await writeFile(join(target, 'Workflows', 'Wait.xnl'), `<AICtrlWorkflow #eidolon.fixture.WaitWorkflow envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 (<FlowContract #eidolon.fixture.WaitWorkflow>) [
  <ExternalJob #review { signalKind = "fixture.done" signalKey = "review" }>
  <Return #done { src = "vfs://./flow-code/index.ts#identity" }>
]>`);
    await writeFile(join(target, 'Workflows', 'Material.xnl'), `<AICtrlWorkflow #eidolon.fixture.MaterialWorkflow envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 (<FlowContract #eidolon.fixture.MaterialWorkflow>) [
  <Run #write { src = "vfs://./flow-code/index.ts#writeMaterial" config = { nodeId = "write" } }>
  <Return #done { src = "vfs://./flow-code/index.ts#identity" }>
]>`);
    await writeFile(join(target, 'Data', 'Identity.xnl'), `<AIDataWorkflow #eidolon.fixture.DataWorkflow envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 (
  <FlowContract #eidolon.fixture.DataWorkflow { inputPorts = ["value"] outputPorts = ["value"] }>
) [
  <EntryNode #entry>
  <TransformNode #transform { inputs = { value = "flow-port://#entry/value" } outputs = ["value"] src = "vfs://./flow-code/index.ts#transform" }>
  <ReturnNode #return { inputs = { value = "flow-port://#transform/value" } }>
]>`);
    await writeFile(join(target, 'Data', 'Manual.xnl'), `<AIDataWorkflow #eidolon.fixture.ManualDataWorkflow envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 (
  <FlowContract #eidolon.fixture.ManualDataWorkflow { inputPorts = ["value"] outputPorts = ["value"] }>
) [
  <EntryNode #entry>
  <TransformNode #transform { inputs = { value = "flow-port://#entry/value" } outputs = ["value"] src = "vfs://./flow-code/index.ts#transform" config = { node_type = "manual" } }>
  <ReturnNode #return { inputs = { value = "flow-port://#transform/value" } }>
]>`);
}
export async function fixture(policy: HostAuthorizationEffects = { permits: () => true, currentGrantsVersion: () => '1' }) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'anchor-workflow-workbench-'))), workDir = join(root, 'workspace'), globalRoot = join(root, 'global');
    await mkdir(workDir, { recursive: true });
    await installBundledSystemSkills({ globalRoot });
    await seedWorkflowResources(workDir);
    let calls = 0;
    __setLlmAdapterFactoryForTest(async () => ({ type: 'openai', async createStream() { calls++; throw new Error('unexpected_workflow_model_call'); } }));
    const options = { workDir, globalRoot, authorization: policy, runtimeConfig: { adapter: 'openai', model: 'mock', mcp: false } };
    let host = await createHost(options);
    return { root, workDir, get host() { return host; }, get calls() { return calls; }, async restart() { await host.close(); host = await createHost(options); }, async close() { await host.close(); __setLlmAdapterFactoryForTest(null); await rm(root, { recursive: true, force: true }); } };
}
export function startCommand(f: Awaited<ReturnType<typeof fixture>>, definition: WorkflowDefinition, commandId = 'start', input: WorkflowCommand extends {
    input: infer T;
} ? T : any = { value: 'native original' }): WorkflowCommand {
    return { kind: 'start', commandId, expectedServerInstanceId: f.host.capabilities(request).serverInstanceId, workflowRef: definition.workflowRef, definitionRevision: definition.revision, input, source: { kind: 'independent', channelId: 'workflow-center', label: 'Workflow center' }, confirmed: true };
}
export async function waitForRun(f: Awaited<ReturnType<typeof fixture>>, runId: string, predicate: (view: WorkflowRunView) => boolean = view => view.executionState !== 'active' && (view.run.terminal || (view.run.status === 'Waiting' && (view.waits.length > 0 || view.dataResumes.some(contract => contract.canResume))))) {
    const deadline = Date.now() + 15000;
    while (true) {
        const view = await f.host.workflowRun!(request, { runId });
        if (predicate(view))
            return view;
        if (Date.now() > deadline)
            throw new Error('workflow_fixture_run_timeout ' + JSON.stringify(view.run));
        await Bun.sleep(10);
    }
}
