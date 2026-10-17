import { expect, test } from 'bun:test'
import { fixture, server, client } from './helpers'
import { principal } from './helpers'
import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnWorkspaceWorker } from '../../cell/packages/ai-runtime-host-support/src/daemonWorkerProxy'
import { createDaemonResourceEffects } from '../../cell/packages/ai-runtime-host-support/src/daemonResource'
import { workerCommand } from './helpers'
import { serveDaemon } from '../../backend/packages/elysia/src/daemonServe'
import { security } from './helpers'
import { createHost } from '../../cell/packages/ai-runtime-host-capsule/src/host'

test('one authenticated listener scopes directory and rejects stale daemon/workspace generations', async () => {
  const f = await fixture(), s = await server(f), request = client(s)
  try {
    expect((await fetch(s.address + '/v1/daemon')).status).toBe(401)
    expect((await request('/capabilities')).status).toBe(404)
    expect((await request('/workspaces', { headers: { 'X-Eidolon-Daemon-Instance': 'old' } })).status).toBe(409)
    const a = await s.daemon.register(f.a), b = await s.daemon.register(f.b)
    const opened = await (await request(`/workspaces/${a.workspaceKey}/open`, { method: 'POST' })).json()
    expect(opened.state).toBe('ready')
    const generation = opened.serverInstanceId
    expect((await request(`/workspaces/${a.workspaceKey}/sessions`)).status).toBe(409)
    const directory = await request(`/workspaces/${a.workspaceKey}/sessions`, {}, generation)
    expect(directory.status).toBe(200); expect((await directory.json()).sessions).toEqual([])
    const identity = await (await request(`/workspaces/${a.workspaceKey}/workspace`, {}, generation)).json()
    expect(identity.workDir).toBe(f.a)
    expect((await request(`/workspaces/${b.workspaceKey}/sessions`, {}, generation)).status).toBe(409)
    const other = await s.daemon.open(b.workspaceKey)
    expect((await request(`/workspaces/${b.workspaceKey}/sessions`, {}, generation)).status).toBe(409)
    expect((await request(`/workspaces/${b.workspaceKey}/sessions/foreign/actors`, {}, other.serverInstanceId)).status).toBe(404)
    await s.daemon.closeWorkspace(a.workspaceKey); await s.daemon.open(a.workspaceKey)
    expect((await request(`/workspaces/${a.workspaceKey}/sessions`, {}, generation)).status).toBe(409)
  } finally { await s.close(); await f.cleanup() }
}, 30_000)

