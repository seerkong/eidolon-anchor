import path from "node:path"
import { lstatSync, readFileSync, realpathSync } from "node:fs"
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises"
import type { DefinitionStepSourceReadPort } from "flow-step-space-contract"

import {
  projectAIWorkflowAgentResources,
  projectAIWorkflowAppBundles,
} from "ai-workflow-logic"
import { resolveAIWorkflowResourceTree } from "ai-workflow-logic/filesystem"
import {
  freezeAIWorkflowHolonTaskTarget,
  freezeAIWorkflowRunResources,
  projectFrozenHolonTaskTarget,
  projectFrozenAIAgentTaskBinding,
} from "ai-workflow-logic/run-freeze"
import type {
  AIAgentDefinitionProjection,
  AIAgentMessageRole,
  AIWorkflowAgentTaskRef,
  AIWorkflowAgentResourceProjection,
  AIWorkflowAppBundleProjection,
  AIWorkflowRunResourceFreezeReceipt,
  FrozenHolonTaskTarget,
  FrozenAIAgentTaskBinding,
  HolonTaskTarget,
} from "ai-workflow-contract"
import type { AgentConfig } from "@cell/ai-core-contract/runtime/AgentConfig"
import type {
  EffectiveEidolonVfsSnapshot,
  EidolonVfsEntry,
  EidolonVfsReadPort,
} from "@cell/symbiont-contract/resource/EffectiveEidolonVFS"
import type { AgentContextPipelineBinding } from "@cell/ai-core-contract/runtime/AgentContextPipeline"
import type {
  AgentExecutionContract,
  AgentExecutionMaterialPortInput,
  AgentExecutionSchema,
} from "@cell/ai-core-contract/runtime/AgentExecutionContract"
import {
  normalizeAgentExecutionSchema,
  normalizeAgentExecutionValue,
  validateAgentExecutionInput,
  validateAgentExecutionMessages,
} from "../agent/AgentExecutionContract"
import {
  composeLayeredResourceRegistry,
  buildResourceDependencySnapshot,
  canonicalResourcePackageSourcePath,
  loadResourceTree,
  loadResourceTreeFromReadPort,
  resolveEffectiveResourceContentIdentities,
  sha256Digest,
  type AuthoredResourceTree,
  type EffectiveResourceRegistry,
  type PortableSpec,
  type ResolvedResourceRecord,
  type ResolvedResourceTree,
  type ResourceContentIdentity,
  type ResourceLayerContentIdentityInput,
  type ResourcePackageReadPort,
  type ResourceRecord,
} from "halfcode-compiler.xnl/resource-core"
import { safePathLexicalIssue } from "halfcode-compiler.xnl/resource-mapping"
import {
  freezeHolonExecutionBinding,
  projectHolonExecutionBindings,
  type EidolonHolonExecutionBindingFreezeReceipt,
  type EidolonHolonExecutionBindingProjection,
} from "./HolonExecutionBindingProjection"
import {
  projectHolonTaskRuntimeDefinitions,
  type EidolonHolonTaskRuntimeDefinitionProjection,
} from "./HolonTaskRuntimeDefinitionProjection"
import { EidolonResourceRegistryError } from "./EidolonResourceRegistryError"
import { createEidolonResourceResolutionContext } from "./EidolonResourceKindContractCapsule"

export { EidolonResourceRegistryError } from "./EidolonResourceRegistryError"

export type ResourcePackageLayerId = "global" | "workspace"

export type ResourcePackageLayerBinding = {
  readonly id: ResourcePackageLayerId
  readonly rootDir: string
}

export type EidolonResourceRegistrySnapshot = {
  readonly schemaVersion: "eidolon.resource-registry-snapshot/v1"
  /** Authentic authored registry paired with contentIdentityLayers for digest/authoring authority. */
  readonly contentIdentityRegistry: EffectiveResourceRegistry
  readonly registry: EffectiveResourceRegistry
  readonly contentIdentities: ReadonlyMap<string, ResourceContentIdentity>
  /** Exact loaded trees composed into registry; retained for branded Halfcode proof projection. */
  readonly contentIdentityLayers: readonly ResourceLayerContentIdentityInput[]
  /** Exact reader-admitted resource records selected by the layered effective registry. */
  readonly resolvedResources: ReadonlyMap<string, ResolvedResourceRecord>
  readonly readerProfileId: string
  readonly effectiveVfs?: Readonly<{
    readonly revision: string
    readonly treeDigest: string
    readonly materializationReceiptId: string
    readonly packageRoot: "/.eidolon/resources"
  }>
  readonly registryRevision: string
  readonly appBundles: readonly AIWorkflowAppBundleProjection[]
  readonly agentResources: AIWorkflowAgentResourceProjection
  readonly holonExecutionBindings: readonly EidolonHolonExecutionBindingProjection[]
  readonly holonTaskRuntimeDefinitions: readonly EidolonHolonTaskRuntimeDefinitionProjection[]
  readonly layers: readonly ResourcePackageLayerBinding[]
}

export type EidolonResourceRegistryPublicationCandidate = {
  readonly schemaVersion: "eidolon.resource-registry-publication-candidate/v1"
  readonly generation: number
  readonly snapshot: EidolonResourceRegistrySnapshot
}

export type EidolonResourceRegistryPublicationFence = {
  readonly currentSnapshot: EidolonResourceRegistrySnapshot
  readonly loadCandidateSnapshot: (input?: {
    readonly effectiveVfs?: EidolonVfsReadPort
  }) => Promise<EidolonResourceRegistryPublicationCandidate>
}

export type EidolonResourceRegistryPublicationDecision<T> = {
  readonly candidate: EidolonResourceRegistryPublicationCandidate
  readonly value: T
}

export type EidolonResourceRegistryPublicationResult<T> = {
  readonly schemaVersion: "eidolon.resource-registry-publication-result/v1"
  readonly candidateGeneration: number
  readonly previousSnapshot: EidolonResourceRegistrySnapshot
  readonly snapshot: EidolonResourceRegistrySnapshot
  readonly value: T
}

export type EidolonWorkflowAppBrief = {
  readonly id: string
  readonly description?: string
  readonly workflowCount: number
  readonly entrypoints: readonly string[]
  readonly registryRevision: string
}

export type EidolonWorkflowAppDetail = EidolonWorkflowAppBrief & {
  readonly kind: "AIWorkflowAppBundle"
  readonly bindings: readonly {
    readonly id: string
    readonly kind: "AICtrlWorkflow" | "AIDataWorkflow"
    readonly ref: string
    readonly entrypoint: boolean
  }[]
}

export type EidolonReusableAgentBrief = {
  readonly id: string
  readonly description?: string
  readonly messageCount: number
  readonly toolCount: number
  readonly materialPortCount: number
  readonly promptLoaded: false
  readonly registryRevision: string
}

export type EidolonResourceAgentResolvedMessage = {
  readonly id: string
  readonly role: AIAgentMessageRole
  readonly promptResourceId: string
  readonly contentDigest: string
  readonly content: string
  readonly schema?: AgentExecutionSchema
}

export type EidolonResourceAgentExecutionPlan = {
  readonly schemaVersion: "eidolon.resource-agent-execution-plan/v1"
  readonly agentDefinitionRef: `resource://${string}`
  readonly registryRevision: string
  readonly compositionRevision: string
  readonly agentContentDigest: string
  readonly messages: readonly EidolonResourceAgentResolvedMessage[]
  readonly contextPipeline?: AgentContextPipelineBinding
  readonly toolResourceIds: readonly string[]
  readonly requiresWorkflowTask: boolean
  readonly executionContract: AgentExecutionContract
  readonly agentConfig: AgentConfig
}

export type EidolonResourceAgentExecutionScope = "standalone" | "workflow"

export type EidolonPreparedWorkflowAgentExecution = {
  readonly plan: EidolonResourceAgentExecutionPlan
  readonly receipt: AIWorkflowRunResourceFreezeReceipt
}

export type EidolonWorkflowAgentTaskProofRef = {
  readonly taskProofRef: `resource://${string}`
  readonly task: AIWorkflowAgentTaskRef
}

export type EidolonEffectiveResourceSource = {
  readonly resource: ResourceRecord
  readonly source: string
  readonly logicalPath: string
  readonly baseUri: string
  readonly layerId: string
  readonly packageId: string
  readonly compositionRevision: string
  readonly registryRevision: string
  readonly authorityDigest: string
  readonly contentDigest: string
}

type LoadedLayer = {
  readonly binding: ResourcePackageLayerBinding
  readonly tree: AuthoredResourceTree
  readonly resolvedTree: ResolvedResourceTree
}

type LoadedSnapshotGeneration = {
  readonly generation: number
  readonly snapshot: EidolonResourceRegistrySnapshot
}

export type EffectiveEidolonVfsRegistrySource =
  | EidolonVfsReadPort
  | (() => EidolonVfsReadPort | PromiseLike<EidolonVfsReadPort>)

const EFFECTIVE_VFS_LAYER_ID = "effective-vfs"
const EFFECTIVE_VFS_PACKAGE_ROOT = "/.eidolon/resources" as const

const LAYER_ORDER: Readonly<Record<ResourcePackageLayerId, number>> = Object.freeze({
  global: 0,
  workspace: 1,
})

export class EidolonAppResourceRegistryAdapter {
  private readonly configuredLayers: readonly ResourcePackageLayerBinding[]
  private readonly effectiveVfsSource?: EffectiveEidolonVfsRegistrySource
  private readonly workspaceRoot: string
  private readonly effectiveSources = new WeakMap<
    EidolonEffectiveResourceSource,
    EidolonResourceRegistrySnapshot
  >()
  private current?: EidolonResourceRegistrySnapshot
  private readonly effectiveVfsPorts = new WeakMap<EidolonResourceRegistrySnapshot, EidolonVfsReadPort>()
  private initialLoading?: Promise<EidolonResourceRegistrySnapshot>
  private registryOperationTail: Promise<void> = Promise.resolve()
  private nextLoadGeneration = 0
  private admittedLoadGeneration = 0
  private sourceReadsBlocked = false
  private activeSourceReads = 0
  private resolveSourceReadsDrained?: () => void

