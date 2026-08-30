#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { composeToolRegistry } from "../cell/packages/ai-organ-logic/src/composer/AIAgent/ToolFuncComposer"
import { createAiAgentOrchestratorDriver } from "../cell/packages/ai-organ-logic/src/OrchestratorDriver"
import {
  configureRuntimePersistenceSupport,
  recoverAiAgentRuntime,
  saveAiAgentRuntimeSnapshot,
} from "../cell/packages/ai-organ-logic/src/persistence/RuntimeSnapshots"
import {
  flattenModelConfig,
  loadProviderCatalog,
  processRuntimeIngressStream,
  ProviderRuntimeLlmAdapter,
  readProviderCacheObservationProjection,
} from "../cell/packages/ai-organ-logic/src"
import { compareProviderCacheCostObservations } from "../cell/packages/ai-organ-logic/src/llm/ProviderCacheCostObservation"
import { createAIDataAutonomousControlState } from "../cell/packages/ai-organ-logic/src/workflow/runtime/AIDataAutonomousControlLoop"
import { WorkflowRuntimeService } from "../cell/packages/ai-organ-logic/src/workflow/runtime/WorkflowRuntimeService"
import {
  autonomousPlanningControllerTurnsFromCheckpoint,
  autonomousPlanningResourceFiles,
  autonomousPlanningSourceConformance,
  bindAutonomousPlanningLiveRunnerSource,
  sealAutonomousPlanningReceipt,
  verifyAutonomousPlanningReceipt,
} from "../cell/packages/ai-organ-logic/tests/workflow/autonomous_planning_e2e_testkit"
import {
  AgentRegistry,
  createActor,
  createAIDataControlRuntime,
  createVM,
  DomainRuntimeEventGraph,
  freezeAIDataControlCapabilityCatalog,
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFileRuntimeDerivedIndexesStore,
  LocalFileRuntimeSnapshotRepositoryFactory,
} from "../cell/packages/ai-organ-logic/tests/workflow/autonomous_planning_live_runner_dependencies"

type PropositionId = "construct-value" | "repair-after-verifier-gap"
type CorrelatedCacheObservation = Readonly<{ observation: any; actorId: string }>

declare const AUTONOMOUS_PLANNING_LIVE_RUNNER_SOURCE: string

const MODEL_REF = "deepseek-iqingwa/deepseek-v4-pro"
const embeddedRunnerSource = typeof AUTONOMOUS_PLANNING_LIVE_RUNNER_SOURCE === "string"
  ? AUTONOMOUS_PLANNING_LIVE_RUNNER_SOURCE
  : ""

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function selectedPropositions(): readonly PropositionId[] {
  const value = option("--proposition") ?? "all"
  if (value === "all") return ["construct-value", "repair-after-verifier-gap"]
  if (value === "construct-value" || value === "repair-after-verifier-gap") return [value]
  throw new Error(`unsupported --proposition: ${value}`)
}

