import { describe, expect, it } from "bun:test"

import type {
  CodumentPropositionManifest,
  PropositionModeIdentity,
  PropositionProviderTurn,
} from "../../../../../testkit/codument-proposition/contract"

import {
  canonicalPropositionManifestDigest,
  classifyPropositionCacheScope,
  classifyPropositionCacheScopes,
  projectCanonicalPropositionProviderTurns,
  validatePropositionManifest,
  verifyPropositionModeIdentity,
} from "../../../../../testkit/codument-proposition/harness"
import { createProviderCacheCostObservation } from "../../src/llm/ProviderCacheCostObservation"

const SHA_A = `sha256:${"a".repeat(64)}`
const SHA_B = `sha256:${"b".repeat(64)}`

function manifest(): CodumentPropositionManifest {
  return {
    schemaVersion: "eidolon.codument-proposition-manifest/v1",
    scenarioId: "stream-pipeline-ai-agent",
    revision: "2026-08-27",
    corpusDigest: SHA_A,
    sources: [
      { relativePath: "e2e/request.md", digest: SHA_B, role: "request" },
      { relativePath: "e2e/verify.sh", digest: SHA_A, role: "verifier" },
    ],
    requestComposition: ["e2e/request.md"],
    verifier: {
      argv: ["bash", "e2e/verify.sh"],
      digest: SHA_A,
    },
    workspaceSeed: "empty_git",
    timeoutSeconds: 7_200,
    allowedModes: ["ordinary", "ai_ctrl", "ai_data"],
  }
}

describe("Codument proposition closed contracts", () => {
  it("accepts a closed manifest and produces a stable digest", () => {
    const input = manifest()
    expect(validatePropositionManifest(input)).toEqual(input)
    expect(canonicalPropositionManifestDigest(input)).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(canonicalPropositionManifestDigest(input)).toBe(canonicalPropositionManifestDigest({ ...input }))
  })

  it("rejects path escape, source mismatch and unknown fields", () => {
    expect(() => validatePropositionManifest({
      ...manifest(),
      sources: [{ relativePath: "../secret", digest: SHA_A, role: "request" }],
    })).toThrow("relative source path")
    expect(() => validatePropositionManifest({
      ...manifest(),
      requestComposition: ["missing.md"],
    })).toThrow("request source")
    expect(() => validatePropositionManifest({ ...manifest(), surprise: true } as any)).toThrow("unknown field")
  })

  it("rejects secret-bearing executable environment declarations", () => {
    expect(() => validatePropositionManifest({
      ...manifest(),
      environmentAllowlist: ["PATH", "DEEPSEEK_API_KEY"],
    } as any)).toThrow("unknown field")
  })
})

describe("Codument proposition mode identity", () => {
  it("keeps ordinary execution workflow-free", () => {
    const identity: PropositionModeIdentity = {
      requestedMode: "ordinary",
      actualMode: "ordinary",
      sessionId: "session-1",
      evidenceSource: "terminal.runtime.public-events/v1",
      workflow: null,
    }
    expect(verifyPropositionModeIdentity(identity)).toEqual(identity)
  })

  it("rejects fallback and non-public workflow evidence", () => {
    expect(() => verifyPropositionModeIdentity({
      requestedMode: "ai_ctrl",
      actualMode: "ordinary",
      sessionId: "session-2",
      evidenceSource: "terminal.runtime.public-events/v1",
      workflow: null,
    })).toThrow("mode mismatch")

    expect(() => verifyPropositionModeIdentity({
      requestedMode: "ai_data",
      actualMode: "ai_data",
      sessionId: "session-3",
      evidenceSource: "workflow.internal.store",
      workflow: {
        kind: "AIDataWorkflow",
        definitionRef: "resource://test.data",
        instanceId: "instance-1",
        runId: "run-1",
        nodeActorId: "actor-1",
      },
    })).toThrow("public runtime events")
  })
})

