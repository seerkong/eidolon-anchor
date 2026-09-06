import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises"

import {
  canonicalHolonEffectiveSnapshotBytes,
  canonicalHolonEffectiveSnapshotIssuanceReceiptBytes,
  parseHolonEffectiveSnapshotBytes,
  parseHolonEffectiveSnapshotIssuanceReceiptBytes,
} from "holarchy-core-contract"
import {
  canonicalHolonDeploymentDefinitionBytes,
  canonicalHolonExecutionBindingBytes,
  normalizeHolonDeploymentDefinition,
  parseHolonDeploymentDefinitionBytes,
  parseHolonExecutionBindingBytes,
  type EidolonHolonExecutionBindingFreezeReceipt,
  type EidolonHolonExecutionBindingProjection,
  type HolonDeploymentDefinition,
} from "holarchy-eidolon-adapter"

import {
  EidolonAppResourceRegistryAdapter,
  type EidolonAgentResourceObservationClosure,
  type EidolonFrozenAgentExecutionBundle,
  type ResourcePackageLayerBinding,
} from "../resources/EidolonAppResourceRegistryAdapter"

export interface HolonDeploymentDefinitionRuntime {
  readonly supportRoot: string
  readonly resourceRegistry: EidolonAppResourceRegistryAdapter
  readonly capturedResources?: CapturedHolonDeploymentResources
}

export interface CapturedHolonDeploymentResources {
  readonly observation: EidolonAgentResourceObservationClosure
  readonly agents: readonly EidolonFrozenAgentExecutionBundle[]
  readonly workspaceInstructions: string | null
}

export async function captureHolonDeploymentResources(registry: EidolonAppResourceRegistryAdapter): Promise<CapturedHolonDeploymentResources> {
  const snapshot = await registry.snapshot()
  const observation = await registry.captureAgentResourceObservation(snapshot)
  const workspaceInstructions = observation.workspaceInstructions !== undefined
    ? observation.workspaceInstructions : registry.captureWorkspaceInstructions()
  const agents: EidolonFrozenAgentExecutionBundle[] = []
  for (const agent of snapshot.agentResources.agentDefinitions) {
    if (agent.materialPorts.length > 0) continue
    // Prefix sources intentionally execute on the original registry's workspace view once.
    const originalCode = await registry.compileAgentCodeExecutions(snapshot, agent.resource.resourceId)
    const bundle = await registry.captureFrozenAgentExecution(`resource://${agent.resource.resourceId}`, snapshot, originalCode, { workspaceInstructions })
    if (JSON.stringify(bundle.files) !== JSON.stringify(observation.files)) {
      throw new Error("EIDOLON_HOLON_DEPLOYMENT_CAPTURE_DRIFT")
    }
    agents.push(bundle)
  }
  return Object.freeze({ observation, agents: Object.freeze(agents), workspaceInstructions })
}

export interface HolonDeploymentDefinitionReadRuntime {
  readonly supportRoot: string
}

export interface HolonDeploymentDefinitionInput {
  readonly deploymentId: string
  readonly bindingRef: string
}

export interface HolonDeploymentDefinitionReadInput {
  readonly deploymentId: string
}

export type HolonDeploymentDefinitionConfig = Readonly<Record<string, never>>

export interface MaterializedHolonDeploymentDefinition {
  readonly definitionDir: string
  readonly definition: HolonDeploymentDefinition
  readonly bindingProjection: EidolonHolonExecutionBindingProjection
  readonly bindingFreezeReceipt: EidolonHolonExecutionBindingFreezeReceipt
  readonly resourceRegistry: EidolonAppResourceRegistryAdapter
  readonly materializeAgentExecutionPlan: EidolonAppResourceRegistryAdapter["materializeAgentExecutionPlan"]
}

export class HolonDeploymentDefinitionError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "HolonDeploymentDefinitionError"
  }
}

