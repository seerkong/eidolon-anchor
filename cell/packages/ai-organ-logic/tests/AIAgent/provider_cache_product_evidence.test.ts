import { describe, expect, test } from "bun:test"

import {
  PROVIDER_CACHE_PRODUCT_EPOCH_REASON_MATRIX,
  PROVIDER_CACHE_PRODUCT_FROZEN_SCENARIO_IDS,
  runProviderCacheProductMatrix,
} from "../../src/llm/ProviderCacheProductMatrix"

describe("provider cache product evidence boundary", () => {
  test("keeps signing authority lexical-private and exposes only closed evidence vocabulary", async () => {
    const direct = await import("../../src/llm/internal/ProviderCacheProductEvidenceAuthority")
    expect(Object.keys(direct)).toEqual([])
    expect(PROVIDER_CACHE_PRODUCT_EPOCH_REASON_MATRIX["epoch.reset/v1"]).toBeNull()
    expect(PROVIDER_CACHE_PRODUCT_FROZEN_SCENARIO_IDS.length).toBe(18)
  })

  test("rejects synthetic, duplicate and caller-controlled proof inputs", async () => {
    for (const forged of [
      { mode: "deterministic", repository: new Map() },
      { mode: "deterministic", receipts: [] },
      { mode: "deterministic", scenarios: [...PROVIDER_CACHE_PRODUCT_FROZEN_SCENARIO_IDS] },
      { mode: "deterministic", report: { structuralStatus: "PASS" } },
    ]) {
      await expect(runProviderCacheProductMatrix(forged as any)).rejects.toThrow(/input_not_closed/)
    }
  })
})
