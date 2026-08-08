import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

import type {
  AIDataWorkflowRunGraph,
  AIDataWorkflowReuseCandidate,
  AIWorkflowNodeResult,
  AIWorkflowRunEvent,
  AIWorkflowRunRef,
  AIWorkflowRunState,
  AIWorkflowSemanticFingerprint,
  AIWorkflowStateStore,
  AIWorkflowReusableNodeResultRequest,
} from "@cell/ai-workflow-contract"
import type { WorkCtrlFlowSnapshot, WorkCtrlFlowStore } from "work-ctrl-flow-contract"
import type {
  WorkflowDefinitionRevision,
  WorkflowInstance,
  WorkflowMaterialBinding,
  WorkflowMaterialRevision,
  WorkflowRunReceipt,
} from "./WorkflowLifecycleFacts"

export type WorkflowRunDescriptor = {
  runId: string
  form: "AICtrlWorkflow" | "AIDataWorkflow"
  workflowRef: string
  bundlePath: string
  createdAt: number
  generation: number
  instanceId: string
  definitionRevision: string
  requestFingerprint: string
  frozenInput: unknown
  frozenBindings: WorkflowMaterialBinding[]
  replayOf?: string
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${randomUUID()}`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8")
    await rename(temporary, filePath)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function safeId(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "_")
}

export class WorkflowFactStore implements WorkCtrlFlowStore, AIWorkflowStateStore {
  constructor(readonly rootPath: string) {}

  private ctrlPath(treeId: string): string {
    return path.join(this.rootPath, "ctrl", `${safeId(treeId)}.json`)
  }

  private descriptorPath(runId: string): string {
    return path.join(this.rootPath, "runs", `${safeId(runId)}.json`)
  }

  private statePath(ref: AIWorkflowRunRef): string {
    return path.join(this.rootPath, "ai-state", safeId(ref.runId), `${ref.generation}.json`)
  }

  private eventsPath(runId: string): string {
    return path.join(this.rootPath, "events", `${safeId(runId)}.jsonl`)
  }

  private dataGraphPath(runId: string): string {
    return path.join(this.rootPath, "data-graphs", `${safeId(runId)}.json`)
  }

  private definitionPath(revision: string): string {
    return path.join(this.rootPath, "definition-revisions", `${safeId(revision)}.json`)
  }

  private definitionBundlePath(revision: string): string {
    return path.join(this.rootPath, "definition-bundles", safeId(revision))
  }

  private instancePath(instanceId: string): string {
    return path.join(this.rootPath, "instances", `${safeId(instanceId)}.json`)
  }

  private bindingPath(bindingId: string): string {
    return path.join(this.rootPath, "material-bindings", `${safeId(bindingId)}.json`)
  }

  private materialRevisionPath(materialRef: string, revision: string): string {
    return path.join(this.rootPath, "material-revisions", safeId(materialRef), `${safeId(revision)}.json`)
  }

  private receiptPath(runId: string): string {
    return path.join(this.rootPath, "run-receipts", `${safeId(runId)}.json`)
  }

  materialContentRoot(revision: string): string {
    return path.join(this.rootPath, "material-content", safeId(revision))
  }

  frozenDefinitionRoot(revision: string): string {
    return this.definitionBundlePath(revision)
  }

  load(treeId: string): Promise<WorkCtrlFlowSnapshot | undefined> {
    return readJson(this.ctrlPath(treeId))
  }

  save(snapshot: WorkCtrlFlowSnapshot): Promise<void> {
    return writeJsonAtomic(this.ctrlPath(snapshot.treeId), snapshot)
  }

  async remove(treeId: string): Promise<void> {
    await rm(this.ctrlPath(treeId), { force: true })
  }

  saveDescriptor(descriptor: WorkflowRunDescriptor): Promise<void> {
    return writeJsonAtomic(this.descriptorPath(descriptor.runId), descriptor)
  }

  loadDescriptor(runId: string): Promise<WorkflowRunDescriptor | undefined> {
    return readJson(this.descriptorPath(runId))
  }

  async saveDefinitionRevision(definition: WorkflowDefinitionRevision): Promise<void> {
    const existing = await this.loadDefinitionRevision(definition.revision)
    if (existing) {
      if (JSON.stringify(existing.files) !== JSON.stringify(definition.files)) {
        throw new Error(`Definition revision collision: ${definition.revision}`)
      }
      return
    }
    const root = this.definitionBundlePath(definition.revision)
    for (const [relativePath, content] of Object.entries(definition.files)) {
      if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => !part || part === "..")) {
        throw new Error(`Unsafe frozen definition path: ${relativePath}`)
      }
      const target = path.join(root, ...relativePath.split("/"))
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content, "utf8")
    }
    await writeJsonAtomic(this.definitionPath(definition.revision), definition)
  }

  loadDefinitionRevision(revision: string): Promise<WorkflowDefinitionRevision | undefined> {
    return readJson(this.definitionPath(revision))
  }

  async listDefinitionRevisions(): Promise<WorkflowDefinitionRevision[]> {
    return this.listJsonDirectory<WorkflowDefinitionRevision>(path.join(this.rootPath, "definition-revisions"))
  }

  saveInstance(instance: WorkflowInstance): Promise<void> {
    return writeJsonAtomic(this.instancePath(instance.instanceId), instance)
  }

  loadInstance(instanceId: string): Promise<WorkflowInstance | undefined> {
    return readJson(this.instancePath(instanceId))
  }

  async listInstances(): Promise<WorkflowInstance[]> {
    return this.listJsonDirectory<WorkflowInstance>(path.join(this.rootPath, "instances"))
  }

  saveMaterialRevision(material: WorkflowMaterialRevision): Promise<void> {
    return writeJsonAtomic(this.materialRevisionPath(material.materialRef, material.revision), material)
  }

  loadMaterialRevision(materialRef: string, revision: string): Promise<WorkflowMaterialRevision | undefined> {
    return readJson(this.materialRevisionPath(materialRef, revision))
  }

  async listMaterialRevisions(materialRef?: string): Promise<WorkflowMaterialRevision[]> {
    if (materialRef) {
      return this.listJsonDirectory<WorkflowMaterialRevision>(path.join(this.rootPath, "material-revisions", safeId(materialRef)))
    }
    const root = path.join(this.rootPath, "material-revisions")
    let names: string[]
    try {
      names = await readdir(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    return (await Promise.all(names.map((name) => this.listJsonDirectory<WorkflowMaterialRevision>(path.join(root, name)))))
      .flat()
  }

  saveMaterialBinding(binding: WorkflowMaterialBinding): Promise<void> {
    return writeJsonAtomic(this.bindingPath(binding.bindingId), binding)
  }

  loadMaterialBinding(bindingId: string): Promise<WorkflowMaterialBinding | undefined> {
    return readJson(this.bindingPath(bindingId))
  }

  async removeMaterialBinding(bindingId: string): Promise<void> {
    await rm(this.bindingPath(bindingId), { force: true })
  }

  async listMaterialBindings(): Promise<WorkflowMaterialBinding[]> {
    return this.listJsonDirectory<WorkflowMaterialBinding>(path.join(this.rootPath, "material-bindings"))
  }

  saveRunReceipt(receipt: WorkflowRunReceipt): Promise<void> {
    return writeJsonAtomic(this.receiptPath(receipt.runId), receipt)
  }

  loadRunReceipt(runId: string): Promise<WorkflowRunReceipt | undefined> {
    return readJson(this.receiptPath(runId))
  }

  async listRunReceipts(): Promise<WorkflowRunReceipt[]> {
    return this.listJsonDirectory<WorkflowRunReceipt>(path.join(this.rootPath, "run-receipts"))
  }

  async removeMaterialRevision(materialRef: string, revision: string): Promise<void> {
    await rm(this.materialRevisionPath(materialRef, revision), { force: true })
    const remaining = (await this.listMaterialRevisions()).some((item) => item.revision === revision)
    if (!remaining) await rm(this.materialContentRoot(revision), { recursive: true, force: true })
  }

  saveDataGraph(graph: AIDataWorkflowRunGraph): Promise<void> {
    return writeJsonAtomic(this.dataGraphPath(graph.runId), graph)
  }

  loadDataGraph(runId: string): Promise<AIDataWorkflowRunGraph | undefined> {
    return readJson(this.dataGraphPath(runId))
  }

  loadRunState(ref: AIWorkflowRunRef): Promise<AIWorkflowRunState | undefined> {
    return readJson(this.statePath(ref))
  }

  saveRunState(state: AIWorkflowRunState): Promise<void> {
    return writeJsonAtomic(this.statePath(state.ref), state)
  }

  async appendRunEvent(_ref: AIWorkflowRunRef, event: AIWorkflowRunEvent): Promise<void> {
    const filePath = this.eventsPath(event.runId)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" })
  }

  async readRunEvents(runId: string): Promise<AIWorkflowRunEvent[]> {
    try {
      return (await readFile(this.eventsPath(runId), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AIWorkflowRunEvent)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
  }

  async findReusableNodeResult(
    request: AIWorkflowReusableNodeResultRequest,
  ): Promise<AIWorkflowNodeResult | undefined> {
    const runDir = path.join(this.rootPath, "ai-state", safeId(request.run.runId))
    let names: string[]
    try {
      names = await readdir(runDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    const states = await Promise.all(names
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson<AIWorkflowRunState>(path.join(runDir, name))))
    return states
      .filter((state): state is AIWorkflowRunState => Boolean(state))
      .flatMap((state) => Object.values(state.nodes))
      .find((node) => node.nodeId === request.nodeId
        && sameFingerprint(node.semanticFingerprint, request.fingerprint)
        && (node.status === "Succeeded" || node.status === "Reused"))
  }

  async listReusableNodeCandidates(runId: string, nodeId: string): Promise<AIDataWorkflowReuseCandidate[]> {
    const runDir = path.join(this.rootPath, "ai-state", safeId(runId))
    let names: string[]
    try {
      names = await readdir(runDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    const states = await Promise.all(names
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson<AIWorkflowRunState>(path.join(runDir, name))))
    return states.flatMap((state) => {
      const result = state?.nodes[nodeId]
      if (!state || !result?.semanticFingerprint || (result.status !== "Succeeded" && result.status !== "Reused")) {
        return []
      }
      return [{
        runId,
        nodeId,
        generation: result.generation,
        result,
        semanticFingerprint: result.semanticFingerprint,
      }]
    })
  }

  private async listJsonDirectory<T>(directory: string): Promise<T[]> {
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    return (await Promise.all(names
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson<T>(path.join(directory, name)))))
      .filter((item): item is T => Boolean(item))
  }
}

function sameFingerprint(
  left: AIWorkflowSemanticFingerprint | undefined,
  right: AIWorkflowSemanticFingerprint,
): boolean {
  return left?.algorithm === right.algorithm && left.value === right.value
}
