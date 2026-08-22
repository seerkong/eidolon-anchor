import path from "node:path"

import {
  EidolonAppResourceRegistryAdapter,
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
    repository?: WorkflowDefinitionRepository
  }) {
    this.authoring = options?.authoring
    const store = this.authoring?.store
    if (!store && !options?.sessions) {
      throw new Error("WorkflowComponent requires an authoring store or session store")
    }
    this.sessions = options?.sessions ?? new WorkflowAuthoringSessionStore(store!)
    this.catalog = options?.catalog ?? new WorkflowAuthoringCatalog()
    this.resourceRegistry = options?.resourceRegistry ?? new EidolonAppResourceRegistryAdapter()
    this.resourcePackagePublisher = options?.resourcePackagePublisher
      ?? (options?.resourceLayers?.some((layer) => layer.id === "workspace")
        ? new WorkflowResourcePackagePublisher(this.sessions, this.resourceRegistry, options.resourceLayers)
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
  store?: WorkflowAuthoringStore
  resources?: WorkflowResourceLoader
  catalog?: WorkflowAuthoringCatalog
  candidateHarness?: WorkflowCandidateAcceptanceHarness
  resourceLayers?: readonly ResourcePackageLayerBinding[]
  resourceRegistry?: EidolonAppResourceRegistryAdapter
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

export function createWorkflowComponent(options: WorkflowComponentOptions = {}): WorkflowComponent {
  const resources = options.resources ?? new WorkflowResourceLoader()
  const store = options.store
    ?? (options.workspaceRoot ? new NodeWorkflowAuthoringStore(options.workspaceRoot) : undefined)
  const effectiveStore = store ?? new NodeWorkflowAuthoringStore(path.resolve(process.cwd(), ".eidolon", "workflows"))
  const authoring = new WorkflowAuthoringWorkspace(effectiveStore, resources)
  const resourceRegistry = options.resourceRegistry ?? new EidolonAppResourceRegistryAdapter({
    layers: options.resourceLayers,
  })
  const sessions = new WorkflowAuthoringSessionStore(
    effectiveStore,
    resources,
    options.candidateHarness,
    {
      registry: resourceRegistry,
      layers: options.resourceLayers ?? [],
    },
  )
  return new WorkflowComponent({
    resources,
    authoring,
    sessions,
    catalog: options.catalog,
    resourceRegistry,
    resourceLayers: options.resourceLayers ?? [],
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
    resourceLayers: options.resourceLayers ?? runtimeResourcePackageLayers(runtime),
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
