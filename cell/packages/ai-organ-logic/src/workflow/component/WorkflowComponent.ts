import path from "node:path"

import {
  NodeWorkflowAuthoringStore,
  WorkflowAuthoringCatalog,
  WorkflowAuthoringSessionStore,
  WorkflowAuthoringWorkspace,
  type WorkflowCandidateAcceptanceHarness,
  type WorkflowAuthoringStore,
} from "../authoring"
import { WorkflowResourceLoader } from "../resources"
import { WorkflowCommandService } from "./WorkflowCommandService"
import { WorkflowQueryService } from "./WorkflowQueryService"

export class WorkflowComponent {
  readonly queries: WorkflowQueryService
  readonly commands: WorkflowCommandService
  readonly authoring?: WorkflowAuthoringWorkspace
  readonly sessions: WorkflowAuthoringSessionStore
  readonly catalog: WorkflowAuthoringCatalog

  constructor(options?: {
    queries?: WorkflowQueryService
    commands?: WorkflowCommandService
    resources?: WorkflowResourceLoader
    authoring?: WorkflowAuthoringWorkspace
    sessions?: WorkflowAuthoringSessionStore
    catalog?: WorkflowAuthoringCatalog
  }) {
    this.authoring = options?.authoring
    const store = this.authoring?.store
    if (!store && !options?.sessions) {
      throw new Error("WorkflowComponent requires an authoring store or session store")
    }
    this.sessions = options?.sessions ?? new WorkflowAuthoringSessionStore(store!)
    this.catalog = options?.catalog ?? new WorkflowAuthoringCatalog()
    this.queries = options?.queries ?? new WorkflowQueryService(this.authoring)
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

export function createWorkflowComponent(options: WorkflowComponentOptions = {}): WorkflowComponent {
  const resources = options.resources ?? new WorkflowResourceLoader()
  const store = options.store
    ?? (options.workspaceRoot ? new NodeWorkflowAuthoringStore(options.workspaceRoot) : undefined)
  const effectiveStore = store ?? new NodeWorkflowAuthoringStore(path.resolve(process.cwd(), ".eidolon", "workflows"))
  const authoring = new WorkflowAuthoringWorkspace(effectiveStore, resources)
  const sessions = new WorkflowAuthoringSessionStore(effectiveStore, resources, options.candidateHarness)
  return new WorkflowComponent({ resources, authoring, sessions, catalog: options.catalog })
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
  if (canReuseBinding) {
    const existing = COMPONENT_BY_VM.get(vm)
    if (existing) return existing
  }
  const component = createWorkflowComponent({
    ...options,
    workspaceRoot: runtimeWorkspaceRoot(runtime),
  })
  if (canReuseBinding) COMPONENT_BY_VM.set(vm, component)
  return component
}
