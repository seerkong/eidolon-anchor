import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import {
  PROVIDER_CACHE_PRODUCT_FROZEN_SCENARIO_IDS,
  runProviderCacheProductMatrix,
} from "../../src/llm/ProviderCacheProductMatrix"

const llmRoot = fileURLToPath(new URL("../../src/llm/", import.meta.url))
const packageManifest = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"))

describe("closed provider cache product matrix", () => {
  test("does not export owner, ref, receipt, repository, digest or callback admission", async () => {
    const publicSurface = await import("../../src/llm/ProviderCacheProductEvidence")
    expect(Object.keys(publicSurface).filter((name) => /Owner|Receipt|EvidenceRef|Repository|Digest|issue/i.test(name))).toEqual([])
    const source = readFileSync(`${llmRoot}ProviderCacheProductEvidence.ts`, "utf8")
    expect(source).not.toMatch(/export\s+(?:function|type|interface|const)\s+(?:createProviderCacheProductEvidenceOwner|createProviderCacheProductEvidenceRef|issueProviderCacheProductJourneyReceipt)/)
    expect(packageManifest.exports["./llm/internal/*"]).toBeNull()
    const directAuthority = await import("../../src/llm/internal/ProviderCacheProductEvidenceAuthority")
    expect(Object.keys(directAuthority).filter((name) => /Owner|Receipt|EvidenceRef|Repository|issue|verify/i.test(name))).toEqual([])
    const matrixSource = readFileSync(`${llmRoot}ProviderCacheProductMatrix.ts`, "utf8")
    expect(matrixSource).not.toMatch(/\b(?:Map|WeakMap|createHmac|randomBytes|signProductChild|issueCompositeReceipt)\b/)
    const productionEvidenceRuntime = await import("../../src/llm/internal/ProviderCacheProductEvidenceRuntime")
    expect(Object.keys(productionEvidenceRuntime).filter((name) => /Owner|Receipt|EvidenceRef|Repository|issue|verify|sign/i.test(name))).toEqual([])

    const productionRuntime = await import("../../src/llm/internal/ProviderCacheProductRuntime")
    expect(Object.keys(productionRuntime).sort()).toEqual([
      "PROVIDER_CACHE_PRODUCT_PRODUCTION_SCENARIOS",
      "openVerifiedProductChild",
      "runClosedProviderCacheProductScenario",
    ])
    const productionRuntimeSource = readFileSync(`${llmRoot}internal/ProviderCacheProductRuntime.ts`, "utf8")
    expect(productionRuntimeSource).not.toMatch(/export\s+(?:async\s+)?function\s+(?:runOrdinaryProductScenario|runWorkflowNodeProductScenario|runWorkflowLifecycleProductScenario|readProviderCacheProductTransportGlobalOrdinal)/)
    expect(productionRuntimeSource).not.toMatch(/export\s+(?:type|const)\s+(?:OrdinaryProductScenarioOptions|OrdinaryProductScenarioRun|ProviderCacheProductSourceRecord|PRODUCT_RESOURCE_V2_MATERIALS)/)
  })

  test("derives the exact frozen scenario set from verified in-process product executions", async () => {
    const matrix = await runProviderCacheProductMatrix({ mode: "deterministic" })
    expect(matrix.structuralStatus).toBe("PASS")
    expect(matrix.unexplainedLocalDivergences).toBe(0)
    expect(matrix.scenarioIds).toEqual(PROVIDER_CACHE_PRODUCT_FROZEN_SCENARIO_IDS)
    expect(new Set(matrix.scenarioIds).size).toBe(matrix.scenarioIds.length)
    expect(matrix.bounds).toEqual({ actorCount: 4, sessionCount: 2, retainedMessages: 128, appendMessages: 1 })
    expect(matrix.journeys.every((journey) => journey.provenance === "canonical_product_runtime" && journey.verified)).toBe(true)
    expect(matrix.journeys.map((journey) => journey.scenarioId)).toEqual(matrix.scenarioIds)
    expect(matrix.compositeAdversarialRejections).toEqual([
      "missing", "duplicate", "substitute", "reorder", "cross-owner", "ref", "body", "closure", "hmac",
      "measured-bounds", "measured-actor-class", "measured-divergence",
      "ordinary-recovery-call-count", "ordinary-recovery-child-count", "ordinary-recovery-recovery-count",
      "resource-call-count", "resource-child-count", "resource-actor-count", "resource-session-count", "resource-recovery-count",
      "lifecycle-call-count", "lifecycle-child-count", "lifecycle-actor", "lifecycle-session", "lifecycle-stage-count", "lifecycle-terminal-count", "lifecycle-recovery-count",
      "isolation-call-count", "isolation-child-count", "isolation-actor-class", "isolation-actor-count", "isolation-session-count", "isolation-global-ordinal",
    ])
    expect(Object.fromEntries(matrix.journeys
      .filter((journey) => [
        "workflow.lifecycle.stable-superset/v1",
        "workflow.complete-authoring-release/v1",
        "isolation.four-actors-two-sessions/v1",
        "resource.old-new-actor/v1",
        "recovery.fresh-runtime/v1",
      ].includes(journey.scenarioId))
      .map((journey) => [journey.scenarioId, {
        childReceiptCount: journey.childReceiptCount,
        providerCallCount: journey.providerCallCount,
        recoveryStepCount: journey.recoveryStepCount,
        compositeVerified: journey.compositeVerified,
      }]))).toEqual({
      "workflow.lifecycle.stable-superset/v1": { childReceiptCount: 2, providerCallCount: 12, recoveryStepCount: 1, compositeVerified: true },
      "workflow.complete-authoring-release/v1": { childReceiptCount: 2, providerCallCount: 12, recoveryStepCount: 1, compositeVerified: true },
      "isolation.four-actors-two-sessions/v1": { childReceiptCount: 4, providerCallCount: 5, recoveryStepCount: 0, compositeVerified: true },
      "resource.old-new-actor/v1": { childReceiptCount: 3, providerCallCount: 5, recoveryStepCount: 1, compositeVerified: true },
      "recovery.fresh-runtime/v1": { childReceiptCount: 2, providerCallCount: 2, recoveryStepCount: 1, compositeVerified: true },
    })
    expect(Object.fromEntries(matrix.journeys.map((journey) => [journey.scenarioId, {
      stepCount: journey.stepCount,
      actorCount: journey.bounds.actorCount,
      sessionCount: journey.bounds.sessionCount,
      retainedMessages: journey.bounds.retainedMessages,
      unexplainedLocalDivergences: journey.unexplainedLocalDivergences,
    }]))).toEqual({
      "context.long-128/v1": { stepCount: 2, actorCount: 1, sessionCount: 1, retainedMessages: 128, unexplainedLocalDivergences: 0 },
      "epoch.compaction/v1": { stepCount: 3, actorCount: 1, sessionCount: 1, retainedMessages: 128, unexplainedLocalDivergences: 0 },
      "epoch.legacy-import-rebuild/v1": { stepCount: 2, actorCount: 1, sessionCount: 1, retainedMessages: 5, unexplainedLocalDivergences: 0 },
      "epoch.provider-model-profile/v1": { stepCount: 3, actorCount: 1, sessionCount: 1, retainedMessages: 3, unexplainedLocalDivergences: 0 },
      "epoch.resource-revision/v1": { stepCount: 3, actorCount: 1, sessionCount: 1, retainedMessages: 3, unexplainedLocalDivergences: 0 },
      "epoch.rewind-fork/v1": { stepCount: 3, actorCount: 1, sessionCount: 1, retainedMessages: 3, unexplainedLocalDivergences: 0 },
      "epoch.surface-revision/v1": { stepCount: 3, actorCount: 1, sessionCount: 1, retainedMessages: 3, unexplainedLocalDivergences: 0 },
      "isolation.four-actors-two-sessions/v1": { stepCount: 5, actorCount: 4, sessionCount: 2, retainedMessages: 3, unexplainedLocalDivergences: 0 },
      "ordinary.code.all-tools/v1": { stepCount: 1, actorCount: 1, sessionCount: 1, retainedMessages: 3, unexplainedLocalDivergences: 0 },
      "ordinary.no-tool.forward/v1": { stepCount: 2, actorCount: 1, sessionCount: 1, retainedMessages: 3, unexplainedLocalDivergences: 0 },
      "recovery.fresh-runtime/v1": { stepCount: 2, actorCount: 1, sessionCount: 1, retainedMessages: 3, unexplainedLocalDivergences: 0 },
      "resource.old-new-actor/v1": { stepCount: 5, actorCount: 3, sessionCount: 2, retainedMessages: 3, unexplainedLocalDivergences: 0 },
      "tool.reasoning-parallel-pending/v1": { stepCount: 4, actorCount: 1, sessionCount: 1, retainedMessages: 3, unexplainedLocalDivergences: 0 },
      "transport.retry-503/v1": { stepCount: 2, actorCount: 1, sessionCount: 1, retainedMessages: 3, unexplainedLocalDivergences: 0 },
      "workflow.complete-authoring-release/v1": { stepCount: 12, actorCount: 1, sessionCount: 1, retainedMessages: 4, unexplainedLocalDivergences: 0 },
      "workflow.ctrl-node.stage-free/v1": { stepCount: 1, actorCount: 1, sessionCount: 1, retainedMessages: 3, unexplainedLocalDivergences: 0 },
      "workflow.data-node.stage-free/v1": { stepCount: 1, actorCount: 1, sessionCount: 1, retainedMessages: 3, unexplainedLocalDivergences: 0 },
      "workflow.lifecycle.stable-superset/v1": { stepCount: 12, actorCount: 1, sessionCount: 1, retainedMessages: 4, unexplainedLocalDivergences: 0 },
    })
    expect(matrix.epochReasonSequence).toEqual([
      "initial_projection",
      "provider_model_profile_switch",
      "history_compaction",
      "history_rewind_or_fork",
      "frozen_resource_revision_accepted",
      "provider_surface_revision_accepted",
      "legacy_context_import",
    ])
    expect(matrix.strategyProof).toMatchObject({
      strategyRevision: "stable-superset/v1",
      selectionAuthorityDigest: expect.stringMatching(/^sha256:/),
      lifecycleStages: 5,
      providerRequestsPerStage: 2,
      freshRecoveryVerified: true,
      verified: true,
    })
  }, 120_000)

  test("gate source cannot hard-code structural proof after merely running tests", () => {
    const source = readFileSync(fileURLToPath(new URL("../../scripts/providerCacheProductGate.ts", import.meta.url)), "utf8")
    expect(source).not.toContain('structuralStatus: "PASS"')
    expect(source).not.toContain("unexplainedLocalDivergences: 0")
    expect(source).not.toContain("cacheHitTokens: 75")
    expect(source).toContain("fixtureUsage: matrix.fixtureUsage")
    expect(source).toContain("runProviderCacheProductMatrix")
  })

  test("rejects caller-supplied missing, duplicate or synthetic scenario rows", async () => {
    await expect(runProviderCacheProductMatrix({
      mode: "deterministic",
      scenarios: [],
    } as any)).rejects.toThrow(/input_not_closed/)
    await expect(runProviderCacheProductMatrix({
      mode: "deterministic",
      journeys: [{ scenarioId: "ordinary.no-tool.forward/v1", verified: true }],
    } as any)).rejects.toThrow(/input_not_closed/)
    const inherited = Object.create({ scenarios: [...PROVIDER_CACHE_PRODUCT_FROZEN_SCENARIO_IDS] })
    inherited.mode = "deterministic"
    await expect(runProviderCacheProductMatrix(inherited)).rejects.toThrow(/input_not_closed/)
  })
})
