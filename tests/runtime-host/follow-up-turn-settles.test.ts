import { afterEach, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { installBundledSystemSkills } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import {
  createSessionRuntimeAssembly,
  __setLlmAdapterFactoryForTest,
} from "@cell/ai-runtime-host-capsule/session/SessionRuntimeAssembly"
import { projectInputContentText } from "@shared/composer"
import { createMockProviderCacheCostObservation } from "../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream"

afterEach(() => __setLlmAdapterFactoryForTest(null))

it("settles a follow-up turn after the TUI reasserts the active model", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-follow-up-turn-"))
  const workDir = path.join(root, "workspace")
  const globalRoot = path.join(root, "authority")
  fs.mkdirSync(globalRoot, { recursive: true })
  fs.mkdirSync(path.join(workDir, ".eidolon"), { recursive: true })
  fs.writeFileSync(path.join(globalRoot, "llm-provider.json"), JSON.stringify({
    providers: [{
      id: "openai",
      adapter: "openai",
      options: { baseURL: "http://127.0.0.1:9", apiKey: "test" },
      models: [{ id: "gpt-4o-mini", limits: { context: 128000, output: 8192 } }],
    }],
  }))
  __setLlmAdapterFactoryForTest(async () => ({
    type: "openai",
    runtime: { adapterName: "openai", providerId: "openai", chatCompatibilityProfileId: "openai-chat@1" },
    async createStream(options: any) {
      const text = projectInputContentText(options.messages.filter((row: any) => row.role === "user").at(-1)?.content)
      async function* stream() {
        yield { choices: [{ delta: { content: `reply:${text}` } }] }
        yield { choices: [{ delta: {}, finish_reason: "stop" }] }
      }
      return {
        stream: stream(),
        providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }),
      }
    },
  }))
  await installBundledSystemSkills({ globalRoot })
  const bridge = await createSessionRuntimeAssembly({
    sessionKey: "follow-up-turn",
    config: { workDir, globalRoot, adapter: "openai", model: "gpt-4o-mini", mcp: false, profileId: "ai-coding" },
  })
  try {
    await expect(bridge!.turn("你是谁")).resolves.toContain("reply:你是谁")
    await bridge!.setActorActiveModel?.({}, { providerID: "openai", modelID: "gpt-4o-mini" })
    await expect(bridge!.turn("你的模型版本是多少")).resolves.toContain("reply:你的模型版本是多少")
  } finally {
    await bridge?.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 20_000)
