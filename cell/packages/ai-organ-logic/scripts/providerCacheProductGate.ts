import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  runProviderCacheProductLive,
  type ProviderCacheProductLiveConfig,
} from "../src/llm/ProviderCacheProductLive"
import { runProviderCacheProductMatrix } from "../src/llm/ProviderCacheProductMatrix"

const deterministicTests = Object.freeze([
  "tests/AIAgent/provider_cache_product_evidence.test.ts",
  "tests/AIAgent/provider_cache_product_closed_matrix.test.ts",
  "tests/AIAgent/provider_cache_product_e2e.test.ts",
  "tests/AIAgent/provider_cache_product_live.test.ts",
  "tests/workflow/provider_cache_product_lifecycle_e2e.test.ts",
  "tests/workflow/workflow_surface_product_journey.test.ts",
  "tests/AIAgent/runtime/provider_context_epoch_transition.test.ts",
])

type LiveMode = "none" | "deepseek" | "official" | "compatible" | "all"

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`
}

async function run(command: readonly string[], env: Record<string, string> = {}): Promise<string> {
  const child = Bun.spawn(command, {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  process.stdout.write(stdout)
  process.stderr.write(stderr)
  if (exitCode !== 0) throw new Error(`provider cache product gate failed (${command.join(" ")})`)
  return stdout
}

function readLiveConfig(): ProviderCacheProductLiveConfig | undefined {
  const configPath = join(homedir(), ".eidolon", "llm-provider.json")
  if (!existsSync(configPath)) return undefined
  const catalog = JSON.parse(readFileSync(configPath, "utf8")) as { providers?: unknown }
  const candidates = Array.isArray(catalog.providers)
    ? catalog.providers
    : catalog.providers && typeof catalog.providers === "object"
      ? Object.entries(catalog.providers).map(([id, value]) => ({ id, ...(value as object) }))
      : []
  const preferredProviderId = process.env.EIDOLON_PROVIDER_CACHE_PROVIDER?.trim()
  const deepSeekProviders = candidates.filter((candidate: any) => candidate?.adapter === "deepseek")
  const provider = (preferredProviderId
    ? deepSeekProviders.find((candidate: any) => candidate?.id === preferredProviderId)
    : undefined) ?? deepSeekProviders[0]
  const models = Array.isArray(provider?.models) ? provider.models : Object.values(provider?.models ?? {})
  const model = models.find((candidate: any) => typeof candidate?.id === "string" && /deepseek/i.test(candidate.id))?.id
    ?? models.find((candidate: any) => typeof candidate?.id === "string")?.id
  if (provider?.adapter !== "deepseek"
    || typeof provider?.options?.apiKey !== "string"
    || typeof provider?.options?.baseURL !== "string"
    || typeof model !== "string") return undefined
  return {
    providerId: provider.id,
    adapterName: "deepseek",
    profileId: "deepseek-chat@1",
    model,
    apiKey: provider.options.apiKey,
    baseURL: provider.options.baseURL,
  }
}

const liveMode = (process.env.EIDOLON_PROVIDER_CACHE_LIVE ?? "none") as LiveMode
if (!["none", "deepseek", "official", "compatible", "all"].includes(liveMode)) {
  throw new Error("EIDOLON_PROVIDER_CACHE_LIVE must be none|deepseek")
}

await run(["bun", "test", ...deterministicTests])
const matrix = await runProviderCacheProductMatrix({ mode: "deterministic" })

let deepseek: unknown = {
  executionStatus: "NOT_REQUESTED",
  evidenceStatus: "UNKNOWN",
  gateAuthority: "deepseek",
}
if (liveMode !== "none") {
  deepseek = await runProviderCacheProductLive({
    requested: true,
    evidenceClass: "deepseek",
    config: readLiveConfig(),
    groupCount: 3,
  })
  console.log(`DEEPSEEK_OBSERVATION ${canonical(deepseek)}`)
}

const payload = Object.freeze({
  schemaVersion: "eidolon.provider-cache-product-gate-report/v1",
  actorClasses: matrix.actorClasses,
  deterministic: Object.freeze({
    evidenceClass: "fixture",
    structuralStatus: matrix.structuralStatus,
    unexplainedLocalDivergences: matrix.unexplainedLocalDivergences,
    aggregateProviderMissPolicy: "grouped_slo_only",
    frozenBounds: matrix.bounds,
    fixtureUsage: matrix.fixtureUsage,
    compositeAdversarialRejections: matrix.compositeAdversarialRejections,
    journeys: matrix.journeys.map((journey) => Object.freeze({
      scenarioId: journey.scenarioId,
      actorClass: journey.actorClass,
      epochReasons: journey.epochReasons,
      normalizedInputCost: journey.normalizedInputCost,
      cacheHitTokens: journey.cacheHitTokens,
      cacheMissTokens: journey.cacheMissTokens,
      stepCount: journey.stepCount,
      bounds: journey.bounds,
      firstDivergence: journey.firstDivergence,
      unexplainedLocalDivergences: journey.unexplainedLocalDivergences,
      provenance: journey.provenance,
      verified: journey.verified,
      childReceiptCount: journey.childReceiptCount,
      providerCallCount: journey.providerCallCount,
      recoveryStepCount: journey.recoveryStepCount,
      compositeVerified: journey.compositeVerified,
    })),
    strategyProof: matrix.strategyProof,
  }),
  epochReasons: matrix.epochReasonOccurrences,
  evidence: Object.freeze({ fixture: matrix.structuralStatus, deepseek }),
  scenarioIds: matrix.scenarioIds,
})
const canonicalPayload = canonical(payload)
const report = Object.freeze({
  ...payload,
  reportDigest: `sha256:${createHash("sha256").update(canonicalPayload, "utf8").digest("hex")}`,
})
console.log(`PROVIDER_CACHE_PRODUCT_REPORT ${canonical(report)}`)
