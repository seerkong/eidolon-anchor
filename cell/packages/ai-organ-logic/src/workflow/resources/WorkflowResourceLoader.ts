import type {
  AIWorkflowDefinitionBinding,
  AIWorkflowKind as AiWorkflowForm,
  AIWorkflowSubstrate,
} from "ai-workflow-contract"
import { loadAICtrlWorkflowSources } from "ai-ctrl-workflow-logic"
import { loadAIDataWorkflow } from "ai-data-workflow-logic"
import type {
  DefinitionStepExtensionCodecRegistryPort,
  DefinitionStepSourceReadPort,
} from "flow-step-space-contract"
import {
  assembleDefinitionStepProfile,
  createDefinitionStepSourceRuntime,
} from "flow-step-space-logic"

export type WorkflowSourceCollection = Readonly<Record<string, string>>

export type WorkflowResourceDiagnostic = {
  profile: AiWorkflowForm
  code: string
  message: string
  source?: string
  nodeId?: string
}

export type WorkflowResourceLoadInput = {
  form?: AiWorkflowForm
  sources: WorkflowSourceCollection
  stepSources?: DefinitionStepSourceReadPort
  baseUri?: string
}

export type WorkflowResourceLoadResult = {
  form?: AiWorkflowForm
  substrate?: AIWorkflowSubstrate
  binding?: AIWorkflowDefinitionBinding
  diagnostics: WorkflowResourceDiagnostic[]
}

export type WorkflowStaticProjection = {
  kind: "workflow.staticProjection"
  form: AiWorkflowForm
  substrate: AIWorkflowSubstrate
  definitionFqn: string
  declarationOrder: readonly string[]
  terminalNodeIds: readonly string[]
  effectDispatched: false
}

function normalizeDiagnostics(
  profile: AiWorkflowForm,
  diagnostics: readonly unknown[],
): WorkflowResourceDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const item = diagnostic as {
      code?: unknown
      message?: unknown
      source?: unknown
      nodeId?: unknown
    }
    return {
      profile,
      code: typeof item.code === "string" ? item.code : "workflow-load-error",
      message: typeof item.message === "string" ? item.message : "Unknown workflow loader diagnostic",
      ...(typeof item.source === "string" ? { source: item.source } : {}),
      ...(typeof item.nodeId === "string" ? { nodeId: item.nodeId } : {}),
    }
  })
}

const EMPTY_EXTENSION_CODECS: DefinitionStepExtensionCodecRegistryPort = Object.freeze({
  resolve: () => undefined,
})

function loadCtrl(
  sources: WorkflowSourceCollection,
  extensionCodecs: DefinitionStepExtensionCodecRegistryPort,
  stepSources?: DefinitionStepSourceReadPort,
  baseUri?: string,
): WorkflowResourceLoadResult {
  const sourceEntries = Object.entries(sources).map(([ref, content]) => ({ ref, content }))
  const assembled = assembleDefinitionStepProfile(
    stepSources
      ? { sources: stepSources, extensionCodecs }
      : createDefinitionStepSourceRuntime(sourceEntries, extensionCodecs),
    { sources: sourceEntries },
    { profileRoot: "AICtrlWorkflow" },
  )
  if (assembled.diagnostics.length > 0) {
    return {
      form: "AICtrlWorkflow",
      substrate: "WorkCtrlFlow",
      diagnostics: normalizeDiagnostics("AICtrlWorkflow", assembled.diagnostics),
    }
  }
  const projectedSources = Object.fromEntries(
    Array.isArray(assembled.sources)
      ? assembled.sources.map((source) => ["ref" in source ? source.ref : source.name, source.content])
      : Object.entries(assembled.sources),
  )
  const loaded = loadAICtrlWorkflowSources(projectedSources, baseUri ? { baseUri } : {})
  const binding = loaded.binding && assembled.forest
    ? {
        ...loaded.binding,
        definition: { ...loaded.binding.definition, definitionStepForest: assembled.forest },
      }
    : loaded.binding
  return {
    form: "AICtrlWorkflow",
    substrate: "WorkCtrlFlow",
    ...(binding ? { binding } : {}),
    diagnostics: normalizeDiagnostics("AICtrlWorkflow", loaded.diagnostics),
  }
}

