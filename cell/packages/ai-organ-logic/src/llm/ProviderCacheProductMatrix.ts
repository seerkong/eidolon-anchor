import {
  PROVIDER_CACHE_PRODUCT_EPOCH_REASON_MATRIX,
  PROVIDER_CACHE_PRODUCT_FROZEN_SCENARIO_IDS,
  runProviderCacheProductMatrix as runClosedProviderCacheProductMatrix,
  type ProviderCacheProductMatrixJourney,
  type ProviderCacheProductMatrixResult,
} from "./internal/ProviderCacheProductEvidenceRuntime"

export {
  PROVIDER_CACHE_PRODUCT_EPOCH_REASON_MATRIX,
  PROVIDER_CACHE_PRODUCT_FROZEN_SCENARIO_IDS,
}

export type {
  ProviderCacheProductMatrixJourney,
  ProviderCacheProductMatrixResult,
}

type ClosedMatrixInput = Readonly<{ mode: "deterministic" }>

export function runProviderCacheProductMatrix(
  input: ClosedMatrixInput,
): Promise<ProviderCacheProductMatrixResult> {
  return runClosedProviderCacheProductMatrix(input)
}