test('embedding authorization remains authoritative across IPC and grant revocation closes all workers', async () => {
  const f = await fixture(); let denySend = false, grants = '1'
  const s = await serveDaemon({ globalRoot: f.globalRoot, workerCommand, listen: { port: 0 }, runtimeConfig: { mcp: false }, security: {
    ...security, authorization: { currentGrantsVersion: () => grants, permits: (_p, target) => target.action !== 'stop_daemon' && !(denySend && target.kind === 'actor' && ['send_text', 'read_history'].includes(target.action)) } } })
  const request = client(s)
  try {
    const a = await s.daemon.register(f.a), opened = await s.daemon.open(a.workspaceKey)
    const post = (route: string, value: unknown) => request(`/workspaces/${a.workspaceKey}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }, opened.serverInstanceId)
    const response = await post('/sessions', { commandId: 'permission', profileId: 'ai-coding', expectedServerInstanceId: opened.serverInstanceId })
    expect(response.status).toBe(201); const session = await response.json()
    const actors = await (await request(`/workspaces/${a.workspaceKey}/sessions/${session.sessionId}/actors`, {}, opened.serverInstanceId)).json()
    const actor = actors.actors[0]
    denySend = true
    expect((await post(`/sessions/${session.sessionId}/commands`, { commandId: 'denied', surfaceId: 'test', expectedEpoch: session.epoch, kind: 'send_text', payload: { actorId: actor.actorId, text: 'must never invoke provider' } })).status).toBe(403)
    expect((await request(`/workspaces/${a.workspaceKey}/sessions/${session.sessionId}/actors/${actor.actorId}/history`, {}, opened.serverInstanceId)).status).toBe(403)
    expect((await request('/daemon/stop', { method: 'POST' })).status).toBe(403)
    grants = 'revoked'
    const end = Date.now() + 10_000; let replacement: Awaited<ReturnType<typeof createHost>> | undefined
    while (!replacement) { try { replacement = await createHost({ workDir: f.a, globalRoot: f.globalRoot, authorization: security.authorization }) }
      catch { if (Date.now() > end) throw new Error('revocation_cleanup_timeout'); await Bun.sleep(20) } }
    expect(() => s.daemon.scope(a.workspaceKey)).toThrow('daemon_closing')
    await replacement.close()
  } finally { await s.close(); await f.cleanup() }
}, 20_000)

test('an idle observation pull outlives ordinary RPC timeout without terminating its worker', async () => {
  const f = await fixture(), resources = createDaemonResourceEffects(), request = { principal, requestId: 'idle-stream' }
  const worker = await spawnWorkspaceWorker({ workspace: { workspaceKey: 'idle', workspaceId: f.a, workDir: f.a, revision: 1, placement: 'workspace' }, globalRoot: f.globalRoot,
    principalId: principal.principalId, grantsVersion: principal.grantsVersion, runtimeConfig: { mcp: false } }, workerCommand, resources, undefined, 64, 1500)
  try {
    const session = await worker.port.createSession(request, { commandId: 'idle', profileId: 'ai-coding', expectedServerInstanceId: worker.capabilities.serverInstanceId })
    const actor = (await worker.port.actors(request, session)).actors[0]
    const subscription = await worker.port.subscribe(request, session, { actors: [actor.actorId] }), iterator = subscription.frames[Symbol.asyncIterator]()
    expect((await iterator.next()).value.kind).toBe('snapshot')
    let settled = false
    const idle = iterator.next().finally(() => { settled = true })
    await Bun.sleep(1800)
    expect(settled).toBe(false)
    expect((await worker.port.sessions(request, {})).sessions[0].sessionId).toBe(session.sessionId)
    subscription.close(); expect((await idle).done).toBe(true)
  } finally { await worker.close(); resources.close(); await f.cleanup() }
}, 15_000)

test('copying a session registry into another workspace does not transfer its authority', async () => {
  const f = await fixture(), s = await server(f), request = { principal, requestId: 'copied-session' }
  try {
    const a = await s.daemon.register(f.a), b = await s.daemon.register(f.b)
    await s.daemon.open(a.workspaceKey)
    const port = s.daemon.scope(a.workspaceKey).port
    const session = await port.createSession(request, { commandId: 'source', profileId: 'ai-coding', expectedServerInstanceId: port.capabilities(request).serverInstanceId })
    const actor = (await port.actors(request, session)).actors[0]
    await s.daemon.closeWorkspace(a.workspaceKey)
    await cp(join(f.a, '.eidolon'), join(f.b, '.eidolon'), { recursive: true })
    await s.daemon.open(b.workspaceKey)
    const copied = s.daemon.scope(b.workspaceKey).port
    await expect(copied.actors(request, session)).rejects.toMatchObject({ status: 409, error: { code: 'session_workspace_mismatch' } })
    await expect(copied.history(request, { sessionId: session.sessionId, actorId: actor.actorId }, {})).rejects.toMatchObject({ status: 409, error: { code: 'session_workspace_mismatch' } })
  } finally { await s.close(); await f.cleanup() }
}, 30_000)

test('actor, command, attachment and subscription identities cannot be transplanted between workspaces; subscription cap is daemon-wide', async () => {
  const f = await fixture(), s = await server(f), request = { principal, requestId: 'scope-negative' }
  const subscriptions: { close(): void }[] = []
  try {
    const a = await s.daemon.register(f.a), b = await s.daemon.register(f.b)
    await Promise.all([s.daemon.open(a.workspaceKey), s.daemon.open(b.workspaceKey)])
    const pa = s.daemon.scope(a.workspaceKey).port, pb = s.daemon.scope(b.workspaceKey).port
    const sa = await pa.createSession(request, { commandId: 'same-id', profileId: 'ai-coding', expectedServerInstanceId: pa.capabilities(request).serverInstanceId })
    const sb = await pb.createSession(request, { commandId: 'same-id', profileId: 'ai-coding', expectedServerInstanceId: pb.capabilities(request).serverInstanceId })
    const aa = (await pa.actors(request, sa)).actors[0], ab = (await pb.actors(request, sb)).actors[0]
    await expect(pb.command(request, sa, { commandId: 'foreign-session', surfaceId: 'test', expectedEpoch: sa.epoch, kind: 'send_text', payload: { actorId: aa.actorId, text: 'never execute' } })).rejects.toMatchObject({ status: 404 })
    await expect(pb.command(request, sb, { commandId: 'foreign-actor', surfaceId: 'test', expectedEpoch: sb.epoch, kind: 'send_text', payload: { actorId: aa.actorId, text: 'never execute' } })).rejects.toMatchObject({ status: 404 })
    const bytes = 'scope A', digest = 'sha256:' + new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
    const upload = await pa.attachment!(request, { sessionId: sa.sessionId, actorId: aa.actorId }, { kind: 'begin', expectedEpoch: sa.epoch, uploadId: 'upload-a', filename: 'scope.txt', mime: 'text/plain', totalBytes: bytes.length, digest })
    await expect(pb.attachment!(request, { sessionId: sb.sessionId, actorId: ab.actorId }, { kind: 'append', expectedEpoch: sb.epoch, attachmentId: upload.attachmentId, offsetBytes: 0, data: Buffer.from(bytes).toString('base64') })).rejects.toMatchObject({ status: 404 })
    await expect(pb.history(request, { sessionId: sb.sessionId, actorId: aa.actorId }, {})).rejects.toMatchObject({ status: 404 })
    await expect(pb.subscribe(request, sb, { actors: [aa.actorId] })).rejects.toMatchObject({ status: 404 })
    for (let i = 0; i < 32; i++) subscriptions.push(await (i % 2 ? pa.subscribe(request, sa, { actors: [aa.actorId] }) : pb.subscribe(request, sb, { actors: [ab.actorId] })))
    await expect(pb.subscribe(request, sb, { actors: [ab.actorId] })).rejects.toMatchObject({ status: 429 })
    subscriptions.pop()!.close(); await Bun.sleep(10)
    subscriptions.push(await pa.subscribe(request, sa, { actors: [aa.actorId] }))
  } finally { for (const subscription of subscriptions) subscription.close(); await s.close(); await f.cleanup() }
}, 30_000)