  constructor(input: {
    readonly layers?: readonly ResourcePackageLayerBinding[]
    readonly effectiveVfs?: EffectiveEidolonVfsRegistrySource
    readonly workspaceRoot?: string
  } = {}) {
    if (input.effectiveVfs && input.layers && input.layers.length > 0) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_RESOURCE_AUTHORITY_AMBIGUOUS",
        "Registry adapter accepts either one Effective VFS source or legacy physical layers, never both.",
      )
    }
    this.configuredLayers = normalizeLayerBindings(input.layers ?? [])
    this.effectiveVfsSource = input.effectiveVfs
    this.workspaceRoot = path.resolve(input.workspaceRoot ?? process.cwd())
  }

  snapshot(): Promise<EidolonResourceRegistrySnapshot> {
    if (this.current) return Promise.resolve(this.current)
    if (this.initialLoading) return this.initialLoading
    const pending = this.enqueueRegistryOperation(async () => {
      if (this.current) return this.current
      const loaded = await this.loadConfiguredSnapshot()
      this.admitSnapshot(loaded)
      return loaded.snapshot
    })
    this.trackInitialLoading(pending)
    return pending
  }

  refresh(): Promise<EidolonResourceRegistrySnapshot> {
    const pending = this.enqueueRegistryOperation(async () => {
      const loaded = await this.loadConfiguredSnapshot()
      this.admitSnapshot(loaded)
      return loaded.snapshot
    })
    if (!this.current && !this.initialLoading) this.trackInitialLoading(pending)
    return pending
  }

  loadIsolatedSnapshot(input: {
    readonly layers: readonly ResourcePackageLayerBinding[]
  }): Promise<EidolonResourceRegistrySnapshot> {
    return this.loadSnapshot(normalizeLayerBindings(input.layers))
  }

  loadIsolatedEffectiveVfsSnapshot(
    readPort: EidolonVfsReadPort,
  ): Promise<EidolonResourceRegistrySnapshot> {
    return this.loadEffectiveVfsSnapshot(readPort)
  }

  async withPublicationFence<T>(
    callback: (
      fence: EidolonResourceRegistryPublicationFence,
    ) => Promise<EidolonResourceRegistryPublicationDecision<T>>,
  ): Promise<EidolonResourceRegistryPublicationResult<T>> {
    if (typeof callback !== "function") {
      throw new EidolonResourceRegistryError(
        "EIDOLON_RESOURCE_PUBLICATION_CALLBACK_INVALID",
        "Registry publication fence requires one callback.",
      )
    }
    await this.snapshot()
    return this.enqueueRegistryOperation(async () => {
      const previousSnapshot = this.current
      if (!previousSnapshot) {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_PUBLICATION_CURRENT_MISSING",
          "Registry publication fence requires one admitted current snapshot.",
        )
      }

      this.sourceReadsBlocked = true
      await this.waitForSourceReadsToDrain()
      let candidatePromise: Promise<EidolonResourceRegistryPublicationCandidate> | undefined
      let candidate: EidolonResourceRegistryPublicationCandidate | undefined
      const loadCandidateSnapshot = (input?: {
        readonly effectiveVfs?: EidolonVfsReadPort
      }): Promise<EidolonResourceRegistryPublicationCandidate> => {
        if (!candidatePromise) {
          const loading = input?.effectiveVfs
            ? this.loadEffectiveVfsSnapshot(input.effectiveVfs).then((snapshot) => Object.freeze({
                generation: ++this.nextLoadGeneration,
                snapshot,
              }))
            : this.loadConfiguredSnapshot()
          candidatePromise = loading.then((loaded) => {
            candidate = Object.freeze({
              schemaVersion: "eidolon.resource-registry-publication-candidate/v1",
              generation: loaded.generation,
              snapshot: loaded.snapshot,
            })
            return candidate
          })
        }
        return candidatePromise
      }

      try {
        const decision = await callback(Object.freeze({
          currentSnapshot: previousSnapshot,
          loadCandidateSnapshot,
        }))
        if (!candidate || !decision || decision.candidate !== candidate) {
          throw new EidolonResourceRegistryError(
            "EIDOLON_RESOURCE_PUBLICATION_CANDIDATE_INVALID",
            "Publication admission requires the exact candidate loaded by the current fence.",
          )
        }
        this.admitSnapshot(candidate)
        return Object.freeze({
          schemaVersion: "eidolon.resource-registry-publication-result/v1",
          candidateGeneration: candidate.generation,
          previousSnapshot,
          snapshot: candidate.snapshot,
          value: decision.value,
        })
      } finally {
        this.sourceReadsBlocked = false
      }
    })
  }

  async listApps(): Promise<readonly EidolonWorkflowAppBrief[]> {
    const snapshot = await this.snapshot()
    return Object.freeze(snapshot.appBundles.map((app) => appBrief(app, snapshot.registryRevision)))
  }

  async getApp(resourceId: string): Promise<EidolonWorkflowAppDetail> {
    const exactId = exactResourceId(resourceId)
    const snapshot = await this.snapshot()
    const app = snapshot.appBundles.find((candidate) => candidate.resource.resourceId === exactId)
    if (!app) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_APP_RESOURCE_NOT_FOUND",
        `AIWorkflowAppBundle '${exactId}' is not present in registry ${snapshot.registry.compositionRevision}.`,
      )
    }
    const brief = appBrief(app, snapshot.registryRevision)
    return Object.freeze({
      ...brief,
      kind: "AIWorkflowAppBundle",
      bindings: Object.freeze(app.workflowBindings.map((binding) => Object.freeze({
        id: binding.id,
        kind: binding.kind,
        ref: binding.ref,
        entrypoint: binding.entrypoint,
      }))),
    })
  }

  async listReusableAgents(): Promise<readonly EidolonReusableAgentBrief[]> {
    const snapshot = await this.snapshot()
    return Object.freeze(snapshot.agentResources.agentDefinitions.map((agent) => agentBrief(
      agent,
      snapshot.registryRevision,
    )))
  }

  async listHolonExecutionBindings(): Promise<readonly EidolonHolonExecutionBindingProjection[]> {
    return (await this.snapshot()).holonExecutionBindings
  }

  async listHolonTaskRuntimeDefinitions(): Promise<
    readonly EidolonHolonTaskRuntimeDefinitionProjection[]
  > {
    return (await this.snapshot()).holonTaskRuntimeDefinitions
  }

  async freezeHolonExecutionBinding(
    bindingRef: string,
    providedSnapshot?: EidolonResourceRegistrySnapshot,
  ): Promise<EidolonHolonExecutionBindingFreezeReceipt> {
    const exactRef = exactResourceRef(bindingRef)
    const snapshot = providedSnapshot ?? await this.snapshot()
    const projection = snapshot.holonExecutionBindings.find(
      (candidate) => candidate.binding.bindingRef === exactRef,
    )
    if (!projection) throw new EidolonResourceRegistryError(
      "EIDOLON_HOLON_BINDING_NOT_FOUND",
      `HolonExecutionBinding '${exactRef}' is not present in registry ${snapshot.registryRevision}.`,
    )
    return freezeHolonExecutionBinding({
      projection,
      registry: snapshot.registry,
      contentIdentities: snapshot.contentIdentities,
      registryRevision: snapshot.registryRevision,
      agentResources: snapshot.agentResources,
    })
  }

  async listStandaloneAgentExecutionPlans(): Promise<readonly EidolonResourceAgentExecutionPlan[]> {
    const snapshot = await this.snapshot()
    const plans: EidolonResourceAgentExecutionPlan[] = []
    for (const agent of snapshot.agentResources.agentDefinitions) {
      if (agent.materialPorts.length > 0) continue
      plans.push(this.materializeAgentExecutionPlanFromSnapshot(
        resourceRef(agent.resource.resourceId),
        "standalone",
        snapshot,
        { payload: null },
      ))
    }
    return Object.freeze(plans)
  }

  async materializeAgentExecutionPlan(
    agentDefinitionRef: string,
    options: { readonly scope: EidolonResourceAgentExecutionScope },
  ): Promise<EidolonResourceAgentExecutionPlan> {
    const exactRef = exactResourceRef(agentDefinitionRef)
    if (options?.scope !== "standalone" && options?.scope !== "workflow") {
      throw new EidolonResourceRegistryError(
        "EIDOLON_RESOURCE_AGENT_SCOPE_INVALID",
        "Agent execution scope must be 'standalone' or 'workflow'.",
      )
    }
    return this.materializeAgentExecutionPlanFromSnapshot(exactRef, options.scope, await this.snapshot(), { payload: null })
  }

  async prepareWorkflowAgentExecution(
    task: AIWorkflowAgentTaskRef,
    input: { readonly payload?: unknown } = {},
  ): Promise<EidolonPreparedWorkflowAgentExecution> {
    const snapshot = await this.snapshot()
    const receipt = freezeAIWorkflowRunResources({
      registry: snapshot.registry,
      projection: snapshot.agentResources,
      task,
      contentIdentities: snapshot.contentIdentities,
    })
    const plan = this.materializeAgentExecutionPlanFromSnapshot(
      exactResourceRef(task.agentDefinitionRef),
      "workflow",
      snapshot,
      { task, receipt, payload: input.payload ?? null },
    )
    return Object.freeze({ plan, receipt })
  }

  async freezeWorkflowAgentTaskBinding(task: AIWorkflowAgentTaskRef): Promise<FrozenAIAgentTaskBinding> {
    const snapshot = await this.snapshot()
    return projectFrozenAIAgentTaskBinding(freezeAIWorkflowRunResources({
      registry: snapshot.registry,
      projection: snapshot.agentResources,
      task,
      contentIdentities: snapshot.contentIdentities,
    }))
  }

  async freezeWorkflowAgentTaskBindingByRef(
    taskProofRef: string,
    expectedTask: AIWorkflowAgentTaskRef,
  ): Promise<FrozenAIAgentTaskBinding> {
    const exactRef = exactResourceRef(taskProofRef)
    const snapshot = await this.snapshot()
    const resourceId = exactRef.slice("resource://".length)
    const binding = snapshot.agentResources.materialBindings.find(
      (candidate) => candidate.resource.resourceId === resourceId,
    )
    if (!binding) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_WORKFLOW_AGENT_TASK_PROOF_NOT_FOUND",
        `Workflow Agent task proof '${exactRef}' is not present in registry ${snapshot.registryRevision}.`,
      )
    }
    if (!sameAgentTask(binding.task, expectedTask)) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_WORKFLOW_AGENT_TASK_PROOF_IDENTITY_MISMATCH",
        `Workflow Agent task proof '${exactRef}' does not match the expected workflow, node and Agent definition identity.`,
      )
    }
    const receipt = freezeAIWorkflowRunResources({
      registry: snapshot.registry,
      projection: snapshot.agentResources,
      task: binding.task,
      contentIdentities: snapshot.contentIdentities,
    })
    if (!receipt.bindingResourceIds.includes(resourceId)) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_WORKFLOW_AGENT_TASK_PROOF_CLOSURE_MISMATCH",
        `Workflow Agent task proof '${exactRef}' is absent from its frozen dependency closure.`,
      )
    }
    return projectFrozenAIAgentTaskBinding(receipt)
  }

  async freezeWorkflowHolonTaskTarget(target: HolonTaskTarget): Promise<FrozenHolonTaskTarget> {
    const snapshot = await this.snapshot()
    return projectFrozenHolonTaskTarget(freezeAIWorkflowHolonTaskTarget({
      registry: snapshot.registry,
      target,
      contentIdentities: snapshot.contentIdentities,
    }))
  }

  /** Captures one admitted authority as portable instance-owned bytes. */
  async captureFrozenResourceClosure(): Promise<Readonly<Record<string, string>>> {
    const snapshot = await this.snapshot()
    const files: Record<string, string> = {}
    const effectiveVfs = this.effectiveVfsPorts.get(snapshot)
    if (effectiveVfs && snapshot.effectiveVfs) {
      await captureFrozenEffectiveVfs(effectiveVfs, "/.eidolon", ".agent-resources/effective-vfs/.eidolon", files)
      files[".agent-resources/effective-vfs/provenance.json"] = `${JSON.stringify({
        schemaVersion: "eidolon.frozen-effective-vfs/v1",
        effectiveVfsRevision: snapshot.effectiveVfs.revision,
        treeDigest: snapshot.effectiveVfs.treeDigest,
        materializationReceiptId: snapshot.effectiveVfs.materializationReceiptId,
        registryRevision: snapshot.registryRevision,
        packageRoot: snapshot.effectiveVfs.packageRoot,
      }, null, 2)}\n`
      return Object.freeze(files)
    }
    for (const layer of snapshot.layers) {
      await captureFrozenLayer(layer.rootDir, `.agent-resources/${layer.id}`, files)
    }
    return Object.freeze(files)
  }

  async listMaterialResourceRefsForWorkflow(workflowRef: string): Promise<readonly string[]> {
    const snapshot = await this.snapshot()
    const refs = snapshot.agentResources.materialBindings
      .filter((binding) => binding.task.workflowRef === workflowRef)
      .map((binding) => binding.material.ref)
    return Object.freeze([...new Set(refs)])
  }

  async listWorkflowAgentTasks(workflowRef: string): Promise<readonly AIWorkflowAgentTaskRef[]> {
    const snapshot = await this.snapshot()
    return Object.freeze(snapshot.agentResources.materialBindings
      .map((binding) => binding.task)
      .filter((task) => task.workflowRef === workflowRef)
      .map((task) => Object.freeze({ ...task })))
  }

  async listWorkflowAgentTaskProofRefs(workflowRef: string): Promise<readonly EidolonWorkflowAgentTaskProofRef[]> {
    const snapshot = await this.snapshot()
    return Object.freeze(snapshot.agentResources.materialBindings
      .filter((binding) => binding.task.workflowRef === workflowRef)
      .map((binding) => Object.freeze({
        taskProofRef: resourceRef(binding.resource.resourceId),
        task: Object.freeze({ ...binding.task }),
      })))
  }

  async readEffectiveSource(
    resourceId: string,
    providedSnapshot?: EidolonResourceRegistrySnapshot,
  ): Promise<EidolonEffectiveResourceSource> {
    const exactId = exactResourceId(resourceId)
    const snapshot = providedSnapshot ?? await this.snapshot()
    return this.withSourceRead(async () => {
      const entry = snapshot.registry.byId.get(exactId)
      if (!entry?.resource || !entry.effectiveOrigin) {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_NOT_FOUND",
          `Resource '${exactId}' is not present in registry ${snapshot.registry.compositionRevision}.`,
        )
      }
      if (entry.resource.sourceShape !== "single-file") {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_SOURCE_SHAPE_UNSUPPORTED",
          `Resource '${exactId}' uses '${entry.resource.sourceShape}', expected an exact single-file authority.`,
        )
      }
      const effectiveVfs = this.effectiveVfsPorts.get(snapshot)
      if (effectiveVfs) {
        const logicalPath = entry.resource.logicalPath
        const sourcePath = effectiveResourceSourcePath(logicalPath)
        const bytes = await requiredVfsBytes(effectiveVfs, sourcePath, exactId)
        const identity = snapshot.contentIdentities.get(exactId)
        if (!identity) {
          throw new EidolonResourceRegistryError(
            "EIDOLON_RESOURCE_CONTENT_IDENTITY_MISSING",
            `Resource '${exactId}' has no effective Halfcode content identity.`,
          )
        }
        const observedDigest = sha256Digest(bytes)
        if (observedDigest !== identity.authorityDigest) {
          throw new EidolonResourceRegistryError(
            "EIDOLON_RESOURCE_SOURCE_DIGEST_MISMATCH",
            `Resource '${exactId}' bytes do not match Effective VFS revision ${snapshot.effectiveVfs?.revision}.`,
          )
        }
        const source = decodeResourceUtf8(bytes, exactId)
        const result = Object.freeze({
          resource: entry.resource,
          source,
          logicalPath,
          baseUri: path.posix.dirname(sourcePath),
          layerId: EFFECTIVE_VFS_LAYER_ID,
          packageId: entry.effectiveOrigin.packageId,
          compositionRevision: snapshot.registry.compositionRevision,
          registryRevision: snapshot.registryRevision,
          authorityDigest: identity.authorityDigest,
          contentDigest: identity.contentDigest,
        })
        this.effectiveSources.set(result, snapshot)
        return result
      }
      const layer = snapshot.layers.find((candidate) => candidate.id === entry.effectiveOrigin?.layerId)
      if (!layer) {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_LAYER_UNBOUND",
          `Resource '${exactId}' selected unknown layer '${entry.effectiveOrigin.layerId}'.`,
        )
      }
      const logicalPath = entry.resource.logicalPath
      const target = path.resolve(layer.rootDir, ...logicalPath.split("/"))
      const canonicalRoot = await realpath(layer.rootDir)
      const canonicalTarget = await realpath(target)
      if (!isContained(canonicalRoot, canonicalTarget)) {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_ORIGIN_OUTSIDE_LAYER",
          `Resource '${exactId}' origin '${logicalPath}' escapes layer '${layer.id}'.`,
        )
      }
      const bytes = await readFile(canonicalTarget)
      const identity = snapshot.contentIdentities.get(exactId)
      if (!identity) {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_CONTENT_IDENTITY_MISSING",
          `Resource '${exactId}' has no effective Halfcode content identity.`,
        )
      }
      const observedDigest = sha256Digest(bytes)
      if (observedDigest !== identity.authorityDigest) {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_SOURCE_DIGEST_MISMATCH",
          `Resource '${exactId}' source changed after registry ${snapshot.registry.compositionRevision} was loaded.`,
        )
      }
      let source: string
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_SOURCE_UTF8_INVALID",
          `Resource '${exactId}' source is not valid UTF-8.`,
        )
      }
      const result = Object.freeze({
        resource: entry.resource,
        source,
        logicalPath,
        baseUri: path.dirname(canonicalTarget),
        layerId: entry.effectiveOrigin.layerId,
        packageId: entry.effectiveOrigin.packageId,
        compositionRevision: snapshot.registry.compositionRevision,
        registryRevision: snapshot.registryRevision,
        authorityDigest: identity.authorityDigest,
        contentDigest: identity.contentDigest,
      })
      this.effectiveSources.set(result, snapshot)
      return result
    })
  }

  async readEffectiveDependencySource(
    owner: EidolonEffectiveResourceSource,
    relativePath: string,
  ): Promise<string> {
    const ownerSnapshot = this.effectiveSources.get(owner)
    if (!ownerSnapshot) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_RESOURCE_DEPENDENCY_OWNER_INVALID",
        "Resource dependency reads require an effective source produced by this registry adapter.",
      )
    }
    const exactPath = exactDependencyPath(relativePath)
    return this.withSourceRead(async () => {
      const effectiveVfs = this.effectiveVfsPorts.get(ownerSnapshot)
      if (effectiveVfs) {
        const sourcePath = containedVfsDependencyPath(owner.baseUri, owner.baseUri, exactPath, "OWNER")
        return decodeResourceUtf8(
          await requiredVfsBytes(effectiveVfs, sourcePath, `${owner.resource.resourceId}:${exactPath}`),
          `${owner.resource.resourceId}:${exactPath}`,
        )
      }
      if (this.current !== ownerSnapshot) {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_DEPENDENCY_OWNER_STALE",
          "Resource dependency owner no longer belongs to the admitted registry snapshot.",
          true,
        )
      }
      const canonicalBase = await realpath(owner.baseUri)
      const canonicalTarget = await realpath(path.resolve(canonicalBase, ...exactPath.split("/")))
      if (!isContained(canonicalBase, canonicalTarget)) {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_DEPENDENCY_OUTSIDE_OWNER",
          `Resource '${owner.resource.resourceId}' dependency '${exactPath}' escapes its source directory.`,
        )
      }
      const bytes = await readFile(canonicalTarget)
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_DEPENDENCY_UTF8_INVALID",
          `Resource '${owner.resource.resourceId}' dependency '${exactPath}' is not valid UTF-8.`,
        )
      }
    })
  }

  /** Runs one profile parser against an exact, resource-local source port. */
  async loadEffectiveProfile<T>(
    owner: EidolonEffectiveResourceSource,
    load: (input: {
      readonly sources: Readonly<Record<string, string>>
      readonly stepSources: DefinitionStepSourceReadPort
    }) => T,
    providedSnapshot?: EidolonResourceRegistrySnapshot,
  ): Promise<{ readonly result: T; readonly sources: Readonly<Record<string, string>> }> {
    const ownerSnapshot = this.effectiveSources.get(owner)
    if (!ownerSnapshot) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_RESOURCE_DEPENDENCY_OWNER_INVALID",
        "Workflow profile source reads require an effective source produced by this registry adapter.",
      )
    }
    return this.withSourceRead(async () => {
      const effectiveVfs = this.effectiveVfsPorts.get(ownerSnapshot)
      if (!effectiveVfs && (providedSnapshot ?? this.current) !== ownerSnapshot) {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_DEPENDENCY_OWNER_STALE",
          "Workflow profile source owner no longer belongs to the admitted registry snapshot.",
          true,
        )
      }
      if (effectiveVfs) {
        const sources = await captureVfsTextSubtree(effectiveVfs, owner.baseUri)
        sources["manifest.xnl"] = owner.source
        const stepSources: DefinitionStepSourceReadPort = Object.freeze({
          readSource: (refValue: string): Uint8Array => {
            const ref = exactDependencyPath(refValue)
            const existing = sources[ref]
            if (existing === undefined) {
              throw new EidolonResourceRegistryError(
                "EIDOLON_RESOURCE_DEPENDENCY_NOT_FOUND",
                `Workflow profile dependency '${ref}' does not exist in Effective VFS revision ${ownerSnapshot.effectiveVfs?.revision}.`,
              )
            }
            return new TextEncoder().encode(existing)
          },
        })
        const result = load({ sources, stepSources })
        return Object.freeze({ result, sources: Object.freeze({ ...sources }) })
      }
      const canonicalBase = await realpath(owner.baseUri)
      const sources: Record<string, string> = { "manifest.xnl": owner.source }
      const stepSources: DefinitionStepSourceReadPort = Object.freeze({
        readSource: (refValue: string): Uint8Array => {
          const ref = exactDependencyPath(refValue)
          const existing = sources[ref]
          if (existing !== undefined) return new TextEncoder().encode(existing)
          const segments = ref.split("/")
          let target = canonicalBase
          for (const [index, segment] of segments.entries()) {
            target = path.join(target, segment)
            let metadata
            try {
              metadata = lstatSync(target)
            } catch {
              throw new EidolonResourceRegistryError(
                "EIDOLON_RESOURCE_DEPENDENCY_NOT_FOUND",
                `Workflow profile dependency '${ref}' does not exist.`,
              )
            }
            const final = index === segments.length - 1
            if (metadata.isSymbolicLink() || (final ? !metadata.isFile() : !metadata.isDirectory())) {
              throw new EidolonResourceRegistryError(
                "EIDOLON_RESOURCE_DEPENDENCY_ENTRY_INVALID",
                `Workflow profile dependency '${ref}' must traverse directories to one regular non-symbolic-link file.`,
              )
            }
          }
          const canonicalTarget = realpathSync(target)
          if (!isContained(canonicalBase, canonicalTarget)) {
            throw new EidolonResourceRegistryError(
              "EIDOLON_RESOURCE_DEPENDENCY_OUTSIDE_OWNER",
              `Workflow profile dependency '${ref}' escapes its resource directory.`,
            )
          }
          const bytes = readFileSync(canonicalTarget)
          try {
            sources[ref] = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
          } catch {
            throw new EidolonResourceRegistryError(
              "EIDOLON_RESOURCE_DEPENDENCY_UTF8_INVALID",
              `Workflow profile dependency '${ref}' is not valid UTF-8.`,
            )
          }
          return bytes.slice()
        },
      })
      const result = load({ sources, stepSources })
      return Object.freeze({ result, sources: Object.freeze({ ...sources }) })
    })
  }

  async readEffectivePackageDependencySource(
    owner: EidolonEffectiveResourceSource,
    packageRelativePath: string,
  ): Promise<string> {
    const ownerSnapshot = this.effectiveSources.get(owner)
    if (!ownerSnapshot) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_RESOURCE_DEPENDENCY_OWNER_INVALID",
        "Resource package dependency reads require an effective source produced by this registry adapter.",
      )
    }
    const exactPath = exactDependencyPath(packageRelativePath)
    return this.withSourceRead(async () => {
      const effectiveVfs = this.effectiveVfsPorts.get(ownerSnapshot)
      if (effectiveVfs) {
        const sourcePath = containedVfsDependencyPath(EFFECTIVE_VFS_PACKAGE_ROOT, EFFECTIVE_VFS_PACKAGE_ROOT, exactPath, "PACKAGE")
        return decodeResourceUtf8(
          await requiredVfsBytes(effectiveVfs, sourcePath, `${owner.resource.resourceId}:${exactPath}`),
          `${owner.resource.resourceId}:${exactPath}`,
        )
      }
      if (this.current !== ownerSnapshot) {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_DEPENDENCY_OWNER_STALE",
          "Resource package dependency owner no longer belongs to the admitted registry snapshot.",
          true,
        )
      }
      const layer = ownerSnapshot.layers.find((candidate) => candidate.id === owner.layerId)
      if (!layer) {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_LAYER_UNBOUND",
          `Resource '${owner.resource.resourceId}' selected unknown layer '${owner.layerId}'.`,
        )
      }
      const canonicalRoot = await realpath(layer.rootDir)
      const canonicalTarget = await realpath(path.resolve(canonicalRoot, ...exactPath.split("/")))
      if (!isContained(canonicalRoot, canonicalTarget)) {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_DEPENDENCY_OUTSIDE_PACKAGE",
          `Resource '${owner.resource.resourceId}' package dependency '${exactPath}' escapes layer '${layer.id}'.`,
        )
      }
      const bytes = await readFile(canonicalTarget)
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } catch {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_DEPENDENCY_UTF8_INVALID",
          `Resource '${owner.resource.resourceId}' package dependency '${exactPath}' is not valid UTF-8.`,
        )
      }
    })
  }

  private enqueueRegistryOperation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.registryOperationTail.then(operation, operation)
    this.registryOperationTail = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }

  private trackInitialLoading(pending: Promise<EidolonResourceRegistrySnapshot>): void {
    this.initialLoading = pending
    void pending.then(
      () => {
        if (this.initialLoading === pending) this.initialLoading = undefined
      },
      () => {
        if (this.initialLoading === pending) this.initialLoading = undefined
      },
    )
  }

  private async loadConfiguredSnapshot(): Promise<LoadedSnapshotGeneration> {
    const generation = ++this.nextLoadGeneration
    const snapshot = this.effectiveVfsSource
      ? await this.loadEffectiveVfsSnapshot(await resolveEffectiveVfsSource(this.effectiveVfsSource))
      : await this.loadSnapshot(this.configuredLayers)
    return Object.freeze({
      schemaVersion: "eidolon.resource-registry-publication-candidate/v1",
      generation,
      snapshot,
    })
  }

  private admitSnapshot(candidate: LoadedSnapshotGeneration): void {
    if (candidate.generation <= this.admittedLoadGeneration) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_RESOURCE_REGISTRY_GENERATION_STALE",
        `Registry generation ${candidate.generation} cannot replace admitted generation ${this.admittedLoadGeneration}.`,
      )
    }
    this.current = candidate.snapshot
    this.admittedLoadGeneration = candidate.generation
  }

  private async withSourceRead<T>(read: () => Promise<T>): Promise<T> {
    if (this.sourceReadsBlocked) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_RESOURCE_REGISTRY_PUBLICATION_RETRYABLE",
        "Resource source reads are temporarily unavailable while a registry publication is being verified.",
        true,
      )
    }
    this.activeSourceReads += 1
    try {
      return await read()
    } finally {
      this.activeSourceReads -= 1
      if (this.activeSourceReads === 0) {
        const resolve = this.resolveSourceReadsDrained
        this.resolveSourceReadsDrained = undefined
        resolve?.()
      }
    }
  }

  private waitForSourceReadsToDrain(): Promise<void> {
    if (this.activeSourceReads === 0) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.resolveSourceReadsDrained = resolve
    })
  }

  private materializeAgentExecutionPlanFromSnapshot(
    agentDefinitionRef: `resource://${string}`,
    scope: EidolonResourceAgentExecutionScope,
    snapshot: EidolonResourceRegistrySnapshot,
    execution: {
      readonly task?: AIWorkflowAgentTaskRef
      readonly receipt?: AIWorkflowRunResourceFreezeReceipt
      readonly payload: unknown
    },
  ): EidolonResourceAgentExecutionPlan {
    const agentId = agentDefinitionRef.slice("resource://".length)
    const agent = snapshot.agentResources.agentDefinitions.find(
      (candidate) => candidate.resource.resourceId === agentId,
    )
    if (!agent) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_RESOURCE_AGENT_NOT_FOUND",
        `AIAgentDefinition '${agentDefinitionRef}' is not present in registry ${snapshot.registryRevision}.`,
      )
    }
    if (scope === "standalone" && agent.materialPorts.length > 0) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_RESOURCE_AGENT_WORKFLOW_TASK_REQUIRED",
        `AIAgentDefinition '${agentDefinitionRef}' declares Material ports and requires workflow task admission.`,
      )
    }

    const messages: readonly EidolonResourceAgentResolvedMessage[] = Object.freeze(
      agent.messagePrefix.flatMap<EidolonResourceAgentResolvedMessage>((item) => {
        if (item.type === "message-source") {
        const source = effectiveResource(snapshot, item.source.resource.resourceId)
        if (source !== item.source.resource || source.kind !== item.source.kind) {
          throw new EidolonResourceRegistryError(
            "EIDOLON_RESOURCE_AGENT_MESSAGE_SOURCE_IDENTITY_MISMATCH",
            `Agent message source '${item.id}' does not match the selected effective resource.`,
          )
        }
        const descriptor = parseClosedResourceDescriptor(snapshot, source, "AgentMessageSource")
        if (descriptor.implementation !== "eidolon.workspace-agents/v1") {
          throw new EidolonResourceRegistryError(
            "EIDOLON_AGENT_MESSAGE_SOURCE_IMPLEMENTATION_UNSUPPORTED",
            `Agent message source '${item.id}' selects unsupported implementation '${String(descriptor.implementation)}'.`,
          )
        }
        const workspaceInstructions = loadWorkspaceAgentInstructions(this.workspaceRoot)
        if (!workspaceInstructions) return []
        return [Object.freeze({
          id: item.id,
          role: "system" as const,
          promptResourceId: source.resourceId,
          contentDigest: sha256Digest(new TextEncoder().encode(workspaceInstructions)),
          content: workspaceInstructions,
        }) satisfies EidolonResourceAgentResolvedMessage]
        }
        const message = item
        const prompt = effectiveResource(snapshot, message.prompt.resource.resourceId)
      if (prompt !== message.prompt.resource || prompt.kind !== message.prompt.kind) {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_AGENT_PROMPT_IDENTITY_MISMATCH",
          `Agent message '${message.id}' prompt does not match the selected effective resource.`,
        )
      }
      const promptSpec = requiredResolvedResource(snapshot, prompt).readerValue
      const promptProperties = portableRecord(promptSpec.properties)
      const content = promptProperties?.template
      if (typeof content !== "string" || !content.trim()) {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_AGENT_PROMPT_CONTENT_UNSUPPORTED",
          `Agent message '${message.id}' requires one non-empty Prompt.template value.`,
        )
      }
      const identity = requiredContentIdentity(snapshot, prompt.resourceId)
        return [Object.freeze({
        id: message.id,
        role: message.role,
        promptResourceId: prompt.resourceId,
        contentDigest: identity.contentDigest,
        content,
        schema: message.schema
          ? normalizeAgentExecutionSchema(message.schema.schema, `message.${message.id}.schema`)
          : undefined,
        }) satisfies EidolonResourceAgentResolvedMessage]
      }),
    )
    const contextPipeline = materializeAgentContextPipeline(agent, snapshot)

    const toolResourceIds = agent.tools.map((tool) => {
      const selected = effectiveResource(snapshot, tool.resource.resourceId)
      if (selected !== tool.resource || selected.kind !== tool.kind) {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_AGENT_TOOL_IDENTITY_MISMATCH",
          `Agent tool '${tool.ref}' does not match the selected effective resource.`,
        )
      }
      return selected.resourceId
    })
    if (new Set(toolResourceIds).size !== toolResourceIds.length) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_RESOURCE_AGENT_TOOL_DUPLICATE",
        `AIAgentDefinition '${agentDefinitionRef}' declares a duplicate Tool reference.`,
      )
    }
    const toolMode = agent.effectPolicy?.toolMode ?? "declared-only"
    if (toolMode === "none" && toolResourceIds.length > 0) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_RESOURCE_AGENT_EFFECT_POLICY_CONFLICT",
        `AIAgentDefinition '${agentDefinitionRef}' declares ToolRefs while EffectPolicy.toolMode is 'none'.`,
      )
    }
    const admittedToolResourceIds = toolMode === "none" ? [] : toolResourceIds
    const frozenToolResourceIds = Object.freeze(admittedToolResourceIds) as string[]
    const seedMessages = Object.freeze(messages.map((message) => Object.freeze({
      role: message.role,
      content: message.content,
    })))
    const materialInputs = this.materializeAgentMaterialInputs({
      agent,
      snapshot,
      task: execution.task,
      receipt: execution.receipt,
    })
    const executionContract = Object.freeze({
      schemaVersion: "eidolon.agent-execution-contract/v1",
      input: Object.freeze({
        schemaVersion: "eidolon.agent-execution-input/v1",
        payload: normalizeAgentExecutionValue(execution.payload, "input.payload"),
        materials: materialInputs,
      }),
      messageSchemas: Object.freeze(messages.flatMap((message) => message.schema
        ? [Object.freeze({ messageId: message.id, schema: message.schema })]
        : [])),
      ...(agent.inputSchema
        ? { inputSchema: normalizeAgentExecutionSchema(agent.inputSchema.schema, "agent.inputSchema") }
        : {}),
      ...(agent.outputSchema
        ? { outputSchema: normalizeAgentExecutionSchema(agent.outputSchema.schema, "agent.outputSchema") }
        : {}),
      effectPolicy: Object.freeze({ toolMode }),
    }) satisfies AgentExecutionContract
    validateAgentExecutionMessages(executionContract, messages)
    validateAgentExecutionInput(executionContract)
    const agentConfig = Object.freeze({
      name: agentDefinitionRef,
      description: agent.resource.description ?? agentDefinitionRef,
      tools: frozenToolResourceIds,
      prompt: Object.freeze([]) as unknown as string[],
      seedMessages,
      requireExactTools: true,
      executionContract,
      ...(contextPipeline ? { contextPipeline } : {}),
    }) satisfies AgentConfig
    return Object.freeze({
      schemaVersion: "eidolon.resource-agent-execution-plan/v1",
      agentDefinitionRef,
      registryRevision: snapshot.registryRevision,
      compositionRevision: snapshot.registry.compositionRevision,
      agentContentDigest: requiredContentIdentity(snapshot, agent.resource.resourceId).contentDigest,
      messages,
      ...(contextPipeline ? { contextPipeline } : {}),
      toolResourceIds: frozenToolResourceIds,
      requiresWorkflowTask: scope === "workflow",
      executionContract,
      agentConfig,
    })
  }

  private materializeAgentMaterialInputs(input: {
    readonly agent: AIAgentDefinitionProjection
    readonly snapshot: EidolonResourceRegistrySnapshot
    readonly task?: AIWorkflowAgentTaskRef
    readonly receipt?: AIWorkflowRunResourceFreezeReceipt
  }): readonly AgentExecutionMaterialPortInput[] {
    if (input.agent.materialPorts.length === 0) return Object.freeze([])
    if (!input.task || !input.receipt) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_RESOURCE_AGENT_WORKFLOW_TASK_REQUIRED",
        `AIAgentDefinition '${input.agent.fqn}' requires an exact workflow task and freeze receipt.`,
      )
    }
    const bindingsById = new Map(input.snapshot.agentResources.materialBindings.map((binding) => [binding.resource.resourceId, binding]))
    const selectedBindings = input.receipt.bindingResourceIds.map((bindingId) => {
      const binding = bindingsById.get(bindingId)
      if (!binding) {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_AGENT_MATERIAL_BINDING_MISSING",
          `Freeze receipt selects unknown MaterialBinding '${bindingId}'.`,
        )
      }
      return binding
    })
    return Object.freeze(input.agent.materialPorts.map((portRef) => {
      const port = input.snapshot.agentResources.materialPorts.find(
        (candidate) => candidate.resource.resourceId === portRef.resource.resourceId,
      )
      if (!port || port.resource !== portRef.resource) {
        throw new EidolonResourceRegistryError(
          "EIDOLON_RESOURCE_AGENT_MATERIAL_PORT_MISMATCH",
          `Agent MaterialPort '${portRef.ref}' does not match the selected effective resource.`,
        )
      }
      const values = selectedBindings
        .filter((binding) => binding.port.resource.resourceId === port.resource.resourceId)
        .map((binding) => Object.freeze({
          bindingResourceId: binding.resource.resourceId,
          materialResourceId: binding.material.resource.resourceId,
          value: normalizeAgentExecutionValue(binding.material.value, `material.${binding.material.resource.resourceId}`),
        }))
      return Object.freeze({
        portResourceId: port.resource.resourceId,
        materialKind: port.materialKind,
        required: port.required,
        cardinality: port.cardinality,
        ...(port.schema
          ? { schema: normalizeAgentExecutionSchema(port.schema.schema, `materialPort.${port.resource.resourceId}.schema`) }
          : {}),
        values: Object.freeze(values),
      })
    }))
  }

  private async loadSnapshot(
    configuredLayers: readonly ResourcePackageLayerBinding[],
  ): Promise<EidolonResourceRegistrySnapshot> {
    const layers: LoadedLayer[] = []
    const resolutionContext = createEidolonResourceResolutionContext()
    for (const binding of configuredLayers) {
      if (!await directoryExists(binding.rootDir)) continue
      const tree = await loadResourceTree({ rootDir: binding.rootDir })
      const resolvedTree = resolveAIWorkflowResourceTree(tree, resolutionContext)
      layers.push(Object.freeze({ binding, tree, resolvedTree }))
    }
    const contentIdentityLayers = Object.freeze(
      layers.map(({ binding, tree }) => Object.freeze({ id: binding.id, tree })),
    )
    const authoredRegistry = composeLayeredResourceRegistry({
      layers: contentIdentityLayers,
    })
    const registry = composeLayeredResourceRegistry({
      layers: layers.map(({ binding, resolvedTree }) => Object.freeze({ id: binding.id, tree: resolvedTree })),
    })
    const contentIdentities = resolveEffectiveResourceContentIdentities({
      registry: authoredRegistry,
      layers: contentIdentityLayers,
    })
    const resolvedResources = selectEffectiveResolvedResources(
      registry,
      layers.map(({ binding, resolvedTree }) => ({ id: binding.id, resolvedTree })),
    )
    const roots = [...registry.byId.values()]
      .filter((entry) => entry.resource !== undefined)
      .map((entry) => entry.resourceId)
    const registryRevision = roots.length === 0
      ? registry.compositionRevision
      : buildResourceDependencySnapshot({ registry, roots, edges: [], contentIdentities }).registryRevision
    const kindDefinitionAuthorityDigests = await readKindDefinitionAuthorityDigests(registry, layers)
    const holonExecutionBindings = await projectHolonExecutionBindings({
      registry,
      contentIdentities,
      kindDefinitionAuthorityDigests,
      registryRevision,
    })
    const agentResources = projectAIWorkflowAgentResources(registry)
    const holonTaskRuntimeDefinitions = await projectHolonTaskRuntimeDefinitions({
      registry,
      contentIdentities,
      kindDefinitionAuthorityDigests,
      registryRevision,
      holonExecutionBindings,
      agentResources,
    })
    return Object.freeze({
      schemaVersion: "eidolon.resource-registry-snapshot/v1",
      contentIdentityRegistry: authoredRegistry,
      registry,
      contentIdentities,
      contentIdentityLayers,
      resolvedResources,
      readerProfileId: resolutionContext.readerProfile.profileId,
      registryRevision,
      appBundles: projectAIWorkflowAppBundles(registry),
      agentResources,
      holonExecutionBindings,
      holonTaskRuntimeDefinitions,
      layers: Object.freeze(layers.map(({ binding }) => binding)),
    })
  }

  private async loadEffectiveVfsSnapshot(
    readPort: EidolonVfsReadPort,
  ): Promise<EidolonResourceRegistrySnapshot> {
    if (readPort.snapshot.rootPath !== "/.eidolon") {
      throw new EidolonResourceRegistryError(
        "EIDOLON_EFFECTIVE_VFS_ROOT_INVALID",
        `Effective VFS root must be '/.eidolon', got '${readPort.snapshot.rootPath}'.`,
      )
    }
    const tree = await loadResourceTreeFromReadPort({
      port: createHalfcodeReadPort(readPort),
      rootPath: EFFECTIVE_VFS_PACKAGE_ROOT,
    })
    const resolutionContext = createEidolonResourceResolutionContext()
    const resolvedTree = resolveAIWorkflowResourceTree(tree, resolutionContext)
    const contentIdentityLayers = Object.freeze([
      Object.freeze({ id: EFFECTIVE_VFS_LAYER_ID, tree }),
    ])
    const authoredRegistry = composeLayeredResourceRegistry({ layers: contentIdentityLayers })
    const registry = composeLayeredResourceRegistry({
      layers: [Object.freeze({ id: EFFECTIVE_VFS_LAYER_ID, tree: resolvedTree })],
    })
    const contentIdentities = resolveEffectiveResourceContentIdentities({
      registry: authoredRegistry,
      layers: contentIdentityLayers,
    })
    const resolvedResources = selectEffectiveResolvedResources(registry, [
      Object.freeze({ id: EFFECTIVE_VFS_LAYER_ID, resolvedTree }),
    ])
    const roots = [...registry.byId.values()]
      .filter((entry) => entry.resource !== undefined)
      .map((entry) => entry.resourceId)
    const registryRevision = roots.length === 0
      ? registry.compositionRevision
      : buildResourceDependencySnapshot({ registry, roots, edges: [], contentIdentities }).registryRevision
    const kindDefinitionAuthorityDigests = await readEffectiveKindDefinitionAuthorityDigests(registry, readPort)
    const holonExecutionBindings = await projectHolonExecutionBindings({
      registry,
      contentIdentities,
      kindDefinitionAuthorityDigests,
      registryRevision,
    })
    const agentResources = projectAIWorkflowAgentResources(registry)
    const holonTaskRuntimeDefinitions = await projectHolonTaskRuntimeDefinitions({
      registry,
      contentIdentities,
      kindDefinitionAuthorityDigests,
      registryRevision,
      holonExecutionBindings,
      agentResources,
    })
    const snapshot = Object.freeze({
      schemaVersion: "eidolon.resource-registry-snapshot/v1" as const,
      contentIdentityRegistry: authoredRegistry,
      registry,
      contentIdentities,
      contentIdentityLayers,
      resolvedResources,
      readerProfileId: resolutionContext.readerProfile.profileId,
      effectiveVfs: Object.freeze({
        revision: readPort.snapshot.revision,
        treeDigest: readPort.snapshot.treeDigest,
        materializationReceiptId: readPort.snapshot.materializationReceiptId,
        packageRoot: EFFECTIVE_VFS_PACKAGE_ROOT,
      }),
      registryRevision,
      appBundles: projectAIWorkflowAppBundles(registry),
      agentResources,
      holonExecutionBindings,
      holonTaskRuntimeDefinitions,
      layers: Object.freeze([]),
    }) satisfies EidolonResourceRegistrySnapshot
    this.effectiveVfsPorts.set(snapshot, readPort)
    return snapshot
  }
}

