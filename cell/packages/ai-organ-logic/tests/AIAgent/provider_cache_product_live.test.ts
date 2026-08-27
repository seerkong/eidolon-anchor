import { afterEach, describe, expect, test } from "bun:test"

import {
  runProviderCacheProductLive,
  type ProviderCacheProductLiveRequest,
} from "../../src/llm/ProviderCacheProductLive"

const originalFetch = globalThis.fetch

afterEach(() => { globalThis.fetch = originalFetch })

function response(input: Readonly<{ hit?: number; miss?: number; usage?: boolean }> = {}): Response {
  const hit = input.hit ?? 90
  const miss = input.miss ?? 10
  return new Response([
    `data: ${JSON.stringify({
      choices: [{ delta: { content: "OK" }, finish_reason: null }],
      ...(input.usage === false ? {} : {
        usage: {
          prompt_tokens: hit + miss,
          completion_tokens: 2,
          total_tokens: hit + miss + 2,
          prompt_cache_hit_tokens: hit,
          prompt_cache_miss_tokens: miss,
        },
      }),
    })}`,
    "data: [DONE]",
    "",
  ].join("\n\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } })
}

function request(
  evidenceClass: "official_deepseek" | "deepseek_compatible",
  requested = true,
): ProviderCacheProductLiveRequest {
  return {
    requested,
    evidenceClass,
    groupCount: 3,
    config: {
      providerId: evidenceClass === "official_deepseek" ? "deepseek" : "siliconflow",
      adapterName: "deepseek",
      profileId: evidenceClass === "official_deepseek"
        ? "deepseek-official-chat@1"
        : "deepseek-compatible-chat@1",
      model: evidenceClass === "official_deepseek" ? "deepseek-chat" : "deepseek-ai/DeepSeek-V4-Flash",
      apiKey: "must-never-enter-report",
      baseURL: evidenceClass === "official_deepseek"
        ? "https://api.deepseek.com/v1"
        : "https://api.siliconflow.cn/v1",
    },
  }
}

describe("provider cache live evidence axes", () => {
  test("keeps not-requested and absent-credential states honest", async () => {
    expect(await runProviderCacheProductLive({ requested: false, evidenceClass: "official_deepseek" }))
      .toMatchObject({ executionStatus: "NOT_REQUESTED", evidenceStatus: "UNKNOWN", reasonCode: "not_requested" })
    expect(await runProviderCacheProductLive({ requested: true, evidenceClass: "official_deepseek" }))
      .toMatchObject({ executionStatus: "SKIPPED", evidenceStatus: "UNKNOWN", reasonCode: "credential_missing" })
  })

  test("passes only three or more valid official warmed groups", async () => {
    globalThis.fetch = (async () => response()) as typeof fetch
    const report = await runProviderCacheProductLive(request("official_deepseek"))
    expect(report).toMatchObject({
      executionStatus: "EXECUTED",
      evidenceStatus: "PASS",
      evidenceClass: "official_deepseek",
      gateAuthority: "official_deepseek",
      reasonCode: "thresholds_passed",
    })
    expect(report.groups).toHaveLength(3)
    expect(report.groups.every((group) => group.retainedPrefixIntegrity === 1 && group.followupHitRate >= 0.85)).toBe(true)
    expect(report.aggregate).toMatchObject({ p50HitRate: 0.9, p50NormalizedInputCost: 19, p95NormalizedInputCost: 19 })
    expect(JSON.stringify(report)).not.toContain("must-never-enter-report")
  }, 30_000)

  test("reports valid official threshold regressions as FAIL", async () => {
    globalThis.fetch = (async () => response({ hit: 0, miss: 100 })) as typeof fetch
    expect(await runProviderCacheProductLive(request("official_deepseek"))).toMatchObject({
      executionStatus: "EXECUTED",
      evidenceStatus: "FAIL",
      reasonCode: "thresholds_failed",
    })
  }, 30_000)

  test("reports executed malformed/non-final usage and transport failures as UNKNOWN", async () => {
    globalThis.fetch = (async () => response({ usage: false })) as typeof fetch
    expect(await runProviderCacheProductLive(request("official_deepseek"))).toMatchObject({
      executionStatus: "EXECUTED",
      evidenceStatus: "UNKNOWN",
      reasonCode: "invalid_final_success_usage",
    })
    globalThis.fetch = (async () => { throw new Error("fixture transport failed") }) as typeof fetch
    const failed = await runProviderCacheProductLive(request("official_deepseek"))
    expect(failed).toMatchObject({ executionStatus: "EXECUTED", evidenceStatus: "UNKNOWN", reasonCode: "transport_failed" })
    expect(JSON.stringify(failed)).not.toContain("fixture transport failed")
  }, 30_000)

  test("keeps compatible evidence separately observable and non-authoritative", async () => {
    globalThis.fetch = (async () => response()) as typeof fetch
    const compatible = await runProviderCacheProductLive(request("deepseek_compatible"))
    expect(compatible).toMatchObject({
      executionStatus: "EXECUTED",
      evidenceStatus: "PASS",
      evidenceClass: "deepseek_compatible",
      gateAuthority: "compatible_observation_only",
    })
    expect(compatible.profileId).toBe("deepseek-compatible-chat@1")
    expect(compatible.gateAuthority).not.toBe("official_deepseek")
  }, 30_000)
})
