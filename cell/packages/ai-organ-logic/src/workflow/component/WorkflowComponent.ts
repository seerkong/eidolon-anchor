import path from "node:path"
import type { DefinitionStepExtensionCodecRegistryPort } from "flow-step-space-contract"
import type { EidolonVfsReadPort } from "@cell/symbiont-contract/resource/EffectiveEidolonVFS"

import {
  EidolonAppResourceRegistryAdapter,
  type EffectiveEidolonVfsRegistrySource,
  type EidolonEffectiveVfsAuthoringPort,
  type ResourcePackageLayerBinding,
} from "../../resources"

import {
  NodeWorkflowAuthoringStore,
  WorkflowAuthoringCatalog,
  WorkflowAuthoringSessionStore,
  WorkflowAuthoringWorkspace,
  type WorkflowCandidateAcceptanceHarness,
  type WorkflowAuthoringStore,
} from "../authoring"
import { WorkflowResourceLoader } from "../resources"
import { createAIDataAgentPreparationExtensionCodecRegistry } from "../runtime/AIDataAgentResourcePreparation"
import { createAIDataAutonomousControlExtensionCodecRegistry } from "../runtime/AIDataAutonomousControlLoop"
import { createAIDataChildAgentPreparationExtensionCodecRegistry } from "../runtime/AIDataChildAgentPreparation"
import { WorkflowDefinitionRepository } from "../runtime/WorkflowDefinitionRepository"
import { WorkflowCommandService } from "./WorkflowCommandService"
import { WorkflowQueryService } from "./WorkflowQueryService"
import { WorkflowResourcePackagePublisher } from "./WorkflowResourcePackagePublisher"

export class WorkflowComponent {
  readonly queries: WorkflowQueryService
  readonly commands: WorkflowCommandService
  readonly authoring?: WorkflowAuthoringWorkspace
  readonly sessions: WorkflowAuthoringSessionStore
  readonly catalog: WorkflowAuthoringCatalog
  readonly resourceRegistry: EidolonAppResourceRegistryAdapter
  readonly resourcePackagePublisher?: WorkflowResourcePackagePublisher
  readonly repository?: WorkflowDefinitionRepository
  readonly effectiveVfsAuthoring?: EidolonEffectiveVfsAuthoringPort
  readonly resourceLayers: readonly ResourcePackageLayerBinding[]

  constructor(options?: {
    queries?: WorkflowQueryService
    commands?: WorkflowCommandService
    resources?: WorkflowResourceLoader
    authoring?: WorkflowAuthoringWorkspace
    sessions?: WorkflowAuthoringSessionStore
    catalog?: WorkflowAuthoringCatalog
    resourceRegistry?: EidolonAppResourceRegistryAdapter
    resourcePackagePublisher?: WorkflowResourcePackagePublisher
    resourceLayers?: readonly ResourcePackageLayerBinding[]
    effectiveVfs?: EffectiveEidolonVfsRegistrySource
    effectiveVfsAuthoring?: EidolonEffectiveVfsAuthoringPort
    repository?: WorkflowDefinitionRepository
  }) {
    const usesEffectiveVfs = options?.effectiveVfs !== undefined
    if (usesEffectiveVfs && options?.resourcePackagePublisher) {
      throw new Error("WorkflowComponent cannot combine Effective VFS with a physical ResourcePackage publisher")
    }
    const resourceLayers = usesEffectiveVfs ? [] : options?.resourceLayers ?? []
    this.authoring = options?.authoring
    const store = this.authoring?.store
    if (!store && !options?.sessions) {
      throw new Error("WorkflowComponent requires an authoring store or session store")
    }
    this.sessions = options?.sessions ?? new WorkflowAuthoringSessionStore(store!)
    this.catalog = options?.catalog ?? new WorkflowAuthoringCatalog()
    this.resourceRegistry = options?.resourceRegistry ?? new EidolonAppResourceRegistryAdapter({
      ...(options?.effectiveVfs ? { effectiveVfs: options.effectiveVfs } : { layers: resourceLayers }),
    })
    this.effectiveVfsAuthoring = options?.effectiveVfsAuthoring
    this.resourceLayers = Object.freeze([...resourceLayers])
    this.resourcePackagePublisher = options?.resourcePackagePublisher
      ?? (resourceLayers.some((layer) => layer.id === "workspace")
        ? new WorkflowResourcePackagePublisher(this.sessions, this.resourceRegistry, resourceLayers)
        : undefined)
    this.repository = options?.repository ?? (this.authoring
      ? new WorkflowDefinitionRepository(
          this.authoring,
          options?.resources ?? new WorkflowResourceLoader(),
          this.resourceRegistry,
        )
      : undefined)
    this.queries = options?.queries ?? new WorkflowQueryService(this.repository, this.resourceRegistry)
    this.commands = options?.commands
      ?? new WorkflowCommandService(options?.resources ?? new WorkflowResourceLoader())
  }
}

