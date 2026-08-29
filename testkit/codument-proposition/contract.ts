export const CODUMENT_PROPOSITION_MANIFEST_SCHEMA = "eidolon.codument-proposition-manifest/v1" as const
export const CODUMENT_PROPOSITION_RECEIPT_SCHEMA = "eidolon.codument-proposition-receipt/v1" as const
export const PROPOSITION_PUBLIC_EVENT_SOURCE = "terminal.runtime.public-events/v1" as const

export type CodumentPropositionMode = "ordinary" | "ai_ctrl" | "ai_data"
export type PropositionWorkflowKind = "AICtrlWorkflow" | "AIDataWorkflow"
export type PropositionSha256Digest = `sha256:${string}`

export type PropositionSourceRole = "request" | "verifier" | "runner" | "fixture"

export type CodumentPropositionSource = Readonly<{
  relativePath: string
  digest: PropositionSha256Digest
  role: PropositionSourceRole
}>

export type CodumentPropositionManifest = Readonly<{
  schemaVersion: typeof CODUMENT_PROPOSITION_MANIFEST_SCHEMA
  scenarioId: string
  revision: string
  corpusDigest: PropositionSha256Digest
  sources: readonly CodumentPropositionSource[]
  requestComposition: readonly string[]
  verifier: Readonly<{
    argv: readonly string[]
    digest: PropositionSha256Digest
  }>
  workspaceSeed: "empty_git"
  timeoutSeconds: number
  allowedModes: readonly CodumentPropositionMode[]
}>

export type PropositionWorkflowIdentity = Readonly<{
  kind: PropositionWorkflowKind
  definitionRef: string
  instanceId: string
  runId: string
  nodeActorId: string
}>

export type PropositionModeIdentity = Readonly<{
  requestedMode: CodumentPropositionMode
  actualMode: CodumentPropositionMode
  sessionId: string
  evidenceSource: typeof PROPOSITION_PUBLIC_EVENT_SOURCE | string
  workflow: PropositionWorkflowIdentity | null
}>

export type PropositionProviderTurn = Readonly<{
  contextScopeId: string
  providerId: string
  providerProfileId: "deepseek-official-chat@1" | "deepseek-compatible-chat@1" | string
  model: string
  contextEpoch: number
  epochReason: string
  promptTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  outputTokens: number
  normalizedInputCost: number | null
  retainedPrefixIntegrity: number
  finalSuccess: boolean
}>

export type PropositionProviderAttemptFacts = Readonly<{
  providerCalls: number
  providerFailures: number
  providerRetries: number
  finalAttemptTerminalCauses: readonly string[]
  finalAttemptTerminalCauseOmittedCount: number
}>

export type PropositionCacheScopeClassification =
  | "comparable_long_context"
  | "short_or_cold"
  | "epoch_transition"
  | "incomplete_usage"

export type PropositionCacheScope = Readonly<{
  classification: PropositionCacheScopeClassification
  providerClass: "official_deepseek" | "deepseek_compatible" | "other"
  providerId: string | null
  model: string | null
  contextEpoch: number | null
  eligibleSubsequentTurns: number
  promptTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  outputTokens: number
  normalizedInputCost: number | null
  cacheHitRatio: number | null
  /** Provider cache hits bounded by the immediately preceding prompt size. */
  cacheEligiblePrefixTokens: number
  cacheEligiblePrefixHitTokens: number
  cacheEligiblePrefixHitRatio: number | null
  /** Positive prompt growth across cache-eligible turns in this scope. */
  newInputTokens: number
  retainedPrefixIntegrity: number | null
}>

export type PropositionProcessResult = Readonly<{
  exitCode: number | null
  status: "completed" | "paused_with_progress" | "failed" | "timed_out"
  startedAt: string
  finishedAt: string
  stdoutArtifact: string
  stderrArtifact: string
}>

export type PropositionVerifierResult = Readonly<{
  exitCode: number
  passed: boolean
  outputArtifact: string
}>

export type CodumentPropositionRunReceipt = Readonly<{
  schemaVersion: typeof CODUMENT_PROPOSITION_RECEIPT_SCHEMA
  receiptDigest: PropositionSha256Digest
  manifestDigest: PropositionSha256Digest
  corpusDigest: PropositionSha256Digest
  requestDigest: PropositionSha256Digest
  verifierDigest: PropositionSha256Digest
  modeIdentity: PropositionModeIdentity
  /** One public identity per source-runner Agent invocation, in invocation order. */
  modeIdentities: readonly PropositionModeIdentity[]
  process: PropositionProcessResult
  verifier: PropositionVerifierResult
  /** Aggregate across every observed epoch; never substitutes for per-epoch gates. */
  providerScope: PropositionCacheScope
  /** Contiguous provider/model/context-epoch scopes used for cache acceptance. */
  providerScopes: readonly PropositionCacheScope[]
  providerAttempts: PropositionProviderAttemptFacts
  workspaceArtifact: string
  eidolonExecutableDigest: PropositionSha256Digest
  codumentExecutableDigest: PropositionSha256Digest
}>

