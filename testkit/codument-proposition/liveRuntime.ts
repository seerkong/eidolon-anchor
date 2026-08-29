import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import {
  CODUMENT_PROPOSITION_MANIFEST_SCHEMA,
  PROPOSITION_PUBLIC_EVENT_SOURCE,
  type CodumentPropositionProviderBinding,
  type CodumentPropositionEffectRuntime,
  type CodumentPropositionManifest,
  type CodumentPropositionMode,
  type CodumentPropositionRunReceipt,
  type PropositionModeIdentity,
  type PropositionProviderAttemptFacts,
  type PropositionProviderTurn,
  type PropositionReceiptStorePort,
  type PropositionSha256Digest,
} from "./contract"
import { runCodumentPropositionCell } from "./harness"
import {
  createAllowlistedPropositionEnvironment,
  createJsonPropositionReceiptStore,
} from "./support"

export type CodumentPropositionLiveScenario = Readonly<{
  scenarioId: string
  revision: string
  corpusDigest: PropositionSha256Digest
  runnerRelativePath: string
  requestRelativePaths: readonly string[]
  verifierRelativePath: string
  runnerTaskArgument?: string
  runnerEnvironment?: Readonly<Record<string, string>>
  expectedAgentInvocations: number
  verifierKind: "shell" | "modeling_score"
  timeoutSeconds: number
}>

export type CodumentPropositionLiveBinding = Readonly<{
  sourceRoot: string
  executionRoot: string
  mode: CodumentPropositionMode
  runId: string
  shimExecutable: string
  eidolonExecutable: string
  codumentExecutable: string
  provider: CodumentPropositionProviderBinding
  executableEpoch?: CodumentPropositionExecutableEpoch
  scenario: CodumentPropositionLiveScenario
}>

export type CodumentPropositionExecutableEpoch = Readonly<{
  runId: string
  bindingManifest: string
  eidolonExecutable: string
  eidolonExecutableDigest: PropositionSha256Digest
  eidolonRuntimeRoot: string
  eidolonRuntimeClosureDigest: PropositionSha256Digest
  codumentExecutable: string
  codumentExecutableDigest: PropositionSha256Digest
}>

type ExecutableEpochBindingManifest = Readonly<{
  schemaVersion: "eidolon.codument-proposition-executable-epoch/v2"
  runId: string
  eidolon: Readonly<{
    file: string
    digest: PropositionSha256Digest
    runtimeDirectory: string
    runtimeClosureDigest: PropositionSha256Digest
  }>
  codument: Readonly<{ file: string; digest: PropositionSha256Digest }>
}>

type ExecutableEpochIntegrity = Readonly<
  Pick<CodumentPropositionExecutableEpoch,
    "eidolonExecutable" | "eidolonExecutableDigest" | "codumentExecutable" | "codumentExecutableDigest">
  & Partial<Pick<CodumentPropositionExecutableEpoch, "eidolonRuntimeRoot" | "eidolonRuntimeClosureDigest">>
>

type RuntimeSidecarFile = Readonly<{
  relativePath: string
  bytes: Uint8Array
  mode: number
}>

type ShimEvidence = Readonly<{
  mode: CodumentPropositionMode
  propositionRequestDigest: PropositionSha256Digest
  modeIdentity: PropositionModeIdentity | null
  evidenceError: string | null
  providerTurns: readonly PropositionProviderTurn[]
  providerAttempts: PropositionProviderAttemptFacts
}>

const PROCESS_ENV_ALLOWLIST = Object.freeze([
  "HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TERM", "TMPDIR", "USERPROFILE", "XDG_CONFIG_HOME",
])

function sha256(value: string | Uint8Array): PropositionSha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

async function fileDigest(filePath: string): Promise<PropositionSha256Digest> {
  return sha256(await readFile(filePath))
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST"
}

function safeRunId(runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) || runId === "." || runId === "..") {
    throw new Error("proposition executable epoch run id must be a safe path segment")
  }
  return runId
}

