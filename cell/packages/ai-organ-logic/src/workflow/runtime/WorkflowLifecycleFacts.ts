import type { AiWorkflowForm } from "@cell/ai-workflow-contract"

export type WorkflowDefinitionRevision = {
  revision: string
  workflowRef: string
  fqn: string
  form: AiWorkflowForm
  sourceBundlePath: string
  files: Record<string, string>
  createdAt: number
}

export type WorkflowInstanceStatus = "Prepared" | "Running" | "Completed" | "Failed"

export type WorkflowInstance = {
  instanceId: string
  workflowRef: string
  definitionRevision: string
  form: AiWorkflowForm
  status: WorkflowInstanceStatus
  input: unknown
  bindingIds: string[]
  runIds: string[]
  idempotencyKey?: string
  requestFingerprint: string
  createdAt: number
  updatedAt: number
}

export type WorkflowMaterialRevisionRef = {
  materialRef: string
  revision: string
}

export type WorkflowMaterialManifestEntry = {
  path: string
  digest: string
  size: number
}

export type WorkflowMaterialRevision = {
  materialRef: string
  revision: string
  manifest: WorkflowMaterialManifestEntry[]
  provenance: Record<string, unknown>
  createdAt: number
}

export type WorkflowMaterialBinding = {
  bindingId: string
  instanceId: string
  nodeId: string
  port: string
  material: WorkflowMaterialRevisionRef
  createdAt: number
}

export type WorkflowRunReceipt = {
  runId: string
  instanceId: string
  definitionRevision: string
  input: unknown
  inputMaterials: WorkflowMaterialBinding[]
  outputMaterials: WorkflowMaterialRevisionRef[]
  requestFingerprint: string
  replayOf?: string
  createdAt: number
  updatedAt: number
}
