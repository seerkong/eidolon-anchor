// Explicit Bun test preload for the real CLI. Production serve never imports this file.
import { __setLlmAdapterFactoryForTest } from "@cell/ai-runtime-host-capsule/session/SessionRuntimeAssembly"
import { projectInputContentText } from "@shared/composer"
import { createMockProviderCacheCostObservation } from "../../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream"

__setLlmAdapterFactoryForTest(async () => ({
  type: "openai", runtime: { adapterName: "openai", providerId: "openai" },
  async createStream(options: any) {
    const text = projectInputContentText(options.messages.filter((message: any) => message.role === "user").at(-1).content)
    return {
      stream: (async function* () {
        yield { choices: [{ delta: { content: `controlled-cli:${text}` } }] }
        yield { choices: [{ delta: {}, finish_reason: "stop" }] }
      })(),
      providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }),
    }
  },
}))
