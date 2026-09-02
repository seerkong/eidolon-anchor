import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import {
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFileRuntimeDerivedIndexesStore,
  LocalFileRuntimeSnapshotRepositoryFactory,
} from "@cell/ai-support"
import { createAIDataControlRuntime, freezeAIDataControlCapabilityCatalog } from "ai-data-workflow-logic"

import { composeToolRegistry } from "../../src/composer/AIAgent/ToolFuncComposer"
import { appendLiveHistoryMessageToConversationDomainRuntime } from "../../src/conversation/ConversationDomainRuntime"
import { createAiAgentOrchestratorDriver } from "../../src/OrchestratorDriver"
import {
  configureRuntimePersistenceSupport,
  recoverAiAgentRuntime,
  saveAiAgentRuntimeSnapshot,
} from "../../src/persistence/RuntimeSnapshots"
import { createAIDataAutonomousControlState } from "../../src/workflow/runtime/AIDataAutonomousControlLoop"
import { WorkflowRuntimeService } from "../../src/workflow/runtime/WorkflowRuntimeService"
import {
  autonomousPlanningResourceFiles,
  autonomousPlanningSourceConformance,
  bindAutonomousPlanningLiveRunnerSource,
  decideFromGoalCatalogAndObservation,
  sealAutonomousPlanningReceipt,
  verifyAutonomousPlanningReceipt,
  type AutonomousPlanningControllerTurn,
  type AutonomousPlanningSealedReceipt,
} from "./autonomous_planning_e2e_testkit"
import { pairAutonomousPlanningProviderAttempts } from "../../../../../scripts/run-autonomous-ai-data-live"

const temporaryRoots: string[] = []

configureRuntimePersistenceSupport({
  snapshotRepositoryFactory: LocalFileRuntimeSnapshotRepositoryFactory,
  derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore,
  conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
})

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function cloneReceipt(receipt: AutonomousPlanningSealedReceipt): AutonomousPlanningSealedReceipt {
  return JSON.parse(JSON.stringify(receipt)) as AutonomousPlanningSealedReceipt
}

function redigestReceipt(receipt: AutonomousPlanningSealedReceipt): AutonomousPlanningSealedReceipt {
  const mutable = receipt as any
  const { receiptDigest: _receiptDigest, ...unsigned } = mutable
  mutable.receiptDigest = runtimeDigest(unsigned)
  return receipt
}