function loadData(
  sources: WorkflowSourceCollection,
  extensionCodecs: DefinitionStepExtensionCodecRegistryPort,
  stepSources?: DefinitionStepSourceReadPort,
  baseUri?: string,
): WorkflowResourceLoadResult {
  const sourceEntries = Object.entries(sources).map(([ref, content]) => ({ ref, content }))
  const assembled = assembleDefinitionStepProfile(
    stepSources
      ? { sources: stepSources, extensionCodecs }
      : createDefinitionStepSourceRuntime(sourceEntries, extensionCodecs),
    { sources: sourceEntries },
    { profileRoot: "AIDataWorkflow" },
  )
  if (assembled.diagnostics.length > 0) return {
    form: "AIDataWorkflow",
    substrate: "EagerDataFlow",
    diagnostics: normalizeDiagnostics("AIDataWorkflow", assembled.diagnostics),
  }
  const projectedSources = Object.fromEntries(
    Array.isArray(assembled.sources)
      ? assembled.sources.map((source) => ["ref" in source ? source.ref : source.name, source.content])
      : Object.entries(assembled.sources),
  )
  const loaded = loadAIDataWorkflow(
    { extensionCodecs },
    { sources: projectedSources },
    baseUri ? { baseUri } : {},
  )
  const binding = loaded.binding && assembled.forest
    ? {
        ...loaded.binding,
        definition: { ...loaded.binding.definition, definitionStepForest: assembled.forest },
      }
    : loaded.binding
  return {
    form: "AIDataWorkflow",
    substrate: "EagerDataFlow",
    ...(binding ? { binding } : {}),
    diagnostics: normalizeDiagnostics("AIDataWorkflow", loaded.diagnostics),
  }
}

export class WorkflowResourceLoader {
  constructor(
    private readonly extensionCodecs: DefinitionStepExtensionCodecRegistryPort = EMPTY_EXTENSION_CODECS,
  ) {}

  load(input: WorkflowResourceLoadInput): WorkflowResourceLoadResult {
    if (input.form === "AICtrlWorkflow") return loadCtrl(input.sources, this.extensionCodecs, input.stepSources, input.baseUri)
    if (input.form === "AIDataWorkflow") return loadData(input.sources, this.extensionCodecs, input.stepSources, input.baseUri)

    const ctrl = loadCtrl(input.sources, this.extensionCodecs, input.stepSources, input.baseUri)
    const data = loadData(input.sources, this.extensionCodecs, input.stepSources, input.baseUri)
    const successful = [ctrl, data].filter((result) => result.binding)
    if (successful.length === 1) return successful[0]
    return {
      diagnostics: [...ctrl.diagnostics, ...data.diagnostics],
    }
  }

  projectStatic(input: WorkflowResourceLoadInput): WorkflowStaticProjection {
    const loaded = this.load(input)
    if (!loaded.form || !loaded.substrate || !loaded.binding || loaded.diagnostics.length > 0) {
      const details = loaded.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ")
      throw new Error(`Workflow static projection requires canonical sources${details ? `: ${details}` : ""}`)
    }
    const definition = loaded.binding.definition as any
    const nodes: any[] = loaded.form === "AIDataWorkflow"
      ? [...(definition.nodes ?? [])]
      : flattenCtrlStatements(definition.statements ?? [])
    const terminalNodeIds = nodes
      .filter((node) => node?.tag === "Return" || node?.tag === "ReturnNode")
      .map((node, index) => String(node.id ?? `terminal-${index}`))
    if (terminalNodeIds.length === 0) {
      throw new Error(`Workflow static projection failed: ${definition.fqn} has no terminal return node`)
    }
    return Object.freeze({
      kind: "workflow.staticProjection" as const,
      form: loaded.form,
      substrate: loaded.substrate,
      definitionFqn: String(definition.fqn),
      declarationOrder: Object.freeze(nodes.map((node, index) => String(node?.id ?? `${node?.tag ?? "node"}-${index}`))),
      terminalNodeIds: Object.freeze(terminalNodeIds),
      effectDispatched: false as const,
    })
  }
}

function flattenCtrlStatements(statements: readonly any[]): any[] {
  const result: any[] = []
  const visit = (node: any): void => {
    result.push(node)
    for (const child of node?.children ?? []) visit(child)
    for (const value of Object.values(node?.sections ?? {})) {
      if (Array.isArray(value)) for (const child of value) visit(child)
    }
  }
  for (const statement of statements) visit(statement)
  return result
}