function digestFileName(role: "eidolon" | "codument", digest: PropositionSha256Digest): string {
  return `${role}-${digest.replace(/^sha256:/, "")}.bin`
}

function runtimeDirectoryName(digest: PropositionSha256Digest): string {
  return `eidolon-runtime-${digest.replace(/^sha256:/, "")}`
}

async function collectRuntimeSidecars(root: string): Promise<readonly RuntimeSidecarFile[]> {
  const collect = async (directory: string, prefix: string): Promise<RuntimeSidecarFile[]> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
      throw error
    })
    const files: RuntimeSidecarFile[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) files.push(...await collect(absolutePath, relativePath))
      else if (entry.isFile()) {
        const [bytes, metadata] = await Promise.all([readFile(absolutePath), stat(absolutePath)])
        files.push(Object.freeze({ relativePath, bytes, mode: metadata.mode & 0o777 }))
      } else {
        throw new Error(`unsupported proposition executable sidecar entry: ${relativePath}`)
      }
    }
    return files
  }
  return Object.freeze(await collect(root, ""))
}

function runtimeSidecarDigest(files: readonly RuntimeSidecarFile[]): PropositionSha256Digest {
  const hash = createHash("sha256")
  for (const file of files) {
    hash.update(file.relativePath, "utf8")
    hash.update("\0")
    hash.update(file.bytes)
    hash.update("\0")
  }
  return `sha256:${hash.digest("hex")}`
}

function runtimeClosureDigest(
  executableDigest: PropositionSha256Digest,
  sidecarDigest: PropositionSha256Digest,
): PropositionSha256Digest {
  return sha256(`${executableDigest}\0${sidecarDigest}`)
}

async function materializeRuntimeSidecars(root: string, files: readonly RuntimeSidecarFile[]): Promise<void> {
  for (const file of files) {
    const destination = path.join(root, ...file.relativePath.split("/"))
    await mkdir(path.dirname(destination), { recursive: true })
    const readOnlyMode = file.mode & 0o555 || 0o400
    await writeFile(destination, file.bytes, { flag: "wx", mode: readOnlyMode }).catch(async (error) => {
      if (!isAlreadyExists(error)) throw error
      if (sha256(await readFile(destination)) !== sha256(file.bytes)) {
        throw new Error(`proposition executable epoch integrity drift: ${destination}`)
      }
    })
  }
}

function parseExecutableEpochBinding(
  text: string,
  expectedRunId: string,
  epochRoot: string,
  bindingManifest: string,
): CodumentPropositionExecutableEpoch {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== "object") throw new Error("invalid proposition executable epoch binding")
  const record = value as Record<string, unknown>
  const eidolon = record.eidolon as Record<string, unknown> | undefined
  const codument = record.codument as Record<string, unknown> | undefined
  const digestPattern = /^sha256:[a-f0-9]{64}$/
  if (record.schemaVersion !== "eidolon.codument-proposition-executable-epoch/v2"
    || record.runId !== expectedRunId
    || !eidolon || !codument
    || typeof eidolon.file !== "string" || typeof eidolon.digest !== "string"
    || typeof eidolon.runtimeDirectory !== "string" || typeof eidolon.runtimeClosureDigest !== "string"
    || typeof codument.file !== "string" || typeof codument.digest !== "string"
    || !digestPattern.test(eidolon.digest) || !digestPattern.test(eidolon.runtimeClosureDigest)
    || !digestPattern.test(codument.digest)
    || eidolon.runtimeDirectory !== runtimeDirectoryName(eidolon.runtimeClosureDigest as PropositionSha256Digest)
    || eidolon.file !== `${eidolon.runtimeDirectory}/${digestFileName("eidolon", eidolon.digest as PropositionSha256Digest)}`
    || codument.file !== digestFileName("codument", codument.digest as PropositionSha256Digest)) {
    throw new Error("invalid proposition executable epoch binding")
  }
  return Object.freeze({
    runId: expectedRunId,
    bindingManifest,
    eidolonExecutable: path.join(epochRoot, ...eidolon.file.split("/")),
    eidolonExecutableDigest: eidolon.digest as PropositionSha256Digest,
    eidolonRuntimeRoot: path.join(epochRoot, eidolon.runtimeDirectory),
    eidolonRuntimeClosureDigest: eidolon.runtimeClosureDigest as PropositionSha256Digest,
    codumentExecutable: path.join(epochRoot, codument.file),
    codumentExecutableDigest: codument.digest as PropositionSha256Digest,
  })
}

