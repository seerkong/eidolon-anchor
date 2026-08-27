import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  freezeAiWorkflowResourcePackage,
  installBundledSystemSkills,
} from "@cell/ai-support"
import { ProviderRuntimeLlmAdapter } from "../../src/llm/ProviderRuntimeAdapter"
import { OpenAICompletionsNodejsFetchLlmAdapter } from "../../src/llm/OpenAICompletionsNodejsFetchAdapter"
import { WORKFLOW_LIFECYCLE_TOOL_PROFILE } from "../../src/workflow/tools"

import {
  AI_WORKFLOW_PROVIDER_TOOL_SURFACE,
  AI_WORKFLOW_STAGE_TOOL_POLICY,
} from "../../src/workflow/tools/WorkflowStageToolCatalog"
import {
  CLOSED_WORKFLOW_SURFACE_EXPERIMENT,
  SELECTED_WORKFLOW_SURFACE_STRATEGY_REVISION,
  WORKFLOW_SURFACE_EXPERIMENT_STAGES,
  WORKFLOW_SURFACE_STRATEGY_REGISTRY,
  createClosedWorkflowSurfaceExperimentInput,
  digestClosedWorkflowSurfaceValue,
  projectWorkflowProviderSurface,
  validateClosedWorkflowSurfaceExperimentInput,
  type WorkflowSurfaceRawExperimentReport,
} from "../../src/workflow/runtime/WorkflowProviderSurfaceStrategy"
import {
  createLocalWorkflowSurfaceExperimentRuntime,
  runClosedWorkflowSurfaceExperiment,
  selectWorkflowSurfaceStrategy,
  type WorkflowSurfaceExperimentRuntime,
} from "../../src/workflow/runtime/WorkflowProviderSurfaceExperimentRuntime"

let observedRawReport: WorkflowSurfaceRawExperimentReport | undefined
let observedRuntime: WorkflowSurfaceExperimentRuntime | undefined
let observedRuntimeConfig: Parameters<typeof createLocalWorkflowSurfaceExperimentRuntime>[0] | undefined
let observedArtifactRoot: string | undefined

