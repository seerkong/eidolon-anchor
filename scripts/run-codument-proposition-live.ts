#!/usr/bin/env bun

import { randomUUID } from "node:crypto"
import path from "node:path"

import type {
  CodumentPropositionProviderBinding,
  CodumentPropositionMode,
  CodumentPropositionRunReceipt,
  PropositionCacheScope,
} from "../testkit/codument-proposition/contract.ts"
import { resolveCodumentPropositionProviderBinding } from "../testkit/codument-proposition/contract.ts"
import {
  planCodumentPropositionMatrix,
  runCodumentPropositionMatrixPlan,
  type CodumentPropositionMatrixSelection,
} from "../testkit/codument-proposition/matrixRunner.ts"
import {
  bindCodumentPropositionExecutableEpoch,
  buildCodumentPropositionLiveManifest,
  runCodumentPropositionLiveCell,
  type CodumentPropositionExecutableEpoch,
  type CodumentPropositionLiveScenario,
} from "../testkit/codument-proposition/liveRuntime.ts"

const CORPUS_DIGEST = "sha256:bf90556035c4b8936c9aad76510cf84cd061aa60c701a840ea09645d05a549ed" as const
const SENTINEL_SCENARIOS = Object.freeze(["stream-pipeline-ai-agent"])

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function options(name: string): readonly string[] {
  return Object.freeze(process.argv.flatMap((value, index) => value === name ? [process.argv[index + 1] ?? ""] : [])
    .map((value) => value.trim()).filter(Boolean))
}

