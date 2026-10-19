import { expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { workspaceWorkerRuntimeConfig } from '../../cell/packages/ai-runtime-host-capsule/src/daemonWorker'
import { daemonApprovalMode } from '../../terminal/packages/cli/src/commands/daemon'

test('daemon approval mode maps to the same sandbox metadata as exec', () => {
  expect(workspaceWorkerRuntimeConfig({ model: 'm' }, undefined, tmpdir())).toEqual({ model: 'm' })
  expect(workspaceWorkerRuntimeConfig({ model: 'm', approvalMode: 'default' }, undefined, tmpdir())).toEqual({ model: 'm' })
  for (const mode of ['dangerous', 'full-auto'] as const) {
    const config = workspaceWorkerRuntimeConfig({ model: 'm', approvalMode: mode }, undefined, tmpdir()) as any
    expect(config.approvalMode).toBeUndefined()
    expect(config.metadata.sandbox_permissions).toMatchObject({ sandbox_mode: 'danger-full-access', approval_policy: 'never' })
    expect(config.metadata.exec_protocol.mode).toBe(mode)
  }
  expect(() => workspaceWorkerRuntimeConfig({ approvalMode: 'dangerous' })).toThrow('approval_mode_requires_workdir')
})

test('daemon CLI resolves --yolo and --approval-mode', () => {
  expect(daemonApprovalMode({})).toBeUndefined()
  expect(daemonApprovalMode({ approvalMode: 'full-auto' })).toBe('full-auto')
  expect(daemonApprovalMode({ dangerouslyBypassApprovalsAndSandbox: true, approvalMode: 'default' })).toBe('dangerous')
  expect(daemonApprovalMode({ approvalMode: 'bogus' })).toBeUndefined()
})
