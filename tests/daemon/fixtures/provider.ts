// Explicit test-only preload: actual workers and owners, deterministic provider, no network calls.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { __setLlmAdapterFactoryForTest } from '@cell/ai-runtime-host-capsule/session/SessionRuntimeAssembly'
import { projectInputContentText } from '@shared/composer'
import { createMockProviderCacheCostObservation } from '../../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream'

__setLlmAdapterFactoryForTest(async (_adapter, workDir) => ({
  type: 'openai', runtime: { adapterName: 'openai', providerId: 'fixture' },
  async createStream(options: any) {
    const text = projectInputContentText(options.messages.filter((m: any) => m.role === 'user').at(-1).content)
    appendFileSync(join(workDir!, 'provider-calls.jsonl'), JSON.stringify({ text }) + '\n')
    return { stream: (async function* () {
      yield { choices: [{ delta: { content: `controlled:${text}` } }] }
      if (text.includes('crash-worker')) process.exit(71)
      if (text.includes('slow-turn')) await Bun.sleep(2500)
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] }
    })(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
  },
}))
