import {emptyContext} from './fixtures/participant'
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHost } from '../../cell/packages/ai-runtime-host-capsule/src/host'
import { prepareSkillDrivenOrganizationWorkspace } from '../../cell/packages/ai-organ-logic/tests/workflow/prepareSkillDrivenOrganizationWorkspace'
import { installBundledSystemSkills } from '@cell/ai-support/system-skill/SystemSkillInstaller'
import { __setLlmAdapterFactoryForTest } from '../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly'
import { createMockProviderCacheCostObservation } from '../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream'

afterEach(() => __setLlmAdapterFactoryForTest(null))
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 500; i++) { if (await check()) return; await Bun.sleep(20) }
  throw new Error('questionnaire_e2e_timeout')
}

// Actual resource admission, built-in Questionnaire, Task service, execution driver, snapshots,
// restart and IM outbox. Only the LLM adapter is controlled; no task/answer owner is mocked.
test('real admitted member and Holon questions run concurrently, answer only their exact channel, and restart does not resume pending work', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anchor-bots-question-e2e-'))
  const globalRoot = join(root, 'global'), workDir = join(globalRoot, 'daemon')
  await mkdir(workDir,{recursive:true}); await installBundledSystemSkills({ globalRoot })
  await prepareSkillDrivenOrganizationWorkspace(workDir, { tools: ['Questionnaire'], prompt: 'Call Questionnaire once then return strict JSON {"value":"the user answer"}.' })
  await writeFile(join(workDir, '.eidolon/llm-provider.json'), JSON.stringify({ providers: [{ id: 'one', adapter: 'openai', options: { apiKey: 'controlled-test-only' }, models: [{ id: 'a', limits: { context: 32000, output: 2048 } }] }] }))
  await writeFile(join(workDir, '.eidolon/agent-present.json'), JSON.stringify({ defaultPreset: 'test', presets: { test: { primary: { model: 'one/a' } } } }))
  const calls: string[] = []
  __setLlmAdapterFactoryForTest(async () => ({ type: 'openai', runtime: { adapterName: 'openai', providerId: 'one' }, async createStream(options: any) {
    const all = JSON.stringify(options.messages)
    const current = JSON.stringify(options.messages.filter((m:any)=>m.role==='user').at(-1))
    const label = ['alpha', 'beta', 'gamma'].find(value => current.includes(`input-${value}`))!
    const answered = options.messages.some((m: any) => m.role === 'tool')
    calls.push(`${label}:${answered ? 'final' : 'question'}`)
    return { stream: (async function* () {
      if (!answered) {
        yield { choices: [{ delta: { content: `完整问题准备:${label}`, tool_calls: [{ index: 0, id: `tool-${label}`, type: 'function', function: { name: 'Questionnaire', arguments: JSON.stringify({ questionnaireId: `question-${label}`, kind: 'approval', title: `确认 ${label}`, suspendPolicy: 'continue_others', questions: [{ id: 'answer', prompt: `请输入 ${label} 的答复`, type: 'text', required: true }] }) } }] }, finish_reason: 'tool_calls' }] }
      } else {
        // Exercise a genuinely asynchronous continuation after the human answer.
        await Bun.sleep(250);
        yield { choices: [{ delta: { content: JSON.stringify({ value: `${label}:${all.includes('answer-alpha') ? 'answer-alpha' : 'answer-beta'}` }) }, finish_reason: 'stop' }] }
      }
    })(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
  } }))
  const config = { workDir, globalRoot, globalAuthority:{daemonId:'fixture',globalWorkspaceKey:'global'}, runtimeConfig: { model: 'one/a', mcp: false }, authorization: { permits: () => true, currentGrantsVersion: () => '1' } }
  const request = { principal: { principalId: 'owner', grantsVersion: '1' }, requestId: 'test' }
  let host = await createHost(config)
  try {
    const directory = await host.participantDirectory!(request)
    const bindings = await Promise.all(['member', 'holon'].map(async (kind, index) => {
      const recipient = directory.contacts.find(c => c.recipient.kind === kind && c.available)!.recipient
      const binding = await host.openParticipant!(request, { bindingKey: `channel-${index}`, recipient, expectedServerInstanceId: host.capabilities(request).serverInstanceId })
      return { ...binding, recipient }
    }))
    await Promise.all(bindings.map((b, index) => host.submitExecution!(request, {contextCut:emptyContext(), bindingKey: b.bindingKey, recipient: b.recipient, commandId: 'message', text: index ? 'input-beta' : 'input-alpha' })))
    const pages = () => Promise.all(bindings.map(b => host.participantWork!(request, { bindingKey: b.bindingKey })))
    await until(async () => (await pages()).every(p => p.work[0]?.questions[0]?.canAnswer))
    expect(calls.sort()).toEqual(['alpha:question', 'beta:question'])
    const [a, b] = await pages()
    expect(a!.work[0]!.questions[0]!.questions[0]!.prompt).toContain('alpha')
    expect(b!.work[0]!.questions[0]!.questions[0]!.prompt).toContain('beta')
    expect(a!.work[0]!.executions[0]!.executionSessionRef).not.toBe(b!.work[0]!.executions[0]!.executionSessionRef)
    await expect(host.controlParticipant!(request, { kind: 'answer', bindingKey: bindings[0]!.bindingKey, commandId: 'message', questionnaireId: 'question-beta', responseText: 'Q1: answer-alpha' })).rejects.toMatchObject({ status: 409 })
    await host.controlParticipant!(request, { kind: 'answer', bindingKey: bindings[0]!.bindingKey, commandId: 'message', questionnaireId: 'question-alpha', responseText: 'Q1: answer-alpha' })
    await until(async () => (await host.executionOutputPage!(request, { bindingKey: bindings[0]!.bindingKey })).outputs.some(p => p.kind === 'result'))
    const transcript = await host.executionOutputPage!(request, { bindingKey: bindings[0]!.bindingKey })
    expect(transcript.outputs.map(p => p.kind)).toEqual(['question', 'stage', 'result'])
    expect(transcript.outputs.at(-1)!.text).toContain('alpha:answer-alpha')
    expect((await pages())[1]!.work[0]!.questions[0]).toMatchObject({ state: 'pending', canAnswer: true })
    expect(calls).not.toContain('beta:final')
    const pending = (await pages())[1]!.work[0]!
    await host.controlParticipant!(request, { kind: 'cancel', bindingKey: bindings[1]!.bindingKey, commandId: 'message', controlId: 'cancel-live', expectedRevision: pending.revision, occurredAt: new Date().toISOString(), reason: 'explicit cancellation' })
    expect((await pages())[1]!.work[0]!.status).toBe('Cancelled')
    expect((await host.executionOutputPage!(request, { bindingKey: bindings[1]!.bindingKey })).outputs.some(p => p.kind === 'result')).toBe(false)
    const recipient = bindings[0]!.recipient
    const third = await host.openParticipant!(request, { bindingKey: 'channel-2', recipient, expectedServerInstanceId: host.capabilities(request).serverInstanceId })
    await host.submitExecution!(request, {contextCut:emptyContext(), bindingKey: third.bindingKey, recipient, commandId: 'pending-restart', text: 'input-gamma' })
    await until(async () => (await host.participantWork!(request, { bindingKey: third.bindingKey })).work[0]?.questions[0]?.canAnswer === true)
    const callCount = calls.length
    await host.close(); host = await createHost(config)
    const restored = await pages()
    expect(restored[0]!.work[0]!.status).toBe('Succeeded')
    expect(restored[1]!.work[0]!.status).toBe('Cancelled')
    expect((await host.participantWork!(request, { bindingKey: third.bindingKey })).work[0]!.questions[0]).toMatchObject({ state: 'pending', canAnswer: false, unavailableReason: 'execution_not_active' })
    expect(calls).toHaveLength(callCount)
    expect((await host.executionOutputPage!(request, { bindingKey: bindings[0]!.bindingKey })).outputs).toEqual(transcript.outputs)
    await expect(host.controlParticipant!(request, { kind: 'answer', bindingKey: third.bindingKey, commandId: 'pending-restart', questionnaireId: 'question-gamma', responseText: 'Q1: answer-gamma' })).rejects.toMatchObject({ status: 409 })
    expect((await host.executionOutputPage!(request, { bindingKey: third.bindingKey })).outputs.some(p => p.kind === 'result')).toBe(false)
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
}, 40000)
