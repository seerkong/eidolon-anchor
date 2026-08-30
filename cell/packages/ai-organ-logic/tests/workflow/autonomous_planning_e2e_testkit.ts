import type {
  AIDataControlCapabilityCatalog,
  AIDataControlDecision,
  AIDataControlObservation,
  AIDataControlVerifierFact,
} from "ai-data-workflow-contract"
import { createAIDataControlRuntime } from "ai-data-workflow-logic"
import type {
  AIWorkflowFlowRunCheckpoint,
  AIWorkflowProfileDurableState,
  FlowClosedValue,
} from "ai-workflow-contract"
import { readFile, realpath } from "node:fs/promises"
import path from "node:path"

import {
  readAIDataAutonomousControlState,
  type AIDataAutonomousControlState,
} from "../../src/workflow/runtime/AIDataAutonomousControlLoop"
import type { AIDataAutonomousControllerPayload } from "../../src/workflow/runtime/AIDataAutonomousControlRunner"

export const AUTONOMOUS_PLANNING_LEGACY_RECEIPT_SCHEMA = "eidolon.autonomous-planning-evidence/v1" as const
export const AUTONOMOUS_PLANNING_RECEIPT_SCHEMA = "eidolon.autonomous-planning-evidence/v2" as const
export const AUTONOMOUS_PLANNING_LIVE_RUNNER_SOURCE_REF = "scripts/run-autonomous-ai-data-live.ts" as const

export async function bindAutonomousPlanningLiveRunnerSource(input: Readonly<{
  workspaceRoot: string
  embeddedSource: string
}>): Promise<Readonly<{ sourceRef: typeof AUTONOMOUS_PLANNING_LIVE_RUNNER_SOURCE_REF; sourcePath: string; source: string }>> {
  const expectedSourcePath = await realpath(path.resolve(
    input.workspaceRoot,
    AUTONOMOUS_PLANNING_LIVE_RUNNER_SOURCE_REF,
  ))
  const source = await readFile(expectedSourcePath, "utf8")
  if (input.embeddedSource !== source) {
    throw new Error(
      `LIVE_RUNNER_SOURCE_BINDING_MISMATCH: executable does not embed current source ${expectedSourcePath}`,
    )
  }
  return Object.freeze({
    sourceRef: AUTONOMOUS_PLANNING_LIVE_RUNNER_SOURCE_REF,
    sourcePath: expectedSourcePath,
    source,
  })
}

export type AutonomousPlanningEvidenceClass =
  | "deterministic-mechanics/v1"
  | "live-provider/v1"

export type AutonomousPlanningControllerTurn = Readonly<{
  payload: AIDataAutonomousControllerPayload
  rawOutput: FlowClosedValue
}>

export type AutonomousPlanningProviderAttemptIdentity = Readonly<{
  providerCallId: string
  providerCallOrdinal: number
  providerAttemptOrdinal: number
  transportAttemptOrdinal: number
  transportType: "http" | "websocket"
  providerId: string
  model: string
  actorId: string
  sessionId: string | null
  turnId: string | null
  traceId: string | null
}>

export type AutonomousPlanningProviderFacts = Readonly<{
  provider: string
  model: string
  calls: number
  failures: number
  replays: number
  attempts: readonly Readonly<{
    identity: AutonomousPlanningProviderAttemptIdentity
    requestIdentityDigest: string
    outcomeIdentityDigest: string
    terminalState: "completed" | "failed" | "aborted" | "incomplete"
    fallbackUsed: boolean
    completenessStatus: "complete" | "incomplete" | "not_observed"
    completenessSource: "completed_output" | "indexed_done_items" | "reconstructed_event_items" | null
    completenessReasonDigest: string
  }>[]
  cacheObservationCount: number
  prefixComparisons: readonly Readonly<{
    actorId: string
    actorClass: string
    contextEpoch: number
    priorObservationDigest: string
    currentObservationDigest: string
    retainedPrefixIntegrity: number
  }>[]
  promptTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  prefixIntegrity: 1 | 0
}>

export type AutonomousPlanningSealedReceipt = Readonly<{
  schemaVersion: typeof AUTONOMOUS_PLANNING_RECEIPT_SCHEMA
  evidenceClass: AutonomousPlanningEvidenceClass
  run: Readonly<{
    workflowRef: string
    instanceId: string
    runId: string
    profileKind: string
  }>
  source: Readonly<{
    resourceDigest: string
    executableDigest: string
  }>
  authority: Readonly<{
    goalDigest: string
    verifierIdentityDigest: string
    catalogDigest: string
    finalGraphDigest: string
    finalGeneration: number
    patchDigests: readonly string[]
    patchHistory: readonly unknown[]
    invalidations: readonly unknown[]
  }>
  control: Readonly<{
    iterations: readonly Readonly<{
      iteration: number
      observationDigest: string
      verifierFactDigest: string
      rawOutputDigest: string
      rawOutput: FlowClosedValue
      decisionDigest: string
      admissionKind: string
      generationBefore: number
      generationAfter: number
      feedbackCodes: readonly string[]
    }>[]
    terminal: AIDataAutonomousControlState["terminal"]
  }>
  agents: readonly Readonly<{
    invocationKey: string
    role: "controller" | "worker"
    mode: "new" | "targeted"
    definitionRef: string
    instanceName?: string
    instanceId?: string
    sessionId?: string
    generation?: number
  }>[]
  provider: AutonomousPlanningProviderFacts
  outcome: Readonly<{
    verifierStatus: AIDataControlVerifierFact["status"]
    completed: boolean
    outputDigest: string
  }>
  receiptDigest: string
}>