export function pairAutonomousPlanningProviderAttempts(input: Readonly<{
  requests: readonly any[]
  outcomes: readonly any[]
  providerId: string
  model?: string
}>) {
  const protocol = createAIDataControlRuntime()
  const transportRequests = input.requests.filter(
    (item) => item.captureLayer === "provider_transport_before_send",
  )
  const attemptIdentity = (item: any) => {
    const providerAttemptOrdinal = item.providerAttemptOrdinal ?? item.attemptOrdinal
    if (typeof item.providerCallId !== "string" || item.providerCallId.length === 0
      || !Number.isSafeInteger(item.providerCallOrdinal) || item.providerCallOrdinal < 1
      || !Number.isSafeInteger(providerAttemptOrdinal) || providerAttemptOrdinal < 1
      || !Number.isSafeInteger(item.transportAttemptOrdinal) || item.transportAttemptOrdinal < 1
      || (item.transportType !== "http" && item.transportType !== "websocket")
      || item.providerId !== input.providerId || typeof item.model !== "string" || item.model.length === 0
      || (input.model !== undefined && item.model !== input.model)
      || typeof item.actorId !== "string" || item.actorId.length === 0) {
      throw new Error("LIVE_PROVIDER_ATTEMPT_IDENTITY_INVALID")
    }
    return Object.freeze({
      providerCallId: item.providerCallId,
      providerCallOrdinal: item.providerCallOrdinal,
      providerAttemptOrdinal,
      transportAttemptOrdinal: item.transportAttemptOrdinal,
      transportType: item.transportType,
      providerId: item.providerId,
      model: item.model,
      actorId: item.actorId,
      sessionId: typeof item.sessionId === "string" ? item.sessionId : null,
      turnId: typeof item.turnId === "string" ? item.turnId : null,
      traceId: typeof item.traceId === "string" ? item.traceId : null,
    })
  }
  const outcomesByIdentity = new Map<string, Readonly<{ outcome: any; identity: ReturnType<typeof attemptIdentity> }>>()
  for (const outcome of input.outcomes) {
    const identity = attemptIdentity(outcome)
    const digest = protocol.stableDigest(identity)
    if (outcomesByIdentity.has(digest)) throw new Error("LIVE_PROVIDER_OUTCOME_DUPLICATE")
    outcomesByIdentity.set(digest, Object.freeze({ outcome, identity }))
  }
  const attempts = transportRequests.map((request) => {
    const requestIdentity = attemptIdentity(request)
    const requestIdentityDigest = protocol.stableDigest(requestIdentity)
    const matched = outcomesByIdentity.get(requestIdentityDigest)
    if (!matched) throw new Error("LIVE_PROVIDER_OUTCOME_MISSING")
    outcomesByIdentity.delete(requestIdentityDigest)
    return Object.freeze({
      identity: requestIdentity,
      requestIdentityDigest,
      outcomeIdentityDigest: protocol.stableDigest(matched.identity),
      terminalState: matched.outcome.terminalState,
      fallbackUsed: matched.outcome.fallbackUsed,
      completenessStatus: matched.outcome.completenessStatus,
      completenessSource: matched.outcome.completenessSource,
      completenessReasonDigest: protocol.stableDigest(matched.outcome.completenessReason),
    })
  })
  if (outcomesByIdentity.size > 0 || attempts.length !== input.outcomes.length) {
    throw new Error("LIVE_PROVIDER_ATTEMPT_ACCOUNTING_MISMATCH")
  }
  return Object.freeze(attempts)
}

function providerFacts(
  observations: readonly CorrelatedCacheObservation[],
  requests: readonly any[],
  outcomes: readonly any[],
) {
  const protocol = createAIDataControlRuntime()
  const transportRequests = requests.filter((item) => item.captureLayer === "provider_transport_before_send")
  const attempts = pairAutonomousPlanningProviderAttempts({
    requests,
    outcomes,
    providerId: "deepseek-iqingwa",
  })
  if (observations.length !== transportRequests.length) {
    throw new Error("LIVE_PROVIDER_CACHE_COVERAGE_MISMATCH")
  }
  const groups = new Map<string, CorrelatedCacheObservation[]>()
  for (const item of observations) {
    const { observation, actorId } = item
    const key = `${observation.identity.actorClass}\u0000${observation.identity.contextEpoch}`
      + `\u0000${actorId}`
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const prefixComparisons = [...groups.values()].flatMap((items) => items.slice(1).map((item, index) => {
    const prior = items[index]!
    const comparison = compareProviderCacheCostObservations(prior.observation, item.observation)
    return Object.freeze({
      actorId: item.actorId,
      actorClass: item.observation.identity.actorClass,
      contextEpoch: item.observation.identity.contextEpoch,
      priorObservationDigest: protocol.stableDigest(prior.observation),
      currentObservationDigest: protocol.stableDigest(item.observation),
      retainedPrefixIntegrity: comparison.retainedPrefixIntegrity,
    })
  }))
  if (prefixComparisons.length === 0) throw new Error("LIVE_PREFIX_COMPARISON_COVERAGE_MISSING")
  const usage = observations.flatMap(({ observation }) => (
    observation.tokenBreakdown.usage ? [observation.tokenBreakdown.usage] : []
  ))
  return Object.freeze({
    provider: "deepseek-iqingwa",
    model: MODEL_REF,
    calls: transportRequests.length,
    failures: attempts.filter((item) => item.terminalState !== "completed").length,
    replays: attempts.filter((item) => item.fallbackUsed || item.identity.providerAttemptOrdinal > 1).length,
    attempts: Object.freeze(attempts),
    cacheObservationCount: observations.length,
    prefixComparisons: Object.freeze(prefixComparisons),
    promptTokens: usage.reduce((sum, item) => sum + item.cacheHitTokens + item.cacheMissTokens, 0),
    outputTokens: usage.reduce((sum, item) => sum + item.completionTokens, 0),
    cacheReadTokens: usage.reduce((sum, item) => sum + item.cacheHitTokens, 0),
    prefixIntegrity: prefixComparisons.every((item) => item.retainedPrefixIntegrity === 1) ? 1 as const : 0 as const,
  })
}

async function writeResourcePackage(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, "utf8")
  }
}

