import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { AIWorkflowProfileDurableState, FlowClosedValue } from "ai-workflow-contract"
import type { AIDataWorkflowRunGraph } from "ai-data-workflow-contract"
import {
  applyAIDataWorkflowGraphPatch,
  commitAIDataWorkflowCheckpoint,
  createAIDataWorkflowCheckpoint,
  createAIDataWorkflowRunGraph,
  loadAIDataWorkflowCheckpoint,
  recordAIDataWorkflowNodeResult,
  restoreAIDataWorkflowRunGraph,
} from "ai-data-workflow-logic"
import { normalizeFlowClosedValue } from "ai-workflow-logic"
import {
  convertLegacyWorkCtrlSnapshotToCheckpoint,
  importLegacyWorkCtrlSnapshot,
  type LegacyWorkCtrlSnapshotRead,
} from "ai-workflow-logic/checkpoint-filesystem"
import { computeFlowBundleDigest } from "work-ctrl-flow-logic"
import type { WorkCtrlFlowSnapshot } from "work-ctrl-flow-contract"
import type { WorkflowDepaPersistence } from "./WorkflowDepaPersistence"
import { EMPTY_AI_WORKFLOW_DURABLE_STATE } from "./WorkflowDepaPersistence"
import type { WorkflowDefinitionRevision } from "./WorkflowLifecycleFacts"
import type { WorkflowDefinitionResourceReceipt } from "./WorkflowLifecycleFacts"

type InventoryClassification = "canonical-input" | "derived-evidence" | "read-only-evidence"

export type WorkflowLegacyInventoryEntry = Readonly<{
  kind: string
  logicalPath: string
  digest: `sha256:${string}`
  classification: InventoryClassification
}>

export type WorkflowLegacyMigrationAttempt = Readonly<{
  schemaVersion: "eidolon.workflow-legacy-migration-attempt/v1"
  sourceInventoryDigest: `sha256:${string}`
  target: Readonly<{ instanceId: string; runId: string }>
  legacyRunId: string
  profileKind: "AICtrlWorkflow" | "AIDataWorkflow"
  stage: "inventoried" | "instance-admitted" | "checkpoint-admitted"
  inventory: readonly WorkflowLegacyInventoryEntry[]
}>

export type WorkflowLegacyMigrationReceipt = Readonly<{
  schemaVersion: "eidolon.workflow-legacy-migration-receipt/v1"
  sourceInventoryDigest: `sha256:${string}`
  target: Readonly<{ instanceId: string; runId: string }>
  legacyRunId: string
  profileKind: "AICtrlWorkflow" | "AIDataWorkflow"
  acceptedCheckpointVersion: number
  acceptedCheckpointDigest: `sha256:${string}`
  inventory: readonly WorkflowLegacyInventoryEntry[]
}>

type LegacyDescriptor = {
  runId: string
  form: "AICtrlWorkflow" | "AIDataWorkflow"
  workflowRef: string
  generation: number
  instanceId: string
  definitionRevision: string
  requestFingerprint: string
  frozenInput: FlowClosedValue
  frozenBindings: FlowClosedValue
}

type InventoryFile = { logicalPath: string; bytes: Buffer }
type LegacyMaterialBindingRef = { bindingId: string; materialRef: string; revision: string }
type PreparedLegacyData = { legacy: AIDataWorkflowRunGraph; transitions: readonly AIDataWorkflowRunGraph[] }
type HeldMigrationLock = { file: string; fd: number; token: string; device: number; inode: number }
type MigrationLockOwner = { token: string; pid: number; createdAtMs: number; device: number; inode: number }

const SHA256 = /^sha256:[a-f0-9]{64}$/
const EMPTY_AI: AIWorkflowProfileDurableState = EMPTY_AI_WORKFLOW_DURABLE_STATE

function digestBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, nested]) => [key, stableValue(nested)]))
}

function digestValue(value: unknown): `sha256:${string}` {
  return digestBytes(Buffer.from(JSON.stringify(stableValue(value)), "utf8"))
}

function safeSegment(value: string, label: string): string {
  if (!value || value !== value.trim() || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new Error(`${label} must be one safe path segment`)
  }
  return value
}

function safeLegacyId(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "_")
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  normalizeFlowClosedValue(value, label)
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be a closed object`)
  const record = value as Record<string, unknown>
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(record)) if (!allowed.has(key)) throw new Error(`${label}.${key} is not part of the closed contract`)
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(record, key)) throw new Error(`${label}.${key} is required`)
  return record
}

function identity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) throw new Error(`${label} must be a non-empty identity`)
  return value
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`)
  return value
}