const DEFINITION_FILE = "definition.json"
const RESOURCE_OBSERVATION_FILE = "authority/resource-observation.json"
const AGENT_EXECUTIONS_FILE = "authority/agent-executions.json"
const WORKSPACE_INSTRUCTIONS_FILE = ".agent-resources/workspace-instructions.json"
const AUTHORITY_FILES = Object.freeze({
  snapshot: "authority/organization-snapshot.json",
  snapshotReceipt: "authority/organization-snapshot-receipt.json",
  binding: "authority/execution-binding.json",
  bindingFreezeReceipt: "authority/execution-binding-freeze-receipt.json",
})

const compareUtf16 = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

function invalid(code: string, message: string): never {
  throw new HolonDeploymentDefinitionError(code, message)
}

function exactIdentity(value: unknown, location: string): string {
  if (typeof value !== "string" || value !== value.trim()
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    return invalid("EIDOLON_HOLON_DEPLOYMENT_IDENTITY_INVALID", `${location} must be one portable identity.`)
  }
  return value
}

function exactInput<T extends "materialize" | "read">(
  value: unknown,
  kind: T,
): T extends "materialize" ? HolonDeploymentDefinitionInput : HolonDeploymentDefinitionReadInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    return invalid("EIDOLON_HOLON_DEPLOYMENT_INPUT_INVALID", "Deployment input must be one plain object.")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const expected = kind === "materialize" ? ["deploymentId", "bindingRef"] : ["deploymentId"]
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some((key) => typeof key !== "string")
    || keys.length !== expected.length
    || expected.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key))) {
    return invalid("EIDOLON_HOLON_DEPLOYMENT_INPUT_INVALID", "Deployment input has missing or unsupported fields.")
  }
  const output: Record<string, string> = Object.create(null)
  for (const key of expected) {
    const descriptor = descriptors[key]
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      return invalid("EIDOLON_HOLON_DEPLOYMENT_INPUT_INVALID", `Deployment input '${key}' must be enumerable own data.`)
    }
    output[key] = key === "deploymentId"
      ? exactIdentity(descriptor.value, key)
      : exactResourceRef(descriptor.value, key)
  }
  return Object.freeze(output) as unknown as T extends "materialize"
    ? HolonDeploymentDefinitionInput
    : HolonDeploymentDefinitionReadInput
}

function exactResourceRef(value: unknown, location: string): `resource://${string}` {
  if (typeof value !== "string" || value !== value.trim() || !value.startsWith("resource://")
    || !value.slice("resource://".length) || value.slice("resource://".length).includes("://")) {
    return invalid("EIDOLON_HOLON_DEPLOYMENT_RESOURCE_REF_INVALID", `${location} must be one exact resource:// identity.`)
  }
  return value as `resource://${string}`
}

function assertEmptyConfig(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).length !== 0) {
    invalid("EIDOLON_HOLON_DEPLOYMENT_CONFIG_INVALID", "Deployment config must be one closed empty object.")
  }
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

async function physicalDirectory(directory: string, location: string): Promise<string> {
  const facts = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return invalid("EIDOLON_HOLON_DEPLOYMENT_DIRECTORY_MISSING", `${location} does not exist.`)
    }
    throw error
  })
  if (!facts.isDirectory() || facts.isSymbolicLink()) {
    return invalid("EIDOLON_HOLON_DEPLOYMENT_DIRECTORY_INVALID", `${location} must be one physical directory.`)
  }
  return realpath(directory)
}