async function resolveEffectiveVfsSource(source: EffectiveEidolonVfsRegistrySource): Promise<EidolonVfsReadPort> {
  return typeof source === "function" ? await source() : source
}

function createHalfcodeReadPort(readPort: EidolonVfsReadPort): ResourcePackageReadPort {
  return Object.freeze({
    async stat(sourcePath: string) {
      const entry = await readPort.stat(canonicalResourcePackageSourcePath(sourcePath))
      return entry ? Object.freeze({ kind: entry.kind }) : undefined
    },
    async readDirectory(sourcePath: string) {
      const entries = await readPort.readDirectory(canonicalResourcePackageSourcePath(sourcePath))
      return entries?.map((entry) => Object.freeze({
        name: entry.logicalPath.split("/").at(-1) ?? "",
        kind: entry.kind,
      }))
    },
    async readBytes(sourcePath: string) {
      return readPort.readBytes(canonicalResourcePackageSourcePath(sourcePath))
    },
  })
}

function effectiveResourceSourcePath(logicalPath: string): string {
  const issue = safePathLexicalIssue(logicalPath, "relative-path")
  if (issue) throw new EidolonResourceRegistryError(
    "EIDOLON_RESOURCE_SOURCE_PATH_INVALID",
    `Effective resource source path '${logicalPath}' is invalid: ${issue}.`,
  )
  return `${EFFECTIVE_VFS_PACKAGE_ROOT}/${logicalPath}`
}