export type AutonomousPlanningConformanceDiagnostic = Readonly<{
  code:
    | "HIDDEN_ANSWER"
    | "DIRECT_GRAPH_MUTATION"
    | "SHADOW_GRAPH_AUTHORITY"
    | "FALLBACK_AGENT_CREATION"
    | "EVIDENCE_CLASS_FORGERY"
  source: string
  message: string
}>

const runtime = createAIDataControlRuntime()

function sortedEntries<T>(record: Readonly<Record<string, T>>): readonly (readonly [string, T])[] {
  return Object.entries(record).sort(([left], [right]) => left.localeCompare(right))
}

function commonDecision(
  payload: AIDataAutonomousControllerPayload,
  reason: string,
): Omit<AIDataControlDecision, "kind"> {
  return {
    schemaVersion: "depa.ai-data-control/v1",
    decisionId: `decision:${payload.observation.observationDigest}:${runtime.stableDigest(reason)}`,
    goalId: payload.goal.goalId,
    observationId: payload.observation.observationId,
    observationDigest: payload.observation.observationDigest,
    catalogDigest: payload.catalog.digest,
    reason,
  }
}

function compatibleFoundationBinding(
  observation: AIDataControlObservation,
  catalog: AIDataControlCapabilityCatalog,
  schemaRef: string,
): Readonly<{ kind: "port"; nodeId: string; port: string; schemaRef: string }> {
  for (const node of observation.graph.nodes) {
    if (!catalog.foundationNodes[node.nodeId]?.protected) continue
    const output = sortedEntries(node.outputSchemaRefs).find(([, candidate]) => candidate === schemaRef)
    if (output) return Object.freeze({ kind: "port", nodeId: node.nodeId, port: output[0], schemaRef })
  }
  throw new Error(`NO_COMPATIBLE_FOUNDATION_OUTPUT: ${schemaRef}`)
}

/**
 * Mechanics-only planner. It knows the generic control protocol, but it has no
 * proposition id, verifier answer, expected node id or pre-authored patch.
 */
export function decideFromGoalCatalogAndObservation(
  payload: AIDataAutonomousControllerPayload,
): AIDataControlDecision {
  const { observation, catalog } = payload
  if (observation.goalId !== payload.goal.goalId || observation.catalogDigest !== catalog.digest) {
    throw new Error("CONTROLLER_PAYLOAD_AUTHORITY_MISMATCH")
  }
  const capabilityNodes = observation.graph.nodes
    .filter((node) => node.capabilityId !== undefined)
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId))

  if (observation.verifier.status === "passed") {
    const outputNode = capabilityNodes.find((node) => node.status === "Succeeded" || node.status === "Reused")
    const output = outputNode && sortedEntries(outputNode.outputSchemaRefs)[0]
    if (!outputNode || !output) throw new Error("NO_VERIFIED_OUTPUT_NODE")
    return Object.freeze({
      ...commonDecision(payload, "Complete from the current host-owned verifier fact"),
      kind: "complete",
      verifierFactId: observation.verifier.factId,
      outputNodeId: outputNode.nodeId,
      outputPort: output[0],
      outputSchemaRef: output[1],
    } as AIDataControlDecision)
  }

  if (capabilityNodes.length === 0) {
    const capabilityEntry = sortedEntries(catalog.capabilities)[0]
    if (!capabilityEntry) throw new Error("EMPTY_CAPABILITY_CATALOG")
    const [capabilityId, capability] = capabilityEntry
    const inputs = Object.fromEntries(sortedEntries(capability.inputSchemaRefs).map(([port, schemaRef]) => [
      port,
      compatibleFoundationBinding(observation, catalog, schemaRef),
    ]))
    return Object.freeze({
      ...commonDecision(payload, "Add the first compatible frozen capability"),
      kind: "revise",
      operations: Object.freeze([Object.freeze({
        op: "add-capability",
        nodeId: capabilityId,
        capabilityId,
        inputs: Object.freeze(inputs),
      })]),
    } as AIDataControlDecision)
  }

  const observed = capabilityNodes[0]!
  const capability = catalog.capabilities[observed.capabilityId!]
  if (!capability) throw new Error(`OBSERVED_CAPABILITY_NOT_FROZEN: ${observed.capabilityId}`)
  const inputs = Object.fromEntries(sortedEntries(capability.inputSchemaRefs).map(([port, schemaRef]) => [
    port,
    Object.freeze({
      kind: "literal" as const,
      schemaRef,
      value: `retry:${observation.graph.generation}:${port}`,
    }),
  ]))
  return Object.freeze({
    ...commonDecision(payload, "Revise the observed capability after verifier failure"),
    kind: "revise",
    operations: Object.freeze([Object.freeze({
      op: "rewire-capability",
      nodeId: observed.nodeId,
      capabilityId: observed.capabilityId!,
      inputs: Object.freeze(inputs),
    })]),
  } as AIDataControlDecision)
}

