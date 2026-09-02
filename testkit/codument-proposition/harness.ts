import { createHash } from "node:crypto"

import {
  CODUMENT_PROPOSITION_MANIFEST_SCHEMA,
  CODUMENT_PROPOSITION_RECEIPT_SCHEMA,
  PROPOSITION_PUBLIC_EVENT_SOURCE,
  type CodumentPropositionEffectRuntime,
  type CodumentPropositionManifest,
  type CodumentPropositionMode,
  type CodumentPropositionRunReceipt,
  type PropositionCacheScope,
  type PropositionCredentialBinding,
  type PropositionModeIdentity,
  type PropositionProviderTurn,
  type PropositionSha256Digest,
} from "./contract"
import type { ProviderCacheCostObservation } from "../../cell/packages/ai-organ-contract/src/llm/ProviderCacheCostObservation"
import { compareProviderCacheCostObservations } from "../../cell/packages/ai-organ-logic/src/llm/ProviderCacheCostObservation"

const MANIFEST_KEYS = Object.freeze([
  "allowedModes",
  "corpusDigest",
  "requestComposition",
  "revision",
  "scenarioId",
  "schemaVersion",
  "sources",
  "timeoutSeconds",
  "verifier",
  "workspaceSeed",
])
const SOURCE_KEYS = Object.freeze(["digest", "relativePath", "role"])
const VERIFIER_KEYS = Object.freeze(["argv", "digest"])
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
const RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[^\0]+$/

function ownRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an own-data object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must use a plain prototype`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.get || descriptor.set) throw new Error(`${label}.${key} cannot be an accessor`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  const unknown = Object.keys(record).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new Error(`${label} has unknown field: ${unknown.sort().join(", ")}`)
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(record, key))
  if (missing.length > 0) throw new Error(`${label} is missing field: ${missing.join(", ")}`)
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be non-empty`)
}

function assertDigest(value: unknown, label: string): asserts value is PropositionSha256Digest {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new Error(`${label} must be sha256:<64 lowercase hex>`)
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must be a non-empty string array`)
  }
}

function assertRelativePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !RELATIVE_PATH_PATTERN.test(value)) {
    throw new Error(`${label} must be a safe relative source path`)
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`
}

function digest(value: string | Uint8Array): PropositionSha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

export function validatePropositionManifest(value: unknown): CodumentPropositionManifest {
  const record = ownRecord(value, "manifest")
  assertExactKeys(record, MANIFEST_KEYS, "manifest")
  if (record.schemaVersion !== CODUMENT_PROPOSITION_MANIFEST_SCHEMA) throw new Error("unsupported manifest schemaVersion")
  assertString(record.scenarioId, "scenarioId")
  assertString(record.revision, "revision")
  assertDigest(record.corpusDigest, "corpusDigest")
  if (record.workspaceSeed !== "empty_git") throw new Error("workspaceSeed must be empty_git")
  if (!Number.isSafeInteger(record.timeoutSeconds) || Number(record.timeoutSeconds) <= 0) {
    throw new Error("timeoutSeconds must be a positive integer")
  }
  if (!Array.isArray(record.allowedModes) || record.allowedModes.length === 0
    || record.allowedModes.some((mode) => !["ordinary", "ai_ctrl", "ai_data"].includes(String(mode)))) {
    throw new Error("allowedModes must contain only ordinary, ai_ctrl or ai_data")
  }
  if (new Set(record.allowedModes).size !== record.allowedModes.length) throw new Error("allowedModes cannot contain duplicates")

  if (!Array.isArray(record.sources) || record.sources.length === 0) throw new Error("sources must be non-empty")
  const sourcePaths = new Set<string>()
  for (const [index, sourceValue] of record.sources.entries()) {
    const source = ownRecord(sourceValue, `sources[${index}]`)
    assertExactKeys(source, SOURCE_KEYS, `sources[${index}]`)
    assertRelativePath(source.relativePath, `sources[${index}].relativePath`)
    assertDigest(source.digest, `sources[${index}].digest`)
    if (!["request", "verifier", "runner", "fixture"].includes(String(source.role))) {
      throw new Error(`sources[${index}].role is invalid`)
    }
    if (sourcePaths.has(source.relativePath)) throw new Error(`duplicate source path: ${source.relativePath}`)
    sourcePaths.add(source.relativePath)
  }

  assertStringArray(record.requestComposition, "requestComposition")
  for (const relativePath of record.requestComposition) {
    assertRelativePath(relativePath, "requestComposition item")
    const source = (record.sources as any[]).find((candidate) => candidate.relativePath === relativePath)
    if (!source || source.role !== "request") throw new Error(`request source is not declared: ${relativePath}`)
  }

  const verifier = ownRecord(record.verifier, "verifier")
  assertExactKeys(verifier, VERIFIER_KEYS, "verifier")
  assertStringArray(verifier.argv, "verifier.argv")
  assertDigest(verifier.digest, "verifier.digest")
  if (!(record.sources as any[]).some((source) => source.role === "verifier" && source.digest === verifier.digest)) {
    throw new Error("verifier digest is not declared by a verifier source")
  }

  return value as CodumentPropositionManifest
}