async function requiredVfsBytes(
  readPort: EidolonVfsReadPort,
  logicalPath: string,
  owner: string,
): Promise<Uint8Array> {
  const bytes = await readPort.readBytes(logicalPath)
  if (!bytes) throw new EidolonResourceRegistryError(
    "EIDOLON_RESOURCE_DEPENDENCY_NOT_FOUND",
    `Effective VFS source '${logicalPath}' for '${owner}' does not exist in revision ${readPort.snapshot.revision}.`,
  )
  return bytes
}

function decodeResourceUtf8(bytes: Uint8Array, owner: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new EidolonResourceRegistryError(
      "EIDOLON_RESOURCE_SOURCE_UTF8_INVALID",
      `Resource source '${owner}' is not valid UTF-8.`,
    )
  }
}

function containedVfsDependencyPath(
  containmentRoot: string,
  base: string,
  relativePath: string,
  scope: "OWNER" | "PACKAGE",
): string {
  const target = path.posix.normalize(path.posix.join(base, relativePath))
  if (target !== containmentRoot && !target.startsWith(`${containmentRoot}/`)) {
    throw new EidolonResourceRegistryError(
      `EIDOLON_RESOURCE_DEPENDENCY_OUTSIDE_${scope}`,
      `Resource dependency '${relativePath}' escapes Effective VFS boundary '${containmentRoot}'.`,
    )
  }
  return target
}

