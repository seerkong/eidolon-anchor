import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHost } from '../../../../cell/packages/ai-runtime-host-capsule/src/host'
import { __setLlmAdapterFactoryForTest } from '../../../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly'
import { installBundledSystemSkills } from '@cell/ai-support/system-skill/SystemSkillInstaller'
import { parseSessionStatistics, type HostRequest, type SessionStatistics } from '../../../../cell/packages/ai-runtime-host-contract/src'
import { createTurnObservationWindow, recordTurnObservation, projectTurnStatistics } from '../../../../cell/packages/ai-runtime-host-logic/src/statistics'

afterEach(() => __setLlmAdapterFactoryForTest(null))
const request: HostRequest = { principal: { principalId: 'owner', grantsVersion: '1' }, requestId: 'statistics-test' }

test('bounded turn observations preserve first start/terminal, waiting and cancellation without changing execution', () => {
  const window = createTurnObservationWindow(100, 2)
  const a = { actorId: 'a', turnId: 'one', state: 'queued' as const }
  recordTurnObservation(window, a, 110); recordTurnObservation(window, { ...a, state: 'running' }, 120)
  recordTurnObservation(window, { ...a, state: 'waiting_input' }, 130)
  expect(projectTurnStatistics(window, 140)).toMatchObject({ counts: { waiting_input: 1 }, current: { startedAt: 110, observedWallMs: 30 } })
  recordTurnObservation(window, { ...a, state: 'cancelled' }, 150)
  recordTurnObservation(window, { ...a, state: 'cancelled' }, 190)
  recordTurnObservation(window, { ...a, actorId: 'wrong', state: 'running' }, 200)
  expect(projectTurnStatistics(window, 200)).toMatchObject({ recent: { actorId: 'a', endedAt: 150, observedWallMs: 40 }, peakObservedWallMs: 40 })
  recordTurnObservation(window, { ...a, turnId: 'two', state: 'failed' }, 210)
  recordTurnObservation(window, { ...a, turnId: 'three', state: 'running' }, 220)
  expect(projectTurnStatistics(window, 230)).toMatchObject({ retained: 2, evicted: 1, counts: { failed: 1, running: 1, cancelled: 0 }, peakObservedWallMs: 0, current: { turnId: 'three' } })
  recordTurnObservation(window, { ...a, turnId: 'three', state: 'succeeded' }, 200)
  expect(projectTurnStatistics(window, 240).recent).toMatchObject({ turnId: 'three', observedWallMs: 0 })
  expect(() => createTurnObservationWindow(0, 10001)).toThrow()
})

function sample(): SessionStatistics {
  return { sessionId: 's', epoch: 'e', scope: 'session', lifetime: 'runtime_epoch', startedAt: 100, observedAt: 200,
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16, cache_creation_tokens: 8, cache_read_tokens: 2, is_estimated: true },
    turns: { scope: 'retained_window', limit: 10000, retained: 1, evicted: 0, counts: { queued: 0, running: 0, waiting_input: 0, succeeded: 1, failed: 0, cancelled: 0, interrupted: 0 },
      recent: { actorId: 'a', turnId: 't', state: 'succeeded', startedAt: 110, endedAt: 150, observedWallMs: 40 }, peakObservedWallMs: 40 },
    timing: { intervalMode: 'exclusive_union', wallMs: 100, providerWaitMs: 10, providerGenerationMs: 20, toolMs: 30, productOwnedMs: 40 } }
}
test('canonical statistics reject fabricated scope, numeric corruption and inconsistent counts or timing', () => {
  expect(parseSessionStatistics(sample())).toEqual(sample())
  const bad = [ { ...sample(), scope: 'actor' }, { ...sample(), cost: 0 }, { ...sample(), usage: { ...sample().usage, total_tokens: NaN } },
    { ...sample(), usage: { ...sample().usage, prompt_tokens: -1 } }, { ...sample(), usage: { ...sample().usage, total_tokens: 0.5 } },
    { ...sample(), turns: { ...sample().turns, retained: 2 } }, { ...sample(), turns: { ...sample().turns, limit: 0 } },
    { ...sample(), timing: { ...sample().timing, wallMs: 101 } }, { ...sample(), timing: { ...sample().timing, toolMs: 31 } },
    { ...sample(), turns: { ...sample().turns, recent: { ...sample().turns.recent!, endedAt: 201 } } },
    { ...sample(), turns: { ...sample().turns, current: sample().turns.recent } },
    { ...sample(), turns: { ...sample().turns, recent: undefined } }, { ...sample(), turns: { ...sample().turns, peakObservedWallMs: 39 } },
    { ...sample(), turns: { ...sample().turns, peakObservedWallMs: 101 } } ]
  for (const value of bad) expect(() => parseSessionStatistics(value)).toThrow()
})