function normalizeResourceReceipt(value: unknown, form: LegacyDescriptor["form"]): WorkflowDefinitionResourceReceipt {
  const record = exactRecord(value, [
    "schemaVersion", "resourceId", "kind", "packageId", "layerId", "logicalPath",
    "compositionRevision", "registryRevision", "authorityDigest", "contentDigest",
  ], [], "legacy.definition.resourceReceipt")
  if (record.schemaVersion !== "eidolon.workflow-definition-resource-receipt/v1") throw new Error("legacy definition resource receipt schema is invalid")
  if (record.kind !== form) throw new Error("legacy definition resource receipt kind differs")
  return {
    schemaVersion: "eidolon.workflow-definition-resource-receipt/v1",
    resourceId: identity(record.resourceId, "legacy.definition.resourceReceipt.resourceId"),
    kind: form,
    packageId: identity(record.packageId, "legacy.definition.resourceReceipt.packageId"),
    layerId: identity(record.layerId, "legacy.definition.resourceReceipt.layerId"),
    logicalPath: identity(record.logicalPath, "legacy.definition.resourceReceipt.logicalPath"),
    compositionRevision: identity(record.compositionRevision, "legacy.definition.resourceReceipt.compositionRevision"),
    registryRevision: identity(record.registryRevision, "legacy.definition.resourceReceipt.registryRevision"),
    authorityDigest: identity(record.authorityDigest, "legacy.definition.resourceReceipt.authorityDigest"),
    contentDigest: identity(record.contentDigest, "legacy.definition.resourceReceipt.contentDigest"),
  }
}

function normalizeDescriptor(value: unknown): LegacyDescriptor {
  const record = exactRecord(value, [
    "runId", "form", "workflowRef", "bundlePath", "createdAt", "generation", "instanceId",
    "definitionRevision", "requestFingerprint", "frozenInput", "frozenBindings",
  ], ["replayOf"], "legacy.runDescriptor")
  const form = record.form
  if (form !== "AICtrlWorkflow" && form !== "AIDataWorkflow") throw new Error("legacy.runDescriptor.form is invalid")
  const generation = record.generation
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) throw new Error("legacy.runDescriptor.generation is invalid")
  identity(record.bundlePath, "legacy.runDescriptor.bundlePath")
  timestamp(record.createdAt, "legacy.runDescriptor.createdAt")
  return {
    runId: identity(record.runId, "legacy.runDescriptor.runId"),
    form,
    workflowRef: identity(record.workflowRef, "legacy.runDescriptor.workflowRef"),
    generation,
    instanceId: identity(record.instanceId, "legacy.runDescriptor.instanceId"),
    definitionRevision: identity(record.definitionRevision, "legacy.runDescriptor.definitionRevision"),
    requestFingerprint: identity(record.requestFingerprint, "legacy.runDescriptor.requestFingerprint"),
    frozenInput: normalizeFlowClosedValue(record.frozenInput, "legacy.runDescriptor.frozenInput"),
    frozenBindings: normalizeFlowClosedValue(record.frozenBindings, "legacy.runDescriptor.frozenBindings"),
  }
}

function normalizeMaterialBindingRefs(value: FlowClosedValue, instanceId: string): readonly LegacyMaterialBindingRef[] {
  if (!Array.isArray(value)) throw new Error("legacy.runDescriptor.frozenBindings must be an array")
  return value.map((item, index) => {
    const label = `legacy.runDescriptor.frozenBindings[${index}]`
    const record = exactRecord(item, ["bindingId", "instanceId", "nodeId", "port", "material", "createdAt"], [], label)
    if (identity(record.instanceId, `${label}.instanceId`) !== instanceId) throw new Error(`${label}.instanceId differs from run authority`)
    identity(record.nodeId, `${label}.nodeId`)
    identity(record.port, `${label}.port`)
    timestamp(record.createdAt, `${label}.createdAt`)
    const material = exactRecord(record.material, ["materialRef", "revision"], [], `${label}.material`)
    return {
      bindingId: identity(record.bindingId, `${label}.bindingId`),
      materialRef: identity(material.materialRef, `${label}.material.materialRef`),
      revision: identity(material.revision, `${label}.material.revision`),
    }
  })
}

function normalizeDefinition(value: unknown, revision: string): WorkflowDefinitionRevision {
  const record = exactRecord(value, [
    "revision", "workflowRef", "fqn", "form", "sourceBundlePath", "files", "createdAt",
  ], ["resourceReceipt"], "legacy.definition")
  if (identity(record.revision, "legacy.definition.revision") !== revision) throw new Error("legacy definition revision identity differs")
  const form = record.form
  if (form !== "AICtrlWorkflow" && form !== "AIDataWorkflow") throw new Error("legacy.definition.form is invalid")
  const files = exactRecord(record.files, [], Object.keys(record.files as Record<string, unknown>), "legacy.definition.files")
  for (const [filePath, content] of Object.entries(files)) {
    if (path.isAbsolute(filePath) || filePath.split(/[\\/]/).some((part) => !part || part === "..") || typeof content !== "string") {
      throw new Error(`legacy.definition.files.${filePath} is invalid`)
    }
  }
  return {
    revision,
    workflowRef: identity(record.workflowRef, "legacy.definition.workflowRef"),
    fqn: identity(record.fqn, "legacy.definition.fqn"),
    form,
    sourceBundlePath: identity(record.sourceBundlePath, "legacy.definition.sourceBundlePath"),
    files: files as Record<string, string>,
    ...(record.resourceReceipt === undefined ? {} : { resourceReceipt: normalizeResourceReceipt(record.resourceReceipt, form) }),
    createdAt: timestamp(record.createdAt, "legacy.definition.createdAt"),
  }
}