async function readBoundExecutableEpoch(
  epochRoot: string,
  runId: string,
): Promise<CodumentPropositionExecutableEpoch | null> {
  const bindingManifest = path.join(epochRoot, "binding.json")
  const text = await readFile(bindingManifest, "utf8").catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  })
  return text === null ? null : parseExecutableEpochBinding(text, runId, epochRoot, bindingManifest)
}

async function materializeExecutableSnapshot(
  destination: string,
  bytes: Uint8Array,
  digest: PropositionSha256Digest,
): Promise<void> {
  await writeFile(destination, bytes, { flag: "wx", mode: 0o500 }).catch(async (error) => {
    if (!isAlreadyExists(error)) throw error
    if (await fileDigest(destination) !== digest) {
      throw new Error(`proposition executable epoch integrity drift: ${destination}`)
    }
  })
}

export async function assertCodumentPropositionExecutableEpoch(
  epoch: ExecutableEpochIntegrity,
): Promise<void> {
  const [eidolonDigest, codumentDigest] = await Promise.all([
    fileDigest(epoch.eidolonExecutable),
    fileDigest(epoch.codumentExecutable),
  ]).catch((error) => {
    throw new Error(`proposition executable epoch integrity drift: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (eidolonDigest !== epoch.eidolonExecutableDigest || codumentDigest !== epoch.codumentExecutableDigest) {
    throw new Error("proposition executable epoch integrity drift")
  }
  if (!!epoch.eidolonRuntimeRoot !== !!epoch.eidolonRuntimeClosureDigest) {
    throw new Error("proposition executable epoch integrity binding is incomplete")
  }
  if (epoch.eidolonRuntimeRoot && epoch.eidolonRuntimeClosureDigest) {
    const sidecars = await collectRuntimeSidecars(path.join(epoch.eidolonRuntimeRoot, "node_modules"))
    const observedClosureDigest = runtimeClosureDigest(eidolonDigest, runtimeSidecarDigest(sidecars))
    if (observedClosureDigest !== epoch.eidolonRuntimeClosureDigest) {
      throw new Error("proposition executable epoch integrity drift")
    }
  }
}

export async function bindCodumentPropositionExecutableEpoch(input: Readonly<{
  executionRoot: string
  runId: string
  eidolonExecutable: string
  codumentExecutable: string
}>): Promise<CodumentPropositionExecutableEpoch> {
  const runId = safeRunId(input.runId)
  const epochRoot = path.resolve(input.executionRoot, ".executable-snapshots", runId)
  await mkdir(epochRoot, { recursive: true })
  const existing = await readBoundExecutableEpoch(epochRoot, runId)
  if (existing) {
    await assertCodumentPropositionExecutableEpoch(existing)
    return existing
  }

  const eidolonSource = path.resolve(input.eidolonExecutable)
  const [eidolonBytes, codumentBytes, sidecars] = await Promise.all([
    readFile(eidolonSource),
    readFile(path.resolve(input.codumentExecutable)),
    collectRuntimeSidecars(path.join(path.dirname(eidolonSource), "node_modules")),
  ])
  const eidolonDigest = sha256(eidolonBytes)
  const codumentDigest = sha256(codumentBytes)
  const eidolonRuntimeClosureDigest = runtimeClosureDigest(eidolonDigest, runtimeSidecarDigest(sidecars))
  const eidolonRuntimeDirectory = runtimeDirectoryName(eidolonRuntimeClosureDigest)
  const eidolonRuntimeRoot = path.join(epochRoot, eidolonRuntimeDirectory)
  const eidolonFile = digestFileName("eidolon", eidolonDigest)
  const codumentFile = digestFileName("codument", codumentDigest)
  await mkdir(eidolonRuntimeRoot, { recursive: true })
  await Promise.all([
    materializeExecutableSnapshot(path.join(eidolonRuntimeRoot, eidolonFile), eidolonBytes, eidolonDigest),
    materializeRuntimeSidecars(path.join(eidolonRuntimeRoot, "node_modules"), sidecars),
    materializeExecutableSnapshot(path.join(epochRoot, codumentFile), codumentBytes, codumentDigest),
  ])
  const manifest: ExecutableEpochBindingManifest = Object.freeze({
    schemaVersion: "eidolon.codument-proposition-executable-epoch/v2",
    runId,
    eidolon: Object.freeze({
      file: `${eidolonRuntimeDirectory}/${eidolonFile}`,
      digest: eidolonDigest,
      runtimeDirectory: eidolonRuntimeDirectory,
      runtimeClosureDigest: eidolonRuntimeClosureDigest,
    }),
    codument: Object.freeze({ file: codumentFile, digest: codumentDigest }),
  })
  const bindingManifest = path.join(epochRoot, "binding.json")
  await writeFile(bindingManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  }).catch((error) => {
    if (!isAlreadyExists(error)) throw error
  })
  const bound = await readBoundExecutableEpoch(epochRoot, runId)
  if (!bound) throw new Error("proposition executable epoch binding was not persisted")
  await assertCodumentPropositionExecutableEpoch(bound)
  return bound
}

export function createExecutableEpochReceiptStore(
  outputRoot: string,
  epoch: ExecutableEpochIntegrity,
): PropositionReceiptStorePort {
  const delegate = createJsonPropositionReceiptStore(outputRoot)
  return Object.freeze({
    async persist(receipt) {
      await assertCodumentPropositionExecutableEpoch(epoch)
      if (receipt.eidolonExecutableDigest !== epoch.eidolonExecutableDigest
        || receipt.codumentExecutableDigest !== epoch.codumentExecutableDigest) {
        throw new Error("proposition receipt executable epoch mismatch")
      }
      return delegate.persist(receipt)
    },
  })
}

function contained(root: string, relativePath: string): string {
  const absoluteRoot = path.resolve(root)
  const absolute = path.resolve(absoluteRoot, relativePath)
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`proposition source escapes root: ${relativePath}`)
  }
  return absolute
}

function parseShimEvidence(filePath: string): Promise<readonly ShimEvidence[]> {
  return readFile(filePath, "utf8").then((text) => Object.freeze(text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ShimEvidence)))
}

async function detectTrackId(workspaceRoot: string): Promise<string | null> {
  for (const stage of ["active", "pending"] as const) {
    const root = path.join(workspaceRoot, "codument", "tracks", stage)
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue
      const trackFile = path.join(root, entry.name, "track.xnl")
      if (await readFile(trackFile).then(() => true).catch(() => false)) return entry.name
    }
  }
  return null
}

async function runChild(input: Readonly<{
  argv: readonly string[]
  cwd: string
  environment: Readonly<Record<string, string>>
  timeoutSeconds: number
}>): Promise<Readonly<{
  exitCode: number
  timedOut: boolean
  stdout: string
  stderr: string
  startedAt: string
  finishedAt: string
}>> {
  const startedAt = new Date().toISOString()
  const child = Bun.spawn(input.argv, {
    cwd: input.cwd,
    env: input.environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, input.timeoutSeconds * 1_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return Object.freeze({
      exitCode,
      timedOut,
      stdout,
      stderr,
      startedAt,
      finishedAt: new Date().toISOString(),
    })
  } finally {
    clearTimeout(timer)
  }
}

export async function buildCodumentPropositionLiveManifest(input: Readonly<{
  sourceRoot: string
  scenario: CodumentPropositionLiveScenario
}>): Promise<CodumentPropositionManifest> {
  const source = input.scenario
  if (source.requestRelativePaths.length === 0) throw new Error("live scenario requires request sources")
  if (!Number.isSafeInteger(source.expectedAgentInvocations) || source.expectedAgentInvocations <= 0) {
    throw new Error("live scenario expectedAgentInvocations must be positive")
  }
  const [requestDigests, verifierDigest, runnerDigest] = await Promise.all([
    Promise.all(source.requestRelativePaths.map((relativePath) => fileDigest(contained(input.sourceRoot, relativePath)))),
    fileDigest(contained(input.sourceRoot, source.verifierRelativePath)),
    fileDigest(contained(input.sourceRoot, source.runnerRelativePath)),
  ])
  return Object.freeze({
    schemaVersion: CODUMENT_PROPOSITION_MANIFEST_SCHEMA,
    scenarioId: source.scenarioId,
    revision: source.revision,
    corpusDigest: source.corpusDigest,
    sources: Object.freeze([
      ...source.requestRelativePaths.map((relativePath, index) => Object.freeze({ relativePath, digest: requestDigests[index]!, role: "request" as const })),
      Object.freeze({ relativePath: source.verifierRelativePath, digest: verifierDigest, role: "verifier" as const }),
      Object.freeze({ relativePath: source.runnerRelativePath, digest: runnerDigest, role: "runner" as const }),
    ]),
    requestComposition: Object.freeze([...source.requestRelativePaths]),
    verifier: Object.freeze({
      argv: Object.freeze([source.verifierRelativePath]),
      digest: verifierDigest,
    }),
    workspaceSeed: "empty_git",
    timeoutSeconds: source.timeoutSeconds,
    allowedModes: Object.freeze(["ordinary", "ai_ctrl", "ai_data"] as const),
  })
}

function combineAttemptFacts(evidence: readonly ShimEvidence[]): PropositionProviderAttemptFacts {
  return Object.freeze({
    providerCalls: evidence.reduce((sum, item) => sum + item.providerAttempts.providerCalls, 0),
    providerFailures: evidence.reduce((sum, item) => sum + item.providerAttempts.providerFailures, 0),
    providerRetries: evidence.reduce((sum, item) => sum + item.providerAttempts.providerRetries, 0),
    finalAttemptTerminalCauses: Object.freeze(evidence.flatMap((item) => item.providerAttempts.finalAttemptTerminalCauses)),
    finalAttemptTerminalCauseOmittedCount: evidence.reduce((sum, item) => (
      sum + item.providerAttempts.finalAttemptTerminalCauseOmittedCount
    ), 0),
  })
}

export function createCodumentPropositionLiveRuntime(
  binding: CodumentPropositionLiveBinding,
  executableEpoch?: ExecutableEpochIntegrity,
): CodumentPropositionEffectRuntime {
  const sourceRoot = path.resolve(binding.sourceRoot)
  const cellRoot = path.resolve(binding.executionRoot, binding.scenario.scenarioId, binding.mode, binding.runId)
  const workspaceRoot = path.join(cellRoot, "workspace")
  const artifactRoot = path.join(cellRoot, "artifacts")
  const evidencePath = path.join(artifactRoot, "shim-evidence.jsonl")
  const receiptRoot = path.join(cellRoot, "receipts")
  const runtime: CodumentPropositionEffectRuntime = {
    workspace: {
      async create(input) {
        if (input.scenarioId !== binding.scenario.scenarioId || input.seed !== "empty_git") {
          throw new Error("live workspace request does not match the bound scenario")
        }
        await mkdir(artifactRoot, { recursive: true })
        return Object.freeze({
          workspaceId: `${binding.scenario.scenarioId}:${binding.mode}:${binding.runId}`,
          root: workspaceRoot,
          artifactRef: `artifact://${binding.scenario.scenarioId}/${binding.mode}/${binding.runId}/workspace`,
        })
      },
      async preserve(_workspaceId, reason) {
        await mkdir(artifactRoot, { recursive: true })
        await writeFile(path.join(artifactRoot, "preserved-reason.txt"), `${reason}\n`, { encoding: "utf8", mode: 0o600 })
      },
    },
    source: {
      read: (relativePath) => readFile(contained(sourceRoot, relativePath)),
      digest: (relativePath) => fileDigest(contained(sourceRoot, relativePath)),
    },
    mode: {
      async execute(input) {
        if (input.mode !== binding.mode) throw new Error("live mode binding mismatch")
        if (input.credential.providerId !== binding.provider.credential.providerId
          || input.credential.profileId !== binding.provider.credential.profileId
          || input.credential.model !== binding.provider.credential.model) {
          throw new Error(`live proposition credential differs from provider binding ${binding.provider.id}`)
        }
        if (sha256(input.request) !== input.requestDigest) throw new Error("live proposition request digest mismatch")
        await mkdir(artifactRoot, { recursive: true })
        await writeFile(evidencePath, "", { encoding: "utf8", mode: 0o600 })
        const environment = {
          ...createAllowlistedPropositionEnvironment(process.env, PROCESS_ENV_ALLOWLIST),
          AGENT: "codex",
          AGENT_TIMEOUT: String(input.timeoutSeconds),
          CODEX: path.resolve(binding.shimExecutable),
          CODUMENT: path.resolve(binding.codumentExecutable),
          EIDOLON_PROPOSITION_EVIDENCE: evidencePath,
          EIDOLON_PROPOSITION_EXECUTABLE: path.resolve(binding.eidolonExecutable),
          EIDOLON_PROPOSITION_MODE: input.mode,
          EIDOLON_PROPOSITION_PROVIDER_BINDING: binding.provider.id,
          EIDOLON_PROPOSITION_REQUEST_DIGEST: input.requestDigest,
          EIDOLON_PROPOSITION_RUN_ID: binding.runId,
          KEEP: "1",
          MODEL: input.credential.model,
          REPO: sourceRoot,
          WS: input.workspaceRoot,
          ...binding.scenario.runnerEnvironment,
        }
        const runner = contained(sourceRoot, binding.scenario.runnerRelativePath)
        const argv = ["bash", runner, ...(binding.scenario.runnerTaskArgument ? [binding.scenario.runnerTaskArgument] : [])]
        const child = await runChild({
          argv,
          cwd: sourceRoot,
          environment,
          timeoutSeconds: input.timeoutSeconds,
        })
        await Promise.all([
          writeFile(path.join(artifactRoot, "runner.stdout.log"), child.stdout, { encoding: "utf8", mode: 0o600 }),
          writeFile(path.join(artifactRoot, "runner.stderr.log"), child.stderr, { encoding: "utf8", mode: 0o600 }),
        ])
        const evidence = await parseShimEvidence(evidencePath).catch((error) => {
          throw new Error(`live source runner emitted no readable shim evidence: ${error instanceof Error ? error.message : String(error)}`)
        })
        if (evidence.length !== binding.scenario.expectedAgentInvocations) {
          throw new Error(`live scenario expected ${binding.scenario.expectedAgentInvocations} Agent invocation(s), observed ${evidence.length}`)
        }
        const identities = evidence.map((observed, index) => {
          if (observed.mode !== input.mode || observed.propositionRequestDigest !== input.requestDigest) {
            throw new Error(`live shim evidence ${index + 1} does not match the requested mode/proposition digest`)
          }
          if (observed.evidenceError || !observed.modeIdentity) {
            throw new Error(`live mode evidence ${index + 1} failed: ${observed.evidenceError ?? "identity missing"}`)
          }
          if (observed.modeIdentity.evidenceSource !== PROPOSITION_PUBLIC_EVENT_SOURCE) {
            throw new Error(`live mode identity ${index + 1} is not a public runtime projection`)
          }
          return observed.modeIdentity
        })
        return Object.freeze({
          identity: identities[0]!,
          identities: Object.freeze(identities),
          process: Object.freeze({
            exitCode: child.exitCode,
            status: child.timedOut ? "timed_out" as const : child.exitCode === 0 ? "completed" as const : "failed" as const,
            startedAt: child.startedAt,
            finishedAt: child.finishedAt,
            stdoutArtifact: `artifact://${binding.scenario.scenarioId}/${binding.mode}/${binding.runId}/runner.stdout.log`,
            stderrArtifact: `artifact://${binding.scenario.scenarioId}/${binding.mode}/${binding.runId}/runner.stderr.log`,
          }),
          providerTurns: Object.freeze(evidence.flatMap((item) => item.providerTurns)),
          providerAttempts: combineAttemptFacts(evidence),
        })
      },
    },
    verifier: {
      async run(input) {
        if (input.argv.length !== 1 || input.argv[0] !== binding.scenario.verifierRelativePath) {
          throw new Error("live verifier invocation does not match the frozen manifest")
        }
        const verifier = contained(sourceRoot, binding.scenario.verifierRelativePath)
        const environment = createAllowlistedPropositionEnvironment(process.env, PROCESS_ENV_ALLOWLIST)
        const verifierArgv = binding.scenario.verifierKind === "shell"
          ? ["bash", verifier, input.cwd, path.resolve(binding.codumentExecutable), ""]
          : await (async () => {
              const trackId = await detectTrackId(input.cwd)
              if (!trackId) return ["bun", verifier, input.cwd, "--track", "__missing__", "--out", path.join(input.cwd, "reports", "coordinator"), "--codument", path.resolve(binding.codumentExecutable)]
              return ["bun", verifier, input.cwd, "--track", trackId, "--out", path.join(input.cwd, "reports", "coordinator"), "--codument", path.resolve(binding.codumentExecutable)]
            })()
        const child = await runChild({
          argv: verifierArgv,
          cwd: input.cwd,
          environment,
          timeoutSeconds: input.timeoutSeconds,
        })
        const output = `${child.stdout}${child.stderr}`
        await writeFile(path.join(artifactRoot, "coordinator-verifier.log"), output, { encoding: "utf8", mode: 0o600 })
        return Object.freeze({
          exitCode: child.exitCode,
          passed: !child.timedOut && child.exitCode === 0,
          outputArtifact: `artifact://${binding.scenario.scenarioId}/${binding.mode}/${binding.runId}/coordinator-verifier.log`,
        })
      },
    },
    receiptStore: executableEpoch
      ? createExecutableEpochReceiptStore(receiptRoot, executableEpoch)
      : createJsonPropositionReceiptStore(receiptRoot),
  }
  return Object.freeze(runtime)
}