export type PropositionCredentialBinding = Readonly<{
  providerId: string
  profileId: string
  model: string
}>

export type PropositionLiveEvidenceClass = "official" | "compatible"

export type CodumentPropositionProviderBinding = Readonly<{
  id: "official-deepseek" | "siliconflow-deepseek-flash" | "deepseek-iqingwa-v4-pro"
  credential: PropositionCredentialBinding
  evidenceClass: PropositionLiveEvidenceClass
  expectedProviderClass: PropositionCacheScope["providerClass"]
}>

export const CODUMENT_PROPOSITION_PROVIDER_BINDINGS = Object.freeze({
  "official-deepseek": Object.freeze({
    id: "official-deepseek",
    credential: Object.freeze({
      providerId: "deepseek",
      profileId: "deepseek-official-chat@1",
      model: "deepseek/deepseek-v4-flash",
    }),
    evidenceClass: "official",
    expectedProviderClass: "official_deepseek",
  }),
  "siliconflow-deepseek-flash": Object.freeze({
    id: "siliconflow-deepseek-flash",
    credential: Object.freeze({
      providerId: "siliconflow",
      profileId: "deepseek-compatible-chat@1",
      model: "siliconflow/deepseek-ai/DeepSeek-V4-Flash",
    }),
    evidenceClass: "compatible",
    expectedProviderClass: "deepseek_compatible",
  }),
  "deepseek-iqingwa-v4-pro": Object.freeze({
    id: "deepseek-iqingwa-v4-pro",
    credential: Object.freeze({
      providerId: "deepseek-iqingwa",
      profileId: "deepseek-compatible-chat@1",
      model: "deepseek-iqingwa/deepseek-v4-pro",
    }),
    evidenceClass: "compatible",
    expectedProviderClass: "deepseek_compatible",
  }),
} satisfies Readonly<Record<string, CodumentPropositionProviderBinding>>)

export function resolveCodumentPropositionProviderBinding(
  id: string,
): CodumentPropositionProviderBinding {
  const binding = (CODUMENT_PROPOSITION_PROVIDER_BINDINGS as Readonly<Record<string, CodumentPropositionProviderBinding>>)[id]
  if (!binding) throw new Error(`unsupported Codument proposition provider binding: ${id}`)
  return binding
}

export type PropositionProcessInvocation = Readonly<{
  cwd: string
  argv: readonly string[]
  timeoutSeconds: number
  environment: Readonly<Record<string, string>>
  credential: PropositionCredentialBinding
}>

export interface PropositionWorkspaceEffectPort {
  create(input: Readonly<{ scenarioId: string; seed: "empty_git" }>): Promise<Readonly<{
    workspaceId: string
    root: string
    artifactRef: string
  }>>
  preserve(workspaceId: string, reason: string): Promise<void>
}

export interface PropositionSourceReadPort {
  read(relativePath: string): Promise<Uint8Array>
  digest(relativePath: string): Promise<PropositionSha256Digest>
}

export interface PropositionProcessEffectPort {
  run(input: PropositionProcessInvocation): Promise<PropositionProcessResult>
}

export interface PropositionVerifierEffectPort {
  run(input: Readonly<{
    cwd: string
    argv: readonly string[]
    timeoutSeconds: number
  }>): Promise<PropositionVerifierResult>
}

export interface PropositionModeExecutionPort {
  execute(input: Readonly<{
    mode: CodumentPropositionMode
    workspaceRoot: string
    request: Uint8Array
    requestDigest: PropositionSha256Digest
    timeoutSeconds: number
    credential: PropositionCredentialBinding
  }>): Promise<Readonly<{
    identity: PropositionModeIdentity
    identities: readonly PropositionModeIdentity[]
    process: PropositionProcessResult
    providerTurns: readonly PropositionProviderTurn[]
    providerAttempts: PropositionProviderAttemptFacts
  }>>
}

export interface PropositionReceiptStorePort {
  persist(receipt: CodumentPropositionRunReceipt): Promise<string>
}

export interface CodumentPropositionEffectRuntime {
  workspace: PropositionWorkspaceEffectPort
  source: PropositionSourceReadPort
  mode: PropositionModeExecutionPort
  verifier: PropositionVerifierEffectPort
  receiptStore: PropositionReceiptStorePort
}