function checkpointStatus(graph: AIDataWorkflowRunGraph): "Pending" | "Running" | "Succeeded" | "Failed" {
  const nodes = Object.values(graph.nodes).filter((node) => node.status !== "Removed")
  if (nodes.some((node) => node.status === "Failed")) return "Failed"
  if (nodes.some((node) => node.status === "Running")) return "Running"
  if (nodes.length > 0 && nodes.every((node) => node.status === "Succeeded" || node.status === "Reused")) return "Succeeded"
  return "Pending"
}

function durableGraph(graph: AIDataWorkflowRunGraph): AIDataWorkflowRunGraph {
  const { baseUri: _baseUri, ...definition } = graph.binding.definition
  return { ...graph, binding: { ...graph.binding, definition } }
}

function nodeSidecars(graph: AIDataWorkflowRunGraph): Record<string, FlowClosedValue> {
  return Object.fromEntries(graph.declarationOrder.map((nodeId) => [nodeId, {
    status: graph.nodes[nodeId]!.status,
    generation: graph.nodes[nodeId]!.generation,
  }]))
}

function checkpointOutput(graph: AIDataWorkflowRunGraph): FlowClosedValue {
  if (checkpointStatus(graph) !== "Succeeded") return null
  const result = graph.declarationOrder.map((nodeId) => graph.nodes[nodeId]).find((node) => node?.tag === "ReturnNode")?.result
  return result?.output === undefined ? null : normalizeFlowClosedValue(result.output, "legacy.data.output")
}

/** One-way runtime-root migration. Legacy files are inventory inputs and are never mutated. */
export class WorkflowLegacyMigration {
  readonly #realRoot: string

  constructor(
    readonly root: string,
    readonly depa: WorkflowDepaPersistence,
  ) {
    const absolute = path.resolve(root)
    const stat = fs.lstatSync(absolute)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("legacy runtime root must be a physical directory")
    this.root = absolute
    this.#realRoot = fs.realpathSync(absolute)
  }

  async migrate(input: {
    legacyRunId: string
    targetInstanceId: string
    targetRunId: string
  }): Promise<WorkflowLegacyMigrationReceipt> {
    const target = {
      instanceId: safeSegment(input.targetInstanceId, "targetInstanceId"),
      runId: safeSegment(input.targetRunId, "targetRunId"),
    }
    const lock = await this.acquireLock(target)
    try {
      return await this.migrateLocked(input, target)
    } finally {
      this.releaseLock(lock)
    }
  }

