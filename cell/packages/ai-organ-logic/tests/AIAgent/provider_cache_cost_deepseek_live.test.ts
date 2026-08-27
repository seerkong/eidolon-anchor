import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProviderRuntimeLlmAdapter } from "../../src/llm/ProviderRuntimeAdapter";
import { compareProviderCacheCostObservations } from "../../src/llm/ProviderCacheCostObservation";

type LiveProvider = Readonly<{
  id: string;
  adapter: string;
  options: Readonly<{ apiKey: string; baseURL: string }>;
  models: ReadonlyArray<Readonly<{ id: string }>> | Readonly<Record<string, Readonly<{ id: string }>>>;
}>;

function readOfficialDeepSeekProvider(): LiveProvider {
  const configPath = join(homedir(), ".eidolon", "llm-provider.json");
  if (!existsSync(configPath)) throw new Error("official_deepseek_credential_missing");
  const catalog = JSON.parse(readFileSync(configPath, "utf8")) as { providers?: unknown };
  const candidates = Array.isArray(catalog.providers)
    ? catalog.providers
    : catalog.providers && typeof catalog.providers === "object"
      ? Object.entries(catalog.providers).map(([id, value]) => ({ id, ...(value as object) }))
      : [];
  const provider = candidates.find((candidate: any) => (
    candidate?.id === "deepseek"
    && candidate?.adapter === "deepseek"
    && typeof candidate?.options?.apiKey === "string"
    && candidate.options.apiKey.length > 0
    && typeof candidate?.options?.baseURL === "string"
    && candidate.options.baseURL.startsWith("https://api.deepseek.com")
  ));
  if (!provider) throw new Error("official_deepseek_credential_missing");
  return provider as LiveProvider;
}

function firstModel(provider: LiveProvider): string {
  const models = Array.isArray(provider.models) ? provider.models : Object.values(provider.models ?? {});
  const model = models.find((candidate) => typeof candidate?.id === "string" && candidate.id.length > 0)?.id;
  if (!model) throw new Error("official_deepseek_model_missing");
  return model;
}

const live = process.env.EIDOLON_DEEPSEEK_LIVE === "1" ? test : test.skip;

live("records three warmed official DeepSeek groups without mixing compatible providers", async () => {
  const provider = readOfficialDeepSeekProvider();
  const model = firstModel(provider);
  const adapter = new ProviderRuntimeLlmAdapter({
    providerId: "deepseek",
    selectedModel: model,
    adapterName: "deepseek",
    options: {
      apiKey: provider.options.apiKey,
      baseURL: provider.options.baseURL,
      compatibility_profile: "deepseek-official-chat@1",
    },
  });
  const results: Array<Record<string, number | string>> = [];
  const stableRoot = [
    "You are measuring provider prefix-cache reuse.",
    "Return only OK.",
    "The following stable material is intentionally repeated:",
    "stable-cache-material-".repeat(256),
  ].join("\n");

  for (let group = 1; group <= 3; group += 1) {
    const stableMessages = [
      { role: "system", content: `${stableRoot}\ngroup:${group}` },
      { role: "user", content: `stable request group ${group}` },
    ];
    const observations: any[] = [];
    for (const messages of [
      stableMessages,
      [...stableMessages, { role: "assistant", content: "OK" }, { role: "user", content: "return OK again" }],
    ]) {
      const result = await adapter.createStream({
        model,
        messages,
        tools: [],
        extraBody: { max_tokens: 2, temperature: 0 },
        providerCacheCostObservation: {
          actorClass: "ordinary",
          contextEpoch: group,
          tokenEstimates: { toolSurfaceTokens: 0, workflowControlTokens: 0 },
          priceWeights: { cacheHitWeight: 0.1, cacheMissWeight: 1 },
        },
      });
      for await (const _chunk of result.stream) {
        // Full consumption is required before final-success usage is accepted.
      }
      const output = await result.providerOutput as any;
      observations.push(output?.provider_cache_cost_observation);
    }
    const warmUsage = observations[0]?.tokenBreakdown?.usage;
    const followupUsage = observations[1]?.tokenBreakdown?.usage;
    expect(warmUsage).not.toBeNull();
    expect(followupUsage).not.toBeNull();
    const comparison = compareProviderCacheCostObservations(observations[0], observations[1]);
    expect(comparison.retainedPrefixIntegrity).toBe(1);
    const hit = followupUsage.cacheHitTokens;
    const miss = followupUsage.cacheMissTokens;
    results.push({
      group,
      contextEpoch: observations[1].identity.contextEpoch,
      epochDigest: observations[1].epochDigest,
      requestDigest: observations[1].requestDigest,
      retainedPrefixIntegrity: comparison.retainedPrefixIntegrity,
      reuseOpportunityCoverage: comparison.reuseOpportunityCoverage,
      warmHitTokens: warmUsage.cacheHitTokens,
      warmMissTokens: warmUsage.cacheMissTokens,
      followupHitTokens: hit,
      followupMissTokens: miss,
      followupProviderHitRate: hit + miss === 0 ? 0 : hit / (hit + miss),
      warmNormalizedInputCost: observations[0].tokenBreakdown.normalizedInputCost,
      followupNormalizedInputCost: observations[1].tokenBreakdown.normalizedInputCost,
    });
  }

  expect(results).toHaveLength(3);
  const hitRates = results.map((row) => Number(row.followupProviderHitRate)).sort((left, right) => left - right);
  const costs = results.map((row) => Number(row.followupNormalizedInputCost)).sort((left, right) => left - right);
  const p50HitRate = hitRates[Math.floor((hitRates.length - 1) * 0.5)]!;
  const p50Cost = costs[Math.floor((costs.length - 1) * 0.5)]!;
  const p95Cost = costs[Math.ceil((costs.length - 1) * 0.95)]!;
  expect(hitRates.every((rate) => rate >= 0.85)).toBe(true);
  expect(p50HitRate).toBeGreaterThanOrEqual(0.90);
  expect(costs.every((cost) => cost <= 260)).toBe(true);
  expect(p50Cost).toBeLessThanOrEqual(248);
  expect(p95Cost).toBeLessThanOrEqual(260);
  console.log(`DEEPSEEK_CACHE_BASELINE ${JSON.stringify({ provider: "deepseek_official", model, groups: results })}`);
}, 180_000);
