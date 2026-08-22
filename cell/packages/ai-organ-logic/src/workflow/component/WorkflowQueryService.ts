import {
  summarizeAiWorkflowContractBoundary,
  validateAiWorkflowResourceRef,
  type AiWorkflowResourceRefValidationResult,
  type AiWorkflowRootDescriptor,
} from "@cell/ai-workflow-contract"
import type { EidolonAppResourceRegistryAdapter } from "../../resources"
import type {
  EidolonReusableAgentBrief,
  EidolonWorkflowAppBrief,
  EidolonWorkflowAppDetail,
} from "../../resources"
import { WorkflowDefinitionRepository } from "../runtime/WorkflowDefinitionRepository"

export type WorkflowCapabilityInspection = {
  capability: "ai-workflow"
  native: true
  forms: string[]
  resourceSchemes: string[]
  dataSubgraphComponentId: string
  ownedFactNodes: string[]
  notOwnedHere: string[]
  forbiddenLiveReads: string[]
  workflowRootsInjected: boolean
  workflowRoots: AiWorkflowRootDescriptor | null
  sampleResourceRef: AiWorkflowResourceRefValidationResult
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function normalizeRootDescriptor(value: unknown): AiWorkflowRootDescriptor | null {
  if (!isRecord(value)) return null
  const roots: AiWorkflowRootDescriptor = {}
  if (typeof value.globalRoot === "string") roots.globalRoot = value.globalRoot
  if (typeof value.workspaceRoot === "string") roots.workspaceRoot = value.workspaceRoot
  if (typeof value.sessionWorkflowRoot === "string") roots.sessionWorkflowRoot = value.sessionWorkflowRoot
  return Object.keys(roots).length > 0 ? roots : null
}

export function readWorkflowRootsFromRuntime(runtime: unknown): AiWorkflowRootDescriptor | null {
  const outerCtx = isRecord((runtime as any)?.vm) ? (runtime as any).vm.outerCtx : null
  if (!isRecord(outerCtx)) return null
  return (
    normalizeRootDescriptor(outerCtx.workflowRoots)
    || normalizeRootDescriptor(isRecord(outerCtx.metadata) ? outerCtx.metadata.workflowRoots : null)
    || normalizeRootDescriptor(isRecord(outerCtx.metadata) && isRecord(outerCtx.metadata.workflow) ? outerCtx.metadata.workflow.roots : null)
    || normalizeRootDescriptor(isRecord(outerCtx.metadata) && isRecord(outerCtx.metadata.aiWorkflow) ? outerCtx.metadata.aiWorkflow.roots : null)
  )
}

export class WorkflowQueryService {
  constructor(
    private readonly repository?: WorkflowDefinitionRepository,
    private readonly resourceRegistry?: EidolonAppResourceRegistryAdapter,
  ) {}

  listApps(): Promise<readonly EidolonWorkflowAppBrief[]> {
    if (!this.resourceRegistry) return Promise.resolve([])
    return this.resourceRegistry.listApps()
  }

  getApp(resourceId: string): Promise<EidolonWorkflowAppDetail> {
    if (!this.resourceRegistry) throw new Error("Eidolon resource registry is not bound")
    return this.resourceRegistry.getApp(resourceId)
  }

  listReusableAgents(): Promise<readonly EidolonReusableAgentBrief[]> {
    if (!this.resourceRegistry) return Promise.resolve([])
    return this.resourceRegistry.listReusableAgents()
  }

  inspectCapability(runtime: unknown): WorkflowCapabilityInspection {
    const boundary = summarizeAiWorkflowContractBoundary()
    const workflowRoots = readWorkflowRootsFromRuntime(runtime)
    return {
      capability: "ai-workflow",
      native: true,
      forms: boundary.forms,
      resourceSchemes: boundary.resourceSchemes,
      dataSubgraphComponentId: boundary.componentId,
      ownedFactNodes: boundary.ownedFactNodes,
      notOwnedHere: boundary.notOwnedHere,
      forbiddenLiveReads: boundary.forbiddenLiveReads,
      workflowRootsInjected: workflowRoots !== null,
      workflowRoots,
      sampleResourceRef: validateAiWorkflowResourceRef("vfs://./workflow/manifest.xnl"),
    }
  }

  validateResourceRef(ref: unknown): AiWorkflowResourceRefValidationResult {
    return validateAiWorkflowResourceRef(ref)
  }

  async validateDefinition(ref: unknown): Promise<{
    ok: boolean
    kind: "workflow.definitionValidation"
    ref: string
    resourceRef: AiWorkflowResourceRefValidationResult
    form?: string
    substrate?: string
    definition?: { fqn: string; manifestPath: string; bundlePath: string }
    nodes?: { valid: true; count: number; ids: string[] }
    materials?: { valid: true; count: number; refs: string[] }
    diagnostics: Array<{ level: "resource" | "definition" | "node" | "material"; code: string; message: string; nodeId?: string }>
  }> {
    const resourceRef = this.validateResourceRef(ref)
    const logicalRef = typeof ref === "string" ? ref : ""
    if (!resourceRef.ok) {
      return {
        ok: false,
        kind: "workflow.definitionValidation",
        ref: logicalRef,
        resourceRef,
        diagnostics: [{ level: "resource", code: "invalid-resource-ref", message: resourceRef.reason }],
      }
    }
    if (!this.repository) {
      return {
        ok: false,
        kind: "workflow.definitionValidation",
        ref: logicalRef,
        resourceRef,
        diagnostics: [{ level: "definition", code: "workspace-unbound", message: "Workflow authoring workspace is not bound" }],
      }
    }
    try {
      const resolved = await this.repository.resolve(logicalRef)
      const definition = resolved.binding.definition as any
      const nodeIds = Array.isArray(definition.declarationOrder)
        ? definition.declarationOrder.map(String)
        : definition.nodeById && typeof definition.nodeById === "object"
          ? Object.keys(definition.nodeById)
          : Array.isArray(definition.nodes)
            ? definition.nodes.map((node: any) => String(node?.id ?? node?.name ?? "")).filter(Boolean)
            : []
      const materialRefs = this.resourceRegistry
        ? [...await this.resourceRegistry.listMaterialResourceRefsForWorkflow(resolved.workflowRef)]
        : []
      return {
        ok: true,
        kind: "workflow.definitionValidation",
        ref: logicalRef,
        resourceRef,
        form: resolved.binding.kind,
        substrate: resolved.binding.substrate,
        definition: {
          fqn: resolved.binding.definition.fqn,
          manifestPath: resolved.manifestPath,
          bundlePath: resolved.bundlePath,
        },
        nodes: { valid: true, count: nodeIds.length, ids: nodeIds },
        materials: { valid: true, count: materialRefs.length, refs: materialRefs },
        diagnostics: [],
      }
    } catch (error) {
      return {
        ok: false,
        kind: "workflow.definitionValidation",
        ref: logicalRef,
        resourceRef,
        diagnostics: [{
          level: "definition",
          code: "definition-invalid",
          message: String((error as Error)?.message ?? error),
        }],
      }
    }
  }
}
