import { describe, expect, test } from "bun:test";
import {
  PROVIDER_CACHE_OBSERVATION_SCHEMA_VERSION,
  type ProviderCacheCostObservationIdentity,
  type ProviderCachePrefixComparison,
  type ProviderCacheRelevantUnit,
} from "@cell/ai-organ-contract/llm/ProviderCacheCostObservation";
import {
  bindProviderCacheUsageToObservation,
  compareProviderCacheCostObservations,
  createProviderCacheCostObservation,
} from "../../src/llm/ProviderCacheCostObservation";
import { normalizeProviderCacheUsageTokens } from "../../src/llm/ProviderCacheUsage";
import { buildBuiltinToolDefs } from "../../src/composer/AIAgent/ToolFuncBuiltin";

describe("provider cache-cost observation contract", () => {
  test("names the actor/provider/epoch identity and both prefix denominators", () => {
    const identity: ProviderCacheCostObservationIdentity = {
      schemaVersion: PROVIDER_CACHE_OBSERVATION_SCHEMA_VERSION,
      providerId: "deepseek",
      providerProfile: "deepseek_official",
      providerProfileId: "deepseek-official-chat@1",
      model: "deepseek-chat",
      actorClass: "workflow_lifecycle",
      contextEpoch: 7,
    };
    const units: ProviderCacheRelevantUnit[] = [
      { ordinal: 0, kind: "message", byteLength: 12, digest: "sha256:prior" },
    ];
    const comparison: ProviderCachePrefixComparison = {
      relation: "same_epoch",
      priorUnitCount: 1,
      currentUnitCount: 2,
      exactLcpUnitCount: 1,
      priorByteLength: 12,
      currentByteLength: 20,
      exactLcpByteLength: 12,
      retainedPrefixIntegrity: 1,
      reuseOpportunityCoverage: 0.5,
      firstDivergence: null,
    };

    expect(identity).toEqual({
      schemaVersion: 1,
      providerId: "deepseek",
      providerProfile: "deepseek_official",
      providerProfileId: "deepseek-official-chat@1",
      model: "deepseek-chat",
      actorClass: "workflow_lifecycle",
      contextEpoch: 7,
    });
    expect(units[0]?.digest).toBe("sha256:prior");
    expect(comparison.retainedPrefixIntegrity).toBe(1);
    expect(comparison.reuseOpportunityCoverage).toBe(0.5);
  });

  test("derives value-safe units from final serialized request bytes", () => {
    const body = JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: "stable root" },
        { role: "user", content: "secret user value" },
      ],
      tools: [
        { type: "function", function: { name: "Read", description: "read secret", parameters: { type: "object" } } },
      ],
      stream: true,
    });
    const observation = createProviderCacheCostObservation({
      identity: {
        schemaVersion: 1,
        providerId: "deepseek",
        providerProfile: "deepseek_official",
        providerProfileId: "deepseek-official-chat@1",
        model: "deepseek-chat",
        actorClass: "ordinary",
        contextEpoch: 0,
      },
      serializedRequestBody: body,
      tokenEstimates: {
        toolSurfaceTokens: 12,
        workflowControlTokens: 0,
      },
    });

    expect(observation.units.map((unit) => unit.kind)).toEqual([
      "request_prefix",
      "tool_schema",
      "message",
      "message",
    ]);
    expect(JSON.stringify(observation)).not.toContain("secret user value");
    expect(JSON.stringify(observation)).not.toContain("read secret");
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(observation.units)).toBe(true);
  });

  test("keeps ordinary, Workflow lifecycle, and Workflow node actor families independent", () => {
    const observe = (actorClass: "ordinary" | "workflow_lifecycle" | "workflow_node") =>
      createProviderCacheCostObservation({
        identity: {
          schemaVersion: 1,
          providerId: "deepseek",
          providerProfile: "deepseek_official",
          providerProfileId: "deepseek-official-chat@1",
          model: "deepseek-chat",
          actorClass,
          contextEpoch: 0,
        },
        serializedRequestBody: JSON.stringify({ model: "deepseek-chat", messages: [], tools: [] }),
        tokenEstimates: { toolSurfaceTokens: 0, workflowControlTokens: 0 },
      });

    expect([
      observe("ordinary").identity.actorClass,
      observe("workflow_lifecycle").identity.actorClass,
      observe("workflow_node").identity.actorClass,
    ]).toEqual(["ordinary", "workflow_lifecycle", "workflow_node"]);
  });

  test("separates prior-prefix integrity from current reuse opportunity", () => {
    const identity = {
      schemaVersion: 1 as const,
      providerId: "deepseek",
      providerProfile: "deepseek_official" as const,
      providerProfileId: "deepseek-official-chat@1" as const,
      model: "deepseek-chat",
      actorClass: "workflow_lifecycle" as const,
      contextEpoch: 4,
    };
    const prior = createProviderCacheCostObservation({
      identity,
      serializedRequestBody: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "system", content: "root" }, { role: "user", content: "one" }],
        tools: [],
      }),
      tokenEstimates: { toolSurfaceTokens: 0, workflowControlTokens: 1 },
    });
    const current = createProviderCacheCostObservation({
      identity,
      serializedRequestBody: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "root" },
          { role: "user", content: "one" },
          { role: "assistant", content: "reply" },
        ],
        tools: [],
      }),
      tokenEstimates: { toolSurfaceTokens: 0, workflowControlTokens: 1 },
    });
    const comparison = compareProviderCacheCostObservations(prior, current);

    expect(comparison.retainedPrefixIntegrity).toBe(1);
    expect(comparison.reuseOpportunityCoverage).toBe(3 / 4);
    expect(comparison.firstDivergence).toBeNull();
  });

  test("detects a byte-level wire change even when parsed JSON values are equal", () => {
    const identity = {
      schemaVersion: 1 as const,
      providerId: "deepseek",
      providerProfile: "deepseek_official" as const,
      providerProfileId: "deepseek-official-chat@1" as const,
      model: "deepseek-chat",
      actorClass: "ordinary" as const,
      contextEpoch: 2,
    };
    const observe = (serializedRequestBody: string) => createProviderCacheCostObservation({
      identity,
      serializedRequestBody,
      tokenEstimates: { toolSurfaceTokens: 0, workflowControlTokens: 0 },
    });
    const compact = observe('{"model":"deepseek-chat","messages":[{"role":"user","content":"one"}],"tools":[]}');
    const spaced = observe('{"model": "deepseek-chat", "messages": [{"role":"user","content":"one"}], "tools": []}');

    expect(compareProviderCacheCostObservations(compact, spaced).retainedPrefixIntegrity).toBe(0);
    expect(compareProviderCacheCostObservations(compact, spaced).firstDivergence?.ordinal).toBe(0);
  });

  test("detects current dynamic Workflow prefix mutation and global tool leakage", () => {
    const identity = {
      schemaVersion: 1 as const,
      providerId: "siliconflow",
      providerProfile: "deepseek_compatible" as const,
      providerProfileId: "deepseek-compatible-chat@1" as const,
      model: "deepseek-ai/DeepSeek-V4-Flash",
      actorClass: "workflow_lifecycle" as const,
      contextEpoch: 1,
    };
    const build = (remaining: number) => createProviderCacheCostObservation({
      identity,
      serializedRequestBody: JSON.stringify({
        model: identity.model,
        messages: [
          {
            role: "system",
            content: "<!-- eidolon:workflow-progress-budget -->\nremaining_no_progress_turns: " + remaining,
          },
          { role: "user", content: "continue" },
        ],
        tools: buildBuiltinToolDefs().map((definition) => definition.schema),
      }),
      tokenEstimates: {
        toolSurfaceTokens: 100,
        workflowControlTokens: 10,
      },
    });
    const first = build(3);
    const second = build(2);
    const comparison = compareProviderCacheCostObservations(first, second);
    const workflowToolCount = buildBuiltinToolDefs()
      .filter((definition) => definition.schema.function.name.startsWith("Workflow"))
      .length;

    expect(comparison.retainedPrefixIntegrity).toBeLessThan(1);
    expect(comparison.firstDivergence?.ordinal).toBe(1 + buildBuiltinToolDefs().length);
    expect(comparison.firstDivergence?.priorDigest).toMatch(/^sha256:/);
    expect(comparison.firstDivergence?.currentDigest).toMatch(/^sha256:/);
    expect(workflowToolCount).toBeGreaterThan(1);
  });

  test("requires explicit official versus compatible profile identity", () => {
    expect(() => createProviderCacheCostObservation({
      identity: {
        schemaVersion: 1,
        providerId: "siliconflow",
        providerProfile: "deepseek_official",
        providerProfileId: "deepseek-compatible-chat@1",
        model: "deepseek-ai/DeepSeek-V4-Flash",
        actorClass: "workflow_node",
        contextEpoch: 0,
      },
      serializedRequestBody: JSON.stringify({ model: "deepseek-ai/DeepSeek-V4-Flash", messages: [], tools: [] }),
      tokenEstimates: { toolSurfaceTokens: 0, workflowControlTokens: 0 },
    })).toThrow("provider_cache_profile_identity_mismatch");
    expect(() => createProviderCacheCostObservation({
      identity: {
        schemaVersion: 1,
        providerId: "deepseek",
        providerProfile: "deepseek_official",
        providerProfileId: "deepseek-official-chat@1",
        model: "deepseek-chat",
        actorClass: "ordinary",
        contextEpoch: 0,
      },
      serializedRequestBody: JSON.stringify({ model: "different-model", messages: [], tools: [] }),
      tokenEstimates: { toolSurfaceTokens: 0, workflowControlTokens: 0 },
    })).toThrow("provider_cache_observation_identity_mismatch");
  });

  test("includes exact array delimiter bytes without breaking append-only prefix units", () => {
    const identity = {
      schemaVersion: 1 as const,
      providerId: "deepseek",
      providerProfile: "deepseek_official" as const,
      providerProfileId: "deepseek-official-chat@1" as const,
      model: "deepseek-chat",
      actorClass: "ordinary" as const,
      contextEpoch: 0,
    };
    const observeRaw = (serializedRequestBody: string) => createProviderCacheCostObservation({
      identity,
      serializedRequestBody,
      tokenEstimates: { toolSurfaceTokens: 0, workflowControlTokens: 0 },
    });
    const compact = observeRaw('{"model":"deepseek-chat","messages":[{"role":"user","content":"one"},{"role":"assistant","content":"two"}],"tools":[]}');
    const spaced = observeRaw('{"model":"deepseek-chat","messages":[{"role":"user","content":"one"}, {"role":"assistant","content":"two"}],"tools":[]}');
    const changed = compareProviderCacheCostObservations(compact, spaced);
    expect(compact.requestDigest).not.toBe(spaced.requestDigest);
    expect(compact.units.reduce((sum, unit) => sum + unit.byteLength, 0))
      .toBe(Buffer.byteLength('{"model":"deepseek-chat","messages":[{"role":"user","content":"one"},{"role":"assistant","content":"two"}],"tools":[]}', "utf8"));
    expect(spaced.units.reduce((sum, unit) => sum + unit.byteLength, 0))
      .toBe(Buffer.byteLength('{"model":"deepseek-chat","messages":[{"role":"user","content":"one"}, {"role":"assistant","content":"two"}],"tools":[]}', "utf8"));
    expect(changed.retainedPrefixIntegrity).toBeLessThan(1);
    expect(changed.firstDivergence?.reason).toBe("digest_changed");

    const appended = observeRaw('{"model":"deepseek-chat","messages":[{"role":"user","content":"one"},{"role":"assistant","content":"two"},{"role":"user","content":"three"}],"tools":[]}');
    expect(compareProviderCacheCostObservations(compact, appended).retainedPrefixIntegrity).toBe(1);
  });

  test("binds only final provider usage and explicit price weights", () => {
    const structural = createProviderCacheCostObservation({
      identity: {
        schemaVersion: 1,
        providerId: "deepseek",
        providerProfile: "deepseek_official",
        providerProfileId: "deepseek-official-chat@1",
        model: "deepseek-chat",
        actorClass: "ordinary",
        contextEpoch: 0,
      },
      serializedRequestBody: JSON.stringify({ model: "deepseek-chat", messages: [], tools: [] }),
      tokenEstimates: { toolSurfaceTokens: 17, workflowControlTokens: 0 },
      priceWeights: { cacheHitWeight: 0.1, cacheMissWeight: 1 },
    });
    const usage = normalizeProviderCacheUsageTokens({
      usage: {
        prompt_tokens: 120,
        completion_tokens: 15,
        prompt_cache_hit_tokens: 80,
        prompt_cache_miss_tokens: 40,
      },
    });
    const final = bindProviderCacheUsageToObservation(structural, usage);

    expect(final.tokenBreakdown.usage).toEqual({
      promptTokens: 120,
      completionTokens: 15,
      cacheHitTokens: 80,
      cacheMissTokens: 40,
    });
    expect(final.tokenBreakdown.normalizedInputCost).toBe(48);
    expect(bindProviderCacheUsageToObservation(structural, null).tokenBreakdown.normalizedInputCost).toBeNull();
    expect(normalizeProviderCacheUsageTokens({ usage: { prompt_tokens: 1 } })).toBeNull();
  });

  test("rejects accessor and undefined observation input before acceptance", () => {
    const identity = {
      schemaVersion: 1 as const,
      providerId: "deepseek",
      providerProfile: "deepseek_official" as const,
      providerProfileId: "deepseek-official-chat@1" as const,
      model: "deepseek-chat",
      actorClass: "ordinary" as const,
      contextEpoch: 0,
    };
    const accessorTokenEstimates = Object.defineProperty({}, "toolSurfaceTokens", {
      enumerable: true,
      get: () => 0,
    }) as { toolSurfaceTokens: number; workflowControlTokens: number };
    Object.defineProperty(accessorTokenEstimates, "workflowControlTokens", {
      enumerable: true,
      value: 0,
    });
    expect(() => createProviderCacheCostObservation({
      identity,
      serializedRequestBody: JSON.stringify({ model: "deepseek-chat", messages: [], tools: [] }),
      tokenEstimates: accessorTokenEstimates,
    })).toThrow("must be own data");
    expect(() => createProviderCacheCostObservation({
      identity,
      serializedRequestBody: JSON.stringify({ model: "deepseek-chat", messages: [], tools: [] }),
      tokenEstimates: { toolSurfaceTokens: 0, workflowControlTokens: 0 },
      usage: undefined,
    })).toThrow("usage cannot be undefined");

    const inheritedTokenEstimates = Object.create({ toolSurfaceTokens: 0 }) as never;
    Object.defineProperty(inheritedTokenEstimates as object, "workflowControlTokens", { enumerable: true, value: 0 });
    expect(() => createProviderCacheCostObservation({
      identity,
      serializedRequestBody: JSON.stringify({ model: "deepseek-chat", messages: [], tools: [] }),
      tokenEstimates: inheritedTokenEstimates,
    })).toThrow("plain prototype");
    expect(() => createProviderCacheCostObservation({
      identity,
      serializedRequestBody: JSON.stringify({ model: "deepseek-chat", messages: [], tools: [] }),
      tokenEstimates: { toolSurfaceTokens: Number.POSITIVE_INFINITY, workflowControlTokens: 0 },
    })).toThrow("finite non-negative");
    expect(() => createProviderCacheCostObservation({
      identity,
      serializedRequestBody: JSON.stringify({ model: "deepseek-chat", messages: [], tools: [] }),
      tokenEstimates: [] as never,
    })).toThrow("plain object");
  });
});