export function canonicalPropositionManifestDigest(value: CodumentPropositionManifest): PropositionSha256Digest {
  return digest(canonical(validatePropositionManifest(value)))
}

export function verifyPropositionModeIdentity(identity: PropositionModeIdentity): PropositionModeIdentity {
  if (!identity.sessionId.trim()) throw new Error("mode identity requires sessionId")
  if (identity.requestedMode !== identity.actualMode) {
    throw new Error(`mode mismatch: requested ${identity.requestedMode}, actual ${identity.actualMode}`)
  }
  if (identity.evidenceSource !== PROPOSITION_PUBLIC_EVENT_SOURCE) {
    throw new Error("mode identity must come from public runtime events")
  }
  if (identity.actualMode === "ordinary") {
    if (identity.workflow !== null) throw new Error("ordinary mode must be workflow-free")
    return identity
  }
  if (!identity.workflow) throw new Error("workflow mode requires typed workflow identity")
  const expectedKind = identity.actualMode === "ai_ctrl" ? "AICtrlWorkflow" : "AIDataWorkflow"
  if (identity.workflow.kind !== expectedKind) throw new Error(`workflow kind mismatch: expected ${expectedKind}`)
  if (![identity.workflow.definitionRef, identity.workflow.instanceId, identity.workflow.runId, identity.workflow.nodeActorId].every((item) => item.trim())) {
    throw new Error("workflow identity fields must be non-empty")
  }
  return identity
}

function providerClass(turns: readonly PropositionProviderTurn[]): PropositionCacheScope["providerClass"] {
  if (turns.length === 0) return "other"
  if (turns.every((turn) => (
    turn.providerProfileId === "deepseek-chat@1"
    || turn.providerProfileId === "deepseek-official-chat@1"
    || turn.providerProfileId === "deepseek-compatible-chat@1"
  ))) return "deepseek"
  return "other"
}