export async function runCodumentPropositionLiveCell(binding: CodumentPropositionLiveBinding): Promise<Readonly<{
  receipt: CodumentPropositionRunReceipt
  receiptRef: string
}>> {
  const [manifest, eidolonExecutableDigest, codumentExecutableDigest] = await Promise.all([
    buildCodumentPropositionLiveManifest({ sourceRoot: binding.sourceRoot, scenario: binding.scenario }),
    fileDigest(binding.eidolonExecutable),
    fileDigest(binding.codumentExecutable),
  ])
  const executableIntegrity: ExecutableEpochIntegrity = binding.executableEpoch ?? Object.freeze({
    eidolonExecutable: path.resolve(binding.eidolonExecutable),
    eidolonExecutableDigest,
    codumentExecutable: path.resolve(binding.codumentExecutable),
    codumentExecutableDigest,
  })
  if (executableIntegrity.eidolonExecutableDigest !== eidolonExecutableDigest
    || executableIntegrity.codumentExecutableDigest !== codumentExecutableDigest) {
    throw new Error("live proposition executable epoch does not match bound paths")
  }
  const receipt = await runCodumentPropositionCell({
    manifest,
    mode: binding.mode,
    runtime: createCodumentPropositionLiveRuntime(binding, executableIntegrity),
    credential: binding.provider.credential,
    eidolonExecutableDigest,
    codumentExecutableDigest,
  })
  const name = `${binding.mode}-${receipt.receiptDigest.replace(/^sha256:/, "")}.json`
  return Object.freeze({
    receipt,
    receiptRef: path.join(path.resolve(binding.executionRoot), binding.scenario.scenarioId, binding.mode, binding.runId, "receipts", name),
  })
}