  private async migrateLocked(
    input: { legacyRunId: string; targetInstanceId: string; targetRunId: string },
    target: { instanceId: string; runId: string },
  ): Promise<WorkflowLegacyMigrationReceipt> {
    const legacyRunId = identity(input.legacyRunId, "legacyRunId")
    const descriptorFile = this.readRequiredFile(`runs/${safeLegacyId(legacyRunId)}.json`)
    const descriptor = normalizeDescriptor(JSON.parse(descriptorFile.bytes.toString("utf8")))
    if (descriptor.runId !== legacyRunId) throw new Error("legacy descriptor run identity differs")
    const definitionFile = this.readRequiredFile(`definition-revisions/${safeLegacyId(descriptor.definitionRevision)}.json`)
    const definition = normalizeDefinition(JSON.parse(definitionFile.bytes.toString("utf8")), descriptor.definitionRevision)
    if (definition.form !== descriptor.form || definition.workflowRef !== descriptor.workflowRef) {
      throw new Error("legacy descriptor and definition authority differ")
    }
    const inventoryFiles = this.inventoryFiles(descriptor, descriptorFile, definitionFile)
    const inventory = inventoryFiles.map((file) => this.inventoryEntry(file, descriptor))
    const sourceInventoryDigest = digestValue(inventory.map((entry) => [entry.logicalPath, entry.digest]))
    const receiptFile = this.migrationFile(target, "completion.json")
    const completedValue = this.readOptionalJson(receiptFile)
    const completed = completedValue === undefined ? undefined : this.normalizeReceipt(completedValue)
    if (completed) {
      this.assertReceipt(completed, sourceInventoryDigest, target, legacyRunId, descriptor.form, inventory)
      const checkpoint = await this.depa.checkpointRuntime.checkpointStore.load(target)
      if (!checkpoint || digestValue(checkpoint) !== completed.acceptedCheckpointDigest
        || checkpoint.version !== completed.acceptedCheckpointVersion) {
        throw new Error("legacy migration completion receipt differs from canonical checkpoint authority")
      }
      return completed
    }
    const attemptFile = this.migrationFile(target, "attempt.json")
    const priorAttemptValue = this.readOptionalJson(attemptFile)
    const priorAttempt = priorAttemptValue === undefined ? undefined : this.normalizeAttempt(priorAttemptValue)
    if (priorAttempt) this.assertAttempt(priorAttempt, sourceInventoryDigest, target, legacyRunId, descriptor.form, inventory)
    else this.writeJsonAtomic(attemptFile, {
      schemaVersion: "eidolon.workflow-legacy-migration-attempt/v1",
      sourceInventoryDigest,
      target,
      legacyRunId,
      profileKind: descriptor.form,
      stage: "inventoried",
      inventory,
    } satisfies WorkflowLegacyMigrationAttempt)

    const bundleRoot = this.contained(`definition-bundles/${safeLegacyId(descriptor.definitionRevision)}`)
    this.requirePhysicalDirectory(bundleRoot)
    const config = { legacyRequestFingerprint: descriptor.requestFingerprint }
    let ctrlRead: LegacyWorkCtrlSnapshotRead | undefined
    let preparedData: PreparedLegacyData | undefined
    const definitionIdentity = {
      revision: definition.revision,
      digest: computeFlowBundleDigest(bundleRoot),
      provenance: {
        authority: "eidolon.workflow-definition-repository",
        artifactRef: definition.workflowRef,
      },
    } as const
    if (descriptor.form === "AICtrlWorkflow") {
      const ctrl = this.readRequiredFile(`ctrl/${safeLegacyId(legacyRunId)}.json`)
      const snapshot = JSON.parse(ctrl.bytes.toString("utf8")) as WorkCtrlFlowSnapshot
      convertLegacyWorkCtrlSnapshotToCheckpoint(snapshot, { target, definition: definitionIdentity, config })
      ctrlRead = { identity: { treeId: legacyRunId, digest: digestBytes(ctrl.bytes) }, snapshot }
    } else {
      preparedData = this.prepareData(descriptor, target)
    }
    const admitted = this.depa.materialize(target.instanceId, definition, bundleRoot, () => undefined)
    this.writeAttempt(attemptFile, sourceInventoryDigest, target, legacyRunId, descriptor.form, inventory, "instance-admitted")
    if (descriptor.form === "AICtrlWorkflow") {
      await importLegacyWorkCtrlSnapshot({
        checkpointStore: this.depa.checkpointStore,
        legacyReader: { read: async (treeId) => treeId === legacyRunId ? ctrlRead : undefined },
      }, {
        legacyTreeId: legacyRunId,
        target,
        definition: admitted.descriptor.definition,
        config,
      })
    } else {
      await this.importData(descriptor, target, admitted.descriptor.definition, config, preparedData!)
    }
    this.writeAttempt(attemptFile, sourceInventoryDigest, target, legacyRunId, descriptor.form, inventory, "checkpoint-admitted")
    const checkpoint = await this.depa.checkpointRuntime.checkpointStore.load(target)
    if (!checkpoint) throw new Error("canonical checkpoint missing after migration admission")
    const finalInventory = this.inventoryFiles(descriptor, descriptorFile, definitionFile)
      .map((file) => this.inventoryEntry(file, descriptor))
    if (digestValue(finalInventory.map((entry) => [entry.logicalPath, entry.digest])) !== sourceInventoryDigest) {
      throw new Error("legacy source inventory changed before migration completion")
    }
    const receipt: WorkflowLegacyMigrationReceipt = {
      schemaVersion: "eidolon.workflow-legacy-migration-receipt/v1",
      sourceInventoryDigest,
      target,
      legacyRunId,
      profileKind: descriptor.form,
      acceptedCheckpointVersion: checkpoint.version,
      acceptedCheckpointDigest: digestValue(checkpoint),
      inventory,
    }
    this.writeJsonAtomic(receiptFile, receipt, true)
    const readback = this.normalizeReceipt(this.readOptionalJson(receiptFile))
    if (digestValue(readback) !== digestValue(receipt)) throw new Error("legacy migration receipt readback differs")
    return receipt
  }

  readReceipt(target: { instanceId: string; runId: string }): WorkflowLegacyMigrationReceipt | undefined {
    const expected = this.normalizeTarget(target, "migration.receipt.requestedTarget")
    const value = this.readOptionalJson(this.migrationFile(expected, "completion.json"))
    if (value === undefined) return undefined
    const receipt = this.normalizeReceipt(value)
    if (receipt.target.instanceId !== expected.instanceId || receipt.target.runId !== expected.runId) {
      throw new Error("migration receipt target differs from its requested identity")
    }
    return receipt
  }

