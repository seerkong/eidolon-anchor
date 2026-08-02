import { afterEach, describe, expect, it } from "bun:test"

import { parseProviderCatalogRaw } from "@cell/ai-organ-logic/llm"
import {
  __setRuntimeCatalogAssemblyFactoryForTest,
  createRuntimeCatalog,
} from "../src/runtime/catalog/TuiRuntimeCatalog"

afterEach(() => __setRuntimeCatalogAssemblyFactoryForTest(null))

describe("TUI runtime catalog model modalities", () => {
  it("projects configured capabilities across model switches and never invents image/pdf for missing modalities", () => {
    const providerConfig = parseProviderCatalogRaw({
      providers: [{
        id: "mixed",
        adapter: "openai",
        options: { baseURL: "https://api.example/v1", apiKey: "secret" },
        models: [
          {
            id: "vision",
            limits: { context: 128_000, output: 8_192 },
            modalities: { input: ["text", "image"], output: ["text"] },
          },
          {
            id: "text-only",
            limits: { context: 128_000, output: 8_192 },
            modalities: { input: ["text"], output: ["text"] },
          },
          {
            id: "unspecified",
            limits: { context: 128_000, output: 8_192 },
          },
        ],
      }],
    })

    __setRuntimeCatalogAssemblyFactoryForTest(() => ({
      agentConfigs: {},
      runtimeCatalog: {
        loadConfigBundle: () => ({
          providerConfig,
          presetConfig: {
            preset: "default",
            presets: { default: { main: { model: "mixed/vision" } } },
          },
        } as any),
      },
    } as any))

    const catalog = createRuntimeCatalog("local-runtime", "C:\\workspace")
    const models = catalog.providers[0]?.models ?? {}

    expect(models.vision?.capabilities.input).toMatchObject({ text: true, image: true, pdf: false })
    expect(models.vision?.capabilities.attachment).toBe(true)
    expect(models["text-only"]?.capabilities.input).toMatchObject({ text: true, image: false, pdf: false })
    expect(models["text-only"]?.capabilities.attachment).toBe(false)
    expect(models.unspecified?.capabilities.input).toMatchObject({ image: false, pdf: false })

    const listed = catalog.providerList.all[0]?.models ?? {}
    expect(listed.vision?.attachment).toBe(true)
    expect(listed["text-only"]?.attachment).toBe(false)
    expect(listed.unspecified?.attachment).toBe(false)
  })
})