describe("closed Workflow provider-surface strategy authority", () => {
  test("freezes exactly three strategies, one journey, and G1 cost authority before observation", () => {
    expect(Object.isFrozen(AI_WORKFLOW_STAGE_TOOL_POLICY)).toBe(true)
    expect(Object.values(AI_WORKFLOW_STAGE_TOOL_POLICY).every(Object.isFrozen)).toBe(true)
    expect(() => {
      ;(AI_WORKFLOW_STAGE_TOOL_POLICY.coding as unknown as string[]).push("ForgedWorkflowTool")
    }).toThrow()
    expect(WORKFLOW_SURFACE_STRATEGY_REGISTRY.strategies.map((entry) => entry.strategyRevision)).toEqual([
      "hybrid/v1",
      "stable-superset/v1",
      "stage-epoch/v1",
    ])
    expect(CLOSED_WORKFLOW_SURFACE_EXPERIMENT).toMatchObject({
      schemaVersion: "eidolon.workflow-provider-surface-experiment/v1",
      journey: {
        gateway: "WorkflowAuthor",
        stages: ["planning", "coding", "building", "testing", "releasing"],
        sameStageForwardTurns: 1,
        requiredToolInvocationsPerStage: 1,
      },
      priceWeights: { cacheHitWeight: 0.1, cacheMissWeight: 1 },
      cloneRule: "independent-fresh-clone-per-strategy",
    })
    expect(CLOSED_WORKFLOW_SURFACE_EXPERIMENT.strategySetDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(new Set(WORKFLOW_SURFACE_STRATEGY_REGISTRY.strategies.map((entry) => entry.strategyDigest)).size).toBe(3)
  })

  test("derives union, stage and intersection-plus-capsule surfaces without author labels", () => {
    const stable = projectWorkflowProviderSurface({ strategyRevision: "stable-superset/v1", stage: "coding" })
    expect(stable.toolNames).toEqual(AI_WORKFLOW_PROVIDER_TOOL_SURFACE)
    expect(stable.transitionScope).toBe("actor")

    const stage = projectWorkflowProviderSurface({ strategyRevision: "stage-epoch/v1", stage: "coding" })
    expect(stage.toolNames).toEqual(AI_WORKFLOW_STAGE_TOOL_POLICY.coding)
    expect(stage.transitionScope).toBe("stage")

    const hybrid = projectWorkflowProviderSurface({ strategyRevision: "hybrid/v1", stage: "coding" })
    expect(hybrid.stableControlToolNames).toEqual(["WorkflowLoadStageContext"])
    expect(hybrid.toolNames).toEqual(AI_WORKFLOW_STAGE_TOOL_POLICY.coding)
    expect(hybrid.stageCapsuleToolNames).toEqual(
      AI_WORKFLOW_STAGE_TOOL_POLICY.coding.filter((name) => name !== "WorkflowLoadStageContext"),
    )
    expect(hybrid.surfaceDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  test("binds frozen source authority and rejects altered or ambiguous experiment material", () => {
    const input = createClosedWorkflowSurfaceExperimentInput({
      frozenActorSnapshotDigest: `sha256:${"1".repeat(64)}`,
      frozenConversationSnapshotDigest: `sha256:${"2".repeat(64)}`,
      lifecycleToolProfileDigest: `sha256:${"3".repeat(64)}`,
      lifecycleResourcePackageDigest: `sha256:${"4".repeat(64)}`,
      providerProfileId: "deepseek-compatible-chat@1",
      model: "deepseek-chat",
    })
    expect(validateClosedWorkflowSurfaceExperimentInput(input)).toEqual(input)
    expect(input.inputDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(() => validateClosedWorkflowSurfaceExperimentInput({
      ...input,
      strategySetDigest: `sha256:${"9".repeat(64)}`,
    })).toThrow(/strategy set/i)
    expect(() => validateClosedWorkflowSurfaceExperimentInput({
      ...input,
      journey: { ...input.journey, stages: ["coding"] },
    })).toThrow(/journey/i)
    const closedAuthority = {
      profile: { profileId: "profile", admittedNames: ["Tool"] },
      strategy: { revision: "stable/v1" },
      ref: { ownerId: "owner", digest: "digest" },
    }
    const cleanDigest = digestClosedWorkflowSurfaceValue(closedAuthority)
    expect(cleanDigest).toBe(digestClosedWorkflowSurfaceValue(JSON.parse(JSON.stringify(closedAuthority))))
    const profileWithSymbol = JSON.parse(JSON.stringify(closedAuthority))
    Object.defineProperty(profileWithSymbol.profile, Symbol("profile-authority"), {
      value: "forged",
      enumerable: false,
    })
    expect(() => digestClosedWorkflowSurfaceValue(profileWithSymbol)).toThrow(/symbol/i)
    const strategyWithSymbolAccessor = JSON.parse(JSON.stringify(closedAuthority))
    Object.defineProperty(strategyWithSymbolAccessor.strategy, Symbol("strategy-authority"), {
      get: () => "forged",
      enumerable: true,
    })
    expect(() => digestClosedWorkflowSurfaceValue(strategyWithSymbolAccessor)).toThrow(/symbol/i)
    const refWithSymbol = JSON.parse(JSON.stringify(closedAuthority))
    Object.defineProperty(refWithSymbol.ref, Symbol("ref-authority"), { value: true })
    expect(() => digestClosedWorkflowSurfaceValue(refWithSymbol)).toThrow(/symbol/i)
    const arrayWithSymbol = ["Tool"]
    Object.defineProperty(arrayWithSymbol, Symbol("array-authority"), { value: true })
    expect(() => digestClosedWorkflowSurfaceValue(arrayWithSymbol)).toThrow(/symbol/i)
  })

  test("rejects a no-runtime caller before any candidate journey can execute", async () => {
    const authority = createClosedWorkflowSurfaceExperimentInput({
      frozenActorSnapshotDigest: `sha256:${"1".repeat(64)}`,
      frozenConversationSnapshotDigest: `sha256:${"2".repeat(64)}`,
      lifecycleToolProfileDigest: `sha256:${"3".repeat(64)}`,
      lifecycleResourcePackageDigest: `sha256:${"4".repeat(64)}`,
      providerProfileId: "deepseek-compatible-chat@1",
      model: "deepseek-chat",
    })
    const forgedRuntime = {
      schemaVersion: "eidolon.workflow-provider-surface-runtime-owner/v1",
      ownerId: `sha256:${"5".repeat(64)}`,
    }
    await expect(runClosedWorkflowSurfaceExperiment({
      input: authority,
      runtime: forgedRuntime as any,
    })).rejects.toThrow(/runtime owner is required/i)
  })

  test("records immutable raw observations from independent clones through the actual chat serializer", async () => {
    const frozenActorSnapshot = Object.freeze({
      key: "workflow-author-parent",
      id: "workflow-author-parent-id",
      systemPrompts: Object.freeze(["Frozen WorkflowAuthor parent authority."]),
    })
    const frozenConversationSnapshot = Object.freeze({
      sessionId: "surface-experiment",
      messages: Object.freeze([{ role: "user", content: "Author the frozen planning-to-releasing journey." }]),
    })
    const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-surface-experiment-global-"))
    await installBundledSystemSkills({ globalRoot })
    const resourcePackage = await freezeAiWorkflowResourcePackage({ globalRoot })
    const input = createClosedWorkflowSurfaceExperimentInput({
      frozenActorSnapshotDigest: digestClosedWorkflowSurfaceValue(frozenActorSnapshot),
      frozenConversationSnapshotDigest: digestClosedWorkflowSurfaceValue(frozenConversationSnapshot),
      lifecycleToolProfileDigest: digestClosedWorkflowSurfaceValue(WORKFLOW_LIFECYCLE_TOOL_PROFILE),
      lifecycleResourcePackageDigest: resourcePackage.digest as `sha256:${string}`,
      providerProfileId: "deepseek-compatible-chat@1",
      model: "deepseek-chat",
    })
    try {
      const beforeOwnerRoots = new Set(
        fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("eidolon-workflow-surface-owner-")),
      )
      const runtimeConfig = {
        globalRoot,
        resourcePackage,
        frozenActorSnapshot,
        frozenConversationSnapshot,
        providerProfileId: input.providerProfileId,
        model: input.model,
        lifecycleToolProfileDigest: input.lifecycleToolProfileDigest,
        lifecycleResourcePackageDigest: input.lifecycleResourcePackageDigest,
      } satisfies Parameters<typeof createLocalWorkflowSurfaceExperimentRuntime>[0]
      const runtime = createLocalWorkflowSurfaceExperimentRuntime(runtimeConfig)
      const createdOwnerRoot = fs.readdirSync(os.tmpdir())
        .find((name) => name.startsWith("eidolon-workflow-surface-owner-") && !beforeOwnerRoots.has(name))
      if (!createdOwnerRoot) throw new Error("private owner root was not created")
      const originalProviderRuntimeCreateStream = ProviderRuntimeLlmAdapter.prototype.createStream
      const originalLowLevelCreateStream = OpenAICompletionsNodejsFetchLlmAdapter.prototype.createStream
      const originalLowLevelCreateAdmittedStream = OpenAICompletionsNodejsFetchLlmAdapter.prototype.createAdmittedStream
      const originalGlobalFetch = globalThis.fetch
      ProviderRuntimeLlmAdapter.prototype.createStream = async () => {
        throw new Error("caller monkeypatched exported ProviderRuntime prototype")
      }
      OpenAICompletionsNodejsFetchLlmAdapter.prototype.createStream = async () => {
        throw new Error("caller monkeypatched exported low-level prototype")
      }
      OpenAICompletionsNodejsFetchLlmAdapter.prototype.createAdmittedStream = async () => {
        throw new Error("caller monkeypatched exported admitted-stream prototype")
      }
      globalThis.fetch = async () => {
        throw new Error("caller monkeypatched global fetch")
      }
      let raw: WorkflowSurfaceRawExperimentReport
      try {
        raw = await runClosedWorkflowSurfaceExperiment({ input, runtime })
      } finally {
        ProviderRuntimeLlmAdapter.prototype.createStream = originalProviderRuntimeCreateStream
        OpenAICompletionsNodejsFetchLlmAdapter.prototype.createStream = originalLowLevelCreateStream
        OpenAICompletionsNodejsFetchLlmAdapter.prototype.createAdmittedStream = originalLowLevelCreateAdmittedStream
        globalThis.fetch = originalGlobalFetch
      }
      observedRawReport = raw
      observedRuntime = runtime
      observedRuntimeConfig = runtimeConfig
      observedArtifactRoot = path.join(os.tmpdir(), createdOwnerRoot)
      expect(raw.schemaVersion).toBe("eidolon.workflow-provider-surface-raw-report/v2")
      expect("winner" in raw).toBe(false)
      expect(raw.candidates.map((candidate) => candidate.strategyRevision)).toEqual([
        "hybrid/v1",
        "stable-superset/v1",
        "stage-epoch/v1",
      ])
      expect(new Set(raw.candidates.map((candidate) => candidate.cloneInstanceDigest)).size).toBe(3)
      expect(raw.candidates.every((candidate) => candidate.sourceSnapshotDigest === raw.sourceSnapshotDigest)).toBe(true)
      expect(raw.candidates.every((candidate) => candidate.evidenceRef.ownerId === runtime.ownerId)).toBe(true)
      expect(Object.keys(runtime)).toEqual(["schemaVersion", "ownerId"])
      expect(Object.isFrozen(runtime)).toBe(true)
      expect(Object.isSealed(runtime)).toBe(true)
      expect("readEvidence" in runtime).toBe(false)
      expect("admitFrozenSourceSnapshots" in runtime).toBe(false)
      expect(() => (raw.candidates as any).push({})).toThrow()
    } finally {
      fs.rmSync(globalRoot, { recursive: true, force: true })
      // The opaque runtime owner keeps its private mkdtemp evidence root.
    }
  }, 30_000)

  test("rejects actor/message/digest-fact and unknown config fields at the opaque public boundary", async () => {
    if (!observedRawReport || !observedRuntime || !observedRuntimeConfig) {
      throw new Error("runtime authority unavailable")
    }
    await expect(runClosedWorkflowSurfaceExperiment({
      input: {
        ...createClosedWorkflowSurfaceExperimentInput({
          frozenActorSnapshotDigest: observedRuntimeConfig.frozenActorSnapshot
            ? digestClosedWorkflowSurfaceValue(observedRuntimeConfig.frozenActorSnapshot)
            : `sha256:${"1".repeat(64)}`,
          frozenConversationSnapshotDigest: digestClosedWorkflowSurfaceValue(
            observedRuntimeConfig.frozenConversationSnapshot,
          ),
          lifecycleToolProfileDigest: observedRuntimeConfig.lifecycleToolProfileDigest,
          lifecycleResourcePackageDigest: observedRuntimeConfig.lifecycleResourcePackageDigest,
          providerProfileId: observedRuntimeConfig.providerProfileId,
          model: observedRuntimeConfig.model,
        }),
      },
      runtime: observedRuntime,
      actor: { messages: [], digestFacts: [] },
    } as any)).rejects.toThrow(/unknown or missing field/i)
    expect(() => createLocalWorkflowSurfaceExperimentRuntime({
      ...observedRuntimeConfig,
      workRoot: "/caller-selected-authority",
    } as any)).toThrow(/unknown or missing field/i)
    expect(() => createLocalWorkflowSurfaceExperimentRuntime({
      ...observedRuntimeConfig,
      frozenConversationSnapshot: {
        ...observedRuntimeConfig.frozenConversationSnapshot,
        messages: [{
          ...observedRuntimeConfig.frozenConversationSnapshot.messages[0],
          digestFacts: { trusted: true },
        }],
      },
    } as any)).toThrow(/unknown or missing field/i)
    expect(() => createLocalWorkflowSurfaceExperimentRuntime({
      ...observedRuntimeConfig,
      resourcePackage: { ...observedRuntimeConfig.resourcePackage, producerDigest: `sha256:${"a".repeat(64)}` },
    } as any)).toThrow(/unknown or missing field/i)
    expect(() => createLocalWorkflowSurfaceExperimentRuntime({
      ...observedRuntimeConfig,
      lifecycleResourcePackageDigest: `sha256:${"b".repeat(64)}`,
    })).toThrow(/claimed resource package digest differs/i)
    const sparseMessages = new Array(1)
    expect(() => createLocalWorkflowSurfaceExperimentRuntime({
      ...observedRuntimeConfig,
      frozenConversationSnapshot: {
        ...observedRuntimeConfig.frozenConversationSnapshot,
        messages: sparseMessages,
      },
    } as any)).toThrow(/dense/i)
    const accessorMessage = Object.defineProperty({ role: "user" }, "content", {
      get: () => "accessor-controlled",
      enumerable: true,
    })
    expect(() => createLocalWorkflowSurfaceExperimentRuntime({
      ...observedRuntimeConfig,
      frozenConversationSnapshot: {
        ...observedRuntimeConfig.frozenConversationSnapshot,
        messages: [accessorMessage],
      },
    } as any)).toThrow(/own-data/i)
    const customPrototypeMessage = Object.assign(Object.create({ claimedAuthority: true }), {
      role: "user",
      content: "custom prototype",
    })
    expect(() => createLocalWorkflowSurfaceExperimentRuntime({
      ...observedRuntimeConfig,
      frozenConversationSnapshot: {
        ...observedRuntimeConfig.frozenConversationSnapshot,
        messages: [customPrototypeMessage],
      },
    } as any)).toThrow(/plain own-data/i)
    expect(() => createLocalWorkflowSurfaceExperimentRuntime({
      ...observedRuntimeConfig,
      resourcePackage: {
        ...observedRuntimeConfig.resourcePackage,
        resources: Object.assign(Object.create({ inherited: "authority" }), observedRuntimeConfig.resourcePackage.resources),
      },
    } as any)).toThrow(/plain own-data/i)
    expect(() => createLocalWorkflowSurfaceExperimentRuntime({
      ...observedRuntimeConfig,
      lifecycleToolProfileDigest: `sha256:${"c".repeat(64)}`,
    })).toThrow(/claimed tool profile digest differs/i)
    const configWithSymbol = { ...observedRuntimeConfig }
    Object.defineProperty(configWithSymbol, Symbol("config-authority"), { value: "forged" })
    expect(() => createLocalWorkflowSurfaceExperimentRuntime(configWithSymbol)).toThrow(/symbol/i)
    const messageWithSymbol = {
      ...observedRuntimeConfig.frozenConversationSnapshot.messages[0],
    }
    Object.defineProperty(messageWithSymbol, Symbol("message-authority"), { value: "forged" })
    expect(() => createLocalWorkflowSurfaceExperimentRuntime({
      ...observedRuntimeConfig,
      frozenConversationSnapshot: {
        ...observedRuntimeConfig.frozenConversationSnapshot,
        messages: [messageWithSymbol],
      },
    } as any)).toThrow(/symbol/i)
    const packageWithSymbol = { ...observedRuntimeConfig.resourcePackage }
    Object.defineProperty(packageWithSymbol, Symbol("package-authority"), { value: "forged" })
    expect(() => createLocalWorkflowSurfaceExperimentRuntime({
      ...observedRuntimeConfig,
      resourcePackage: packageWithSymbol,
    })).toThrow(/symbol/i)
  })

  test("independently recomputes eligibility and cost and uses explicit stable tie-breakers", () => {
    if (!observedRawReport || !observedRuntime) throw new Error("raw experiment did not run")
    const selection = selectWorkflowSurfaceStrategy(observedRawReport, observedRuntime)
    expect(selection.selectedStrategyRevision).toBe("stable-superset/v1")
    expect(SELECTED_WORKFLOW_SURFACE_STRATEGY_REVISION).toBe(selection.selectedStrategyRevision)
    expect(selection.ranking.map((candidate) => candidate.strategyRevision)).toEqual([
      "stable-superset/v1",
      "hybrid/v1",
      "stage-epoch/v1",
    ])
    const [stable, hybrid, stageEpoch] = selection.ranking
    expect(stable!.normalizedJourneyCost).toBeLessThan(hybrid!.normalizedJourneyCost)
    expect(hybrid!.normalizedJourneyCost).toBe(stageEpoch!.normalizedJourneyCost)
    expect(selection.ranking.every((candidate) => candidate.eligible)).toBe(true)

    const untrustedWinner = JSON.parse(JSON.stringify(observedRawReport))
    untrustedWinner.winner = "stable-superset/v1"
    expect(() => selectWorkflowSurfaceStrategy(untrustedWinner, observedRuntime!)).toThrow(/winner|field/i)

    const symbolReport = JSON.parse(JSON.stringify(observedRawReport))
    Object.defineProperty(symbolReport, Symbol("signed-report-authority"), {
      value: "forged-with-unchanged-receipt",
      enumerable: false,
    })
    expect(() => selectWorkflowSurfaceStrategy(symbolReport, observedRuntime!)).toThrow(/symbol/i)

    const symbolCandidate = JSON.parse(JSON.stringify(observedRawReport))
    Object.defineProperty(symbolCandidate.candidates[0], Symbol("candidate-authority"), {
      get: () => "forged-with-unchanged-receipt",
      enumerable: true,
    })
    expect(() => selectWorkflowSurfaceStrategy(symbolCandidate, observedRuntime!)).toThrow(/symbol/i)

    const accessorCandidate = JSON.parse(JSON.stringify(observedRawReport))
    const originalStrategyDigest = accessorCandidate.candidates[0].strategyDigest
    Object.defineProperty(accessorCandidate.candidates[0], "strategyDigest", {
      get: () => originalStrategyDigest,
      enumerable: true,
    })
    expect(() => selectWorkflowSurfaceStrategy(accessorCandidate, observedRuntime!)).toThrow(/own-data/i)

    const symbolRef = JSON.parse(JSON.stringify(observedRawReport))
    Object.defineProperty(symbolRef.sourceActorRef, Symbol("ref-authority"), { value: "forged" })
    expect(() => selectWorkflowSurfaceStrategy(symbolRef, observedRuntime!)).toThrow(/symbol/i)

    const symbolCandidateArray = JSON.parse(JSON.stringify(observedRawReport))
    Object.defineProperty(symbolCandidateArray.candidates, Symbol("array-authority"), { value: "forged" })
    expect(() => selectWorkflowSurfaceStrategy(symbolCandidateArray, observedRuntime!)).toThrow(/symbol/i)

    const candidateWinner = JSON.parse(JSON.stringify(observedRawReport))
    candidateWinner.candidates[0].winner = true
    const { reportDigest: _candidateWinnerDigest, ...candidateWinnerBody } = candidateWinner
    candidateWinner.reportDigest = digestClosedWorkflowSurfaceValue(candidateWinnerBody)
    expect(() => selectWorkflowSurfaceStrategy(candidateWinner, observedRuntime!)).toThrow(/runtime owner receipt/i)

    const requestWinner = JSON.parse(JSON.stringify(observedRawReport))
    requestWinner.candidates[0].evidenceRef.winner = true
    const { reportDigest: _requestWinnerDigest, ...requestWinnerBody } = requestWinner
    requestWinner.reportDigest = digestClosedWorkflowSurfaceValue(requestWinnerBody)
    expect(() => selectWorkflowSurfaceStrategy(requestWinner, observedRuntime!)).toThrow(/runtime owner receipt|field/i)

    const forgedCost = JSON.parse(JSON.stringify(observedRawReport))
    forgedCost.candidates[0].cloneInstanceDigest = `sha256:${"9".repeat(64)}`
    const { reportDigest: _oldForged, ...forgedBody } = forgedCost
    forgedCost.reportDigest = digestClosedWorkflowSurfaceValue(forgedBody)
    expect(() => selectWorkflowSurfaceStrategy(forgedCost, observedRuntime!)).toThrow(/runtime owner receipt/i)

    const forgedAdmittedUnit = JSON.parse(JSON.stringify(observedRawReport))
    forgedAdmittedUnit.candidates[0].evidenceRef.artifactDigest = `sha256:${"8".repeat(64)}`
    const { reportDigest: _oldUnitDigest, ...forgedUnitBody } = forgedAdmittedUnit
    forgedAdmittedUnit.reportDigest = digestClosedWorkflowSurfaceValue(forgedUnitBody)
    expect(() => selectWorkflowSurfaceStrategy(forgedAdmittedUnit, observedRuntime!)).toThrow(/runtime owner receipt/i)

    const incorrect = JSON.parse(JSON.stringify(observedRawReport))
    incorrect.candidates[0].strategyRevision = "stable-superset/v1"
    const { reportDigest: _oldIncorrect, ...incorrectBody } = incorrect
    incorrect.reportDigest = digestClosedWorkflowSurfaceValue(incorrectBody)
    expect(() => selectWorkflowSurfaceStrategy(incorrect, observedRuntime!)).toThrow(/runtime owner receipt/i)

    expect(() => Object.defineProperty(observedRuntime!, "readEvidence", {
      value: () => ({ winner: "stage-epoch/v1" }),
    })).toThrow()
    expect(Object.keys(observedRuntime!)).toEqual(["schemaVersion", "ownerId"])

    if (!observedRuntimeConfig) throw new Error("runtime config unavailable")
    const secondOwner = createLocalWorkflowSurfaceExperimentRuntime(observedRuntimeConfig)
    expect(() => selectWorkflowSurfaceStrategy(observedRawReport!, secondOwner)).toThrow(/authority mismatch/i)

    if (!observedArtifactRoot) throw new Error("private artifact root unavailable to adversarial filesystem fixture")
    const sourceActorPath = path.join(
      observedArtifactRoot,
      `${observedRawReport.sourceActorRef.artifactDigest.slice("sha256:".length)}.json`,
    )
    const originalSourceActorBytes = fs.readFileSync(sourceActorPath, "utf8")
    fs.writeFileSync(sourceActorPath, originalSourceActorBytes.replace("workflow-author-parent-id", "tampered-parent-id"))
    expect(() => selectWorkflowSurfaceStrategy(observedRawReport!, observedRuntime!)).toThrow(/artifact digest mismatch/i)
    fs.writeFileSync(sourceActorPath, originalSourceActorBytes)
    const candidatePath = path.join(
      observedArtifactRoot,
      `${observedRawReport.candidates[0]!.evidenceRef.artifactDigest.slice("sha256:".length)}.json`,
    )
    const originalCandidateBytes = fs.readFileSync(candidatePath, "utf8")
    fs.writeFileSync(
      candidatePath,
      originalCandidateBytes.replace("candidate-evidence/v1", "candidate-evidence/tampered"),
    )
    expect(() => selectWorkflowSurfaceStrategy(observedRawReport!, observedRuntime!)).toThrow(/artifact digest mismatch/i)
  })
})