export type WorkflowComponentOptions = {
  workspaceRoot?: string
  resourceWorkspaceRoot?: string
  store?: WorkflowAuthoringStore
  resources?: WorkflowResourceLoader
  catalog?: WorkflowAuthoringCatalog
  candidateHarness?: WorkflowCandidateAcceptanceHarness
  resourceLayers?: readonly ResourcePackageLayerBinding[]
  effectiveVfs?: EffectiveEidolonVfsRegistrySource
  effectiveVfsAuthoring?: EidolonEffectiveVfsAuthoringPort
  resourceRegistry?: EidolonAppResourceRegistryAdapter
  extensionCodecs?: DefinitionStepExtensionCodecRegistryPort
}

export type WorkflowComponentRuntimeLike = {
  vm?: {
    outerCtx?: {
      workDir?: unknown
      metadata?: unknown
    }
  }
}

const COMPONENT_BY_VM = new WeakMap<object, WorkflowComponent>()

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined
}

function runtimeWorkspaceRoot(runtime: WorkflowComponentRuntimeLike): string {
  const outerCtx = runtime.vm?.outerCtx
  const metadata = record(outerCtx?.metadata)
  const aiWorkflow = record(metadata?.aiWorkflow)
  const roots = record(aiWorkflow?.roots)
  const injected = typeof roots?.workspaceRoot === "string" ? roots.workspaceRoot : undefined
  if (injected && path.isAbsolute(injected)) return path.resolve(injected)
  const workDir = typeof outerCtx?.workDir === "string" && path.isAbsolute(outerCtx.workDir)
    ? outerCtx.workDir
    : process.cwd()
  return path.join(workDir, ".eidolon", "workflows")
}

function runtimeResourcePackageLayers(runtime: WorkflowComponentRuntimeLike): readonly ResourcePackageLayerBinding[] {
  const metadata = record(runtime.vm?.outerCtx?.metadata)
  const resourcePackages = record(metadata?.resourcePackages)
  if (resourcePackages?.layers === undefined) return []
  if (!Array.isArray(resourcePackages.layers)) {
    throw new Error("Eidolon resourcePackages.layers must be an array")
  }
  return resourcePackages.layers.map((value, index) => {
    const layer = record(value)
    if (!layer || (layer.id !== "global" && layer.id !== "workspace") || typeof layer.rootDir !== "string") {
      throw new Error(`Eidolon resourcePackages.layers[${index}] is invalid`)
    }
    return Object.freeze({ id: layer.id, rootDir: layer.rootDir })
  })
}

function runtimeEffectiveVfs(runtime: WorkflowComponentRuntimeLike): EffectiveEidolonVfsRegistrySource | undefined {
  const metadata = record(runtime.vm?.outerCtx?.metadata)
  const resourcePackages = record(metadata?.resourcePackages)
  const candidate = resourcePackages?.effectiveVfs as Partial<EidolonVfsReadPort> | (() => EidolonVfsReadPort) | undefined
  if (typeof candidate === "function") return candidate
  return candidate
    && typeof candidate.stat === "function"
    && typeof candidate.readDirectory === "function"
    && typeof candidate.readBytes === "function"
    && typeof candidate.snapshot === "object"
    ? candidate as EidolonVfsReadPort
    : undefined
}

function runtimeEffectiveVfsAuthoring(
  runtime: WorkflowComponentRuntimeLike,
): EidolonEffectiveVfsAuthoringPort | undefined {
  const metadata = record(runtime.vm?.outerCtx?.metadata)
  const resourcePackages = record(metadata?.resourcePackages)
  const candidate = resourcePackages?.effectiveVfsAuthoring as Partial<EidolonEffectiveVfsAuthoringPort> | undefined
  return candidate
    && typeof candidate.workspaceResourceRoot === "string"
    && typeof candidate.read === "function"
    && typeof candidate.prepare === "function"
    && typeof candidate.admit === "function"
    ? candidate as EidolonEffectiveVfsAuthoringPort
    : undefined
}

function runtimeStepExtensionCodecs(
  runtime: WorkflowComponentRuntimeLike,
): DefinitionStepExtensionCodecRegistryPort {
  const metadata = record(runtime.vm?.outerCtx?.metadata)
  const aiWorkflow = record(metadata?.aiWorkflow)
  const candidate = aiWorkflow?.extensionCodecs
  const fallback = candidate
    && typeof candidate === "object"
    && typeof (candidate as { resolve?: unknown }).resolve === "function"
    ? candidate as DefinitionStepExtensionCodecRegistryPort
    : undefined
  return createAIDataChildAgentPreparationExtensionCodecRegistry(createAIDataAgentPreparationExtensionCodecRegistry(
    createAIDataAutonomousControlExtensionCodecRegistry(fallback),
  ))
}

