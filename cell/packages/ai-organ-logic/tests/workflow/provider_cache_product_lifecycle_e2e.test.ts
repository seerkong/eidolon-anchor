import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import {
  freezeAiWorkflowResourcePackage,
  installBundledSystemSkills,
} from "@cell/ai-support"
import { PROVIDER_CACHE_PRODUCT_EPOCH_REASON_MATRIX } from "../../src/llm/ProviderCacheProductEvidence"
import { runProviderCacheProductMatrix } from "../../src/llm/ProviderCacheProductMatrix"
import {
  CLOSED_WORKFLOW_SURFACE_EXPERIMENT,
  WORKFLOW_SURFACE_STRATEGY_REGISTRY,
  createClosedWorkflowSurfaceExperimentInput,
  digestClosedWorkflowSurfaceValue,
} from "../../src/workflow/runtime/WorkflowProviderSurfaceStrategy"
import {
  createLocalWorkflowSurfaceExperimentRuntime,
  readVerifiedWorkflowSurfaceProductJourney,
  runClosedWorkflowSurfaceExperiment,
  selectWorkflowSurfaceStrategy,
} from "../../src/workflow/runtime/WorkflowProviderSurfaceExperimentRuntime"
import { WORKFLOW_LIFECYCLE_TOOL_PROFILE } from "../../src/workflow/tools"

describe("provider cache lifecycle product E2E", () => {
  test("binds the exact G4 opaque-owner strategy proof and complete lifecycle journey", async () => {
    const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "provider-cache-product-lifecycle-"))
    try {
      await installBundledSystemSkills({ globalRoot })
      const resourcePackage = await freezeAiWorkflowResourcePackage({ globalRoot })
      const frozenActorSnapshot = Object.freeze({
        key: "g5-workflow-author-parent",
        id: "g5-workflow-author-parent-id",
        systemPrompts: Object.freeze(["Frozen G5 WorkflowAuthor authority."]),
      })
      const frozenConversationSnapshot = Object.freeze({
        sessionId: "g5-lifecycle-product",
        messages: Object.freeze([{ role: "user" as const, content: "Run the complete lifecycle product journey." }]),
      })
      const input = createClosedWorkflowSurfaceExperimentInput({
        frozenActorSnapshotDigest: digestClosedWorkflowSurfaceValue(frozenActorSnapshot),
        frozenConversationSnapshotDigest: digestClosedWorkflowSurfaceValue(frozenConversationSnapshot),
        lifecycleToolProfileDigest: digestClosedWorkflowSurfaceValue(WORKFLOW_LIFECYCLE_TOOL_PROFILE),
        lifecycleResourcePackageDigest: resourcePackage.digest as `sha256:${string}`,
        providerProfileId: "deepseek-compatible-chat@1",
        model: "deepseek-chat",
      })
      const runtime = createLocalWorkflowSurfaceExperimentRuntime({
        globalRoot,
        resourcePackage,
        frozenActorSnapshot,
        frozenConversationSnapshot,
        providerProfileId: input.providerProfileId,
        model: input.model,
        lifecycleToolProfileDigest: input.lifecycleToolProfileDigest,
        lifecycleResourcePackageDigest: input.lifecycleResourcePackageDigest,
      })
      const raw = await runClosedWorkflowSurfaceExperiment({ input, runtime })
      const selection = selectWorkflowSurfaceStrategy(raw, runtime)
      expect(raw.ownerReceipt).toMatch(/^hmac-sha256:/)
      expect(raw.candidates).toHaveLength(3)
      expect(new Set(raw.candidates.map((candidate) => candidate.cloneInstanceDigest)).size).toBe(3)
      expect(selection.selectedStrategyRevision).toBe("stable-superset/v1")
      expect(selection.selectedStrategyDigest).toBe(
        WORKFLOW_SURFACE_STRATEGY_REGISTRY.resolve("stable-superset/v1").strategyDigest,
      )
      expect(CLOSED_WORKFLOW_SURFACE_EXPERIMENT.journey).toEqual({
        gateway: "WorkflowAuthor",
        stages: ["planning", "coding", "building", "testing", "releasing"],
        sameStageForwardTurns: 1,
        requiredToolInvocationsPerStage: 1,
      })
      expect(selection.ranking.find((candidate) => candidate.strategyRevision === "stable-superset/v1"))
        .toMatchObject({ eligible: true, surfaceEpochCount: 1, toolSelectionErrors: 0 })
      const productJourney = readVerifiedWorkflowSurfaceProductJourney({ runtime, report: raw, selection })
      expect(productJourney.requests).toHaveLength(11)
      expect(productJourney.requests.slice(0, 10).every((request) => request.toolCallRecord !== null)).toBe(true)
      expect(productJourney.requests[10]!.toolCallRecord).toBeNull()
      expect(productJourney.requests.every((request) => /^sha256:/.test(String((request.requestAdmission as any).admissionDigest)))).toBe(true)
      expect(productJourney.freshRecoveryVerified).toBe(true)

      const matrix = await runProviderCacheProductMatrix({ mode: "deterministic" })
      expect(matrix.strategyProof.strategyDigest).toBe(selection.selectedStrategyDigest)
      expect(matrix.strategyProof.verified).toBe(true)
      expect(matrix.journeys.find((journey) => journey.scenarioId === "workflow.lifecycle.stable-superset/v1"))
        .toMatchObject({ childReceiptCount: 2, providerCallCount: 12, recoveryStepCount: 1, compositeVerified: true })
    } finally {
      fs.rmSync(globalRoot, { recursive: true, force: true })
    }
  }, 120_000)

  test("freezes the exact epoch reason matrix and keeps reset reasonless", () => {
    expect(PROVIDER_CACHE_PRODUCT_EPOCH_REASON_MATRIX).toEqual({
      "epoch.initial-projection/v1": "initial_projection",
      "epoch.provider-model-profile/v1": "provider_model_profile_switch",
      "epoch.compaction/v1": "history_compaction",
      "epoch.rewind-fork/v1": "history_rewind_or_fork",
      "epoch.resource-revision/v1": "frozen_resource_revision_accepted",
      "epoch.surface-revision/v1": "provider_surface_revision_accepted",
      "epoch.legacy-import-rebuild/v1": "legacy_context_import",
      "epoch.recovery-rebuild/v1": "recovery_rebuild",
      "epoch.reset/v1": null,
    })
    expect(Object.isFrozen(PROVIDER_CACHE_PRODUCT_EPOCH_REASON_MATRIX)).toBe(true)
  })
})