async function runProposition(
  outputRoot: string,
  propositionId: PropositionId,
  runnerSource: string,
): Promise<Readonly<{ propositionId: PropositionId; receiptPath: string; summary: unknown }>> {
  const propositionRoot = path.join(outputRoot, propositionId)
  const resources = path.join(propositionRoot, "resources")
  const workspaceRoot = path.join(propositionRoot, "workspace")
  const sessionDir = path.join(propositionRoot, "session")
  await mkdir(workspaceRoot, { recursive: true })
  await writeFile(path.join(workspaceRoot, "AGENTS.md"), "Preserve immutable verifier authority and use only admitted AI Data decisions.\n", "utf8")

  const protocol = createAIDataControlRuntime()
  const valueSchema = "schema://eidolon.autonomous/value"
  const repair = propositionId === "repair-after-verifier-gap"
  const goal = Object.freeze({
    schemaVersion: "depa.ai-data-control/v1" as const,
    goalId: `goal:${propositionId}`,
    objective: repair
      ? "Produce a transformed value that remains acceptable after verifier-driven refinement"
      : "Construct a valid implementation path and produce one accepted transformed value",
    verifierRef: `resource://eidolon.autonomous.${repair ? "RefinementVerifier" : "ConstructionVerifier"}` as const,
    requiredOutputSchemaRef: valueSchema,
  })
  const catalog = freezeAIDataControlCapabilityCatalog(protocol, {
    schemaVersion: "depa.ai-data-control/v1",
    catalogId: `catalog:${propositionId}`,
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
    budget: {
      schemaVersion: "depa.ai-data-control/v1",
      limits: { maxIterations: repair ? 10 : 6, maxOperationsPerDecision: 1, maxNoProgressIterations: 3 },
      usage: { iteration: 0, noProgressIterations: 0 },
    },
    controller: {
      taskProofRef: "resource://eidolon.autonomous.ControllerBinding",
      agentDefinitionRef: "resource://eidolon.autonomous.ControllerAgent",
      instanceName: "controller-instance",
    },
    maxObservedNodes: 16,
  })
  const resourceFiles = autonomousPlanningResourceFiles(controlState)
  await writeResourcePackage(resources, resourceFiles)

  const selected = flattenModelConfig(MODEL_REF, loadProviderCatalog())
  if (!selected || selected.provider !== "deepseek-iqingwa" || selected.adapter !== "deepseek") {
    throw new Error(`LIVE_PROVIDER_BINDING_INVALID: ${MODEL_REF}`)
  }
  if (!selected.apiKey || !selected.baseURL) throw new Error("LIVE_PROVIDER_CREDENTIAL_MISSING")
  const requestFacts: any[] = []
  const outcomeFacts: any[] = []
  const sessionId = `autonomous-${propositionId}`
  const llmAdapter = new ProviderRuntimeLlmAdapter({
    providerId: selected.provider,
    selectedModel: selected.model,
    adapterName: selected.adapter,
    options: { ...selected.options, apiKey: selected.apiKey, baseURL: selected.baseURL },
    runtime: {
      sessionId,
      chatCompatibilityProfileId: "deepseek-compatible-chat@1",
      requestObservationPort: {
        append: (fact) => requestFacts.push(fact),
        appendOutcome: (fact) => outcomeFacts.push(fact),
      },
    },
  })
  const eventBus = new DomainRuntimeEventGraph()
  const actor = createActor({
    key: "main",
    id: `runtime-${propositionId}`,
    llmClient: llmAdapter,
    modelConfig: {
      provider: selected.provider,
      adapter: selected.adapter,
      model: selected.model,
      baseUrl: selected.baseURL,
      apiKey: selected.apiKey,
      inputLimit: selected.inputLimit,
      outputLimit: selected.outputLimit,
      maxInputTokens: selected.inputLimit,
      maxOutputTokens: selected.outputLimit,
      options: selected.options,
      capabilities: selected.capabilities,
    },
    callbacks: {
      buildToolset: () => [],
      processStream: (vm, streamActor, stream, options) => processRuntimeIngressStream({
        stream,
        adapterType: "deepseek",
        llmAdapter: options?.llmAdapter,
        eventBus,
        actorMeta: { agentKey: streamActor.key, agentActorId: streamActor.id },
        sessionDir,
        sessionId,
        signal: options?.signal,
      }),
    },
  })
  const vm = createVM({
    controlActorKey: actor.key,
    actors: { [actor.key]: actor },
    registries: { toolRegistry: composeToolRegistry(), agentRegistry: new AgentRegistry({}) },
    eventBus,
    outerCtx: {
      workDir: propositionRoot,
      metadata: {
        sessionDir,
        sessionId,
        aiWorkflow: { roots: { workspaceRoot } },
        resourcePackages: { layers: [{ id: "workspace", rootDir: resources }] },
      },
    },
  })
  const first = new WorkflowRuntimeService({ vm, actor } as any)
  const instance = await first.createInstance({
    workflowRef: "resource://eidolon.autonomous.DataWorkflow",
    instanceId: `instance-${propositionId}`,
    initialInput: { value: repair ? "seed" : "construct this value" },
  })
  const runId = `run-${propositionId}`
  await first.start({ instanceId: instance.instanceId, runId, confirmed: true })

  let activeVm = vm
  let service = first
  const cacheObservations: CorrelatedCacheObservation[] = []
  let correlatedTransportRequestCount = 0
  const captureCacheObservations = (sourceVm: typeof vm): void => {
    const projected = readProviderCacheObservationProjection(sourceVm)
    const transportRequests = requestFacts.filter((item) => item.captureLayer === "provider_transport_before_send")
    if (correlatedTransportRequestCount + projected.length > transportRequests.length) {
      throw new Error("LIVE_CACHE_OBSERVATION_CORRELATION_MISMATCH")
    }
    projected.forEach((observation, index) => {
      const request = transportRequests[correlatedTransportRequestCount + index]
      cacheObservations.push(Object.freeze({
        observation,
        actorId: typeof request?.actorId === "string" ? request.actorId : `unknown-${correlatedTransportRequestCount + index}`,
      }))
    })
    correlatedTransportRequestCount += projected.length
  }
  if (repair) {
    await first.runAutonomousControl(runId, {
      verify: async ({ graph }) => {
        if (graph.currentGeneration === 1) throw new Error("LIVE_RECOVERY_BOUNDARY_AFTER_FIRST_PATCH")
        return verifierFact(goal, graph, false)
      },
    }).then(() => { throw new Error("LIVE_RECOVERY_BOUNDARY_NOT_REACHED") }, (error) => {
      if (!String(error).includes("LIVE_RECOVERY_BOUNDARY_AFTER_FIRST_PATCH")) throw error
    })
    captureCacheObservations(vm)
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
    await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver: snapshotDriver })
    const recovered = await recoverAiAgentRuntime({
      sessionDir,
      sessionId,
      llmClient: llmAdapter,
      actorCallbacks: actor.callbacks,
      registries: vm.registries,
      callbacks: vm.callbacks,
      effects: vm.effects,
      eventBus,
      outerCtx: vm.outerCtx,
      mcpManager: vm.mcpManager,
    })
    if (!recovered) throw new Error("LIVE_RUNTIME_RECOVERY_FAILED")
    activeVm = recovered.vm
    service = new WorkflowRuntimeService({ vm: recovered.vm, actor: recovered.controlActor } as any)
  }

  const completed = await service.runAutonomousControl(runId, {
    verify: async ({ graph }) => verifierFact(goal, graph, repair),
  })
  captureCacheObservations(activeVm)
  const conformance = autonomousPlanningSourceConformance({
    plannerSource: resourceFiles["Prompts/Controller.xnl"] ?? "",
    harnessSource: "service.runAutonomousControl(runId, immutableVerifier)",
    fixtureSources: resourceFiles,
    evidenceClass: "live-provider/v1",
  })
  if (conformance.length > 0) throw new Error(`LIVE_SOURCE_CONFORMANCE_FAILED: ${JSON.stringify(conformance)}`)
  const receipt = sealAutonomousPlanningReceipt({
    evidenceClass: "live-provider/v1",
    workflowRef: "resource://eidolon.autonomous.DataWorkflow",
    instanceId: instance.instanceId,
    checkpoint: completed.checkpoint,
    resourceSources: resourceFiles,
    executableSources: [runnerSource],
    controllerTurns: autonomousPlanningControllerTurnsFromCheckpoint(completed.checkpoint),
    provider: providerFacts(cacheObservations, requestFacts, outcomeFacts),
  })
  verifyAutonomousPlanningReceipt(receipt, {
    requireLiveProvider: true,
    minDistinctPatches: repair ? 2 : 1,
    requiredReuseRoles: repair ? ["controller", "worker"] : ["controller"],
    requireInvalidDecisionFeedback: false,
  })
  if (receipt.provider.provider !== "deepseek-iqingwa" || receipt.provider.model !== MODEL_REF || receipt.provider.calls < 2) {
    throw new Error("LIVE_PROVIDER_EVIDENCE_MISMATCH")
  }
  const receiptPath = path.join(propositionRoot, "receipt.json")
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8")
  return Object.freeze({
    propositionId,
    receiptPath,
    summary: {
      completed: receipt.outcome.completed,
      generation: receipt.authority.finalGeneration,
      patches: receipt.authority.patchDigests.length,
      iterations: receipt.control.iterations.length,
      controllerModes: receipt.agents.filter((item) => item.role === "controller").map((item) => item.mode),
      workerModes: receipt.agents.filter((item) => item.role === "worker").map((item) => item.mode),
      provider: receipt.provider,
    },
  })
}