export function autonomousPlanningSourceConformance(input: Readonly<{
  plannerSource: string
  harnessSource: string
  fixtureSources: Readonly<Record<string, string>>
  evidenceClass: AutonomousPlanningEvidenceClass
}>): readonly AutonomousPlanningConformanceDiagnostic[] {
  const diagnostics: AutonomousPlanningConformanceDiagnostic[] = []
  const executable = `${input.plannerSource}\n${input.harnessSource}`
  const allFixtureSource = sortedEntries(input.fixtureSources).map(([name, value]) => `${name}\n${value}`).join("\n")
  const inspect = (source: string, label: string) => {
    const checks: readonly Readonly<{
      code: AutonomousPlanningConformanceDiagnostic["code"]
      pattern: RegExp
      message: string
    }>[] = [
      { code: "HIDDEN_ANSWER", pattern: /expectedPatch|repairIntent|verifierAnswer|expectedImplementation/i, message: "Executable source embeds a proposition answer" },
      { code: "DIRECT_GRAPH_MUTATION", pattern: /\.(?:applyGraphPatch|resumeDataNode)\s*\(/, message: "Harness bypasses the autonomous control admission path" },
      { code: "SHADOW_GRAPH_AUTHORITY", pattern: /shadowGraph|secondGraph|privateGraphStore|eventRebuiltGraph/i, message: "Executable source declares another graph authority" },
      { code: "FALLBACK_AGENT_CREATION", pattern: /fallback(?:To)?New|targeted[^\n]{0,160}catch[^\n]{0,160}runAgent/i, message: "Targeted Agent reuse may fall back to replacement creation" },
    ]
    for (const check of checks) {
      if (check.pattern.test(source)) diagnostics.push(Object.freeze({ code: check.code, source: label, message: check.message }))
    }
  }
  inspect(executable, "planner+harness")
  inspect(allFixtureSource, "resource-package")
  if (input.evidenceClass === "deterministic-mechanics/v1" && /evidenceClass\s*[:=]\s*["']live-provider\/v1["']/.test(executable)) {
    diagnostics.push(Object.freeze({
      code: "EVIDENCE_CLASS_FORGERY",
      source: "planner+harness",
      message: "Deterministic execution is relabeled as live-provider evidence",
    }))
  }
  return Object.freeze(diagnostics)
}

function verifierIdentityDigest(goal: AIDataAutonomousControlState["binding"]["goal"]): string {
  return runtime.stableDigest({
    verifierRef: goal.verifierRef,
    requiredOutputSchemaRef: goal.requiredOutputSchemaRef,
  })
}

export function autonomousPlanningControllerTurnsFromCheckpoint(
  checkpoint: AIWorkflowFlowRunCheckpoint,
): readonly AutonomousPlanningControllerTurn[] {
  if (checkpoint.profile.kind !== "AIDataWorkflow") throw new Error("EVIDENCE_PROFILE_KIND_INVALID")
  const state = readAIDataAutonomousControlState(checkpoint)
  const ai = (checkpoint.profile as typeof checkpoint.profile & {
    readonly ai: AIWorkflowProfileDurableState
  }).ai
  return Object.freeze(sortedEntries(ai.invocationsByKey)
    .filter(([, invocation]) => invocation.nodeId === state.binding.controlNodeId)
    .map(([, invocation]) => {
      if (invocation.status !== "completed" || invocation.output === undefined) {
        throw new Error(`EVIDENCE_CONTROLLER_INVOCATION_INCOMPLETE: ${invocation.invocationKey}`)
      }
      const payload = invocation.input as unknown as AIDataAutonomousControllerPayload
      if (payload?.schemaVersion !== "eidolon.ai-data-controller-input/v1") {
        throw new Error(`EVIDENCE_CONTROLLER_PAYLOAD_INVALID: ${invocation.invocationKey}`)
      }
      return Object.freeze({ payload, rawOutput: invocation.output })
    }))
}

export function sealAutonomousPlanningReceipt(input: Readonly<{
  evidenceClass: AutonomousPlanningEvidenceClass
  workflowRef: string
  instanceId: string
  checkpoint: AIWorkflowFlowRunCheckpoint
  resourceSources: Readonly<Record<string, string>>
  executableSources: readonly string[]
  controllerTurns: readonly AutonomousPlanningControllerTurn[]
  provider: AutonomousPlanningProviderFacts
}>): AutonomousPlanningSealedReceipt {
  if (input.checkpoint.profile.kind !== "AIDataWorkflow") throw new Error("EVIDENCE_PROFILE_KIND_INVALID")
  const state = readAIDataAutonomousControlState(input.checkpoint)
  const graph = input.checkpoint.profile.runGraph as any
  const ai = (input.checkpoint.profile as typeof input.checkpoint.profile & {
    readonly ai: AIWorkflowProfileDurableState
  }).ai
  const turnsByObservation = new Map(input.controllerTurns.map((turn) => [turn.payload.observation.observationDigest, turn]))
  const iterations = state.receipts.map((receipt) => {
    const turn = turnsByObservation.get(receipt.observationDigest)
    if (!turn) throw new Error(`EVIDENCE_CONTROLLER_TURN_MISSING: ${receipt.observationDigest}`)
    return Object.freeze({
      iteration: receipt.iteration,
      observationDigest: receipt.observationDigest,
      verifierFactDigest: runtime.stableDigest(turn.payload.observation.verifier),
      rawOutputDigest: runtime.stableDigest(turn.rawOutput),
      rawOutput: turn.rawOutput,
      decisionDigest: receipt.decisionDigest,
      admissionKind: receipt.admissionKind,
      generationBefore: receipt.generationBefore,
      generationAfter: receipt.generationAfter,
      feedbackCodes: Object.freeze(turn.payload.observation.feedback.map((feedback) => feedback.code)),
    })
  })
  const agents = sortedEntries(ai.invocationsByKey).map(([invocationKey, invocation]) => {
    const instance = invocation.instanceId
      ? ai.instancesById[invocation.instanceId]
      : undefined
    return Object.freeze({
      invocationKey,
      role: invocation.nodeId === state.binding.controlNodeId ? "controller" as const : "worker" as const,
      mode: invocation.mode,
      definitionRef: invocation.agentDefinitionRef,
      ...(invocation.instanceName === undefined ? {} : { instanceName: invocation.instanceName }),
      ...(invocation.instanceId === undefined ? {} : { instanceId: invocation.instanceId }),
      ...(instance?.sessionId === undefined ? {} : { sessionId: instance.sessionId }),
      ...(invocation.generation === undefined ? {} : { generation: invocation.generation }),
    })
  })
  const unsigned = Object.freeze({
    schemaVersion: AUTONOMOUS_PLANNING_RECEIPT_SCHEMA,
    evidenceClass: input.evidenceClass,
    run: Object.freeze({
      workflowRef: input.workflowRef,
      instanceId: input.instanceId,
      runId: graph.runId,
      profileKind: input.checkpoint.profile.kind,
    }),
    source: Object.freeze({
      resourceDigest: runtime.stableDigest(input.resourceSources),
      executableDigest: runtime.stableDigest(input.executableSources),
    }),
    authority: Object.freeze({
      goalDigest: runtime.stableDigest(state.binding.goal),
      verifierIdentityDigest: verifierIdentityDigest(state.binding.goal),
      catalogDigest: state.binding.catalog.digest,
      finalGraphDigest: runtime.stableDigest(graph),
      finalGeneration: graph.currentGeneration,
      patchDigests: Object.freeze(graph.patchHistory.map((patch: unknown) => runtime.stableDigest(patch))),
      patchHistory: Object.freeze(graph.patchHistory),
      invalidations: Object.freeze(graph.invalidations),
    }),
    control: Object.freeze({ iterations: Object.freeze(iterations), terminal: state.terminal }),
    agents: Object.freeze(agents),
    provider: input.provider,
    outcome: Object.freeze({
      verifierStatus: state.latestVerifier?.status ?? "not-run",
      completed: state.phase === "completed",
      outputDigest: runtime.stableDigest(input.checkpoint.output),
    }),
  })
  return Object.freeze({ ...unsigned, receiptDigest: runtime.stableDigest(unsigned) })
}

function verifyAgentReuseRole(
  receipt: AutonomousPlanningSealedReceipt,
  role: "controller" | "worker",
): void {
  const invocations = receipt.agents.filter((candidate) => candidate.role === role)
  if (invocations.length < 2 || invocations[0]?.mode !== "new" || !invocations.slice(1).some((item) => item.mode === "targeted")) {
    throw new Error(`EVIDENCE_EXACT_REUSE_MISSING: ${role}`)
  }
  const instanceId = invocations[0]?.instanceId
  const sessionId = invocations[0]?.sessionId
  if (!instanceId || !sessionId || invocations.some((item) => item.instanceId !== instanceId || item.sessionId !== sessionId)) {
    throw new Error(`EVIDENCE_EXACT_REUSE_SUBSTITUTED: ${role}`)
  }
}

function verifyExactAgentReuse(receipt: AutonomousPlanningSealedReceipt): void {
  verifyAgentReuseRole(receipt, "controller")
  verifyAgentReuseRole(receipt, "worker")
}

function verifyProviderEvidence(provider: AutonomousPlanningProviderFacts): void {
  if (typeof provider.provider !== "string" || provider.provider.length === 0
    || typeof provider.model !== "string" || provider.model.length === 0
    || !Number.isSafeInteger(provider.calls) || provider.calls < 1 || !Array.isArray(provider.attempts)
    || provider.calls !== provider.attempts.length) {
    throw new Error("EVIDENCE_PROVIDER_CALL_ACCOUNTING_MISMATCH")
  }
  const attemptKeys = new Set<string>()
  for (const attempt of provider.attempts) {
    const identity = attempt?.identity
    if (!identity || typeof identity.providerCallId !== "string" || identity.providerCallId.length === 0
      || !Number.isSafeInteger(identity.providerCallOrdinal) || identity.providerCallOrdinal < 1
      || !Number.isSafeInteger(identity.providerAttemptOrdinal) || identity.providerAttemptOrdinal < 1
      || !Number.isSafeInteger(identity.transportAttemptOrdinal) || identity.transportAttemptOrdinal < 1
      || (identity.transportType !== "http" && identity.transportType !== "websocket")
      || identity.providerId !== provider.provider || typeof identity.model !== "string" || identity.model.length === 0
      || typeof identity.actorId !== "string" || identity.actorId.length === 0) {
      throw new Error("EVIDENCE_PROVIDER_ATTEMPT_IDENTITY_INVALID")
    }
    if (!new Set(["completed", "failed", "aborted", "incomplete"]).has(attempt.terminalState)
      || typeof attempt.fallbackUsed !== "boolean"
      || !new Set(["complete", "incomplete", "not_observed"]).has(attempt.completenessStatus)
      || !new Set(["completed_output", "indexed_done_items", "reconstructed_event_items", null])
        .has(attempt.completenessSource)
      || typeof attempt.completenessReasonDigest !== "string" || attempt.completenessReasonDigest.length === 0) {
      throw new Error("EVIDENCE_PROVIDER_ATTEMPT_OUTCOME_INVALID")
    }
    const identityDigest = runtime.stableDigest(identity)
    if (attempt.requestIdentityDigest !== identityDigest || attempt.outcomeIdentityDigest !== identityDigest) {
      throw new Error("EVIDENCE_PROVIDER_REQUEST_OUTCOME_MISMATCH")
    }
    if (attemptKeys.has(identityDigest)) throw new Error("EVIDENCE_PROVIDER_ATTEMPT_DUPLICATE")
    attemptKeys.add(identityDigest)
  }
  const failures = provider.attempts.filter((attempt) => attempt.terminalState !== "completed").length
  const replays = provider.attempts.filter((attempt) => (
    attempt.fallbackUsed || attempt.identity.providerAttemptOrdinal > 1
  )).length
  if (provider.failures !== failures || provider.replays !== replays) {
    throw new Error("EVIDENCE_PROVIDER_AGGREGATE_MISMATCH")
  }
  if (!Number.isSafeInteger(provider.cacheObservationCount)
    || provider.cacheObservationCount !== provider.calls) {
    throw new Error("EVIDENCE_PROVIDER_CACHE_COVERAGE_MISMATCH")
  }
  if (!Array.isArray(provider.prefixComparisons) || provider.prefixComparisons.length < 1) {
    throw new Error("EVIDENCE_PREFIX_COMPARISON_COVERAGE_MISSING")
  }
  const comparisonKeys = new Set<string>()
  for (const comparison of provider.prefixComparisons) {
    if (!comparison || typeof comparison.actorId !== "string" || comparison.actorId.length === 0
      || typeof comparison.actorClass !== "string" || comparison.actorClass.length === 0
      || !Number.isSafeInteger(comparison.contextEpoch) || comparison.contextEpoch < 0
      || typeof comparison.priorObservationDigest !== "string" || comparison.priorObservationDigest.length === 0
      || typeof comparison.currentObservationDigest !== "string" || comparison.currentObservationDigest.length === 0) {
      throw new Error("EVIDENCE_PREFIX_COMPARISON_INVALID")
    }
    if (comparison.retainedPrefixIntegrity !== 1) throw new Error("EVIDENCE_PREFIX_INTEGRITY_FAILED")
    const comparisonKey = runtime.stableDigest(comparison)
    if (comparisonKeys.has(comparisonKey)) throw new Error("EVIDENCE_PREFIX_COMPARISON_DUPLICATE")
    comparisonKeys.add(comparisonKey)
  }
  if (provider.prefixComparisons.length >= provider.cacheObservationCount || provider.prefixIntegrity !== 1) {
    throw new Error("EVIDENCE_PREFIX_INTEGRITY_FAILED")
  }
}

export function verifyAutonomousPlanningReceipt(
  receipt: AutonomousPlanningSealedReceipt,
  options: Readonly<{
    requireLiveProvider?: boolean
    minDistinctPatches?: number
    requiredReuseRoles?: readonly ("controller" | "worker")[]
    requireInvalidDecisionFeedback?: boolean
  }> = {},
): void {
  if ((receipt as { schemaVersion: string }).schemaVersion === AUTONOMOUS_PLANNING_LEGACY_RECEIPT_SCHEMA) {
    throw new Error("EVIDENCE_LEGACY_PROVIDER_COVERAGE_UNSUPPORTED")
  }
  const { receiptDigest, ...unsigned } = receipt
  if (runtime.stableDigest(unsigned) !== receiptDigest) throw new Error("EVIDENCE_RECEIPT_DIGEST_MISMATCH")
  if (receipt.schemaVersion !== AUTONOMOUS_PLANNING_RECEIPT_SCHEMA) throw new Error("EVIDENCE_SCHEMA_INVALID")
  if (receipt.run.profileKind !== "AIDataWorkflow") throw new Error("EVIDENCE_PROFILE_KIND_INVALID")
  if (options.requireLiveProvider && receipt.evidenceClass !== "live-provider/v1") {
    throw new Error("EVIDENCE_LIVE_PROVIDER_REQUIRED")
  }
  const minDistinctPatches = options.minDistinctPatches ?? 2
  if (receipt.authority.patchDigests.length < minDistinctPatches
    || new Set(receipt.authority.patchDigests).size < minDistinctPatches) {
    throw new Error("EVIDENCE_DISTINCT_PATCHES_REQUIRED")
  }
  if (options.requireInvalidDecisionFeedback ?? true) {
    const rejected = receipt.control.iterations.find((item) => item.admissionKind === "rejected")
    if (!rejected || rejected.generationBefore !== rejected.generationAfter) {
      throw new Error("EVIDENCE_INVALID_DECISION_AUTHORITY_CHANGE")
    }
    if (!receipt.control.iterations.some((item) => item.feedbackCodes.includes("INVALID_DECISION"))) {
      throw new Error("EVIDENCE_INVALID_DECISION_FEEDBACK_MISSING")
    }
  }
  if (!receipt.outcome.completed || receipt.outcome.verifierStatus !== "passed") {
    throw new Error("EVIDENCE_VERIFIER_CONVERGENCE_MISSING")
  }
  verifyProviderEvidence(receipt.provider)
  const requiredRoles = options.requiredReuseRoles ?? ["controller", "worker"]
  if (requiredRoles.length === 2) verifyExactAgentReuse(receipt)
  else for (const role of requiredRoles) verifyAgentReuseRole(receipt, role)
}

const kindDefinition = (kind: string) => `<KindDefinition #eidolon.autonomous.kind.${kind} apiVersion="halfcode.resources/v1" version="1.0.0" { lifecycle = "Stable" resourceKind = "${kind}" sourceShapes = ["single-file"] currentApiVersion = "depa.flows/v1" supportedApiVersions = ["depa.flows/v1"] }>`

export function autonomousPlanningResourceFiles(
  controlState: AIDataAutonomousControlState,
): Readonly<Record<string, string>> {
  return Object.freeze({
    "manifest.xnl": `<ResourcePackage #eidolon.autonomous.package apiVersion="halfcode.resources/v1" version="1.0.0" { lifecycle = "Active" } (
  <Catalogs [
    <Catalog #kind_definitions { kind = "KindDefinition" shape = "directory" root = "vfs://./KindDefinitions/" entry = "manifest.xnl" }>
    <Catalog #data { kind = "AIDataWorkflow" shape = "single-file" root = "vfs://./DataWorkflows/" }>
    <Catalog #agents { kind = "AIAgentDefinition" shape = "single-file" root = "vfs://./Agents/" }>
    <Catalog #prompts { kind = "Prompt" shape = "single-file" root = "vfs://./Prompts/" }>
    <Catalog #pipelines { kind = "AgentContextPipeline" shape = "single-file" root = "vfs://./ContextPipelines/" }>
    <Catalog #schemas { kind = "MessageSchema" shape = "single-file" root = "vfs://./Schemas/" }>
    <Catalog #policies { kind = "EffectPolicy" shape = "single-file" root = "vfs://./Policies/" }>
    <Catalog #ports { kind = "MaterialPort" shape = "single-file" root = "vfs://./Ports/" }>
    <Catalog #bindings { kind = "MaterialBinding" shape = "single-file" root = "vfs://./Bindings/" }>
    <Catalog #requests { kind = "RequestMaterial" shape = "single-file" root = "vfs://./RequestMaterials/" }>
  ]>
)>`,
    ...Object.fromEntries([
      "AIDataWorkflow", "AIAgentDefinition", "Prompt", "AgentContextPipeline", "MessageSchema",
      "EffectPolicy", "MaterialPort", "MaterialBinding", "RequestMaterial",
    ].map((kind) => [`KindDefinitions/${kind}/manifest.xnl`, kindDefinition(kind)])),
    "flow-code/identity.ts": "export function identity(_runtime: unknown, input: unknown) { return input }\n",
    "Prompts/Controller.xnl": `<Prompt #eidolon.autonomous.ControllerPrompt apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" } (<Content ?>You are a generic AI Data control planner. The user message is one JSON object with schemaVersion, immutable goal, frozen capability catalog, and the current canonical observation. Return one raw JSON object only, without Markdown. Every decision requires schemaVersion="depa.ai-data-control/v1", a non-empty decisionId, goalId, observationId, observationDigest, catalogDigest, reason and kind. Copy goalId, observationId, observationDigest and catalogDigest exactly. A revise decision uses the plural field operations, which is an array containing exactly one operation; never use a singular operation field. An add-capability or rewire-capability operation has only op, nodeId, capabilityId, inputs and optional dependsOn. nodeId names a graph node, not fixedConfig.instanceName. For a catalog capability whose implementation kind is agent and carries taskProofRef, nodeId must select the exact frozen AgentTaskRef node associated with that task proof; when the catalog exposes that node as the capability id, use capabilityId exactly and do not invent a suffixed node id. Each inputs value is either {"kind":"port","nodeId":"...","port":"...","schemaRef":"..."} or {"kind":"literal","schemaRef":"...","value":...}. Operation objects never contain outputs. Never create a self-loop or make a revision depend on the protected manual control barrier: that barrier is released only after verifier success and cannot produce a refinement input. To execute the same exact Agent task again when no distinct frozen task node exists, rewire it to a typed literal or an already succeeded non-descendant node. If the current host verifier passed, return kind complete with verifierFactId, outputNodeId, outputPort and outputSchemaRef selected from one succeeded capability node. Otherwise revise with add-capability when no suitable capability node exists, or rewire-capability/remove-node after failure. Use only catalog capability ids and exact typed ports. Never modify protected nodes, invent resources, mutate the graph directly, or claim verifier success.</?>)>`,
    "Prompts/Worker.xnl": `<Prompt #eidolon.autonomous.WorkerPrompt apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" } (<Content ?>You are a reusable typed transformation Worker. Read the JSON input payload, transform its value into a concise but materially improved string, and return exactly one raw JSON object {"value":"..."} without Markdown or extra keys. On targeted follow-up, use the new input and prior conversation to produce a genuinely revised value.</?>)>`,
    "ContextPipelines/Standard.xnl": `<AgentContextPipeline #eidolon.autonomous.StandardContext apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" } (<Content ?>{"implementation":"eidolon.standard-context-pipeline/v1","stages":["prompt-plan","conversation-prelude","provider-context-facts-at-history-anchors","stable-message-prefix","conversation-boundary-overlays","provider-conversion"]}</?>)>`,
    "Schemas/ControllerInput.xnl": `<MessageSchema #eidolon.autonomous.ControllerInput apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Stable" schema = { type = "object" required = ["schemaVersion" "goal" "catalog" "observation"] properties = { schemaVersion = { type = "string" } goal = { type = "object" } catalog = { type = "object" } observation = { type = "object" } } } }>`,
    "Schemas/ControllerDecision.xnl": `<MessageSchema #eidolon.autonomous.ControllerDecision apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Stable" schema = { type = "object" additionalProperties = false required = ["schemaVersion" "kind" "decisionId" "goalId" "observationId" "observationDigest" "catalogDigest" "reason"] properties = { schemaVersion = { type = "string" } kind = { type = "string" } decisionId = { type = "string" } goalId = { type = "string" } observationId = { type = "string" } observationDigest = { type = "string" } catalogDigest = { type = "string" } reason = { type = "string" } operations = { type = "array" minItems = 1 maxItems = 1 items = { type = "object" } } verifierFactId = { type = "string" } outputNodeId = { type = "string" } outputPort = { type = "string" } outputSchemaRef = { type = "string" } failureCode = { type = "string" } } } }>`,
    "Schemas/WorkerInput.xnl": `<MessageSchema #eidolon.autonomous.WorkerInput apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Stable" schema = { type = "object" required = ["value"] properties = { value = { type = "string" } } } }>`,
    "Schemas/WorkerOutput.xnl": `<MessageSchema #eidolon.autonomous.WorkerOutput apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Stable" schema = { type = "object" required = ["value"] additionalProperties = false properties = { value = { type = "string" } } } }>`,
    "Policies/NoTools.xnl": `<EffectPolicy #eidolon.autonomous.NoTools apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Stable" toolMode = "none" }>`,
    "Ports/Request.xnl": `<MaterialPort #eidolon.autonomous.RequestPort apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Stable" materialKind = "RequestMaterial" required = true cardinality = "one" }>`,
    "RequestMaterials/Request.xnl": `<RequestMaterial #eidolon.autonomous.Request apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" value = { request = "autonomous planning" } }>`,
    "Agents/Controller.xnl": `<AIAgentDefinition #eidolon.autonomous.ControllerAgent apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" description = "Reusable autonomous AI Data controller" } (
  <MessagePrefix [<Message #system { role = "system" promptKind = "Prompt" promptRef = "resource://eidolon.autonomous.ControllerPrompt" }>]>
  <ContextPipeline { kind = "AgentContextPipeline" ref = "resource://eidolon.autonomous.StandardContext" }>
  <InputSchemaRef { kind = "MessageSchema" ref = "resource://eidolon.autonomous.ControllerInput" }>
  <OutputSchemaRef { kind = "MessageSchema" ref = "resource://eidolon.autonomous.ControllerDecision" }>
  <ToolRefs []>
  <EffectPolicyRef { kind = "EffectPolicy" ref = "resource://eidolon.autonomous.NoTools" }>
  <MaterialPortRefs [<MaterialPortRef #request { kind = "MaterialPort" ref = "resource://eidolon.autonomous.RequestPort" }>]>
)>`,
    "Agents/Worker.xnl": `<AIAgentDefinition #eidolon.autonomous.WorkerAgent apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" description = "Reusable autonomous AI Data worker" } (
  <MessagePrefix [<Message #system { role = "system" promptKind = "Prompt" promptRef = "resource://eidolon.autonomous.WorkerPrompt" }>]>
  <ContextPipeline { kind = "AgentContextPipeline" ref = "resource://eidolon.autonomous.StandardContext" }>
  <InputSchemaRef { kind = "MessageSchema" ref = "resource://eidolon.autonomous.WorkerInput" }>
  <OutputSchemaRef { kind = "MessageSchema" ref = "resource://eidolon.autonomous.WorkerOutput" }>
  <ToolRefs []>
  <EffectPolicyRef { kind = "EffectPolicy" ref = "resource://eidolon.autonomous.NoTools" }>
  <MaterialPortRefs [<MaterialPortRef #request { kind = "MaterialPort" ref = "resource://eidolon.autonomous.RequestPort" }>]>
)>`,
    "Bindings/Controller.xnl": `<MaterialBinding #eidolon.autonomous.ControllerBinding apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" } (
  <AgentTaskRef { workflowKind = "AIDataWorkflow" workflowRef = "resource://eidolon.autonomous.DataWorkflow" nodeId = "control" agentDefinitionRef = "resource://eidolon.autonomous.ControllerAgent" }>
  <PortRef { kind = "MaterialPort" ref = "resource://eidolon.autonomous.RequestPort" }>
  <MaterialRef { kind = "RequestMaterial" ref = "resource://eidolon.autonomous.Request" }>
)>`,
    "Bindings/Worker.xnl": `<MaterialBinding #eidolon.autonomous.WorkerBinding apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" } (
  <AgentTaskRef { workflowKind = "AIDataWorkflow" workflowRef = "resource://eidolon.autonomous.DataWorkflow" nodeId = "worker" agentDefinitionRef = "resource://eidolon.autonomous.WorkerAgent" }>
  <PortRef { kind = "MaterialPort" ref = "resource://eidolon.autonomous.RequestPort" }>
  <MaterialRef { kind = "RequestMaterial" ref = "resource://eidolon.autonomous.Request" }>
)>`,
    "DataWorkflows/Autonomous.xnl": `<AIDataWorkflow #eidolon.autonomous.DataWorkflow apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #eidolon.autonomous.DataWorkflow { inputPorts = ["value"] outputPorts = ["value"] }>
  <StepSpaceRef { src = "autonomous/step-space.xnl" }>
)>`,
    "DataWorkflows/autonomous/step-space.xnl": `<StepSpace #eidolon.autonomous.Steps apiVersion="depa.flows/v1" version="1" [
  <StepRef #entry { src = "autonomous/steps/entry.xnl" }>
  <StepRef #control { src = "autonomous/steps/control.xnl" }>
  <StepRef #return { src = "autonomous/steps/return.xnl" }>
]>`,
    "DataWorkflows/autonomous/steps/entry.xnl": `<Step #entry (<Core [<EntryNode #entry>]>)>`,
    "DataWorkflows/autonomous/steps/control.xnl": `<Step #control (
  <Core [<TransformNode #control { inputs = { value = "flow-port://#entry/value" } outputs = ["value"] impl = "vfs://@/flow-code/identity.ts#identity" config = { node_type = "manual" } }>]>
  <Extensions [<ExtensionRef { kind = "eidolon.ai-data-autonomous-control" src = "autonomous/steps/autonomous-control.xnl" schema = "schema://eidolon.ai-data-autonomous-control/v1" }>]>
)>`,
    "DataWorkflows/autonomous/steps/return.xnl": `<Step #return (<Core [<ReturnNode #return { inputs = { value = "flow-port://#control/value" } }>]>)>`,
    "DataWorkflows/autonomous/steps/autonomous-control.xnl": `<StepExtension #autonomous-control { kind = "eidolon.ai-data-autonomous-control" schema = "schema://eidolon.ai-data-autonomous-control/v1" value = ${JSON.stringify(JSON.stringify(controlState))} }>`,
  })
}