function classifyPropositionCacheScopeWithEligibility(
  turns: readonly PropositionProviderTurn[],
  eligibleSubsequentTurns: number,
  prefixBasisTurns: readonly PropositionProviderTurn[] = turns,
): PropositionCacheScope {
  if (turns.some((turn) => turn.retainedPrefixIntegrity !== 1)) {
    throw new Error("retained prefix integrity must equal 1 within a comparable scope")
  }
  const promptTokens = turns.reduce((sum, turn) => sum + turn.promptTokens, 0)
  const cacheHitTokens = turns.reduce((sum, turn) => sum + turn.cacheHitTokens, 0)
  const cacheMissTokens = turns.reduce((sum, turn) => sum + turn.cacheMissTokens, 0)
  const outputTokens = turns.reduce((sum, turn) => sum + turn.outputTokens, 0)
  const normalizedInputCost = turns.every((turn) => turn.normalizedInputCost !== null)
    ? turns.reduce((sum, turn) => sum + Number(turn.normalizedInputCost), 0)
    : null
  const denominator = cacheHitTokens + cacheMissTokens
  const prefixTransitions = prefixBasisTurns.slice(1).map((turn, index) => ({
    previous: prefixBasisTurns[index]!,
    current: turn,
  })).filter((transition) => sameProviderEpoch(transition.previous, transition.current))
  const cacheEligiblePrefixTokens = prefixTransitions.reduce((sum, transition) => (
    sum + transition.previous.promptTokens
  ), 0)
  const cacheEligiblePrefixHitTokens = prefixTransitions.reduce((sum, transition) => (
    sum + Math.min(transition.current.cacheHitTokens, transition.previous.promptTokens)
  ), 0)
  const newInputTokens = prefixTransitions.reduce((sum, transition) => (
    sum + Math.max(0, transition.current.promptTokens - transition.previous.promptTokens)
  ), 0)
  const first = turns[0]
  const sameIdentity = first !== undefined && turns.every((turn) => (
    turn.contextScopeId === first.contextScopeId
    && turn.providerId === first.providerId
    && turn.providerProfileId === first.providerProfileId
    && turn.model === first.model
    && turn.contextEpoch === first.contextEpoch
  ))
  const finalSuccess = turns.every((turn) => turn.finalSuccess)
  const classification: PropositionCacheScope["classification"] = !finalSuccess
    ? "incomplete_usage"
    : !sameIdentity
      ? "epoch_transition"
      : eligibleSubsequentTurns >= 3 && denominator >= 32_768
        ? "comparable_long_context"
        : "short_or_cold"
  if (classification === "comparable_long_context"
    && providerClass(turns) === "deepseek"
    && normalizedInputCost === null) {
    throw new Error("official comparable scope requires absolute normalized input cost")
  }
  return Object.freeze({
    classification,
    providerClass: providerClass(turns),
    providerId: first?.providerId ?? null,
    model: first?.model ?? null,
    contextEpoch: sameIdentity ? first?.contextEpoch ?? null : null,
    eligibleSubsequentTurns,
    promptTokens,
    cacheHitTokens,
    cacheMissTokens,
    outputTokens,
    normalizedInputCost,
    cacheHitRatio: denominator > 0 ? cacheHitTokens / denominator : null,
    cacheEligiblePrefixTokens,
    cacheEligiblePrefixHitTokens,
    cacheEligiblePrefixHitRatio: cacheEligiblePrefixTokens > 0
      ? cacheEligiblePrefixHitTokens / cacheEligiblePrefixTokens
      : null,
    newInputTokens,
    retainedPrefixIntegrity: turns.length > 0 ? Math.min(...turns.map((turn) => turn.retainedPrefixIntegrity)) : null,
  })
}

export function classifyPropositionCacheScope(turns: readonly PropositionProviderTurn[]): PropositionCacheScope {
  const eligibleSubsequentTurns = turns.slice(1).reduce((count, turn, index) => (
    count + (sameProviderEpoch(turns[index]!, turn) ? 1 : 0)
  ), 0)
  return classifyPropositionCacheScopeWithEligibility(turns, eligibleSubsequentTurns)
}

function sameProviderEpoch(left: PropositionProviderTurn, right: PropositionProviderTurn): boolean {
  return left.contextScopeId === right.contextScopeId
    && left.providerId === right.providerId
    && left.providerProfileId === right.providerProfileId
    && left.model === right.model
    && left.contextEpoch === right.contextEpoch
}

/**
 * Preserve runtime ordering while isolating every contiguous provider epoch,
 * then split its first cold request from cache-eligible subsequent requests.
 * A later return to an old numeric epoch is intentionally a new scope: a
 * rewind/fork must not be merged into an earlier forward-only denominator.
 */
export function classifyPropositionCacheScopes(
  turns: readonly PropositionProviderTurn[],
): readonly PropositionCacheScope[] {
  if (turns.length === 0) return Object.freeze([])
  const groups: PropositionProviderTurn[][] = []
  for (const turn of turns) {
    const current = groups.at(-1)
    if (!current || !sameProviderEpoch(current[0]!, turn)) {
      groups.push([turn])
    } else {
      current.push(turn)
    }
  }
  return Object.freeze(groups.flatMap((group) => {
    const cold = classifyPropositionCacheScopeWithEligibility(group.slice(0, 1), 0)
    const stableTurns = group.slice(1)
    return stableTurns.length === 0
      ? [cold]
      : [
          cold,
          classifyPropositionCacheScopeWithEligibility(stableTurns, stableTurns.length, group),
        ]
  }))
}

