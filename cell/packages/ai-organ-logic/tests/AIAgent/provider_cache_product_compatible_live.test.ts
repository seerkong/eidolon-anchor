import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { runProviderCacheProductLive } from "../../src/llm/ProviderCacheProductLive"

type CatalogProvider = Readonly<{
  id: string
  adapter: string
  options: Readonly<{ apiKey: string; baseURL: string }>
  models: ReadonlyArray<Readonly<{ id: string }>> | Readonly<Record<string, Readonly<{ id: string }>>>
}>

function readCompatibleProvider(): CatalogProvider | undefined {
  const requestedProviderId = process.env.EIDOLON_DEEPSEEK_COMPATIBLE_PROVIDER?.trim()
  const configPath = join(homedir(), ".eidolon", "llm-provider.json")
  if (!existsSync(configPath)) return undefined
  const catalog = JSON.parse(readFileSync(configPath, "utf8")) as { providers?: unknown }
  const candidates = Array.isArray(catalog.providers)
    ? catalog.providers
    : catalog.providers && typeof catalog.providers === "object"
      ? Object.entries(catalog.providers).map(([id, value]) => ({ id, ...(value as object) }))
      : []
  return candidates.filter((candidate: any) => (
    candidate?.id !== "deepseek"
    && candidate?.adapter === "deepseek"
    && typeof candidate?.options?.apiKey === "string"
    && candidate.options.apiKey.length > 0
    && typeof candidate?.options?.baseURL === "string"
    && candidate.options.baseURL.startsWith("https://")
  )).sort((left: any, right: any) => (
    Number(right.id === requestedProviderId) - Number(left.id === requestedProviderId)
    || Number(right.id === "siliconflow") - Number(left.id === "siliconflow")
  ))[0] as CatalogProvider | undefined
}

const live = process.env.EIDOLON_DEEPSEEK_COMPATIBLE_LIVE === "1" ? test : test.skip

live("records compatible-provider evidence without granting official authority", async () => {
  const provider = readCompatibleProvider()
  const models = Array.isArray(provider?.models) ? provider.models : Object.values(provider?.models ?? {})
  const requestedModelId = process.env.EIDOLON_DEEPSEEK_COMPATIBLE_MODEL?.trim()
  const model = models.find((candidate) => candidate.id === requestedModelId)?.id
    ?? models.find((candidate) => candidate.id.includes("DeepSeek") || candidate.id.includes("deepseek"))?.id
  const result = await runProviderCacheProductLive({
    requested: true,
    evidenceClass: "deepseek_compatible",
    ...(provider && model ? {
      groupCount: 3,
      config: {
        providerId: provider.id,
        adapterName: "deepseek",
        profileId: "deepseek-compatible-chat@1",
        model,
        apiKey: provider.options.apiKey,
        baseURL: provider.options.baseURL,
      },
    } : {}),
  })
  expect(result.gateAuthority).toBe("compatible_observation_only")
  expect(result.evidenceClass).toBe("deepseek_compatible")
  expect(result.gateAuthority).not.toBe("official_deepseek")
  if (provider && model) {
    expect(result.executionStatus).toBe("EXECUTED")
    expect(["PASS", "FAIL", "UNKNOWN"]).toContain(result.evidenceStatus)
  } else {
    expect(result).toMatchObject({ executionStatus: "SKIPPED", evidenceStatus: "UNKNOWN" })
  }
  console.log(`DEEPSEEK_COMPATIBLE_OBSERVATION ${JSON.stringify(result)}`)
}, 180_000)