  private async importData(
    descriptor: LegacyDescriptor,
    target: { instanceId: string; runId: string },
    definition: Parameters<typeof createAIDataWorkflowCheckpoint>[1]["definition"],
    config: FlowClosedValue,
    prepared: PreparedLegacyData,
  ): Promise<void> {
    if (descriptor.runId !== target.runId) throw new Error("legacy Data migration requires the target run identity to remain unchanged")
    const { legacy, transitions } = prepared
    const existing = await loadAIDataWorkflowCheckpoint(this.depa.checkpointRuntime, target)
    if (existing) {
      if (digestValue(existing.profile.runGraph) !== digestValue(durableGraph(legacy))) throw new Error("legacy Data target contains conflicting canonical facts")
      return
    }
    let accepted = await createAIDataWorkflowCheckpoint(this.depa.checkpointRuntime, {
      instanceId: target.instanceId,
      definition,
      graph: durableGraph(transitions[0]!),
      input: descriptor.frozenInput,
      config,
      state: { status: "Pending", generation: 0 },
      output: null,
      controllerSidecars: { status: "Pending" },
      nodeSidecars: nodeSidecars(transitions[0]!),
      ai: EMPTY_AI,
    })
    for (const transition of transitions.slice(1)) accepted = await this.commitData(accepted, transition)
    if (digestValue(accepted.profile.runGraph) !== digestValue(durableGraph(legacy))) {
      throw new Error("legacy Data graph cannot be represented by the canonical transition contract")
    }
  }

  private prepareData(descriptor: LegacyDescriptor, target: { instanceId: string; runId: string }): PreparedLegacyData {
    if (descriptor.runId !== target.runId) throw new Error("legacy Data migration requires the target run identity to remain unchanged")
    const source = this.readRequiredFile(`data-graphs/${safeLegacyId(descriptor.runId)}.json`)
    const legacy = restoreAIDataWorkflowRunGraph(JSON.parse(source.bytes.toString("utf8")) as AIDataWorkflowRunGraph)
    let graph = createAIDataWorkflowRunGraph({ binding: legacy.binding, runId: target.runId })
    const transitions: AIDataWorkflowRunGraph[] = [graph]
    for (const patch of legacy.patchHistory) graph = applyAIDataWorkflowGraphPatch(graph, patch)
    if (legacy.patchHistory.length > 0) transitions.push(graph)
    for (const nodeId of graph.declarationOrder) {
      const result = legacy.nodes[nodeId]?.result
      if (!result) continue
      graph = recordAIDataWorkflowNodeResult(graph, nodeId, result)
      transitions.push(graph)
    }
    if (digestValue(durableGraph(graph)) !== digestValue(durableGraph(legacy))) {
      throw new Error("legacy Data graph cannot be represented by the canonical transition contract")
    }
    return { legacy, transitions }
  }

  private commitData(
    current: Awaited<ReturnType<typeof createAIDataWorkflowCheckpoint>>,
    graph: AIDataWorkflowRunGraph,
  ) {
    const status = checkpointStatus(graph)
    return commitAIDataWorkflowCheckpoint(this.depa.checkpointRuntime, {
      expectedVersion: current.version,
      checkpoint: {
        ...current,
        version: current.version + 1,
        state: { status, generation: graph.currentGeneration },
        output: checkpointOutput(graph),
        controllerSidecars: { status },
        nodeSidecars: nodeSidecars(graph),
        profile: { ...current.profile, runGraph: durableGraph(graph) },
      },
    })
  }

  private inventoryFiles(descriptor: LegacyDescriptor, descriptorFile: InventoryFile, definitionFile: InventoryFile): InventoryFile[] {
    const files = [descriptorFile, definitionFile]
    this.collectDirectory(`definition-bundles/${safeLegacyId(descriptor.definitionRevision)}`, files)
    for (const logical of [
      `instances/${safeLegacyId(descriptor.instanceId)}.json`,
      `ctrl/${safeLegacyId(descriptor.runId)}.json`,
      `data-graphs/${safeLegacyId(descriptor.runId)}.json`,
      `events/${safeLegacyId(descriptor.runId)}.jsonl`,
      `run-receipts/${safeLegacyId(descriptor.runId)}.json`,
    ]) {
      const file = this.readOptionalFile(logical)
      if (file) files.push(file)
    }
    this.collectDirectory(`ai-state/${safeLegacyId(descriptor.runId)}`, files)
    this.collectDirectory(`agent-executions/${safeLegacyId(descriptor.runId)}`, files)
    for (const binding of normalizeMaterialBindingRefs(descriptor.frozenBindings, descriptor.instanceId)) {
      for (const logical of [
        `material-bindings/${safeLegacyId(binding.bindingId)}.json`,
        `material-revisions/${safeLegacyId(binding.materialRef)}/${safeLegacyId(binding.revision)}.json`,
      ]) {
        const file = this.readOptionalFile(logical)
        if (file) files.push(file)
      }
      this.collectDirectory(`material-content/${safeLegacyId(binding.revision)}`, files)
    }
    return files.sort((left, right) => compareCodeUnits(left.logicalPath, right.logicalPath))
  }