export function projectCanonicalPropositionProviderTurns(input: Readonly<{
  contextScopeId: string
  observations: readonly ProviderCacheCostObservation[]
  epochReasons: readonly string[]
}>): readonly PropositionProviderTurn[] {
  if (input.observations.length !== input.epochReasons.length) {
    throw new Error("canonical provider observations and epoch reasons must have equal length")
  }
  if (!input.contextScopeId.trim()) throw new Error("canonical provider observations require contextScopeId")
  return Object.freeze(input.observations.map((observation, index) => {
    const usage = observation.tokenBreakdown.usage
    const comparison = index === 0
      ? null
      : compareProviderCacheCostObservations(input.observations[index - 1]!, observation)
    if (comparison?.relation === "same_epoch"
      && (comparison.retainedPrefixIntegrity !== 1 || comparison.firstDivergence !== null)) {
      throw new Error(`canonical provider observation has retained prefix divergence at turn ${index}`)
    }
    return Object.freeze({
      contextScopeId: input.contextScopeId,
      providerId: observation.identity.providerId,
      providerProfileId: observation.identity.providerProfileId,
      model: observation.identity.model,
      contextEpoch: observation.identity.contextEpoch,
      epochReason: input.epochReasons[index]!,
      promptTokens: usage?.promptTokens ?? 0,
      cacheHitTokens: usage?.cacheHitTokens ?? 0,
      cacheMissTokens: usage?.cacheMissTokens ?? 0,
      outputTokens: usage?.completionTokens ?? 0,
      normalizedInputCost: observation.tokenBreakdown.normalizedInputCost,
      retainedPrefixIntegrity: comparison?.relation === "same_epoch"
        ? comparison.retainedPrefixIntegrity
        : 1,
      finalSuccess: usage !== null,
    })
  }))
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

export async function runCodumentPropositionCell(input: Readonly<{
  manifest: CodumentPropositionManifest
  mode: CodumentPropositionMode
  runtime: CodumentPropositionEffectRuntime
  credential: PropositionCredentialBinding
  eidolonExecutableDigest: PropositionSha256Digest
  codumentExecutableDigest: PropositionSha256Digest
}>): Promise<CodumentPropositionRunReceipt> {
  const manifest = validatePropositionManifest(input.manifest)
  if (!manifest.allowedModes.includes(input.mode)) throw new Error(`mode ${input.mode} is not allowed by manifest`)
  const workspace = await input.runtime.workspace.create({ scenarioId: manifest.scenarioId, seed: manifest.workspaceSeed })
  try {
    const requestParts: Uint8Array[] = []
    for (const relativePath of manifest.requestComposition) {
      const expected = manifest.sources.find((source) => source.relativePath === relativePath)?.digest
      const actual = await input.runtime.source.digest(relativePath)
      if (expected !== actual) throw new Error(`source digest mismatch: ${relativePath}`)
      requestParts.push(await input.runtime.source.read(relativePath))
    }
    const request = concatBytes(requestParts)
    const requestDigest = digest(request)
    const execution = await input.runtime.mode.execute({
      mode: input.mode,
      workspaceRoot: workspace.root,
      request,
      requestDigest,
      timeoutSeconds: manifest.timeoutSeconds,
      credential: input.credential,
    })
    if (execution.identities.length === 0) throw new Error("mode execution emitted no public identities")
    const modeIdentities = Object.freeze(execution.identities.map(verifyPropositionModeIdentity))
    const modeIdentity = verifyPropositionModeIdentity(execution.identity)
    if (modeIdentity.sessionId !== modeIdentities[0]!.sessionId) {
      throw new Error("primary mode identity must equal the first invocation identity")
    }
    const verifier = await input.runtime.verifier.run({
      cwd: workspace.root,
      argv: manifest.verifier.argv,
      timeoutSeconds: manifest.timeoutSeconds,
    })
    const providerScope = classifyPropositionCacheScope(execution.providerTurns)
    const providerScopes = classifyPropositionCacheScopes(execution.providerTurns)
    const unsigned = {
      schemaVersion: CODUMENT_PROPOSITION_RECEIPT_SCHEMA,
      manifestDigest: canonicalPropositionManifestDigest(manifest),
      corpusDigest: manifest.corpusDigest,
      requestDigest,
      verifierDigest: manifest.verifier.digest,
      modeIdentity,
      modeIdentities,
      process: execution.process,
      verifier,
      providerScope,
      providerScopes,
      providerAttempts: execution.providerAttempts,
      workspaceArtifact: workspace.artifactRef,
      eidolonExecutableDigest: input.eidolonExecutableDigest,
      codumentExecutableDigest: input.codumentExecutableDigest,
    }
    const receipt = Object.freeze({ ...unsigned, receiptDigest: digest(canonical(unsigned)) })
    await input.runtime.receiptStore.persist(receipt)
    return receipt
  } catch (error) {
    await input.runtime.workspace.preserve(workspace.workspaceId, error instanceof Error ? error.message : String(error))
    throw error
  }
}