export function createWorkflowComponent(options: WorkflowComponentOptions = {}): WorkflowComponent {
  const resources = options.resources ?? new WorkflowResourceLoader(
    createAIDataChildAgentPreparationExtensionCodecRegistry(createAIDataAgentPreparationExtensionCodecRegistry(
      createAIDataAutonomousControlExtensionCodecRegistry(options.extensionCodecs),
    )),
  )
  const store = options.store
    ?? (options.workspaceRoot ? new NodeWorkflowAuthoringStore(options.workspaceRoot) : undefined)
  const effectiveStore = store ?? new NodeWorkflowAuthoringStore(path.resolve(process.cwd(), ".eidolon", "workflows"))
  const authoring = new WorkflowAuthoringWorkspace(effectiveStore, resources)
  const resourceLayers = options.effectiveVfs ? [] : options.resourceLayers ?? []
  const resourceRegistry = options.resourceRegistry ?? new EidolonAppResourceRegistryAdapter({
    ...(options.effectiveVfs ? { effectiveVfs: options.effectiveVfs } : { layers: resourceLayers }),
    workspaceRoot: options.resourceWorkspaceRoot ?? options.workspaceRoot,
  })
  const sessions = new WorkflowAuthoringSessionStore(
    effectiveStore,
    resources,
    options.candidateHarness,
    {
      registry: resourceRegistry,
      layers: resourceLayers,
    },
  )
  return new WorkflowComponent({
    resources,
    authoring,
    sessions,
    catalog: options.catalog,
    resourceRegistry,
    resourceLayers,
    effectiveVfs: options.effectiveVfs,
    effectiveVfsAuthoring: options.effectiveVfsAuthoring,
  })
}

export function createWorkflowComponentForRuntime(
  runtime: WorkflowComponentRuntimeLike,
  options: Omit<WorkflowComponentOptions, "workspaceRoot"> = {},
): WorkflowComponent {
  const vm = runtime.vm
  const canReuseBinding = vm !== undefined
    && options.store === undefined
    && options.resources === undefined
    && options.catalog === undefined
    && options.candidateHarness === undefined
    && options.resourceLayers === undefined
    && options.effectiveVfs === undefined
    && options.effectiveVfsAuthoring === undefined
    && options.resourceRegistry === undefined
  if (canReuseBinding) {
    const existing = COMPONENT_BY_VM.get(vm)
    if (existing) return existing
  }
  const component = createWorkflowComponentForRuntimeBinding({
    workDir: typeof runtime.vm?.outerCtx?.workDir === "string"
      ? runtime.vm.outerCtx.workDir
      : process.cwd(),
    metadata: record(runtime.vm?.outerCtx?.metadata),
  }, options)
  if (canReuseBinding) COMPONENT_BY_VM.set(vm!, component)
  return component
}

export function createWorkflowComponentForRuntimeBinding(
  binding: { readonly workDir: string; readonly metadata?: Record<string, unknown> },
  options: Omit<WorkflowComponentOptions, "workspaceRoot"> = {},
): WorkflowComponent {
  const runtime = {
    vm: {
      outerCtx: {
        workDir: binding.workDir,
        metadata: binding.metadata,
      },
    },
  }
  return createWorkflowComponent({
    ...options,
    workspaceRoot: runtimeWorkspaceRoot(runtime),
    resourceWorkspaceRoot: options.resourceWorkspaceRoot ?? binding.workDir,
    resourceLayers: options.resourceLayers ?? runtimeResourcePackageLayers(runtime),
    effectiveVfs: options.effectiveVfs ?? runtimeEffectiveVfs(runtime),
    effectiveVfsAuthoring: options.effectiveVfsAuthoring ?? runtimeEffectiveVfsAuthoring(runtime),
    extensionCodecs: options.extensionCodecs ?? runtimeStepExtensionCodecs(runtime),
  })
}

export function bindWorkflowComponentToRuntime(
  runtime: WorkflowComponentRuntimeLike,
  component: WorkflowComponent,
): void {
  const vm = runtime.vm
  if (!vm) throw new Error("WorkflowComponent runtime binding requires a VM")
  const existing = COMPONENT_BY_VM.get(vm)
  if (existing && existing !== component) {
    throw new Error("WorkflowComponent runtime binding already has another component")
  }
  COMPONENT_BY_VM.set(vm, component)
}