describe("Codument proposition cache scopes", () => {
  function turn(overrides: Partial<PropositionProviderTurn> = {}): PropositionProviderTurn {
    return {
      contextScopeId: "session-1",
      providerId: "deepseek",
      providerProfileId: "deepseek-official-chat@1",
      model: "deepseek-v4-flash",
      contextEpoch: 1,
      epochReason: "initial_projection",
      promptTokens: 12_000,
      cacheHitTokens: 11_950,
      cacheMissTokens: 50,
      outputTokens: 100,
      normalizedInputCost: 80,
      retainedPrefixIntegrity: 1,
      finalSuccess: true,
      ...overrides,
    }
  }

  it("classifies a stable official long-context epoch separately", () => {
    const result = classifyPropositionCacheScope([
      turn(),
      turn({ promptTokens: 12_100, cacheHitTokens: 12_050 }),
      turn({ promptTokens: 12_200, cacheHitTokens: 12_150 }),
      turn({ promptTokens: 12_300, cacheHitTokens: 12_250 }),
    ])
    expect(result.classification).toBe("comparable_long_context")
    expect(result.providerClass).toBe("official_deepseek")
    expect(result.retainedPrefixIntegrity).toBe(1)
    expect(result.cacheHitRatio).toBeGreaterThan(0.995)
    expect(result.cacheEligiblePrefixHitRatio).toBeGreaterThan(0.995)
    expect(result.normalizedInputCost).toBe(320)
    expect(result.cacheHitTokens + result.cacheMissTokens).toBeGreaterThanOrEqual(32_768)
  })

  it("does not merge short, epoch-transition, compatible or invalid-prefix evidence", () => {
    expect(classifyPropositionCacheScope([turn({ promptTokens: 1_000 })]).classification).toBe("short_or_cold")
    expect(classifyPropositionCacheScope([
      turn(),
      turn({ contextEpoch: 2, epochReason: "history_compaction" }),
    ]).classification).toBe("epoch_transition")
    expect(classifyPropositionCacheScope([
      turn({ providerId: "siliconflow", providerProfileId: "deepseek-compatible-chat@1", normalizedInputCost: null }),
      turn({ providerId: "siliconflow", providerProfileId: "deepseek-compatible-chat@1", normalizedInputCost: null }),
      turn({ providerId: "siliconflow", providerProfileId: "deepseek-compatible-chat@1", normalizedInputCost: null }),
      turn({ providerId: "siliconflow", providerProfileId: "deepseek-compatible-chat@1", normalizedInputCost: null }),
    ])).toMatchObject({
      providerClass: "deepseek_compatible",
      classification: "comparable_long_context",
      normalizedInputCost: null,
    })
    expect(() => classifyPropositionCacheScope([
      turn(),
      turn({ retainedPrefixIntegrity: 0.99 }),
      turn(),
      turn(),
    ])).toThrow("retained prefix")
    expect(() => classifyPropositionCacheScope([
      turn({ normalizedInputCost: null }),
      turn({ normalizedInputCost: null }),
      turn({ normalizedInputCost: null }),
      turn({ normalizedInputCost: null }),
    ])).toThrow("absolute normalized input cost")
  })

  it("projects contiguous provider epochs as separate cache scopes", () => {
    const scopes = classifyPropositionCacheScopes([
      turn(),
      turn(),
      turn(),
      turn(),
      turn({ contextEpoch: 2, epochReason: "history_compaction" }),
      turn({ contextEpoch: 2, epochReason: "stable_epoch" }),
    ])
    expect(scopes).toHaveLength(4)
    expect(scopes[0]).toMatchObject({
      contextEpoch: 1,
      classification: "short_or_cold",
      eligibleSubsequentTurns: 0,
    })
    expect(scopes[1]).toMatchObject({
      contextEpoch: 1,
      classification: "comparable_long_context",
      eligibleSubsequentTurns: 3,
    })
    expect(scopes[1]!.cacheEligiblePrefixHitRatio).toBeGreaterThan(0.995)
    expect(scopes[2]).toMatchObject({
      contextEpoch: 2,
      classification: "short_or_cold",
      eligibleSubsequentTurns: 0,
    })
    expect(scopes[3]).toMatchObject({
      contextEpoch: 2,
      classification: "short_or_cold",
      eligibleSubsequentTurns: 1,
    })
  })

  it("never merges equal numeric epochs from different Agent sessions", () => {
    const turns = [
      turn({ contextScopeId: "session-plan" }),
      turn({ contextScopeId: "session-plan" }),
      turn({ contextScopeId: "session-implement" }),
      turn({ contextScopeId: "session-implement" }),
    ]
    const scopes = classifyPropositionCacheScopes(turns)
    expect(scopes).toHaveLength(4)
    expect(scopes.map((scope) => scope.eligibleSubsequentTurns)).toEqual([0, 1, 0, 1])
    expect(scopes[0]!.cacheEligiblePrefixHitRatio).toBeNull()
    expect(scopes[1]!.cacheEligiblePrefixHitRatio).toBeGreaterThan(0.995)
    expect(scopes[2]!.cacheEligiblePrefixHitRatio).toBeNull()
    expect(scopes[3]!.cacheEligiblePrefixHitRatio).toBeGreaterThan(0.995)

    const aggregate = classifyPropositionCacheScope(turns)
    expect(aggregate.classification).toBe("epoch_transition")
    expect(aggregate.eligibleSubsequentTurns).toBe(2)
    expect(aggregate.cacheEligiblePrefixTokens).toBe(24_000)
    expect(aggregate.cacheEligiblePrefixHitTokens).toBe(23_900)
    expect(aggregate.cacheEligiblePrefixHitRatio).toBeGreaterThan(0.995)
    expect(aggregate.newInputTokens).toBe(0)
  })

  it("projects final-success facts from canonical final-wire observations", () => {
    const observations = Array.from({ length: 4 }, (_, index) => createProviderCacheCostObservation({
      identity: {
        schemaVersion: 1,
        providerId: "deepseek",
        providerProfile: "deepseek_official",
        providerProfileId: "deepseek-official-chat@1",
        model: "deepseek-v4-flash",
        actorClass: "ordinary",
        contextEpoch: 1,
      },
      serializedRequestBody: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: Array.from({ length: index + 2 }, (__, messageIndex) => ({
          role: messageIndex % 2 === 0 ? "user" : "assistant",
          content: `stable-${messageIndex}`,
        })),
        tools: [],
      }),
      tokenEstimates: {
        finalWireInputTokens: 12_000 + index * 100,
        toolSurfaceTokens: 0,
        workflowControlTokens: 0,
      },
      usage: {
        promptTokens: 12_000 + index * 100,
        completionTokens: 100,
        cacheHitTokens: 11_950 + index * 100,
        cacheMissTokens: 50,
      },
      priceWeights: { cacheHitWeight: 0.1, cacheMissWeight: 1 },
    }))
    const turns = projectCanonicalPropositionProviderTurns({
      contextScopeId: "session-observation",
      observations,
      epochReasons: ["initial_projection", "initial_projection", "initial_projection", "initial_projection"],
    })
    expect(turns).toHaveLength(4)
    expect(turns.every((turn) => turn.finalSuccess && turn.retainedPrefixIntegrity === 1)).toBeTrue()
    expect(classifyPropositionCacheScope(turns).classification).toBe("comparable_long_context")
  })
})
