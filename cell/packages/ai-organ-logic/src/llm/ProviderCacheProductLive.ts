import type { ProviderCacheCostObservation } from "@cell/ai-organ-contract/llm/ProviderCacheCostObservation"

import { compareProviderCacheCostObservations } from "./ProviderCacheCostObservation"
import { ProviderRuntimeLlmAdapter } from "./ProviderRuntimeAdapter"

export type ProviderCacheProductLiveExecutionStatus = "NOT_REQUESTED" | "SKIPPED" | "EXECUTED"
export type ProviderCacheProductLiveEvidenceStatus = "PASS" | "FAIL" | "UNKNOWN"
export type ProviderCacheProductLiveEvidenceClass = "official_deepseek" | "deepseek_compatible"

export type ProviderCacheProductLiveConfig = Readonly<{
  providerId: string
  adapterName: "deepseek"
  profileId: "deepseek-official-chat@1" | "deepseek-compatible-chat@1"
  model: string
  apiKey: string
  baseURL: string
}>

export type ProviderCacheProductLiveRequest = Readonly<{
  requested: boolean
  evidenceClass: ProviderCacheProductLiveEvidenceClass
  config?: ProviderCacheProductLiveConfig
  groupCount?: number
}>

export type ProviderCacheProductLiveGroup = Readonly<{
  groupOrdinal: number
  contextEpoch: number
  epochDigest: string
  requestDigest: string
  retainedPrefixIntegrity: number
  reuseOpportunityCoverage: number
  warmHitTokens: number
  warmMissTokens: number
  followupHitTokens: number
  followupMissTokens: number
  followupHitRate: number
  warmNormalizedInputCost: number
  followupNormalizedInputCost: number
}>

export type ProviderCacheProductLiveReport = Readonly<{
  schemaVersion: "eidolon.provider-cache-product-live-report/v1"
  executionStatus: ProviderCacheProductLiveExecutionStatus
  evidenceStatus: ProviderCacheProductLiveEvidenceStatus
  evidenceClass: ProviderCacheProductLiveEvidenceClass
  gateAuthority: "official_deepseek" | "compatible_observation_only"
  reasonCode:
    | "not_requested"
    | "credential_missing"
    | "invalid_profile_config"
    | "transport_failed"
    | "invalid_final_success_usage"
    | "thresholds_failed"
    | "thresholds_passed"
  providerId: string | null
  profileId: string | null
  model: string | null
  groups: readonly ProviderCacheProductLiveGroup[]
  aggregate: Readonly<{
    p50HitRate: number
    p50NormalizedInputCost: number
    p95NormalizedInputCost: number
  }> | null
}>

const OFFICIAL_PROFILE = "deepseek-official-chat@1"
const COMPATIBLE_PROFILE = "deepseek-compatible-chat@1"

function report(
  request: ProviderCacheProductLiveRequest,
  fields: Pick<ProviderCacheProductLiveReport, "executionStatus" | "evidenceStatus" | "reasonCode">
    & Partial<Pick<ProviderCacheProductLiveReport, "groups" | "aggregate">>,
): ProviderCacheProductLiveReport {
  return Object.freeze({
    schemaVersion: "eidolon.provider-cache-product-live-report/v1",
    executionStatus: fields.executionStatus,
    evidenceStatus: fields.evidenceStatus,
    evidenceClass: request.evidenceClass,
    gateAuthority: request.evidenceClass === "official_deepseek"
      ? "official_deepseek"
      : "compatible_observation_only",
    reasonCode: fields.reasonCode,
    providerId: request.config?.providerId ?? null,
    profileId: request.config?.profileId ?? null,
    model: request.config?.model ?? null,
    groups: Object.freeze([...(fields.groups ?? [])]),
    aggregate: fields.aggregate ? Object.freeze({ ...fields.aggregate }) : null,
  })
}

