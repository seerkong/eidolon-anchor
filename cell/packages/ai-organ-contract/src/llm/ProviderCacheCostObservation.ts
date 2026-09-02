export const PROVIDER_CACHE_OBSERVATION_SCHEMA_VERSION = 1 as const;

export type ProviderCacheActorClass =
  | "ordinary"
  | "workflow_lifecycle"
  | "workflow_node";

export type ProviderCacheProfile =
  | "deepseek"
  /** @deprecated persisted migration input only */
  | "deepseek_official"
  /** @deprecated persisted migration input only */
  | "deepseek_compatible"
  | "other";

/** Versioned cache-unit authority selected explicitly by the provider adapter. */
export type ProviderCacheProfileId =
  | "deepseek-chat@1"
  /** @deprecated persisted migration input only */
  | "deepseek-official-chat@1"
  /** @deprecated persisted migration input only */
  | "deepseek-compatible-chat@1";

export type ProviderCacheRelevantUnitKind =
  | "message"
  | "tool_schema"
  /** Versioned chat-template/model framing; completion-side controls are excluded. */
  | "request_prefix";

/**
 * Exact identity of one comparable provider request family.
 * Provider/profile/model/epoch changes are boundaries, not prefix failures.
 */
export type ProviderCacheCostObservationIdentity = Readonly<{
  schemaVersion: typeof PROVIDER_CACHE_OBSERVATION_SCHEMA_VERSION;
  providerId: string;
  providerProfile: ProviderCacheProfile;
  providerProfileId: ProviderCacheProfileId;
  model: string;
  actorClass: ProviderCacheActorClass;
  contextEpoch: number;
}>;

/**
 * Value-safe final-wire material descriptor. The digest and length describe
 * serialized provider bytes; the original value is intentionally absent.
 */
export type ProviderCacheRelevantUnit = Readonly<{
  ordinal: number;
  kind: ProviderCacheRelevantUnitKind;
  byteLength: number;
  digest: string;
}>;

export type ProviderCachePrefixDivergence = Readonly<{
  ordinal: number;
  reason: "unit_missing" | "kind_changed" | "digest_changed" | "byte_length_changed";
  priorKind: ProviderCacheRelevantUnitKind | null;
  currentKind: ProviderCacheRelevantUnitKind | null;
  priorDigest: string | null;
  currentDigest: string | null;
}>;

/**
 * retainedPrefixIntegrity uses the prior request denominator and proves that
 * an old prefix was retained. reuseOpportunityCoverage uses the current
 * request denominator and measures how much of the new request may be reused.
 */
export type ProviderCachePrefixComparison = Readonly<{
  relation: "same_epoch" | "epoch_boundary";
  priorUnitCount: number;
  currentUnitCount: number;
  exactLcpUnitCount: number;
  priorByteLength: number;
  currentByteLength: number;
  exactLcpByteLength: number;
  retainedPrefixIntegrity: number;
  reuseOpportunityCoverage: number;
  firstDivergence: ProviderCachePrefixDivergence | null;
}>;

export type ProviderCacheUsageTokens = Readonly<{
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}>;

export type ProviderCachePriceWeights = Readonly<{
  cacheHitWeight: number;
  cacheMissWeight: number;
}>;

export type ProviderCacheTokenBreakdown = Readonly<{
  /** Diagnostic estimate derived from the exact admitted serialized request bytes. */
  finalWireInputTokens: number;
  toolSurfaceTokens: number;
  workflowControlTokens: number;
  usage: ProviderCacheUsageTokens | null;
  priceWeights: ProviderCachePriceWeights | null;
  normalizedInputCost: number | null;
}>;

export type ProviderCacheCostObservation = Readonly<{
  identity: ProviderCacheCostObservationIdentity;
  /** Digest of the closed provider/profile/model/Actor/epoch identity. */
  epochDigest: string;
  /** Digest of the complete serialized wire request, including output controls. */
  requestDigest: string;
  /** Provider prompt-cache input units; intentionally narrower than requestDigest. */
  units: readonly ProviderCacheRelevantUnit[];
  tokenBreakdown: ProviderCacheTokenBreakdown;
}>;
