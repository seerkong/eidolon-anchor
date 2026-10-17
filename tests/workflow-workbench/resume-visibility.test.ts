import {expect, test} from 'bun:test';
import {authorizeDaemonPort} from '../../backend/packages/elysia/src/daemonAuthorization';

test('parent read permission exposes original waits while withholding every workflow resume capability', async () => {
  const request = {principal: {principalId: 'reader', grantsVersion: '1'}, requestId: 'read'};
  const original = {waits: [{nodeId: 'node', signalKind: 'event', signalKey: 'key', resumeToken: 'token', canResume: true}], dataResumes: [{nodeId: 'data', outputs: ['value'], canResume: true}], taskTrees: [{nodeId: 'tree', canResume: true}]};
  const port = authorizeDaemonPort({workflowRun: async () => original} as any, {currentGrantsVersion: () => '1', permits: (_principal, target) => target.kind !== 'workflows' || target.action !== 'resume'});
  const result = await port.workflowRun!(request, {runId: 'run'});
  expect(result.waits[0]).toMatchObject({resumeToken: 'token', canResume: false});
  expect(result.dataResumes[0]).toMatchObject({canResume: false, unavailableReason: 'workflow_resume_forbidden'});
  expect(result.taskTrees![0]!.canResume).toBe(false); expect(original.waits[0]!.canResume).toBe(true);
});