  private inventoryEntry(file: InventoryFile, descriptor: LegacyDescriptor): WorkflowLegacyInventoryEntry {
    this.validateInventoryFile(file)
    const canonical = file.logicalPath.startsWith("definition-")
      || file.logicalPath === `runs/${safeLegacyId(descriptor.runId)}.json`
      || file.logicalPath === `ctrl/${safeLegacyId(descriptor.runId)}.json`
      || file.logicalPath === `data-graphs/${safeLegacyId(descriptor.runId)}.json`
    const readOnly = file.logicalPath.startsWith("agent-executions/")
    return {
      kind: file.logicalPath.split("/", 1)[0]!,
      logicalPath: file.logicalPath,
      digest: digestBytes(file.bytes),
      classification: canonical ? "canonical-input" : readOnly ? "read-only-evidence" : "derived-evidence",
    }
  }

  private validateInventoryFile(file: InventoryFile): void {
    const text = file.bytes.toString("utf8")
    if (file.logicalPath.endsWith(".json")) {
      normalizeFlowClosedValue(JSON.parse(text), `legacy.inventory.${file.logicalPath}`)
      return
    }
    if (file.logicalPath.endsWith(".jsonl")) {
      for (const [index, line] of text.split(/\r?\n/).entries()) {
        if (!line.trim()) continue
        normalizeFlowClosedValue(JSON.parse(line), `legacy.inventory.${file.logicalPath}[${index}]`)
      }
    }
  }

  private migrationFile(target: { instanceId: string; runId: string }, name: string): string {
    return this.contained(`migration/attempts/${safeSegment(target.instanceId, "instanceId")}/${safeSegment(target.runId, "runId")}/${name}`)
  }

  private writeAttempt(
    file: string,
    sourceInventoryDigest: `sha256:${string}`,
    target: { instanceId: string; runId: string },
    legacyRunId: string,
    profileKind: "AICtrlWorkflow" | "AIDataWorkflow",
    inventory: readonly WorkflowLegacyInventoryEntry[],
    stage: WorkflowLegacyMigrationAttempt["stage"],
  ): void {
    const currentValue = this.readOptionalJson(file)
    if (currentValue !== undefined) {
      const current = this.normalizeAttempt(currentValue)
      this.assertAttempt(current, sourceInventoryDigest, target, legacyRunId, profileKind, inventory)
      const stages: readonly WorkflowLegacyMigrationAttempt["stage"][] = ["inventoried", "instance-admitted", "checkpoint-admitted"]
      if (stages.indexOf(current.stage) >= stages.indexOf(stage)) return
    }
    this.writeJsonAtomic(file, {
      schemaVersion: "eidolon.workflow-legacy-migration-attempt/v1",
      sourceInventoryDigest,
      target,
      legacyRunId,
      profileKind,
      stage,
      inventory,
    } satisfies WorkflowLegacyMigrationAttempt)
  }

  private assertAttempt(
    value: WorkflowLegacyMigrationAttempt,
    digest: string,
    target: object,
    runId: string,
    form: string,
    inventory: readonly WorkflowLegacyInventoryEntry[],
  ): void {
    if (value.schemaVersion !== "eidolon.workflow-legacy-migration-attempt/v1" || value.sourceInventoryDigest !== digest
      || JSON.stringify(value.target) !== JSON.stringify(target) || value.legacyRunId !== runId || value.profileKind !== form
      || digestValue(value.inventory) !== digestValue(inventory)) {
      throw new Error("legacy migration attempt conflicts with the requested inventory or target")
    }
  }

  private assertReceipt(
    value: WorkflowLegacyMigrationReceipt,
    digest: string,
    target: object,
    runId: string,
    form: string,
    inventory: readonly WorkflowLegacyInventoryEntry[],
  ): void {
    if (value.schemaVersion !== "eidolon.workflow-legacy-migration-receipt/v1" || value.sourceInventoryDigest !== digest
      || JSON.stringify(value.target) !== JSON.stringify(target) || value.legacyRunId !== runId || value.profileKind !== form
      || !SHA256.test(value.acceptedCheckpointDigest) || digestValue(value.inventory) !== digestValue(inventory)) {
      throw new Error("legacy migration receipt conflicts with the requested inventory or target")
    }
  }

  private normalizeInventory(value: unknown, label: string): readonly WorkflowLegacyInventoryEntry[] {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
    const entries: WorkflowLegacyInventoryEntry[] = value.map((item, index): WorkflowLegacyInventoryEntry => {
      const location = `${label}[${index}]`
      const record = exactRecord(item, ["kind", "logicalPath", "digest", "classification"], [], location)
      const digest = identity(record.digest, `${location}.digest`)
      if (!SHA256.test(digest)) throw new Error(`${location}.digest is invalid`)
      const classification = record.classification
      if (classification !== "canonical-input" && classification !== "derived-evidence" && classification !== "read-only-evidence") {
        throw new Error(`${location}.classification is invalid`)
      }
      return {
        kind: identity(record.kind, `${location}.kind`),
        logicalPath: identity(record.logicalPath, `${location}.logicalPath`),
        digest: digest as `sha256:${string}`,
        classification,
      }
    })
    for (let index = 1; index < entries.length; index += 1) {
      if (compareCodeUnits(entries[index - 1]!.logicalPath, entries[index]!.logicalPath) >= 0) {
        throw new Error(`${label} must be uniquely code-unit ordered`)
      }
    }
    return entries
  }