async function deploymentsRoot(supportRoot: string, create: boolean): Promise<string> {
  if (typeof supportRoot !== "string" || !path.isAbsolute(supportRoot)) {
    return invalid("EIDOLON_HOLON_DEPLOYMENT_SUPPORT_ROOT_INVALID", "supportRoot must be one absolute path.")
  }
  if (create) await mkdir(supportRoot, { recursive: true })
  const canonicalSupport = await physicalDirectory(supportRoot, "supportRoot")
  const expected = path.join(canonicalSupport, "holon-deployments")
  if (create) {
    try {
      await mkdir(expected)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }
  const canonicalDeployments = await physicalDirectory(expected, "holon-deployments root")
  if (!isContained(canonicalSupport, canonicalDeployments)) {
    return invalid("EIDOLON_HOLON_DEPLOYMENT_ROOT_OUTSIDE_SUPPORT", "holon-deployments root escapes supportRoot.")
  }
  return canonicalDeployments
}

async function readPhysicalFile(root: string, relative: string): Promise<Uint8Array> {
  const target = path.resolve(root, ...relative.split("/"))
  if (!isContained(root, target)) {
    return invalid("EIDOLON_HOLON_DEPLOYMENT_FILE_OUTSIDE_DEFINITION", `Definition file '${relative}' escapes its root.`)
  }
  const facts = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return invalid("EIDOLON_HOLON_DEPLOYMENT_FILE_MISSING", `Definition file '${relative}' is missing.`)
    }
    throw error
  })
  if (!facts.isFile() || facts.isSymbolicLink()) {
    return invalid("EIDOLON_HOLON_DEPLOYMENT_FILE_INVALID", `Definition file '${relative}' must be one physical regular file.`)
  }
  const canonical = await realpath(target)
  if (!isContained(root, canonical)) {
    return invalid("EIDOLON_HOLON_DEPLOYMENT_FILE_OUTSIDE_DEFINITION", `Definition file '${relative}' escapes its root.`)
  }
  return readFile(canonical)
}