describe("autonomous planning anti-cheat contract", () => {
  it("binds live evidence only to the current runner source embedded by the executable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-autonomous-live-source-"))
    temporaryRoots.push(root)
    const sourcePath = path.join(root, "scripts", "run-autonomous-ai-data-live.ts")
    const bundlePath = path.join(root, ".tmp", "autonomous-ai-data-live", "runner.js")
    await mkdir(path.dirname(sourcePath), { recursive: true })
    await mkdir(path.dirname(bundlePath), { recursive: true })
    await writeFile(sourcePath, "export const currentRunner = true\n", "utf8")
    await writeFile(bundlePath, "// compiled runner bundle\n", "utf8")

    await expect(bindAutonomousPlanningLiveRunnerSource({
      workspaceRoot: root,
      embeddedSource: "export const currentRunner = true\n",
    })).resolves.toMatchObject({
      sourceRef: "scripts/run-autonomous-ai-data-live.ts",
      sourcePath: await realpath(sourcePath),
      source: "export const currentRunner = true\n",
    })
    await expect(bindAutonomousPlanningLiveRunnerSource({
      workspaceRoot: root,
      embeddedSource: await readFile(bundlePath, "utf8"),
    })).rejects.toThrow("LIVE_RUNNER_SOURCE_BINDING_MISMATCH")
  })

  it("pairs v2 attempts from the exact ProviderRuntimeAdapter request and outcome shapes", () => {
    const sharedIdentity = {
      schemaVersion: 1 as const,
      sessionId: "session-1",
      actorId: "actor-1",
      turnId: "turn-1",
      traceId: "trace-1",
      providerCallId: "provider-call-1",
      providerCallOrdinal: 1,
      providerAttemptOrdinal: 1,
      attemptOrdinal: 1,
      transportAttemptOrdinal: 1,
      transportType: "http" as const,
      providerId: "deepseek-iqingwa",
      model: "deepseek-v4-pro",
    }
    const request = {
      ...sharedIdentity,
      requestModel: "deepseek-v4-pro",
      adapterName: "deepseek",
      driverName: "deepseek-chat",
      captureLayer: "provider_transport_before_send" as const,
      capturedAt: 1,
      messages: [],
      tools: [],
      requestBody: "{\"redacted\":true}",
      planKind: null,
      replaySource: null,
      previousResponseIdDecision: null,
      previousResponseId: null,
      previousResponseIdDecisionReason: null,
      requestContract: {},
    }
    const outcome = {
      ...sharedIdentity,
      terminalState: "completed" as const,
      fallbackUsed: false,
      completenessStatus: "complete" as const,
      completenessSource: "completed_output" as const,
      completenessReason: null,
      responseId: "chatcmpl-1",
      capturedAt: 2,
    }

    const attempts = pairAutonomousPlanningProviderAttempts({
      requests: [request],
      outcomes: [outcome],
      providerId: "deepseek-iqingwa",
      model: "deepseek-v4-pro",
    })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.requestIdentityDigest).toBe(attempts[0]?.outcomeIdentityDigest)
    expect(attempts[0]?.identity).toEqual(expect.objectContaining({
      actorId: "actor-1",
      sessionId: "session-1",
      turnId: "turn-1",
      traceId: "trace-1",
    }))
    expect(() => pairAutonomousPlanningProviderAttempts({
      requests: [request],
      outcomes: [{ ...outcome, actorId: "actor-drifted" }],
      providerId: "deepseek-iqingwa",
      model: "deepseek-v4-pro",
    })).toThrow("LIVE_PROVIDER_OUTCOME_MISSING")
  })

  it("rejects hidden answers, graph bypass, shadow authority, fallback creation and evidence relabeling", () => {
    const clean = autonomousPlanningSourceConformance({
      plannerSource: decideFromGoalCatalogAndObservation.toString(),
      harnessSource: "return service.runAutonomousControl(runId, verifier)",
      fixtureSources: {},
      evidenceClass: "deterministic-mechanics/v1",
    })
    expect(clean).toEqual([])

    const cases = [
      ["const expectedPatch = answer", "HIDDEN_ANSWER"],
      ["service.applyGraphPatch(runId, patch)", "DIRECT_GRAPH_MUTATION"],
      ["const shadowGraph = new Map()", "SHADOW_GRAPH_AUTHORITY"],
      ["const fallbackToNew = () => runAgent()", "FALLBACK_AGENT_CREATION"],
      ["const evidenceClass = \"live-provider/v1\"", "EVIDENCE_CLASS_FORGERY"],
    ] as const
    for (const [source, code] of cases) {
      expect(autonomousPlanningSourceConformance({
        plannerSource: source,
        harnessSource: "",
        fixtureSources: {},
        evidenceClass: "deterministic-mechanics/v1",
      })).toEqual(expect.arrayContaining([expect.objectContaining({ code })]))
    }
  })
})

