import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDaemon } from '../../cell/packages/ai-runtime-host-capsule/src/daemon'
import { fixture, cli, principal } from './helpers'
import { serveDaemon } from '../../backend/packages/elysia/src/daemonServe'
import { security } from './helpers'
import { createActor, createVM, createHeartbeatTimeoutSchedule } from '@cell/ai-core-logic'
import { configureRuntimePersistenceSupport, createAiAgentOrchestratorDriver, saveAiAgentRuntimeSnapshot } from '@cell/ai-organ-logic'
import { LocalFileConversationPersistenceRepositoryFactory, LocalFileRuntimeDerivedIndexesStore, LocalFileRuntimeSnapshotRepositoryFactory } from '@cell/ai-support'

const command = [process.execPath, '--preload', new URL('./fixtures/provider.ts', import.meta.url).pathname, cli, '__daemon-worker']
const request = { principal, requestId: 'recovery-test' }
const until = async (check: () => Promise<boolean>) => { const end = Date.now() + 15_000; while (!await check()) { if (Date.now() > end) throw new Error('recovery_timeout'); await Bun.sleep(20) } }

test('workspace restart preserves identity/history, rotates epoch, invalidates cursors and never replays provider work', async () => {
  const started = performance.now()
  const stage = (name: string) => console.log(`workspace recovery: ${name} after ${Math.round(performance.now() - started)}ms`)
  const f = await fixture(); let daemon = await createDaemon({ globalRoot: f.globalRoot, workerCommand: command, runtimeConfig: { mcp: false } })
  try {
    const a = await daemon.register(f.a), b = await daemon.register(f.b)
    await Promise.all([daemon.open(a.workspaceKey), daemon.open(b.workspaceKey)])
    stage('two workers ready')
    const port = daemon.scope(a.workspaceKey).port
    const session = await port.createSession(request, { commandId: 'create', expectedServerInstanceId: port.capabilities(request).serverInstanceId, profileId: 'ai-coding' })
    const actor = (await port.actors(request, session)).actors[0]
    const subscription = await port.subscribe(request, session, { actors: [actor.actorId] })
    const first = await subscription.frames[Symbol.asyncIterator]().next()
    await port.command(request, session, { commandId: 'send', surfaceId: 's', expectedEpoch: session.epoch, kind: 'send_text', payload: { actorId: actor.actorId, text: 'slow-turn recovery marker' } })
    await until(async () => (await readFile(join(f.a, 'provider-calls.jsonl'), 'utf8').catch(() => '')).includes('slow-turn'))
    await expect(daemon.closeWorkspace(a.workspaceKey)).rejects.toThrow('workspace_busy')
    await until(async () => (await port.commandStatus(request, session, { commandId: 'send', expectedEpoch: session.epoch })).associatedTurn?.state === 'succeeded')
    stage('original native turn succeeded')
    subscription.close(); await Bun.sleep(20)
    await daemon.closeWorkspace(a.workspaceKey)
    expect(daemon.workspaces().find(w => w.workspaceKey === b.workspaceKey)?.state).toBe('ready')
    const daemonId = daemon.capabilities().daemonId, oldInstance = daemon.capabilities().daemonInstanceId
    await daemon.close(); daemon = await createDaemon({ globalRoot: f.globalRoot, workerCommand: command, runtimeConfig: { mcp: false } })
    stage('parent replaced')
    expect(daemon.capabilities().daemonId).toBe(daemonId); expect(daemon.capabilities().daemonInstanceId).not.toBe(oldInstance)
    await daemon.open(a.workspaceKey)
    stage('persisted worker reopened')
    const reopened = daemon.scope(a.workspaceKey).port
    expect((await reopened.sessions(request, {})).sessions[0].sessionId).toBe(session.sessionId)
    const directory = await reopened.actors(request, session)
    expect(directory.actors[0].actorId).toBe(actor.actorId); expect(directory.epoch).not.toBe(session.epoch)
    expect(JSON.stringify(await reopened.history(request, { sessionId: session.sessionId, actorId: actor.actorId }, {}))).toContain('controlled:slow-turn recovery marker')
    await expect(reopened.commandStatus(request, session, { commandId: 'send', expectedEpoch: session.epoch })).rejects.toMatchObject({ status: 410, error: { state: 'unknown' } })
    const invalid = await reopened.subscribe(request, session, { actors: [actor.actorId], after: (first.value as any).cursor ?? 'foreign-cursor' })
    expect((await invalid.frames[Symbol.asyncIterator]().next()).value.kind).toBe('reset_required'); invalid.close()
    await Bun.sleep(1200)
    expect((await readFile(join(f.a, 'provider-calls.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1)
    stage('history, epochs, cursor and exact no-replay checked')
  } finally { await daemon.close(); await f.cleanup() }
// This aggregate includes three cold worker starts and a parent replacement;
// provider entry and native settlement retain their separate 15-second bounds.
}, 120_000)

test('worker crash is local, parent crash releases child writers, and neither restart replays an unknown turn', async () => {
  const f = await fixture()
  const child = Bun.spawn([process.execPath, new URL('./fixtures/crash-server.ts', import.meta.url).pathname], {
    env: { ...process.env, TEST_DAEMON_ROOT: f.globalRoot }, stdout: 'pipe', stderr: 'ignore' })
  let restarted: Awaited<ReturnType<typeof serveDaemon>> | undefined
  try {
    const reader = child.stdout.getReader(), decoder = new TextDecoder(); let line = ''
    const ready = (async () => { while (!line.includes('\n')) { const result = await reader.read(); if (result.done) throw new Error('parent_start_failed'); line += decoder.decode(result.value) } return JSON.parse(line.split('\n')[0]) })()
    const { address, capabilities } = await Promise.race([ready, Bun.sleep(10_000).then(() => { throw new Error('parent_start_timeout') })])
    const call = async (route: string, body?: unknown, generation?: string) => {
      const response = await fetch(address + '/v1' + route, { method: body ? 'POST' : 'GET', headers: {
        Authorization: 'Bearer ' + 'D'.repeat(43), 'Content-Type': 'application/json', 'X-Eidolon-Daemon-Instance': capabilities.daemonInstanceId,
        ...(generation ? { 'X-Eidolon-Workspace-Instance': generation } : {}) }, body: body ? JSON.stringify(body) : undefined })
      if (!response.ok) throw new Error(`test_protocol_${response.status}`)
      return response.json() as Promise<any>
    }
    const a = await call('/workspaces', { workDir: f.a }), b = await call('/workspaces', { workDir: f.b })
    const opened = await call(`/workspaces/${a.workspaceKey}/open`, {}), other = await call(`/workspaces/${b.workspaceKey}/open`, {})
    const session = await call(`/workspaces/${a.workspaceKey}/sessions`, { commandId: 'create', profileId: 'ai-coding', expectedServerInstanceId: opened.serverInstanceId }, opened.serverInstanceId)
    const actor = (await call(`/workspaces/${a.workspaceKey}/sessions/${session.sessionId}/actors`, undefined, opened.serverInstanceId)).actors[0]
    await call(`/workspaces/${a.workspaceKey}/sessions/${session.sessionId}/commands`, { commandId: 'crash', surfaceId: 'crash-test', expectedEpoch: session.epoch, kind: 'send_text', payload: { actorId: actor.actorId, text: 'crash-worker' } }, opened.serverInstanceId)
    await until(async () => (await call('/workspaces')).workspaces.find((w: any) => w.workspaceKey === a.workspaceKey).state === 'failed')
    expect((await call(`/workspaces/${b.workspaceKey}/workspace`, undefined, other.serverInstanceId)).workDir).toBe(f.b)
    const recovered = await call(`/workspaces/${a.workspaceKey}/open`, {})
    const directory = await call(`/workspaces/${a.workspaceKey}/sessions/${session.sessionId}/actors`, undefined, recovered.serverInstanceId)
    await call(`/workspaces/${a.workspaceKey}/sessions/${session.sessionId}/commands`, { commandId: 'slow', surfaceId: 'crash-test', expectedEpoch: directory.epoch, kind: 'send_text', payload: { actorId: actor.actorId, text: 'slow-turn parent-crash' } }, recovered.serverInstanceId)
    await until(async () => (await readFile(join(f.a, 'provider-calls.jsonl'), 'utf8')).includes('parent-crash'))
    child.kill('SIGKILL'); await child.exited
    // IPC disconnect must stop workers, so a new daemon can acquire every original writer lease.
    restarted = await serveDaemon({ globalRoot: f.globalRoot, security, listen: { port: 0 }, runtimeConfig: { mcp: false }, workerCommand: command })
    expect(restarted.daemon.capabilities().daemonId).toBe(capabilities.daemonId)
    await until(async () => { try { await restarted!.daemon.open(a.workspaceKey); return true } catch { return false } })
    await restarted.daemon.open(b.workspaceKey)
    const port = restarted.daemon.scope(a.workspaceKey).port, after = await port.actors(request, session)
    await expect(port.commandStatus(request, session, { commandId: 'slow', expectedEpoch: directory.epoch })).rejects.toMatchObject({ status: 410, error: { state: 'unknown' } })
    expect(after.actors[0].actorId).toBe(actor.actorId)
    await Bun.sleep(1500)
    expect((await readFile(join(f.a, 'provider-calls.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2)
  } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited } await restarted?.close(); await f.cleanup() }
}, 120_000)

test('opening a legacy checkpoint does not activate recovered heartbeat or input mailboxes', async () => {
  const f = await fixture(), daemon = await createDaemon({ globalRoot: f.globalRoot, workerCommand: command, runtimeConfig: { mcp: false } })
  configureRuntimePersistenceSupport({ snapshotRepositoryFactory: LocalFileRuntimeSnapshotRepositoryFactory,
    derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore, conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory })
  try {
    const a = await daemon.register(f.a); await daemon.open(a.workspaceKey)
    const port = daemon.scope(a.workspaceKey).port, session = await port.createSession(request, { commandId: 'legacy', profileId: 'ai-coding', expectedServerInstanceId: port.capabilities(request).serverInstanceId })
    const identity = (await port.actors(request, session)).actors[0]
    await daemon.closeWorkspace(a.workspaceKey)
    const actor = createActor({ key: 'main', id: identity.actorId, execution: { originSchemaVersion: 1, origin: { source: 'tui', sessionId: session.sessionId, actorId: identity.actorId }, status: 'settled' } })
    actor.send('humanInput', 'legacy mailbox must not execute on Web open')
    const vm = createVM({ controlActorKey: actor.key, actors: { main: actor }, outerCtx: { workDir: f.a } })
    createHeartbeatTimeoutSchedule(vm, { ownerActorKey: actor.key, ownerActorId: actor.id, now: Date.now() - 120_000,
      input: { name: 'legacy-heartbeat', description: 'must remain inactive on Web recovery', delaySeconds: 60, message: 'must not call a provider' } })
    const driver = createAiAgentOrchestratorDriver({ fibers: [{ fiberId: `main:${actor.id}`, vm, actor, messages: [], basePriority: 1 }], runStep: async () => ({ kind: 'complete' }) })
    driver.suspendFiber(`main:${actor.id}`, Date.now(), 'idle_external')
    expect((await saveAiAgentRuntimeSnapshot({ sessionDir: join(f.a, '.eidolon/sessions', session.sessionId), sessionId: session.sessionId, vm, driver })).status).toBe('saved')
    await daemon.open(a.workspaceKey)
    expect((await daemon.scope(a.workspaceKey).port.actors(request, session)).actors[0].actorId).toBe(identity.actorId)
    await Bun.sleep(2200)
    expect(await readFile(join(f.a, 'provider-calls.jsonl'), 'utf8').catch(() => '')).toBe('')
  } finally { await daemon.close(); await f.cleanup() }
}, 90_000)