function isConfigured(request: ProviderCacheProductLiveRequest): request is ProviderCacheProductLiveRequest & {
  config: ProviderCacheProductLiveConfig
} {
  const config = request.config
  return Boolean(config
    && config.adapterName === "deepseek"
    && config.apiKey.length > 0
    && config.model.length > 0
    && /^https:\/\//.test(config.baseURL))
}

function hasExactProfile(request: ProviderCacheProductLiveRequest & { config: ProviderCacheProductLiveConfig }): boolean {
  if (request.evidenceClass === "official_deepseek") {
    try {
      return request.config.providerId === "deepseek"
        && request.config.profileId === OFFICIAL_PROFILE
        && new URL(request.config.baseURL).hostname === "api.deepseek.com"
    } catch {
      return false
    }
  }
  return request.config.profileId === COMPATIBLE_PROFILE
}

function percentile(sorted: readonly number[], quantile: number): number {
  return sorted[Math.ceil((sorted.length - 1) * quantile)]!
}

async function observe(
  adapter: ProviderRuntimeLlmAdapter,
  model: string,
  contextEpoch: number,
  messages: readonly unknown[],
): Promise<ProviderCacheCostObservation | null> {
  const result = await adapter.createStream({
    model,
    messages: messages as any,
    tools: [],
    extraBody: { max_tokens: 2, temperature: 0 },
    providerCacheCostObservation: {
      actorClass: "ordinary",
      contextEpoch,
      tokenEstimates: { toolSurfaceTokens: 0, workflowControlTokens: 0 },
      priceWeights: { cacheHitWeight: 0.1, cacheMissWeight: 1 },
    },
  })
  for await (const _chunk of result.stream) { /* final-success usage is authoritative only after drain */ }
  const output = await result.providerOutput as any
  return output?.provider_cache_cost_observation ?? null
}

export async function runProviderCacheProductLive(
  request: ProviderCacheProductLiveRequest,
): Promise<ProviderCacheProductLiveReport> {
  if (!request.requested) {
    return report(request, { executionStatus: "NOT_REQUESTED", evidenceStatus: "UNKNOWN", reasonCode: "not_requested" })
  }
  if (!isConfigured(request)) {
    return report(request, { executionStatus: "SKIPPED", evidenceStatus: "UNKNOWN", reasonCode: "credential_missing" })
  }
  if (!hasExactProfile(request)) {
    return report(request, { executionStatus: "SKIPPED", evidenceStatus: "UNKNOWN", reasonCode: "invalid_profile_config" })
  }
  const groupCount = request.groupCount ?? 3
  if (!Number.isSafeInteger(groupCount) || groupCount < 3) {
    return report(request, { executionStatus: "SKIPPED", evidenceStatus: "UNKNOWN", reasonCode: "invalid_profile_config" })
  }
  const adapter = new ProviderRuntimeLlmAdapter({
    providerId: request.config.providerId,
    selectedModel: request.config.model,
    adapterName: request.config.adapterName,
    options: {
      apiKey: request.config.apiKey,
      baseURL: request.config.baseURL,
      compatibility_profile: request.config.profileId,
    },
  })
  const groups: ProviderCacheProductLiveGroup[] = []
  try {
    const stableRoot = [
      "You are measuring provider prefix-cache reuse.",
      "Return only OK.",
      "The following stable material is intentionally repeated:",
      "stable-cache-material-".repeat(256),
    ].join("\n")
    for (let groupOrdinal = 1; groupOrdinal <= groupCount; groupOrdinal += 1) {
      const stableMessages = [
        { role: "system", content: `${stableRoot}\ngroup:${groupOrdinal}` },
        { role: "user", content: `stable request group ${groupOrdinal}` },
      ] as const
      const warm = await observe(adapter, request.config.model, groupOrdinal, stableMessages)
      const followup = await observe(adapter, request.config.model, groupOrdinal, [
        ...stableMessages,
        { role: "assistant", content: "OK" },
        { role: "user", content: "return OK again" },
      ])
      const warmUsage = warm?.tokenBreakdown.usage
      const followupUsage = followup?.tokenBreakdown.usage
      if (!warm || !followup || !warmUsage || !followupUsage
        || warm.tokenBreakdown.normalizedInputCost === null
        || followup.tokenBreakdown.normalizedInputCost === null) {
        return report(request, {
          executionStatus: "EXECUTED",
          evidenceStatus: "UNKNOWN",
          reasonCode: "invalid_final_success_usage",
        })
      }
      const comparison = compareProviderCacheCostObservations(warm, followup)
      const followupTotal = followupUsage.cacheHitTokens + followupUsage.cacheMissTokens
      groups.push(Object.freeze({
        groupOrdinal,
        contextEpoch: followup.identity.contextEpoch,
        epochDigest: followup.epochDigest,
        requestDigest: followup.requestDigest,
        retainedPrefixIntegrity: comparison.retainedPrefixIntegrity,
        reuseOpportunityCoverage: comparison.reuseOpportunityCoverage,
        warmHitTokens: warmUsage.cacheHitTokens,
        warmMissTokens: warmUsage.cacheMissTokens,
        followupHitTokens: followupUsage.cacheHitTokens,
        followupMissTokens: followupUsage.cacheMissTokens,
        followupHitRate: followupTotal === 0 ? 0 : followupUsage.cacheHitTokens / followupTotal,
        warmNormalizedInputCost: warm.tokenBreakdown.normalizedInputCost,
        followupNormalizedInputCost: followup.tokenBreakdown.normalizedInputCost,
      }))
    }
  } catch {
    return report(request, { executionStatus: "EXECUTED", evidenceStatus: "UNKNOWN", reasonCode: "transport_failed" })
  }

  const hitRates = groups.map((group) => group.followupHitRate).sort((left, right) => left - right)
  const costs = groups.map((group) => group.followupNormalizedInputCost).sort((left, right) => left - right)
  const aggregate = Object.freeze({
    p50HitRate: percentile(hitRates, 0.5),
    p50NormalizedInputCost: percentile(costs, 0.5),
    p95NormalizedInputCost: percentile(costs, 0.95),
  })
  const passed = groups.every((group) => (
    group.retainedPrefixIntegrity === 1
    && group.followupHitRate >= 0.85
    && group.followupNormalizedInputCost <= 260
  ))
    && aggregate.p50HitRate >= 0.90
    && aggregate.p50NormalizedInputCost <= 248
    && aggregate.p95NormalizedInputCost <= 260
  return report(request, {
    executionStatus: "EXECUTED",
    evidenceStatus: passed ? "PASS" : "FAIL",
    reasonCode: passed ? "thresholds_passed" : "thresholds_failed",
    groups,
    aggregate,
  })
}