  private normalizeTarget(value: unknown, label: string): { instanceId: string; runId: string } {
    const record = exactRecord(value, ["instanceId", "runId"], [], label)
    return {
      instanceId: safeSegment(identity(record.instanceId, `${label}.instanceId`), `${label}.instanceId`),
      runId: safeSegment(identity(record.runId, `${label}.runId`), `${label}.runId`),
    }
  }

  private normalizeAttempt(value: unknown): WorkflowLegacyMigrationAttempt {
    const record = exactRecord(value, ["schemaVersion", "sourceInventoryDigest", "target", "legacyRunId", "profileKind", "stage", "inventory"], [], "migration.attempt")
    const digest = identity(record.sourceInventoryDigest, "migration.attempt.sourceInventoryDigest")
    if (record.schemaVersion !== "eidolon.workflow-legacy-migration-attempt/v1" || !SHA256.test(digest)) throw new Error("migration attempt schema or digest is invalid")
    const profileKind = record.profileKind
    if (profileKind !== "AICtrlWorkflow" && profileKind !== "AIDataWorkflow") throw new Error("migration attempt profileKind is invalid")
    const stage = record.stage
    if (stage !== "inventoried" && stage !== "instance-admitted" && stage !== "checkpoint-admitted") throw new Error("migration attempt stage is invalid")
    return {
      schemaVersion: "eidolon.workflow-legacy-migration-attempt/v1",
      sourceInventoryDigest: digest as `sha256:${string}`,
      target: this.normalizeTarget(record.target, "migration.attempt.target"),
      legacyRunId: identity(record.legacyRunId, "migration.attempt.legacyRunId"),
      profileKind,
      stage,
      inventory: this.normalizeInventory(record.inventory, "migration.attempt.inventory"),
    }
  }

