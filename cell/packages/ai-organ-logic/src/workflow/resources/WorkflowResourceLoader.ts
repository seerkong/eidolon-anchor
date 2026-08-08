import type {
  AiWorkflowForm,
  AIWorkflowDefinitionBinding,
  AIWorkflowSubstrate,
} from "@cell/ai-workflow-contract"
import { loadAICtrlWorkflowSources } from "ai-ctrl-workflow-logic"
import { loadAIDataWorkflowSources } from "ai-data-workflow-logic"

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
  effectNodeIds: readonly string[]
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

function loadCtrl(sources: WorkflowSourceCollection, baseUri?: string): WorkflowResourceLoadResult {
  const loaded = loadAICtrlWorkflowSources({ ...sources }, baseUri ? { baseUri } : {})
  return {
    form: "AICtrlWorkflow",
    substrate: "WorkCtrlFlow",
    ...(loaded.binding ? { binding: loaded.binding } : {}),
    diagnostics: normalizeDiagnostics("AICtrlWorkflow", loaded.diagnostics),
  }
}

function loadData(sources: WorkflowSourceCollection, baseUri?: string): WorkflowResourceLoadResult {
  const loaded = loadAIDataWorkflowSources({ ...sources }, baseUri ? { baseUri } : {})
  return {
    form: "AIDataWorkflow",
    substrate: "EagerDataFlow",
    ...(loaded.binding ? { binding: loaded.binding } : {}),
    diagnostics: normalizeDiagnostics("AIDataWorkflow", loaded.diagnostics),
  }
}

export class WorkflowResourceLoader {
  load(input: WorkflowResourceLoadInput): WorkflowResourceLoadResult {
    if (input.form === "AICtrlWorkflow") return loadCtrl(input.sources, input.baseUri)
    if (input.form === "AIDataWorkflow") return loadData(input.sources, input.baseUri)

    const ctrl = loadCtrl(input.sources, input.baseUri)
    const data = loadData(input.sources, input.baseUri)
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
    const effectNodeIds = nodes
      .filter((node) => /Effect|Task|Transform|Source|Sink/iu.test(String(node?.tag ?? "")))
      .map((node, index) => String(node.id ?? `effect-${index}`))
    return Object.freeze({
      kind: "workflow.staticProjection" as const,
      form: loaded.form,
      substrate: loaded.substrate,
      definitionFqn: String(definition.fqn),
      declarationOrder: Object.freeze(nodes.map((node, index) => String(node?.id ?? `${node?.tag ?? "node"}-${index}`))),
      terminalNodeIds: Object.freeze(terminalNodeIds),
      effectNodeIds: Object.freeze(effectNodeIds),
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