function verifierFact(goal: any, graph: any, repair: boolean) {
  const value = graph.nodes.worker?.result?.output?.value
  const validValue = typeof value === "string" && value.trim().length > 0
  const passed = validValue && (!repair || graph.currentGeneration >= 2)
  return Object.freeze({
    schemaVersion: "depa.ai-data-control/v1" as const,
    factId: `verifier:${graph.currentGeneration}:${createAIDataControlRuntime().stableDigest({ validValue, repair })}`,
    goalId: goal.goalId,
    graphGeneration: graph.currentGeneration,
    status: passed ? "passed" as const : "failed" as const,
    verifierRef: goal.verifierRef,
    requiredOutputSchemaRef: goal.requiredOutputSchemaRef,
    diagnostics: passed
      ? []
      : [{
          code: validValue && repair ? "REFINEMENT_REQUIRED" : "VALID_VALUE_REQUIRED",
          message: validValue && repair
            ? "The current value is valid but requires one additional verifier-driven refinement of an existing capability."
            : "No valid transformed Worker value is present in the current canonical generation.",
        }],
  })
}

async function main(): Promise<void> {
  const sourceBinding = await bindAutonomousPlanningLiveRunnerSource({
    workspaceRoot: path.resolve(option("--workspace-root") ?? process.cwd()),
    embeddedSource: embeddedRunnerSource,
  })
  if (process.argv.includes("--verify-source-binding")) {
    process.stdout.write(`${JSON.stringify({
      accepted: true,
      sourceRef: sourceBinding.sourceRef,
      executableDigest: createAIDataControlRuntime().stableDigest([sourceBinding.source]),
    }, null, 2)}\n`)
    return
  }
  configureRuntimePersistenceSupport({
    snapshotRepositoryFactory: LocalFileRuntimeSnapshotRepositoryFactory,
    derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore,
    conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
  })
  const outputRoot = path.resolve(option("--output") ?? ".tmp/autonomous-ai-data-live")
  await mkdir(outputRoot, { recursive: true })
  const results = []
  for (const propositionId of selectedPropositions()) {
    results.push(await runProposition(outputRoot, propositionId, sourceBinding.source))
  }
  process.stdout.write(`${JSON.stringify({ accepted: true, model: MODEL_REF, outputRoot, results }, null, 2)}\n`)
}

if (import.meta.main) await main()