async function captureVfsTextSubtree(
  readPort: EidolonVfsReadPort,
  rootPath: string,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  const visit = async (directory: string, relative: string): Promise<void> => {
    for (const entry of await readPort.readDirectory(directory) ?? []) {
      const name = entry.logicalPath.split("/").at(-1) ?? ""
      const nested = relative ? `${relative}/${name}` : name
      if (entry.kind === "directory") {
        await visit(entry.logicalPath, nested)
        continue
      }
      const bytes = await requiredVfsBytes(readPort, entry.logicalPath, nested)
      files[nested] = decodeResourceUtf8(bytes, nested)
    }
  }
  await visit(rootPath, "")
  return files
}

async function captureFrozenEffectiveVfs(
  readPort: EidolonVfsReadPort,
  rootPath: string,
  prefix: string,
  target: Record<string, string>,
): Promise<void> {
  const sources = await captureVfsTextSubtree(readPort, rootPath)
  for (const [relative, source] of Object.entries(sources)) target[`${prefix}/${relative}`] = source
  const manifest = target[`${prefix}/manifest.xnl`]
  if (manifest) addFrozenCatalogMarkers(manifest, prefix, target)
}

function addFrozenCatalogMarkers(manifest: string, prefix: string, target: Record<string, string>): void {
  for (const match of manifest.matchAll(/\broot\s*=\s*"vfs:\/\/\.\/([^"#?]+)"/g)) {
    const catalogRoot = match[1]!.replace(/\/+$/, "")
    if (!catalogRoot || path.posix.isAbsolute(catalogRoot)
      || catalogRoot.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_FROZEN_RESOURCE_CATALOG_ROOT_INVALID",
        `Frozen resource catalog root '${catalogRoot}' is not a portable relative path.`,
      )
    }
    target[`${prefix}/${catalogRoot}/.eidolon-directory`] = "eidolon.frozen-catalog-root/v1\n"
  }
}

