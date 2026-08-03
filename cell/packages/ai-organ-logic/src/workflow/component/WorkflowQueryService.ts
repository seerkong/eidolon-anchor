import {
  summarizeAiWorkflowContractBoundary,
  validateAiWorkflowResourceRef,
  type AiWorkflowResourceRefValidationResult,
  type AiWorkflowRootDescriptor,
} from "@cell/ai-workflow-contract"

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
}