function requiredOption(name: string): string {
  const value = option(name)?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function exactMode(value: string): CodumentPropositionMode {
  if (value === "ordinary" || value === "ai_ctrl" || value === "ai_data") return value
  throw new Error(`unsupported --mode: ${value}`)
}

function matrixSelection(): CodumentPropositionMatrixSelection {
  const kind = option("--selection")?.trim() || "cell"
  if (kind === "deterministic" || kind === "sentinel" || kind === "full") return { kind }
  if (kind !== "cell") throw new Error(`unsupported --selection: ${kind}`)
  return {
    kind: "cell",
    scenarioId: option("--scenario")?.trim() || "stream-pipeline-ai-agent",
    mode: exactMode(requiredOption("--mode")),
  }
}

export function scenarioCatalog(sourceRoot: string, timeoutSeconds: number): readonly CodumentPropositionLiveScenario[] {
  const modeling = (scenarioId: string, task: "todo" | "blog" | "ecommerce", productFile: string): CodumentPropositionLiveScenario => Object.freeze({
    scenarioId,
    revision: "2026-08-28",
    corpusDigest: CORPUS_DIGEST,
    runnerRelativePath: "e2e/modeling-engineering/run.sh",
    requestRelativePaths: Object.freeze([
      `e2e/modeling-engineering/${task}/${productFile}`,
      `e2e/modeling-engineering/${task}/plan.md`,
      `e2e/modeling-engineering/${task}/implement.md`,
    ]),
    verifierRelativePath: "e2e/modeling-engineering/score.ts",
    runnerTaskArgument: task,
    runnerEnvironment: Object.freeze({
      MODE: "full",
      PRODUCT_FILE: path.join(sourceRoot, "e2e", "modeling-engineering", task, productFile),
    }),
    expectedAgentInvocations: 2,
    verifierKind: "modeling_score",
    timeoutSeconds,
  })
  return Object.freeze([
    Object.freeze({
      scenarioId: "stream-pipeline-ai-agent",
      revision: "2026-08-27",
      corpusDigest: CORPUS_DIGEST,
      runnerRelativePath: "e2e/project-implementation/run.sh",
      requestRelativePaths: Object.freeze(["e2e/project-implementation/stream-pipeline-ai-agent/request.md"]),
      verifierRelativePath: "e2e/project-implementation/stream-pipeline-ai-agent/verify.sh",
      runnerTaskArgument: "stream-pipeline-ai-agent",
      expectedAgentInvocations: 1,
      verifierKind: "shell",
      timeoutSeconds,
    }),
    modeling("modeling-todo", "todo", "product.md"),
    modeling("modeling-blog", "blog", "product.md"),
    modeling("modeling-ecommerce-core", "ecommerce", "product-core.md"),
    modeling("modeling-ecommerce-payment", "ecommerce", "product-payment.md"),
    Object.freeze({
      scenarioId: "nested-mission-agent",
      revision: "2026-08-28",
      corpusDigest: CORPUS_DIGEST,
      runnerRelativePath: "e2e/nested-mission-agent/run.sh",
      requestRelativePaths: Object.freeze(["e2e/nested-mission-agent/request.md"]),
      verifierRelativePath: "e2e/nested-mission-agent/verify.sh",
      expectedAgentInvocations: 1,
      verifierKind: "shell",
      timeoutSeconds,
    }),
  ])
}

export function providerScopeEvidenceComplete(scope: PropositionCacheScope): boolean {
  return Number.isFinite(scope.cacheEligiblePrefixTokens)
    && scope.cacheEligiblePrefixTokens >= 0
    && Number.isFinite(scope.cacheEligiblePrefixHitTokens)
    && scope.cacheEligiblePrefixHitTokens >= 0
    && Number.isFinite(scope.newInputTokens)
    && scope.newInputTokens >= 0
    && (scope.eligibleSubsequentTurns === 0
      ? scope.cacheEligiblePrefixHitRatio === null
      : scope.cacheEligiblePrefixHitRatio !== null
        && Number.isFinite(scope.cacheEligiblePrefixHitRatio))
}

function isUnbilledPreacceptScope(scope: PropositionCacheScope): boolean {
  return scope.classification === "incomplete_usage"
    && scope.eligibleSubsequentTurns === 0
    && scope.promptTokens === 0
    && scope.cacheHitTokens === 0
    && scope.cacheMissTokens === 0
    && scope.outputTokens === 0
    && scope.normalizedInputCost === null
    && scope.cacheHitRatio === null
    && scope.cacheEligiblePrefixTokens === 0
    && scope.cacheEligiblePrefixHitTokens === 0
    && scope.cacheEligiblePrefixHitRatio === null
    && scope.newInputTokens === 0
    && scope.retainedPrefixIntegrity === 1
}

export function receiptAccepted(
  receipt: CodumentPropositionRunReceipt,
  provider: CodumentPropositionProviderBinding = resolveCodumentPropositionProviderBinding("official-deepseek"),
): boolean {
  const incompleteScopes = receipt.providerScopes.filter((scope) => scope.classification === "incomplete_usage")
  // A zero-usage observation is accepted by its own provider facts, not by a
  // retry-count heuristic. Semantic completion, transport replay and cold
  // epoch admission are distinct lifecycles and need not produce a 1:1 count.
  // Any billed/integrity-bearing incomplete observation still fails closed.
  const incompleteScopesAccepted = incompleteScopes.every(isUnbilledPreacceptScope)
  const costAccepted = receipt.providerScope.normalizedInputCost !== null
    && receipt.providerScopes.every((scope) => (
      scope.classification === "incomplete_usage"
        ? isUnbilledPreacceptScope(scope)
        : scope.normalizedInputCost !== null
    ))
  const routingIdentityAccepted = receipt.providerScope.providerId === provider.credential.providerId
    && receipt.providerScope.model === provider.credential.model
    && receipt.providerScopes.every((scope) => (
      scope.providerId === provider.credential.providerId
      && scope.model === provider.credential.model
    ))
  return receipt.process.status === "completed"
    && receipt.verifier.passed
    && receipt.modeIdentities.length > 0
    && receipt.modeIdentities.every((identity) => identity.actualMode === receipt.modeIdentity.actualMode)
    && receipt.providerAttempts.finalAttemptTerminalCauses.length
      + receipt.providerAttempts.finalAttemptTerminalCauseOmittedCount === receipt.providerAttempts.providerCalls
    && receipt.providerScope.providerClass === provider.expectedProviderClass
    && costAccepted
    && routingIdentityAccepted
    && providerScopeEvidenceComplete(receipt.providerScope)
    && receipt.providerScopes.length > 0
    && receipt.providerScopes.every((scope) => (
      scope.providerClass === provider.expectedProviderClass
      && (scope.classification !== "incomplete_usage" || incompleteScopesAccepted)
      && providerScopeEvidenceComplete(scope)
    ))
}

export async function prepareLiveMatrixExecutableEpoch(input: Readonly<{
  selection: CodumentPropositionMatrixSelection
  executionRoot: string
  runId: string
  eidolonExecutable?: string
  codumentExecutable?: string
}>): Promise<CodumentPropositionExecutableEpoch | null> {
  if (input.selection.kind === "deterministic") return null
  if (!input.eidolonExecutable?.trim()) throw new Error("--eidolon is required")
  if (!input.codumentExecutable?.trim()) throw new Error("--codument is required")
  return bindCodumentPropositionExecutableEpoch({
    executionRoot: input.executionRoot,
    runId: input.runId,
    eidolonExecutable: path.resolve(input.eidolonExecutable),
    codumentExecutable: path.resolve(input.codumentExecutable),
  })
}

async function main(): Promise<void> {
  const sourceRoot = path.resolve(requiredOption("--source-root"))
  const provider = resolveCodumentPropositionProviderBinding(
    option("--provider")?.trim() || "official-deepseek",
  )
  const selection = matrixSelection()
  const executionRoot = path.resolve(option("--execution-root") ?? ".tmp/codument-proposition-live")
  const runId = option("--run-id")?.trim() || `${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`
  const executableEpoch = await prepareLiveMatrixExecutableEpoch({
    selection,
    executionRoot,
    runId,
    eidolonExecutable: option("--eidolon"),
    codumentExecutable: option("--codument"),
  })
  const scenarios = scenarioCatalog(sourceRoot, Number(option("--timeout") ?? 7_200))
  const manifests = await Promise.all(scenarios.map((scenario) => buildCodumentPropositionLiveManifest({ sourceRoot, scenario })))
  const plan = planCodumentPropositionMatrix({
    manifests,
    selection,
    liveEvidence: selection.kind === "deterministic" ? "none" : provider.evidenceClass,
    sentinelScenarioIds: SENTINEL_SCENARIOS,
  })
  if (plan.deterministic) {
    process.stdout.write(`${JSON.stringify({ accepted: true, plan }, null, 2)}\n`)
    return
  }

  const scenarioById = new Map(scenarios.map((scenario) => [scenario.scenarioId, scenario]))
  const receipts = new Map<string, CodumentPropositionRunReceipt>()
  const results = await runCodumentPropositionMatrixPlan({
    plan,
    completedCellKeys: options("--completed-cell"),
    executeCell: async (cell) => {
      const scenario = scenarioById.get(cell.manifest.scenarioId)
      if (!scenario) throw new Error(`missing live scenario binding: ${cell.manifest.scenarioId}`)
      if (!executableEpoch) throw new Error("live proposition matrix executable epoch is missing")
      const result = await runCodumentPropositionLiveCell({
        sourceRoot,
        executionRoot,
        mode: cell.mode,
        runId,
        shimExecutable: path.resolve(option("--shim") ?? "scripts/codument-proposition-codex-shim.ts"),
        eidolonExecutable: executableEpoch.eidolonExecutable,
        codumentExecutable: executableEpoch.codumentExecutable,
        executableEpoch,
        provider,
        scenario,
      })
      const key = `${cell.manifest.scenarioId}:${cell.mode}`
      receipts.set(key, result.receipt)
      return Object.freeze({
        receiptRef: result.receiptRef,
        status: receiptAccepted(result.receipt, provider) ? "completed" as const : "failed" as const,
      })
    },
  })
  const accepted = results.length > 0 && results.every((result) => result.status === "completed")
  process.stdout.write(`${JSON.stringify({
    accepted,
    provider: {
      id: provider.id,
      providerId: provider.credential.providerId,
      profileId: provider.credential.profileId,
      model: provider.credential.model,
      evidenceClass: provider.evidenceClass,
    },
    selection,
    results: results.map((result) => ({
      ...result,
      receipt: receipts.get(`${result.scenarioId}:${result.mode}`),
    })),
  }, null, 2)}\n`)
  if (!accepted) process.exitCode = 1
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