describe("autonomous planning deterministic mechanics E2E", () => {
  it("converges through two observation-driven patches, invalid feedback and fresh-runtime exact reuse", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-autonomous-planning-"))
    temporaryRoots.push(root)
    const resources = path.join(root, "resources")
    const workspaceRoot = path.join(root, "workspace")
    const sessionDir = path.join(root, "session")
    await mkdir(workspaceRoot, { recursive: true })
    await writeFile(path.join(workspaceRoot, "AGENTS.md"), "Keep the verifier immutable and act through admitted decisions.\n", "utf8")

    const protocol = createAIDataControlRuntime()
    const valueSchema = "schema://eidolon.autonomous/value"
    const goal = Object.freeze({
      schemaVersion: "depa.ai-data-control/v1" as const,
      goalId: "goal:autonomous-planning",
      objective: "Produce an accepted transformed value using only the frozen capability catalog",
      verifierRef: "resource://eidolon.autonomous.HiddenVerifier" as const,
      requiredOutputSchemaRef: valueSchema,
    })
    const budget = Object.freeze({
      schemaVersion: "depa.ai-data-control/v1" as const,
      limits: Object.freeze({ maxIterations: 7, maxOperationsPerDecision: 1, maxNoProgressIterations: 3 }),
      usage: Object.freeze({ iteration: 0, noProgressIterations: 0 }),
    })
    const catalog = freezeAIDataControlCapabilityCatalog(protocol, {
      schemaVersion: "depa.ai-data-control/v1",
      catalogId: "catalog:autonomous-planning",
      foundationNodes: {
        entry: { protected: true, inputSchemaRefs: {}, outputSchemaRefs: { value: valueSchema } },
        control: { protected: true, inputSchemaRefs: { value: valueSchema }, outputSchemaRefs: { value: valueSchema } },
        return: { protected: true, inputSchemaRefs: { value: valueSchema }, outputSchemaRefs: {} },
      },
      capabilities: {
        worker: {
          capabilityId: "worker",
          tag: "TransformNode",
          nodeType: "agent",
          inputSchemaRefs: { value: valueSchema },
          outputSchemaRefs: { value: valueSchema },
          fixedConfig: { node_type: "agent", instanceName: "worker-instance", reuse_policy: "never" },
          implementation: {
            kind: "agent",
            agentDefinitionRef: "resource://eidolon.autonomous.WorkerAgent",
            taskProofRef: "resource://eidolon.autonomous.WorkerBinding",
          },
        },
      },
    }, {})
    const controlState = createAIDataAutonomousControlState({
      controlNodeId: "control",
      goal,
      catalog,
      budget,
      controller: {
        taskProofRef: "resource://eidolon.autonomous.ControllerBinding",
        agentDefinitionRef: "resource://eidolon.autonomous.ControllerAgent",
        instanceName: "controller-instance",
      },
      maxObservedNodes: 16,
    })
    const resourceFiles = autonomousPlanningResourceFiles(controlState)
    for (const [relativePath, content] of Object.entries(resourceFiles)) {
      const target = path.join(resources, relativePath)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content, "utf8")
    }

    const controllerTurns: AutonomousPlanningControllerTurn[] = []
    let providerCalls = 0
    const actor = createActor({
      key: "main",
      id: "autonomous-planning-runtime",
      llmClient: {
        type: "openai",
        async createStream() {
          async function* stream() { yield { ok: true } }
          return { stream: stream() }
        },
      },
      modelConfig: { model: "deterministic-mechanics" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (vm, child) => {
          providerCalls += 1
          const latestUser = [...child.messages].reverse().find((message) => message.role === "user")
          const executionInput = JSON.parse(String(latestUser?.content ?? "{}"))
          let output: unknown
          if (child.agentName === "resource://eidolon.autonomous.ControllerAgent") {
            const payload = executionInput.payload
            const decision = decideFromGoalCatalogAndObservation(payload)
            output = payload.observation.graph.generation === 1
              && payload.observation.feedback.length === 0
              ? { malformed: true }
              : decision
            controllerTurns.push(Object.freeze({ payload, rawOutput: output as any }))
          } else {
            output = { value: `transformed:${String(executionInput.payload.value)}` }
          }
          const message = { role: "assistant" as const, content: JSON.stringify(output) }
          appendLiveHistoryMessageToConversationDomainRuntime({ vm, actorKey: child.key, actorId: child.id, message })
          return message
        },
      },
    })
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry: composeToolRegistry(), agentRegistry: new AgentRegistry({}) },
      outerCtx: {
        workDir: root,
        metadata: {
          sessionDir,
          aiWorkflow: { roots: { workspaceRoot } },
          resourcePackages: { layers: [{ id: "workspace", rootDir: resources }] },
        },
      },
    })
    const first = new WorkflowRuntimeService({ vm, actor } as any)
    const instance = await first.createInstance({
      workflowRef: "resource://eidolon.autonomous.DataWorkflow",
      instanceId: "autonomous-planning-instance",
      initialInput: { value: "seed" },
    })
    await first.start({ instanceId: instance.instanceId, runId: "autonomous-planning-run", confirmed: true })
    await expect(first.runAutonomousControl("autonomous-planning-run", {
      verify: async ({ graph }) => {
        if (graph.currentGeneration === 1) throw new Error("FAULT_CRASH_AFTER_FIRST_ADMITTED_PATCH")
        return {
          schemaVersion: "depa.ai-data-control/v1",
          factId: `verifier:${graph.currentGeneration}`,
          goalId: goal.goalId,
          graphGeneration: graph.currentGeneration,
          status: "failed",
          verifierRef: goal.verifierRef,
          requiredOutputSchemaRef: goal.requiredOutputSchemaRef,
          diagnostics: [{ code: "OUTPUT_NOT_ACCEPTED", message: "Current transformed value is not accepted" }],
        }
      },
    })).rejects.toThrow("FAULT_CRASH_AFTER_FIRST_ADMITTED_PATCH")

    const snapshotDriver = createAiAgentOrchestratorDriver({
      fibers: Object.values(vm.actors).map((currentActor) => ({
        fiberId: `${currentActor.key}:${currentActor.id}`,
        vm,
        actor: currentActor,
        messages: currentActor.messages,
        basePriority: 1,
      })),
      runStep: async () => ({ kind: "yield" as const }),
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    expect((await saveAiAgentRuntimeSnapshot({
      sessionDir,
      sessionId: "autonomous-planning-runtime-session",
      vm,
      driver: snapshotDriver,
    })).status).toBe("saved")
    const recoveredRuntime = await recoverAiAgentRuntime({
      sessionDir,
      sessionId: "autonomous-planning-runtime-session",
      llmClient: actor.llmClient,
      actorCallbacks: actor.callbacks,
      registries: vm.registries,
      callbacks: vm.callbacks,
      effects: vm.effects,
      outerCtx: vm.outerCtx,
      mcpManager: vm.mcpManager,
    })
    expect(recoveredRuntime).not.toBeNull()
    const recovered = new WorkflowRuntimeService({
      vm: recoveredRuntime!.vm,
      actor: recoveredRuntime!.controlActor,
    } as any)
    const completed = await recovered.runAutonomousControl("autonomous-planning-run", {
      verify: async ({ graph }) => {
        const output = (graph.nodes.worker?.result?.output as any)?.value
        const passed = typeof output === "string" && output.length >= 20
        return {
          schemaVersion: "depa.ai-data-control/v1",
          factId: `verifier:${graph.currentGeneration}:${runtimeDigest(output)}`,
          goalId: goal.goalId,
          graphGeneration: graph.currentGeneration,
          status: passed ? "passed" : "failed",
          verifierRef: goal.verifierRef,
          requiredOutputSchemaRef: goal.requiredOutputSchemaRef,
          diagnostics: passed ? [] : [{ code: "OUTPUT_NOT_ACCEPTED", message: "Current transformed value is not accepted" }],
        }
      },
    })
    expect(completed.state).toMatchObject({ phase: "completed", iteration: 4 })
    expect(completed.checkpoint.output).toEqual({ value: "transformed:retry:1:value" })

    const fixtureConformance = autonomousPlanningSourceConformance({
      plannerSource: decideFromGoalCatalogAndObservation.toString(),
      harnessSource: "return service.runAutonomousControl(runId, verifier)",
      fixtureSources: resourceFiles,
      evidenceClass: "deterministic-mechanics/v1",
    })
    expect(fixtureConformance).toEqual([])
    const attempts = Object.freeze(Array.from({ length: providerCalls }, (_, index) => {
      const identity = Object.freeze({
        providerCallId: `fixture-call-${index + 1}`,
        providerCallOrdinal: index + 1,
        providerAttemptOrdinal: 1,
        transportAttemptOrdinal: 1,
        transportType: "http" as const,
        providerId: "eidolon-testkit",
        model: "deterministic-mechanics",
        actorId: "fixture-actor",
        sessionId: null,
        turnId: null,
        traceId: null,
      })
      const identityDigest = runtimeDigest(identity)
      return Object.freeze({
        identity,
        requestIdentityDigest: identityDigest,
        outcomeIdentityDigest: identityDigest,
        terminalState: "completed" as const,
        fallbackUsed: false,
        completenessStatus: "complete" as const,
        completenessSource: "completed_output" as const,
        completenessReasonDigest: runtimeDigest(null),
      })
    }))
    const receipt = sealAutonomousPlanningReceipt({
      evidenceClass: "deterministic-mechanics/v1",
      workflowRef: "resource://eidolon.autonomous.DataWorkflow",
      instanceId: instance.instanceId,
      checkpoint: completed.checkpoint,
      resourceSources: resourceFiles,
      executableSources: [
        decideFromGoalCatalogAndObservation.toString(),
        await readFile(new URL("../../src/workflow/runtime/AIDataAutonomousControlRunner.ts", import.meta.url), "utf8"),
      ],
      controllerTurns,
      provider: {
        provider: "eidolon-testkit",
        model: "deterministic-mechanics",
        calls: providerCalls,
        failures: 0,
        replays: 0,
        attempts,
        cacheObservationCount: providerCalls,
        prefixComparisons: [{
          actorId: "fixture-actor",
          actorClass: "workflow_node",
          contextEpoch: 0,
          priorObservationDigest: runtimeDigest("fixture-prefix-prior"),
          currentObservationDigest: runtimeDigest("fixture-prefix-current"),
          retainedPrefixIntegrity: 1,
        }],
        prefixIntegrity: 1,
      },
    })
    verifyAutonomousPlanningReceipt(receipt)
    expect(() => verifyAutonomousPlanningReceipt(receipt, { requireLiveProvider: true }))
      .toThrow("EVIDENCE_LIVE_PROVIDER_REQUIRED")
    expect(receipt.authority.patchDigests).toHaveLength(2)
    expect(new Set(receipt.authority.patchDigests).size).toBe(2)
    expect(receipt.control.iterations.map((item) => item.admissionKind)).toEqual([
      "patch", "rejected", "patch", "complete",
    ])
    expect(receipt.agents.filter((item) => item.role === "controller").map((item) => item.mode))
      .toEqual(["new", "targeted", "targeted", "targeted"])
    expect(receipt.agents.filter((item) => item.role === "worker").map((item) => item.mode))
      .toEqual(["new", "targeted"])

    const tamperedPatch = cloneReceipt(receipt) as any
    tamperedPatch.authority.patchDigests[0] = "tampered"
    expect(() => verifyAutonomousPlanningReceipt(tamperedPatch)).toThrow("EVIDENCE_RECEIPT_DIGEST_MISMATCH")
    const substitutedReuse = cloneReceipt(receipt) as any
    const targetedWorker = substitutedReuse.agents.find((item: any) => item.role === "worker" && item.mode === "targeted")
    targetedWorker.instanceId = "replacement-instance"
    expect(() => verifyAutonomousPlanningReceipt(substitutedReuse)).toThrow("EVIDENCE_RECEIPT_DIGEST_MISMATCH")

    const inflatedCalls = cloneReceipt(receipt) as any
    inflatedCalls.provider.calls = 99
    expect(() => verifyAutonomousPlanningReceipt(redigestReceipt(inflatedCalls)))
      .toThrow("EVIDENCE_PROVIDER_CALL_ACCOUNTING_MISMATCH")
    const missingOutcome = cloneReceipt(receipt) as any
    delete missingOutcome.provider.attempts[0].outcomeIdentityDigest
    expect(() => verifyAutonomousPlanningReceipt(redigestReceipt(missingOutcome)))
      .toThrow("EVIDENCE_PROVIDER_REQUEST_OUTCOME_MISMATCH")
    const missingLedger = cloneReceipt(receipt) as any
    delete missingLedger.provider.attempts
    expect(() => verifyAutonomousPlanningReceipt(redigestReceipt(missingLedger)))
      .toThrow("EVIDENCE_PROVIDER_CALL_ACCOUNTING_MISMATCH")
    const zeroPrefixCoverage = cloneReceipt(receipt) as any
    zeroPrefixCoverage.provider.prefixComparisons = []
    expect(() => verifyAutonomousPlanningReceipt(redigestReceipt(zeroPrefixCoverage)))
      .toThrow("EVIDENCE_PREFIX_COMPARISON_COVERAGE_MISSING")
    const legacyReceipt = cloneReceipt(receipt) as any
    legacyReceipt.schemaVersion = "eidolon.autonomous-planning-evidence/v1"
    expect(() => verifyAutonomousPlanningReceipt(redigestReceipt(legacyReceipt)))
      .toThrow("EVIDENCE_LEGACY_PROVIDER_COVERAGE_UNSUPPORTED")
  // The deterministic proof performs two admitted graph patches, invalid
  // feedback handling, snapshot persistence, and exact fresh-runtime reuse.
  // This budget is test-only and does not relax the control-loop limits.
  }, 60_000)
})

function runtimeDigest(value: unknown): string {
  return createAIDataControlRuntime().stableDigest(value)
}