test('real Host statistics require an aggregate grant, reject stale epochs and reset on restart without model execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anchor-stats-')), workDir = join(root, 'work'), globalRoot = join(root, 'global')
  await mkdir(join(workDir, '.eidolon'), { recursive: true })
  await writeFile(join(workDir, '.eidolon/llm-provider.json'), JSON.stringify({ providers: [{ id: 'one', adapter: 'openai', options: { apiKey: 'test' }, models: [{ id: 'a', limits: { context: 8000, output: 1024 } }] }] }))
  await writeFile(join(workDir, '.eidolon/agent-present.json'), JSON.stringify({ defaultPreset: 'test', presets: { test: { primary: { model: 'one/a' } } } }))
  await installBundledSystemSkills({ globalRoot })
  let calls = 0, deny = false, grant = '1'
  __setLlmAdapterFactoryForTest(async () => ({ type: 'openai', runtime: { adapterName: 'openai', providerId: 'one' }, async createStream() { calls++; throw new Error('unexpected provider') } }))
  const config = { workDir, globalRoot, runtimeConfig: { model: 'one/a', mcp: false }, authorization: {
    currentGrantsVersion: () => grant, permits: (_principal: unknown, target: { action: string }) => target.action !== 'read_statistics' || !deny,
  } }
  let host = await createHost(config)
  try {
    const caps = host.capabilities(request); expect(caps.features.statistics).toBe(true)
    const session = await host.createSession(request, { commandId: 'session', expectedServerInstanceId: caps.serverInstanceId, profileId: 'ai-coding' })
    const stats = parseSessionStatistics(await host.statistics!(request, session, { expectedEpoch: session.epoch }))
    expect(stats).toMatchObject({ sessionId: session.sessionId, scope: 'session', lifetime: 'runtime_epoch', turns: { retained: 0 }, usage: { total_tokens: 0 } })
    expect(stats.timing.productOwnedMs).toBe(stats.timing.wallMs)
    await expect(host.statistics!(request, session, { expectedEpoch: 'old' })).rejects.toMatchObject({ status: 409 })
    deny = true; expect((await host.actors(request, session)).actors.length).toBeGreaterThan(0)
    await expect(host.statistics!(request, session, { expectedEpoch: session.epoch })).rejects.toMatchObject({ status: 403 })
    deny = false; grant = '2'
    await expect(host.statistics!(request, session, { expectedEpoch: session.epoch })).rejects.toMatchObject({ status: 403 }); grant = '1'
    await host.close(); host = await createHost(config)
    const directory = await host.actors(request, session)
    expect(directory.epoch).not.toBe(session.epoch)
    await expect(host.statistics!(request, session, { expectedEpoch: session.epoch })).rejects.toMatchObject({ status: 409 })
    expect(parseSessionStatistics(await host.statistics!(request, session, { expectedEpoch: directory.epoch }))).toMatchObject({ turns: { retained: 0 }, usage: { total_tokens: 0 } })
    expect(calls).toBe(0)
    await host.close(); await expect(host.statistics!(request, session, { expectedEpoch: directory.epoch })).rejects.toMatchObject({ status: 503 })
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
}, 30000)
