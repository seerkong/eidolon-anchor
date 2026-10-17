import { expect, test } from 'bun:test'
import { createDaemon } from '../../cell/packages/ai-runtime-host-capsule/src/daemon'
import { createHost } from '../../cell/packages/ai-runtime-host-capsule/src/host'
import { fixture, workerCommand } from './helpers'

test('workspace workers open on demand, merge concurrent opens, and close independently', async () => {
  const f = await fixture(), daemon = await createDaemon({ globalRoot: f.globalRoot, workerCommand })
  try {
    const a = await daemon.register(f.a), b = await daemon.register(f.b)
    expect(a.state).toBe('registered')
    const [one, two] = await Promise.all([daemon.open(a.workspaceKey), daemon.open(a.workspaceKey)])
    expect(one.serverInstanceId).toBe(two.serverInstanceId)
    await daemon.open(b.workspaceKey)
    await expect(createHost({ workDir: f.a, globalRoot: f.globalRoot, authorization: { permits: () => true, currentGrantsVersion: () => '1' } })).rejects.toThrow('session_writer_conflict')
    await daemon.closeWorkspace(a.workspaceKey)
    expect(daemon.workspaces().find(w => w.workspaceKey === b.workspaceKey)?.state).toBe('ready')
    expect((await daemon.open(a.workspaceKey)).serverInstanceId).not.toBe(one.serverInstanceId)
    expect(() => daemon.remove(a.workspaceKey)).toThrow('workspace_open')
  } finally { await daemon.close(); await f.cleanup() }
}, 30_000)

test('configured worker/session limits reject admission without publishing an extra session', async () => {
  const startedAt = performance.now()
  const f = await fixture(), daemon = await createDaemon({ globalRoot: f.globalRoot, workerCommand, limits: { workers: 1, sessionsPerWorkspace: 1 } })
  try {
    const a = await daemon.register(f.a), b = await daemon.register(f.b); await daemon.open(a.workspaceKey)
    console.log(`workspace limits: initial worker ready after ${Math.round(performance.now()-startedAt)}ms`)
    await expect(daemon.open(b.workspaceKey)).rejects.toMatchObject({ status: 429 })
    const port = daemon.scope(a.workspaceKey).port, request = { principal: { principalId: 'local-owner', grantsVersion: '1' }, requestId: 'quota' }
    const command = { commandId: 'first', profileId: 'ai-coding', expectedServerInstanceId: port.capabilities(request).serverInstanceId }
    const session = await port.createSession(request, command)
    expect((await port.createSession(request, command)).sessionId).toBe(session.sessionId)
    await expect(port.createSession(request, { ...command, commandId: 'over-limit' })).rejects.toMatchObject({ status: 429 })
    expect((await port.sessions(request, {})).sessions).toHaveLength(1)
    console.log(`workspace limits: exact admissions checked after ${Math.round(performance.now()-startedAt)}ms`)
    await daemon.closeWorkspace(a.workspaceKey); await daemon.open(b.workspaceKey)
    console.log(`workspace limits: replacement worker ready after ${Math.round(performance.now()-startedAt)}ms`)
  } finally { await daemon.close(); await f.cleanup() }
}, 120_000)