export function createFrozenEffectiveEidolonVfsReadPort(
  closure: Readonly<Record<string, string>>,
): EidolonVfsReadPort {
  const prefix = ".agent-resources/effective-vfs/"
  const filePrefix = `${prefix}.eidolon/`
  const rawProvenance = closure[`${prefix}provenance.json`]
  if (!rawProvenance) throw new EidolonResourceRegistryError(
    "EIDOLON_FROZEN_EFFECTIVE_VFS_PROVENANCE_MISSING",
    "Frozen Effective VFS closure requires provenance.json.",
  )
  let provenance: Record<string, unknown>
  try {
    provenance = JSON.parse(rawProvenance) as Record<string, unknown>
  } catch (error) {
    throw new EidolonResourceRegistryError(
      "EIDOLON_FROZEN_EFFECTIVE_VFS_PROVENANCE_INVALID",
      `Frozen Effective VFS provenance is invalid JSON: ${error instanceof Error ? error.message : String(error)}.`,
    )
  }
  for (const field of ["effectiveVfsRevision", "treeDigest", "materializationReceiptId"] as const) {
    if (typeof provenance[field] !== "string" || !provenance[field]) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_FROZEN_EFFECTIVE_VFS_PROVENANCE_INVALID",
        `Frozen Effective VFS provenance requires '${field}'.`,
      )
    }
  }
  const files = new Map<string, Uint8Array>()
  const directories = new Set<string>(["/.eidolon", EFFECTIVE_VFS_PACKAGE_ROOT])
  for (const [frozenPath, source] of Object.entries(closure)) {
    if (!frozenPath.startsWith(filePrefix)) continue
    const relative = frozenPath.slice(filePrefix.length)
    if (!relative || relative.endsWith("/.eidolon-directory")) continue
    const issue = safePathLexicalIssue(relative, "relative-path")
    if (issue) throw new EidolonResourceRegistryError(
      "EIDOLON_FROZEN_EFFECTIVE_VFS_PATH_INVALID",
      `Frozen Effective VFS path '${relative}' is invalid: ${issue}.`,
    )
    const logicalPath = `/.eidolon/${relative}`
    files.set(logicalPath, new TextEncoder().encode(source))
    let parent = path.posix.dirname(logicalPath)
    while (parent.startsWith("/.eidolon")) {
      directories.add(parent)
      if (parent === "/.eidolon") break
      parent = path.posix.dirname(parent)
    }
  }
  const revision = provenance.effectiveVfsRevision as `sha256:${string}`
  const treeDigest = provenance.treeDigest as `sha256:${string}`
  const snapshot = Object.freeze({
    schemaVersion: "eidolon.effective-vfs-snapshot/v1",
    revision,
    baseRevision: revision,
    rootPath: "/.eidolon",
    treeDigest,
    overlays: Object.freeze([]),
    materializationReceiptId: provenance.materializationReceiptId as string,
    admittedAt: "frozen-recovery",
  }) satisfies EffectiveEidolonVfsSnapshot
  const nodeId = (kind: string, logicalPath: string): string => sha256Digest(`${kind}\0${logicalPath}`).slice("sha256:".length, 32)
  const entry = (logicalPath: string): EidolonVfsEntry | undefined => {
    if (directories.has(logicalPath)) {
      return Object.freeze({ kind: "directory", logicalPath, nodeId: nodeId("directory", logicalPath) })
    }
    const bytes = files.get(logicalPath)
    if (!bytes) return undefined
    return Object.freeze({
      kind: "file",
      logicalPath,
      nodeId: nodeId("file", logicalPath),
      size: bytes.byteLength,
      fileType: logicalPath.endsWith(".xnl") ? "xnl" : "text",
      contentDigest: sha256Digest(bytes),
    })
  }
  return Object.freeze({
    snapshot,
    async stat(logicalPath: string) { return entry(logicalPath) },
    async readDirectory(logicalPath: string) {
      if (!directories.has(logicalPath)) return undefined
      const prefixPath = `${logicalPath}/`
      const children = new Set<string>()
      for (const candidate of [...directories, ...files.keys()]) {
        if (!candidate.startsWith(prefixPath)) continue
        const relative = candidate.slice(prefixPath.length)
        if (!relative || relative.includes("/")) continue
        children.add(candidate)
      }
      return Object.freeze([...children].sort().flatMap((candidate) => {
        const value = entry(candidate)
        return value ? [value] : []
      }))
    },
    async readBytes(logicalPath: string) {
      const bytes = files.get(logicalPath)
      return bytes ? new Uint8Array(bytes) : undefined
    },
  })
}