  private normalizeReceipt(value: unknown): WorkflowLegacyMigrationReceipt {
    const record = exactRecord(value, ["schemaVersion", "sourceInventoryDigest", "target", "legacyRunId", "profileKind", "acceptedCheckpointVersion", "acceptedCheckpointDigest", "inventory"], [], "migration.receipt")
    const sourceDigest = identity(record.sourceInventoryDigest, "migration.receipt.sourceInventoryDigest")
    const checkpointDigest = identity(record.acceptedCheckpointDigest, "migration.receipt.acceptedCheckpointDigest")
    if (record.schemaVersion !== "eidolon.workflow-legacy-migration-receipt/v1" || !SHA256.test(sourceDigest) || !SHA256.test(checkpointDigest)) {
      throw new Error("migration receipt schema or digest is invalid")
    }
    const version = record.acceptedCheckpointVersion
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) throw new Error("migration receipt checkpoint version is invalid")
    const profileKind = record.profileKind
    if (profileKind !== "AICtrlWorkflow" && profileKind !== "AIDataWorkflow") throw new Error("migration receipt profileKind is invalid")
    return {
      schemaVersion: "eidolon.workflow-legacy-migration-receipt/v1",
      sourceInventoryDigest: sourceDigest as `sha256:${string}`,
      target: this.normalizeTarget(record.target, "migration.receipt.target"),
      legacyRunId: identity(record.legacyRunId, "migration.receipt.legacyRunId"),
      profileKind,
      acceptedCheckpointVersion: version,
      acceptedCheckpointDigest: checkpointDigest as `sha256:${string}`,
      inventory: this.normalizeInventory(record.inventory, "migration.receipt.inventory"),
    }
  }

  private collectDirectory(logical: string, target: InventoryFile[]): void {
    const directory = this.contained(logical)
    if (!fs.existsSync(directory)) return
    this.requirePhysicalDirectory(directory)
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareCodeUnits(left.name, right.name))) {
      const nested = `${logical}/${entry.name}`
      if (entry.isSymbolicLink()) throw new Error(`legacy inventory ${nested} cannot be a symbolic link`)
      if (entry.isDirectory()) this.collectDirectory(nested, target)
      else if (entry.isFile()) target.push(this.readRequiredFile(nested))
      else throw new Error(`legacy inventory ${nested} must be a regular file or directory`)
    }
  }

  private readRequiredFile(logicalPath: string): InventoryFile {
    const value = this.readOptionalFile(logicalPath)
    if (!value) throw new Error(`legacy inventory file is missing: ${logicalPath}`)
    return value
  }

  private readOptionalFile(logicalPath: string): InventoryFile | undefined {
    const file = this.contained(logicalPath)
    if (!fs.existsSync(file)) return undefined
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`legacy inventory ${logicalPath} must be a physical regular file`)
    const real = fs.realpathSync(file)
    if (real !== this.#realRoot && !real.startsWith(`${this.#realRoot}${path.sep}`)) throw new Error(`legacy inventory ${logicalPath} escapes runtime root`)
    return { logicalPath, bytes: fs.readFileSync(file) }
  }

  private readOptionalJson(file: string): unknown | undefined {
    if (!fs.existsSync(file)) return undefined
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("migration fact must be a physical regular file")
    return normalizeFlowClosedValue(JSON.parse(fs.readFileSync(file, "utf8")), "migration.fact")
  }

  private writeJsonAtomic(file: string, value: unknown, exclusive = false): void {
    normalizeFlowClosedValue(value, "migration.fact")
    this.assertPhysicalParent(path.dirname(file))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.assertPhysicalParent(path.dirname(file))
    const candidate = path.join(path.dirname(file), `.candidate-${path.basename(file)}-${randomUUID()}`)
    try {
      fs.writeFileSync(candidate, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" })
      const readback = this.readOptionalJson(candidate)
      if (digestValue(readback) !== digestValue(value)) throw new Error("migration candidate readback differs")
      if (fs.existsSync(file)) {
        const existing = this.readOptionalJson(file)
        if (digestValue(existing) !== digestValue(value)) {
          if (exclusive) throw new Error("migration fact conflicts with an existing value")
          fs.renameSync(candidate, file)
        }
        return
      }
      if (exclusive) {
        try {
          fs.linkSync(candidate, file)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
          const existing = this.readOptionalJson(file)
          if (digestValue(existing) !== digestValue(value)) throw new Error("migration fact conflicts with a concurrently admitted value")
        }
      }
      else fs.renameSync(candidate, file)
    } finally {
      if (fs.existsSync(candidate)) fs.unlinkSync(candidate)
    }
  }

  private async acquireLock(target: { instanceId: string; runId: string }): Promise<HeldMigrationLock> {
    const file = this.migrationFile(target, "migration.lock")
    this.assertPhysicalParent(path.dirname(file))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    this.assertPhysicalParent(path.dirname(file))
    const token = randomUUID()
    const deadline = Date.now() + 5_000
    for (;;) {
      try {
        const fd = fs.openSync(file, "wx")
        fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, createdAtMs: Date.now() }))
        const stat = fs.fstatSync(fd)
        return { file, fd, token, device: stat.dev, inode: stat.ino }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        const observed = this.observeLock(file)
        if (observed && !this.processAlive(observed.pid)) {
          const claim = `${file}.recovery-${randomUUID()}`
          try {
            fs.linkSync(file, claim)
            const source = fs.lstatSync(file)
            const linked = fs.lstatSync(claim)
            const claimed = this.observeLock(claim)
            if (source.dev === observed.device && source.ino === observed.inode
              && source.dev === linked.dev && source.ino === linked.ino
              && claimed?.token === observed.token) {
              fs.unlinkSync(file)
            }
          } catch {
            // Another process owns or recovered the lock.
          } finally {
            if (fs.existsSync(claim)) fs.unlinkSync(claim)
          }
          continue
        }
        if (Date.now() >= deadline) throw new Error("legacy migration lock acquisition timed out")
        await new Promise<void>((resolve) => setTimeout(resolve, 10))
      }
    }
  }

  private observeLock(file: string): MigrationLockOwner | undefined {
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("migration lock must be a physical regular file")
      const value = exactRecord(JSON.parse(fs.readFileSync(file, "utf8")), ["token", "pid", "createdAtMs"], [], "migration.lockOwner")
      const pid = value.pid
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) throw new Error("migration lock owner pid is invalid")
      return {
        token: identity(value.token, "migration.lockOwner.token"),
        pid,
        createdAtMs: timestamp(value.createdAtMs, "migration.lockOwner.createdAtMs"),
        device: stat.dev,
        inode: stat.ino,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  private processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }

  private releaseLock(lock: HeldMigrationLock): void {
    fs.closeSync(lock.fd)
    if (!fs.existsSync(lock.file)) return
    const stat = fs.lstatSync(lock.file)
    if (stat.dev !== lock.device || stat.ino !== lock.inode) return
    const value = JSON.parse(fs.readFileSync(lock.file, "utf8")) as { token?: unknown }
    if (value.token === lock.token) fs.unlinkSync(lock.file)
  }

  private assertPhysicalParent(directory: string): void {
    const relative = path.relative(this.root, directory)
    let current = this.root
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment)
      if (!fs.existsSync(current)) continue
      const stat = fs.lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("migration parent boundary must contain physical directories")
      const real = fs.realpathSync(current)
      if (real !== this.#realRoot && !real.startsWith(`${this.#realRoot}${path.sep}`)) throw new Error("migration parent escapes runtime root")
    }
  }

  private requirePhysicalDirectory(directory: string): void {
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("legacy inventory directory must be physical")
    const real = fs.realpathSync(directory)
    if (real !== this.#realRoot && !real.startsWith(`${this.#realRoot}${path.sep}`)) throw new Error("legacy inventory directory escapes runtime root")
  }

  private contained(logicalPath: string): string {
    const target = path.resolve(this.root, logicalPath)
    if (target !== this.root && !target.startsWith(`${this.root}${path.sep}`)) throw new Error("legacy inventory path escapes runtime root")
    return target
  }
}
