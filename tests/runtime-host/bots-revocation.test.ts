import {emptyContext} from './fixtures/participant'
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHost } from '../../cell/packages/ai-runtime-host-capsule/src/host'
import { prepareSkillDrivenOrganizationWorkspace } from '../../cell/packages/ai-organ-logic/tests/workflow/prepareSkillDrivenOrganizationWorkspace'
import { installBundledSystemSkills } from '@cell/ai-support/system-skill/SystemSkillInstaller'
import { __setLlmAdapterFactoryForTest } from '../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly'
import { createMockProviderCacheCostObservation } from '../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream'

afterEach(() => __setLlmAdapterFactoryForTest(null))
test('revoked admission preserves original history, disables new work and answers, and allows exact cancellation without retargeting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anchor-bots-revocation-'))
  const globalRoot = join(root, 'global'), workDir = join(globalRoot, 'daemon')
  await mkdir(workDir,{recursive:true}); await installBundledSystemSkills({ globalRoot })
  await prepareSkillDrivenOrganizationWorkspace(workDir, { tools: ['Questionnaire'] })
  await writeFile(join(workDir, '.eidolon/llm-provider.json'), JSON.stringify({ providers: [{ id: 'test', adapter: 'openai', options: { apiKey: 'controlled-test-only' }, models: [{ id: 'a', limits: { context: 32000, output: 2048 } }] }] }))
  await writeFile(join(workDir, '.eidolon/agent-present.json'), JSON.stringify({ defaultPreset: 'test', presets: { test: { primary: { model: 'test/a' } } } }))
  let calls = 0
  __setLlmAdapterFactoryForTest(async () => ({ type: 'openai', runtime: { adapterName: 'openai', providerId: 'test' }, async createStream(options: any) {
    calls++
    return { stream: (async function* () {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'question', type: 'function', function: { name: 'Questionnaire', arguments: JSON.stringify({ questionnaireId: 'original-question', title: 'Confirm original work', kind: 'approval', suspendPolicy: 'continue_others', questions: [{ id: 'decision', type: 'text', prompt: 'Allow?', required: true }] }) } }] }, finish_reason: 'tool_calls' }] }
    })(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
  } }))
  const config = { workDir, globalRoot, globalAuthority:{daemonId:'fixture',globalWorkspaceKey:'global'}, runtimeConfig: { model: 'test/a', mcp: false }, authorization: { permits: () => true, currentGrantsVersion: () => '1' } }
  const request = { principal: { principalId: 'owner', grantsVersion: '1' }, requestId: 'revoke-test' }
  let host = await createHost(config)
  try {
    const directory = await host.participantDirectory!(request), recipient = directory.contacts.find(c => c.recipient.kind === 'holon')!.recipient
    const bootstrap = { bindingKey: 'original-channel', recipient, expectedServerInstanceId: host.capabilities(request).serverInstanceId }
    const binding = await host.openParticipant!(request, bootstrap), selector = { bindingKey: binding.bindingKey }
    await host.submitExecution!(request, {contextCut:emptyContext(), ...selector, recipient, commandId: 'original-message', text: 'Ask for approval' })
    let page = await host.participantWork!(request, selector)
    for (let i = 0; !page.work[0]?.questions[0]?.canAnswer && i < 500; i++) { await Bun.sleep(20); page = await host.participantWork!(request, selector) }
    expect(page.work[0]?.questions[0]?.canAnswer).toBe(true)
    const before = await host.executionOutputPage!(request, selector)
    await rename(join(workDir, '.eidolon/resources/runtimes/Product.xnl'), join(root, 'withdrawn-runtime.xnl'))
    expect((await host.participantDirectory!(request)).contacts.every(c => !c.available && c.unavailableReason === 'admission_missing')).toBe(true)
    page = await host.participantWork!(request, selector)
    expect(page.work[0]!.questions[0]).toMatchObject({ state: 'pending', canAnswer: false, unavailableReason: 'participant_recipient_unavailable' })
    expect(page.settings).toMatchObject({ canSetModel: false, modelUnavailableReason: 'participant_recipient_unavailable' })
    expect(page.settings!.attachments).toBeUndefined()
    await expect(host.controlParticipant!(request, { ...selector, kind: 'answer', commandId: 'original-message', questionnaireId: 'original-question', responseText: 'Q1: yes' })).rejects.toMatchObject({ status: 409, error: { code: 'participant_recipient_unavailable' } })
    await expect(host.controlParticipant!(request, { ...selector, kind: 'set_model', commandId: 'model', modelRef: 'test/a' })).rejects.toMatchObject({ status: 409 })
    await expect(host.submitExecution!(request, {contextCut:emptyContext(), ...selector, recipient, commandId: 'new-message', text: 'new' })).rejects.toMatchObject({ status: 409 })
    await expect(host.openParticipant!(request, bootstrap)).rejects.toMatchObject({ status: 409 })
    expect((await host.executionOutputPage!(request, selector)).outputs).toEqual(before.outputs)
    await host.controlParticipant!(request, { ...selector, kind: 'cancel', commandId: 'original-message', controlId: 'explicit-cancel', expectedRevision: page.work[0]!.revision, occurredAt: new Date().toISOString(), reason: 'Withdrawn admission; stop original work' })
    expect((await host.participantWork!(request, selector)).work[0]!.status).toBe('Cancelled')
    expect(calls).toBe(1)
    await host.close(); host = await createHost(config)
    expect((await host.executionOutputPage!(request, selector)).outputs).toEqual(before.outputs)
    expect((await host.participantWork!(request, selector)).work[0]!.status).toBe('Cancelled')
    expect(calls).toBe(1)
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
}, 40000)
