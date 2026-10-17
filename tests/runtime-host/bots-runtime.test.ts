import {emptyContext} from './fixtures/participant'
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { seedBotResources } from './fixtures/bots'
import { readParticipantDirectory } from '../../cell/packages/ai-runtime-host-capsule/src/participantDirectory'
import { createRuntimeSession, type RuntimeSession } from '../../cell/packages/ai-runtime-host-capsule/src/sessionHost'
import { openHostSessionRegistry, createHostResourceEffects } from '../../cell/packages/ai-runtime-host-support/src'
import { __setLlmAdapterFactoryForTest } from '../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly'
import { createMockProviderCacheCostObservation } from '../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream'
import { installBundledSystemSkills } from '@cell/ai-support/system-skill/SystemSkillInstaller'

afterEach(() => __setLlmAdapterFactoryForTest(null))
async function until(predicate: () => boolean | Promise<boolean>) {
  const end = Date.now() + 15000
  while (!await predicate()) { if (Date.now() > end) throw new Error('bots_runtime_timeout'); await Bun.sleep(20) }
}
test('member and organization channels use real admitted Holon tasks and addressed recipe actors concurrently; Primary cannot receive generic input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anchor-bots-runtime-')), globalRoot = join(root, 'global'), workDir = join(globalRoot, 'daemon')
  await mkdir(workDir,{recursive:true}); await installBundledSystemSkills({ globalRoot }); await seedBotResources(root, workDir)
  const resources = createHostResourceEffects(), registry = openHostSessionRegistry(join(root, 'registry'))
  const runtimes: RuntimeSession[] = [], entered = new Set<string>(), gates = new Map<string, { promise: Promise<void>; release(): void }>()
  const prompts: string[] = []
  for (const value of ['member-input', 'org-input']) {
    let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); gates.set(value, { promise, release })
  }
  __setLlmAdapterFactoryForTest(async () => ({ type: 'openai', runtime: { adapterName: 'openai', providerId: 'fixture' },
    async createStream(options: any) {
      const all = JSON.stringify(options.messages); prompts.push(all)
      const value = ['member-input', 'org-input'].find(text => all.includes(text))!
      async function* stream() {
        entered.add(value); yield { choices: [{ delta: { content: JSON.stringify({ value: `reply:${value}` }) } }] }
        await gates.get(value)?.promise; yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
      }
      return { stream: stream(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
    },
  }))
  const request = { principal: { principalId: 'owner', grantsVersion: '1' }, requestId: 'bots-test' }
  const authorization = { permits: () => true, currentGrantsVersion: () => '1' }
  try {
    const directory = await readParticipantDirectory(workDir, globalRoot)
    for (const kind of ['member', 'holon']) {
      const contact = directory.contacts.find(c => c.recipient.kind === kind)!, sessionId = randomUUID()
      const binding = registry.bindParticipant({ principalId: 'owner', bindingKey: `channel-${kind}`, recipient: contact.recipient,
        session: { sessionId, storageKey: sessionId, profileId: 'ai-coding', displayName: contact.name, createdAt: Date.now() } })
      runtimes.push(await createRuntimeSession({ stored: registry.get(binding.sessionId)!, epoch: `epoch-${kind}`, workDir, globalRoot,
        config: { adapter: 'openai', model: 'mock', mcp: false }, authorization, resources,
        identity: { newId: randomUUID, now: Date.now }, management: registry.management, publications: registry.publications,
        executionOutputs:registry.executionOutputs }))
    }
    expect(prompts).toEqual([])
    expect(runtimes.every(r => Boolean(r.participant) && r.summary.readOnly)).toBe(true)
    const primary = (await runtimes[0]!.actors(request)).actors.find(a => a.executionKind === 'primary')!
    await expect((async () => runtimes[0]!.command(request, { commandId: 'forged-primary', surfaceId: 'test', expectedEpoch: runtimes[0]!.summary.epoch,
      kind: 'send_text', payload: { actorId: primary.actorId, text: 'must not run' } }))()).rejects.toMatchObject({ status: 403 })
    const commands=runtimes.map((_,i)=>({contextCut:emptyContext(),bindingKey:`channel-${i ? 'holon' : 'member'}`,recipient:directory.contacts.find(c=>c.recipient.kind===(i?'holon':'member'))!.recipient,
      commandId:`message-${i}`,text:i?'org-input':'member-input'}))
    const receipts = await Promise.all(runtimes.map((r, i) => r.participant!.send(request, commands[i]!)))
    const selectors = receipts.map(r => r.task)
    expect(new Set(receipts.map(r => r.task.taskSpaceId)).size).toBe(2)
    expect(receipts.every(r => r.state === 'submitted')).toBe(true)
    try { await until(() => entered.size === 2) }
    catch (error) { throw new Error(JSON.stringify({ entered: [...entered], observations: await Promise.all(runtimes.map((r, i) => r.participant!.observe(request, selectors[i]!))) }), { cause: error }) }
    expect(runtimes.every(r => r.isBusy())).toBe(true)
    const pending=await Promise.all(runtimes.map(r=>r.participant!.outputs(request)))
    expect(pending.every(t=>t.outputs.length===0)).toBe(true)
    expect(await runtimes[0]!.participant!.send(request,commands[0]!)).toEqual(receipts[0])
    for (const gate of gates.values()) gate.release()
    await until(async () => (await Promise.all(runtimes.map((r, i) => r.participant!.settlement(request, selectors[i]!)))).every(Boolean))
    for (const [index, runtime] of runtimes.entries()) {
      const settled = await runtime.participant!.settlement(request, selectors[index]!)
      expect(settled!.receipt.status).toBe('Succeeded')
      const actors = (await runtime.actors(request)).actors
      expect(actors.some(a => a.executionKind !== 'primary' && a.displayName === 'resource://eidolon.child.Worker')).toBe(true)
      const observation = await runtime.participant!.observe(request, selectors[index]!)
      expect(observation.sessionRef).toBeTruthy(); expect(observation.memberRef).toBe('member-worker')
      const transcript=await runtime.participant!.outputs(request)
      expect(transcript.outputs.map(p=>p.kind)).toEqual(['result'])
      expect(transcript.outputs[0]!.text).toContain(index?'reply:org-input':'reply:member-input')
      expect(transcript.outputs.every(p=>p.commandId===commands[index]!.commandId && p.source.taskId===selectors[index]!.taskId)).toBe(true)
      expect(registry.executionOutputs.sources({principalId:'owner',bindingKey:commands[index]!.bindingKey},commands[index]!.commandId)).toHaveLength(1)
      expect(await runtime.participant!.outputs(request)).toEqual(transcript)
    }
    expect(prompts.every(p => p.includes('ORDER_RECIPE'))).toBe(true)
    await expect(runtimes[0]!.participant!.observe(request, { ...selectors[0]!, admissionId: 'foreign' })).rejects.toMatchObject({ status: 409 })
    await expect(runtimes[0]!.participant!.assign({ ...request, principal: { principalId: 'foreign', grantsVersion: '1' } }, { commandId: 'no', input: { value: 'none' } })).rejects.toMatchObject({ status: 403 })
    const transcript=await runtimes[0]!.participant!.outputs(request), calls=prompts.length
    const stored=registry.get(runtimes[0]!.summary.sessionId)!
    await runtimes[0]!.close()
    runtimes[0]=await createRuntimeSession({stored,epoch:'restarted',workDir,globalRoot,config:{adapter:'openai',model:'mock',mcp:false},authorization,resources,
      identity:{newId:randomUUID,now:Date.now},management:registry.management,publications:registry.publications,executionOutputs:registry.executionOutputs})
    expect(await runtimes[0]!.participant!.outputs(request)).toEqual(transcript)
    expect(await runtimes[0]!.participant!.send(request,commands[0]!)).toEqual(receipts[0])
    expect(prompts).toHaveLength(calls)
    expect(runtimes[0]!.isBusy()).toBe(false)
  } finally {
    for (const gate of gates.values()) gate.release()
    await Promise.all(runtimes.map(r => r.close())); registry.close(); resources.close(); await rm(root, { recursive: true, force: true })
  }
}, 45000)