async function writeDurableFile(target: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(target, "wx", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeCandidate(
  candidate: string,
  files: Readonly<Record<string, Uint8Array>>,
  definition: HolonDeploymentDefinition,
): Promise<void> {
  await mkdir(candidate)
  const directories = new Set<string>([candidate])
  for (const relative of Object.keys(files).sort(compareUtf16)) {
    const target = path.join(candidate, ...relative.split("/"))
    const parent = path.dirname(target)
    await mkdir(parent, { recursive: true })
    let current = parent
    while (isContained(candidate, current)) {
      directories.add(current)
      if (current === candidate) break
      current = path.dirname(current)
    }
    await writeDurableFile(target, files[relative]!)
  }
  await writeDurableFile(
    path.join(candidate, DEFINITION_FILE),
    canonicalHolonDeploymentDefinitionBytes(definition),
  )
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    await syncDirectory(directory)
  }
}

function layerBindings(definitionRoot: string, files: readonly { readonly path: string }[]): readonly ResourcePackageLayerBinding[] {
  const result: ResourcePackageLayerBinding[] = []
  for (const id of ["global", "workspace"] as const) {
    if (files.some((entry) => entry.path === `.agent-resources/${id}/manifest.xnl`)) {
      result.push(Object.freeze({ id, rootDir: path.join(definitionRoot, ".agent-resources", id) }))
    }
  }
  return Object.freeze(result)
}

async function loadDefinitionDirectory(
  definitionRoot: string,
  expectedDeploymentId: string,
): Promise<MaterializedHolonDeploymentDefinition> {
  const root = await physicalDirectory(definitionRoot, `deployment '${expectedDeploymentId}' definition`)
  const definition = parseHolonDeploymentDefinitionBytes(await readPhysicalFile(root, DEFINITION_FILE))
  if (definition.deploymentId !== expectedDeploymentId) {
    return invalid(
      "EIDOLON_HOLON_DEPLOYMENT_IDENTITY_MISMATCH",
      `Definition '${definition.deploymentId}' does not match requested deployment '${expectedDeploymentId}'.`,
    )
  }
  const material = new Map<string, Uint8Array>()
  for (const file of definition.files) {
    const bytes = await readPhysicalFile(root, file.path)
    if (bytes.byteLength !== file.sizeBytes || digest(bytes) !== file.digest) {
      return invalid("EIDOLON_HOLON_DEPLOYMENT_FILE_DIGEST_MISMATCH", `Definition file '${file.path}' failed full readback.`)
    }
    material.set(file.path, bytes)
  }

  const snapshotBytes = material.get(AUTHORITY_FILES.snapshot)!
  const snapshot = await parseHolonEffectiveSnapshotBytes(snapshotBytes)
  const snapshotReceiptBytes = material.get(AUTHORITY_FILES.snapshotReceipt)!
  const snapshotReceipt = parseHolonEffectiveSnapshotIssuanceReceiptBytes(snapshotReceiptBytes, snapshot)
  const bindingBytes = material.get(AUTHORITY_FILES.binding)!
  const binding = parseHolonExecutionBindingBytes(bindingBytes)

  const observationBytes = material.get(RESOURCE_OBSERVATION_FILE)
  const observation: EidolonAgentResourceObservationClosure | undefined = observationBytes
    ? JSON.parse(Buffer.from(observationBytes).toString("utf8")) : undefined
  if (observation && !material.has(WORKSPACE_INSTRUCTIONS_FILE)) throw new Error("EIDOLON_HOLON_DEPLOYMENT_CAPTURE_INCOMPLETE")
  const registry = observation
    ? await EidolonAppResourceRegistryAdapter.restoreAgentResourceObservation(observation, {
      frozenWorkspaceInstructions: EidolonAppResourceRegistryAdapter.loadFrozenWorkspaceInstructions(root),
    })
    : new EidolonAppResourceRegistryAdapter({ layers: layerBindings(root, definition.files) })
  const executionBytes = material.get(AGENT_EXECUTIONS_FILE)
  if (Boolean(observationBytes) !== Boolean(executionBytes)) throw new Error("EIDOLON_HOLON_DEPLOYMENT_CAPTURE_INCOMPLETE")
  const agents: readonly EidolonFrozenAgentExecutionBundle[] = executionBytes ? JSON.parse(Buffer.from(executionBytes).toString("utf8")) : []
  if (observation) {
    for (const [relative, encoded] of Object.entries(observation.files)) {
      const bytes = material.get(relative)
      if (!bytes || !sameBytes(bytes, Buffer.from(encoded, "base64"))) throw new Error("EIDOLON_HOLON_DEPLOYMENT_RESOURCE_BYTES_MISMATCH")
    }
    if (new Set(agents.map(agent => agent.agentDefinitionRef)).size !== agents.length) throw new Error("EIDOLON_HOLON_DEPLOYMENT_AGENT_DUPLICATE")
    for (const agent of agents) {
      if (!sameBytes(canonicalJsonBytes(agent.files), canonicalJsonBytes(observation.files))
        || !sameBytes(canonicalJsonBytes(agent.layers), canonicalJsonBytes(observation.layers))) {
        throw new Error("EIDOLON_HOLON_DEPLOYMENT_AGENT_SOURCE_MISMATCH")
      }
    }
  }
  const executions = new Map(await Promise.all(agents.map(async bundle => [bundle.agentDefinitionRef,
    await EidolonAppResourceRegistryAdapter.restoreFrozenAgentExecution(bundle)] as const)))
  const registrySnapshot = await registry.snapshot()
  const projection = registrySnapshot.holonExecutionBindings.find(
    (candidate) => candidate.binding.bindingRef === definition.bindingRef,
  )
  if (!projection) {
    return invalid("EIDOLON_HOLON_DEPLOYMENT_BINDING_MISSING", `Frozen binding '${definition.bindingRef}' is not in the deployment closure.`)
  }
  const freezeReceipt = await registry.freezeHolonExecutionBinding(definition.bindingRef, registrySnapshot)
  const expectedFacts = [
    [definition.rootHolonRef, projection.snapshot.rootHolonRef, "root Holon"],
    [definition.snapshotRef, projection.binding.snapshotRef, "snapshot ref"],
    [definition.registryRevision, registrySnapshot.registryRevision, "registry revision"],
    [definition.snapshotTreeDigest, projection.snapshot.treeDigest, "snapshot tree digest"],
    [definition.snapshotReceiptDigest, projection.receiptBytesDigest, "snapshot receipt digest"],
    [definition.bindingBytesDigest, projection.bindingBytesDigest, "binding bytes digest"],
    [definition.bindingSemanticFingerprint, freezeReceipt.semanticFingerprint, "binding semantic fingerprint"],
  ] as const
  for (const [expected, actual, label] of expectedFacts) {
    if (expected !== actual) {
      return invalid("EIDOLON_HOLON_DEPLOYMENT_AUTHORITY_MISMATCH", `Frozen ${label} does not match definition authority.`)
    }
  }
  const canonicalProjectionSnapshot = await canonicalHolonEffectiveSnapshotBytes(projection.snapshot)
  const canonicalProjectionReceipt = canonicalHolonEffectiveSnapshotIssuanceReceiptBytes(
    projection.receipt,
    projection.snapshot,
  )
  if (!sameBytes(snapshotBytes, canonicalProjectionSnapshot)
    || !sameBytes(snapshotReceiptBytes, canonicalProjectionReceipt)
    || !sameBytes(bindingBytes, canonicalHolonExecutionBindingBytes(projection.binding))
    || binding.bindingRef !== projection.binding.bindingRef
    || snapshot.snapshotId !== projection.snapshot.snapshotId
    || snapshotReceipt.treeDigest !== projection.receipt.treeDigest
    || !sameBytes(
      material.get(AUTHORITY_FILES.bindingFreezeReceipt)!,
      canonicalJsonBytes(freezeReceipt),
    )) {
    return invalid("EIDOLON_HOLON_DEPLOYMENT_AUTHORITY_BYTES_MISMATCH", "Frozen authority bytes do not match reconstructed registry authority.")
  }
  return Object.freeze({
    definitionDir: root,
    definition,
    bindingProjection: projection,
    bindingFreezeReceipt: freezeReceipt,
    resourceRegistry: registry,
    materializeAgentExecutionPlan: async (ref: string, options: Parameters<EidolonAppResourceRegistryAdapter["materializeAgentExecutionPlan"]>[1]) => {
      const execution = executions.get(ref as `resource://${string}`)
      if (!execution) throw new Error(`EIDOLON_HOLON_DEPLOYMENT_FROZEN_AGENT_MISSING: ${ref}`)
      return execution.materializeAgentExecutionPlan(ref, options)
    },
  })
}

export async function materializeHolonDeploymentDefinition(
  runtime: HolonDeploymentDefinitionRuntime,
  input: HolonDeploymentDefinitionInput,
  config: HolonDeploymentDefinitionConfig,
): Promise<MaterializedHolonDeploymentDefinition> {
  assertEmptyConfig(config)
  const request = exactInput(input, "materialize")
  if (!runtime || typeof runtime !== "object" || !(runtime.resourceRegistry instanceof EidolonAppResourceRegistryAdapter)) {
    return invalid("EIDOLON_HOLON_DEPLOYMENT_RUNTIME_INVALID", "Materialization requires the shared resource registry runtime.")
  }
  const root = await deploymentsRoot(runtime.supportRoot, true)
  const registrySnapshot = await runtime.resourceRegistry.snapshot()
  const projection = registrySnapshot.holonExecutionBindings.find(
    (candidate) => candidate.binding.bindingRef === request.bindingRef,
  )
  if (!projection) {
    return invalid("EIDOLON_HOLON_DEPLOYMENT_BINDING_MISSING", `Binding '${request.bindingRef}' is not in the admitted registry.`)
  }
  const freezeReceipt = await runtime.resourceRegistry.freezeHolonExecutionBinding(
    request.bindingRef,
    registrySnapshot,
  )
  const captured = runtime.capturedResources ?? await captureHolonDeploymentResources(runtime.resourceRegistry)
  const authorityFiles: Record<string, Uint8Array> = {
    [AUTHORITY_FILES.snapshot]: await canonicalHolonEffectiveSnapshotBytes(projection.snapshot),
    [AUTHORITY_FILES.snapshotReceipt]: canonicalHolonEffectiveSnapshotIssuanceReceiptBytes(
      projection.receipt,
      projection.snapshot,
    ),
    [AUTHORITY_FILES.binding]: canonicalHolonExecutionBindingBytes(projection.binding),
    [AUTHORITY_FILES.bindingFreezeReceipt]: canonicalJsonBytes(freezeReceipt),
    [RESOURCE_OBSERVATION_FILE]: canonicalJsonBytes(captured.observation),
    [AGENT_EXECUTIONS_FILE]: canonicalJsonBytes(captured.agents),
    [WORKSPACE_INSTRUCTIONS_FILE]: canonicalJsonBytes({ schemaVersion: "eidolon.frozen-workspace-instructions/v1", instructions: captured.workspaceInstructions }),
  }
  for (const [relative, content] of Object.entries(captured.observation.files)) {
    authorityFiles[relative] = Buffer.from(content, "base64")
  }
  const definition = normalizeHolonDeploymentDefinition({
    schemaVersion: "eidolon.holon-deployment-definition/v1",
    deploymentId: request.deploymentId,
    rootHolonRef: projection.snapshot.rootHolonRef,
    bindingRef: projection.binding.bindingRef,
    snapshotRef: projection.binding.snapshotRef,
    registryRevision: registrySnapshot.registryRevision,
    snapshotTreeDigest: projection.snapshot.treeDigest,
    snapshotReceiptDigest: projection.receiptBytesDigest,
    bindingBytesDigest: projection.bindingBytesDigest,
    bindingSemanticFingerprint: freezeReceipt.semanticFingerprint,
    files: Object.entries(authorityFiles).map(([filePath, bytes]) => ({
      path: filePath,
      digest: digest(bytes),
      sizeBytes: bytes.byteLength,
    })),
  })
  const live = path.join(root, request.deploymentId, "definition")
  try {
    const existing = await loadDefinitionDirectory(live, request.deploymentId)
    if (!sameBytes(
      canonicalHolonDeploymentDefinitionBytes(existing.definition),
      canonicalHolonDeploymentDefinitionBytes(definition),
    )) {
      return invalid("EIDOLON_HOLON_DEPLOYMENT_DEFINITION_CONFLICT", `Deployment '${request.deploymentId}' already has a different frozen definition.`)
    }
    return existing
  } catch (error) {
    if (!(error instanceof HolonDeploymentDefinitionError)
      || error.code !== "EIDOLON_HOLON_DEPLOYMENT_DIRECTORY_MISSING") throw error
  }

  const deploymentRoot = path.join(root, request.deploymentId)
  try {
    await mkdir(deploymentRoot)
    await syncDirectory(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    await physicalDirectory(deploymentRoot, `deployment '${request.deploymentId}'`)
  }
  const candidate = path.join(deploymentRoot, `.definition-candidate-${randomUUID()}`)
  try {
    await writeCandidate(candidate, authorityFiles, definition)
    await loadDefinitionDirectory(candidate, request.deploymentId)
    try {
      await rename(candidate, live)
      await syncDirectory(deploymentRoot)
    } catch (error) {
      if (!new Set(["EEXIST", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error
    }
    const admitted = await loadDefinitionDirectory(live, request.deploymentId)
    if (!sameBytes(
      canonicalHolonDeploymentDefinitionBytes(admitted.definition),
      canonicalHolonDeploymentDefinitionBytes(definition),
    )) {
      return invalid("EIDOLON_HOLON_DEPLOYMENT_DEFINITION_CONFLICT", `Deployment '${request.deploymentId}' won a conflicting definition race.`)
    }
    return admitted
  } finally {
    await rm(candidate, { recursive: true, force: true })
  }
}

export async function loadHolonDeploymentDefinition(
  runtime: HolonDeploymentDefinitionReadRuntime,
  input: HolonDeploymentDefinitionReadInput,
  config: HolonDeploymentDefinitionConfig,
): Promise<MaterializedHolonDeploymentDefinition> {
  assertEmptyConfig(config)
  const request = exactInput(input, "read")
  const root = await deploymentsRoot(runtime.supportRoot, false)
  return loadDefinitionDirectory(
    path.join(root, request.deploymentId, "definition"),
    request.deploymentId,
  )
}