export async function loadFrozenEffectiveEidolonVfsReadPort(rootDir: string): Promise<EidolonVfsReadPort> {
  const files: Record<string, string> = {}
  await captureFrozenLayer(rootDir, ".agent-resources/effective-vfs", files)
  return createFrozenEffectiveEidolonVfsReadPort(files)
}

async function readEffectiveKindDefinitionAuthorityDigests(
  registry: EffectiveResourceRegistry,
  readPort: EidolonVfsReadPort,
): Promise<ReadonlyMap<string, `sha256:${string}`>> {
  const digests = new Map<string, `sha256:${string}`>()
  for (const [kind, effective] of registry.kindDefinitions) {
    const documentUri = effective.definition.documentUri
    if (!documentUri.startsWith("vfs://@/")) continue
    const relative = documentUri.slice("vfs://@/".length)
    const sourcePath = effectiveResourceSourcePath(relative)
    digests.set(kind, sha256Digest(await requiredVfsBytes(readPort, sourcePath, effective.definition.resourceId)))
  }
  return digests
}

async function readKindDefinitionAuthorityDigests(
  registry: EffectiveResourceRegistry,
  layers: readonly LoadedLayer[],
): Promise<ReadonlyMap<string, `sha256:${string}`>> {
  const digests = new Map<string, `sha256:${string}`>()
  for (const [kind, effective] of registry.kindDefinitions) {
    const documentUri = effective.definition.documentUri
    if (!documentUri.startsWith("vfs://@/")) continue
    const relative = documentUri.slice("vfs://@/".length)
    const issue = safePathLexicalIssue(relative, "relative-path")
    if (issue) throw new EidolonResourceRegistryError(
      "EIDOLON_KIND_DEFINITION_PATH_INVALID",
      `KindDefinition '${effective.definition.resourceId}' has an unsafe source path: ${issue}.`,
    )
    const origin = [...effective.origins]
      .filter((candidate) => candidate.documentUri === documentUri)
      .sort((left, right) => right.layerIndex - left.layerIndex)[0]
    const layer = layers.find((candidate) => candidate.binding.id === origin?.layerId)
    if (!origin || !layer) throw new EidolonResourceRegistryError(
      "EIDOLON_KIND_DEFINITION_ORIGIN_MISSING",
      `KindDefinition '${effective.definition.resourceId}' has no effective physical origin.`,
    )
    const canonicalRoot = await realpath(layer.binding.rootDir)
    const canonicalTarget = await realpath(path.resolve(canonicalRoot, ...relative.split("/")))
    if (!isContained(canonicalRoot, canonicalTarget)) throw new EidolonResourceRegistryError(
      "EIDOLON_KIND_DEFINITION_ORIGIN_OUTSIDE_LAYER",
      `KindDefinition '${effective.definition.resourceId}' escapes layer '${origin.layerId}'.`,
    )
    digests.set(kind, sha256Digest(await readFile(canonicalTarget)))
  }
  return digests
}

async function captureFrozenLayer(rootDir: string, prefix: string, target: Record<string, string>): Promise<void> {
  const canonicalRoot = await realpath(rootDir)
  const visit = async (directory: string, relative: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const absolute = path.join(directory, entry.name)
      const nested = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new EidolonResourceRegistryError(
        "EIDOLON_FROZEN_RESOURCE_CLOSURE_LINK_UNSUPPORTED",
        `Frozen resource closure entry '${nested}' cannot be a symbolic link.`,
      )
      const info = await lstat(absolute)
      if (info.isDirectory()) {
        await visit(absolute, nested)
        continue
      }
      if (!info.isFile()) throw new EidolonResourceRegistryError(
        "EIDOLON_FROZEN_RESOURCE_CLOSURE_ENTRY_UNSUPPORTED",
        `Frozen resource closure entry '${nested}' must be a regular file.`,
      )
      const canonical = await realpath(absolute)
      if (!isContained(canonicalRoot, canonical)) throw new EidolonResourceRegistryError(
        "EIDOLON_FROZEN_RESOURCE_CLOSURE_OUTSIDE_LAYER",
        `Frozen resource closure entry '${nested}' escapes its layer.`,
      )
      try {
        target[`${prefix}/${nested}`] = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(canonical))
      } catch {
        throw new EidolonResourceRegistryError(
          "EIDOLON_FROZEN_RESOURCE_CLOSURE_UTF8_INVALID",
          `Frozen resource closure entry '${nested}' is not valid UTF-8.`,
        )
      }
    }
  }
  await visit(canonicalRoot, "")
  const manifest = target[`${prefix}/manifest.xnl`]
  if (manifest) {
    for (const match of manifest.matchAll(/\broot\s*=\s*"vfs:\/\/\.\/([^"#?]+)"/g)) {
      const catalogRoot = match[1]!.replace(/\/+$/, "")
      if (!catalogRoot || path.posix.isAbsolute(catalogRoot)
        || catalogRoot.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
        throw new EidolonResourceRegistryError(
          "EIDOLON_FROZEN_RESOURCE_CATALOG_ROOT_INVALID",
          `Frozen resource catalog root '${catalogRoot}' is not a portable relative path.`,
        )
      }
      target[`${prefix}/${catalogRoot}/.eidolon-directory`] = "eidolon.frozen-catalog-root/v1\n"
    }
  }
}

function normalizeLayerBindings(
  input: readonly ResourcePackageLayerBinding[],
): readonly ResourcePackageLayerBinding[] {
  const seen = new Set<ResourcePackageLayerId>()
  const normalized = input.map((binding) => {
    if (binding.id !== "global" && binding.id !== "workspace") {
      throw new EidolonResourceRegistryError(
        "EIDOLON_RESOURCE_LAYER_ID_INVALID",
        `Resource layer id must be 'global' or 'workspace', got '${String(binding.id)}'.`,
      )
    }
    if (seen.has(binding.id)) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_RESOURCE_LAYER_ID_DUPLICATE",
        `Resource layer '${binding.id}' is configured more than once.`,
      )
    }
    seen.add(binding.id)
    if (typeof binding.rootDir !== "string" || !path.isAbsolute(binding.rootDir)) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_RESOURCE_LAYER_ROOT_INVALID",
        `Resource layer '${binding.id}' root must be an absolute path.`,
      )
    }
    return Object.freeze({ id: binding.id, rootDir: path.resolve(binding.rootDir) })
  })
  normalized.sort((left, right) => LAYER_ORDER[left.id] - LAYER_ORDER[right.id])
  return Object.freeze(normalized)
}

async function directoryExists(rootDir: string): Promise<boolean> {
  try {
    const facts = await stat(rootDir)
    if (!facts.isDirectory()) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_RESOURCE_LAYER_ROOT_NOT_DIRECTORY",
        `Resource layer root '${rootDir}' is not a directory.`,
      )
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

function exactResourceId(value: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new EidolonResourceRegistryError(
      "EIDOLON_RESOURCE_ID_INVALID",
      "Resource id must be an exact non-empty string without surrounding whitespace.",
    )
  }
  return value
}

function exactResourceRef(value: string): `resource://${string}` {
  const prefix = "resource://"
  if (typeof value !== "string" || value !== value.trim() || !value.startsWith(prefix)) {
    throw new EidolonResourceRegistryError(
      "EIDOLON_RESOURCE_AGENT_REF_INVALID",
      "Agent definition ref must be one exact resource:// identity.",
    )
  }
  const resourceId = value.slice(prefix.length)
  if (!resourceId || resourceId !== resourceId.trim() || resourceId.includes("://")) {
    throw new EidolonResourceRegistryError(
      "EIDOLON_RESOURCE_AGENT_REF_INVALID",
      "Agent definition ref must be one exact resource:// identity.",
    )
  }
  return value as `resource://${string}`
}

function exactDependencyPath(value: string): string {
  const issue = typeof value === "string"
    ? safePathLexicalIssue(value, "relative-path")
    : "must be a string"
  if (issue) {
    throw new EidolonResourceRegistryError(
      "EIDOLON_RESOURCE_DEPENDENCY_PATH_INVALID",
      `Resource dependency path must be one exact containment-safe relative path: ${issue}.`,
    )
  }
  return value
}

function resourceRef(resourceId: string): `resource://${string}` {
  return `resource://${resourceId}`
}

function sameAgentTask(left: AIWorkflowAgentTaskRef, right: AIWorkflowAgentTaskRef): boolean {
  return left.workflowKind === right.workflowKind
    && left.workflowRef === right.workflowRef
    && left.nodeId === right.nodeId
    && left.agentDefinitionRef === right.agentDefinitionRef
}

function effectiveResource(
  snapshot: EidolonResourceRegistrySnapshot,
  resourceId: string,
): ResourceRecord {
  const resource = snapshot.registry.byId.get(resourceId)?.resource
  if (!resource) {
    throw new EidolonResourceRegistryError(
      "EIDOLON_RESOURCE_NOT_FOUND",
      `Resource '${resourceId}' is not present in registry ${snapshot.registryRevision}.`,
    )
  }
  return resource
}

function selectEffectiveResolvedResources(
  registry: EffectiveResourceRegistry,
  layers: readonly Readonly<{ id: string; resolvedTree: ResolvedResourceTree }>[],
): ReadonlyMap<string, ResolvedResourceRecord> {
  const recordsByLayer = new Map(layers.map(({ id, resolvedTree }) => [
    id,
    new Map([...resolvedTree.registry.byKind.values()]
      .flatMap((records) => records)
      .map((record) => [record.resourceId, record] as const)),
  ] as const))
  const selected = new Map<string, ResolvedResourceRecord>()
  for (const entry of registry.byId.values()) {
    if (!entry.resource || !entry.effectiveLayerId) continue
    const resolved = recordsByLayer.get(entry.effectiveLayerId)?.get(entry.resourceId)
    if (!resolved || resolved.stage !== "resolved" || resolved.kind !== entry.kind) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_RESOURCE_RESOLUTION_PROOF_MISSING",
        `Effective resource '${entry.resourceId}' has no exact reader-admitted record in layer '${entry.effectiveLayerId}'.`,
      )
    }
    selected.set(entry.resourceId, resolved)
  }
  return selected
}

function requiredResolvedResource(
  snapshot: EidolonResourceRegistrySnapshot,
  resource: ResourceRecord,
): ResolvedResourceRecord<PortableSpec> {
  const resolved = snapshot.resolvedResources.get(resource.resourceId)
  if (!resolved || resolved.kind !== resource.kind || resolved.stage !== "resolved") {
    throw new EidolonResourceRegistryError(
      "EIDOLON_RESOURCE_RESOLUTION_PROOF_MISSING",
      `Resource '${resource.resourceId}' has no exact reader resolution proof in profile '${snapshot.readerProfileId}'.`,
    )
  }
  return resolved as ResolvedResourceRecord<PortableSpec>
}

type ClosedResourceDescriptor = Readonly<{
  implementation?: unknown
  stages?: unknown
}>

function parseClosedResourceDescriptor(
  snapshot: EidolonResourceRegistrySnapshot,
  resource: ResourceRecord,
  expectedKind: "AgentMessageSource" | "AgentContextPipeline",
): ClosedResourceDescriptor {
  if (resource.kind !== expectedKind) {
    throw new EidolonResourceRegistryError(
      "EIDOLON_AGENT_CODE_RESOURCE_KIND_MISMATCH",
      `Resource '${resource.resourceId}' must have kind '${expectedKind}', got '${resource.kind}'.`,
    )
  }
  const descriptorSpec = requiredResolvedResource(snapshot, resource).readerValue
  const subdomains = portableRecord(descriptorSpec.subdomains)
  const contentNode = portableRecord(subdomains?.Content)
  const content = contentNode?.text
  if (typeof content !== "string" || !content.trim()) {
    throw new EidolonResourceRegistryError(
      "EIDOLON_AGENT_CODE_RESOURCE_CONTENT_MISSING",
      `Resource '${resource.resourceId}' requires one non-empty JSON code descriptor in Content.`,
    )
  }
  try {
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object")
    return Object.freeze({ ...(parsed as Record<string, unknown>) })
  } catch (error) {
    throw new EidolonResourceRegistryError(
      "EIDOLON_AGENT_CODE_RESOURCE_CONTENT_INVALID",
      `Resource '${resource.resourceId}' code descriptor must be exact JSON: ${error instanceof Error ? error.message : String(error)}.`,
    )
  }
}

function portableRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function loadWorkspaceAgentInstructions(workspaceRoot: string): string | null {
  try {
    const target = path.join(workspaceRoot, "AGENTS.md")
    if (!lstatSync(target).isFile()) return null
    const content = readFileSync(target, "utf8").trim()
    return content ? `AGENTS.md (workspace):\n${content}` : null
  } catch {
    return null
  }
}

const STANDARD_CONTEXT_PIPELINE_STAGES = Object.freeze([
  "prompt-plan",
  "conversation-prelude",
  "provider-context-facts-at-history-anchors",
  "stable-message-prefix",
  "conversation-boundary-overlays",
  "provider-conversion",
])

function materializeAgentContextPipeline(
  agent: AIAgentDefinitionProjection,
  snapshot: EidolonResourceRegistrySnapshot,
): AgentContextPipelineBinding | undefined {
  if (!agent.contextPipeline) return undefined
  const resource = effectiveResource(snapshot, agent.contextPipeline.resource.resourceId)
  if (resource !== agent.contextPipeline.resource || resource.kind !== agent.contextPipeline.kind) {
    throw new EidolonResourceRegistryError(
      "EIDOLON_RESOURCE_AGENT_CONTEXT_PIPELINE_IDENTITY_MISMATCH",
      `Agent ContextPipeline does not match the selected effective resource.`,
    )
  }
  const descriptor = parseClosedResourceDescriptor(snapshot, resource, "AgentContextPipeline")
  if (descriptor.implementation !== "eidolon.standard-context-pipeline/v1") {
    throw new EidolonResourceRegistryError(
      "EIDOLON_AGENT_CONTEXT_PIPELINE_IMPLEMENTATION_UNSUPPORTED",
      `ContextPipeline '${resource.resourceId}' selects unsupported implementation '${String(descriptor.implementation)}'.`,
    )
  }
  if (!Array.isArray(descriptor.stages)
    || descriptor.stages.length !== STANDARD_CONTEXT_PIPELINE_STAGES.length
    || descriptor.stages.some((stage, index) => stage !== STANDARD_CONTEXT_PIPELINE_STAGES[index])) {
    throw new EidolonResourceRegistryError(
      "EIDOLON_AGENT_CONTEXT_PIPELINE_STAGES_INVALID",
      `ContextPipeline '${resource.resourceId}' must declare the canonical ordered stage ledger.`,
    )
  }
  return Object.freeze({
    schemaVersion: "eidolon.agent-context-pipeline-binding/v1",
    resourceId: resource.resourceId,
    contentDigest: requiredContentIdentity(snapshot, resource.resourceId).contentDigest,
    implementation: "eidolon.standard-context-pipeline/v1",
    stages: STANDARD_CONTEXT_PIPELINE_STAGES,
  })
}

function requiredContentIdentity(
  snapshot: EidolonResourceRegistrySnapshot,
  resourceId: string,
): ResourceContentIdentity {
  const identity = snapshot.contentIdentities.get(resourceId)
  if (!identity) {
    throw new EidolonResourceRegistryError(
      "EIDOLON_RESOURCE_CONTENT_IDENTITY_MISSING",
      `Resource '${resourceId}' has no effective Halfcode content identity.`,
    )
  }
  return identity
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function appBrief(
  app: AIWorkflowAppBundleProjection,
  registryRevision: string,
): EidolonWorkflowAppBrief {
  return Object.freeze({
    id: app.resource.resourceId,
    ...(app.resource.description === undefined ? {} : { description: app.resource.description }),
    workflowCount: app.workflowBindings.length,
    entrypoints: Object.freeze(app.entrypoints.map((binding) => binding.ref)),
    registryRevision,
  })
}

function agentBrief(
  agent: AIAgentDefinitionProjection,
  registryRevision: string,
): EidolonReusableAgentBrief {
  return Object.freeze({
    id: agent.resource.resourceId,
    ...(agent.resource.description === undefined ? {} : { description: agent.resource.description }),
    messageCount: agent.messages.length,
    toolCount: agent.tools.length,
    materialPortCount: agent.materialPorts.length,
    promptLoaded: false,
    registryRevision,
  })
}

export function mergeResourceAgentConfigs(
  localAgents: Readonly<Record<string, AgentConfig>>,
  plans: readonly EidolonResourceAgentExecutionPlan[],
): Readonly<Record<string, AgentConfig>> {
  const merged: Record<string, AgentConfig> = { ...localAgents }
  for (const plan of plans) {
    const key = plan.agentDefinitionRef
    if (Object.prototype.hasOwnProperty.call(merged, key)) {
      throw new EidolonResourceRegistryError(
        "EIDOLON_RESOURCE_AGENT_REGISTRY_COLLISION",
        `Agent registry key '${key}' is already owned by another Agent config.`,
      )
    }
    merged[key] = plan.agentConfig
  }
  return Object.freeze(merged)
}
