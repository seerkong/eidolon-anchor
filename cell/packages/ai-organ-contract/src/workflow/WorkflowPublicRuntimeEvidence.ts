export const WORKFLOW_PUBLIC_RUNTIME_EVIDENCE_SCHEMA = "eidolon.workflow-public-runtime-evidence/v1" as const
export const WORKFLOW_PUBLIC_RUNTIME_EVIDENCE_SOURCE = "terminal.runtime.public-events/v1" as const

export type WorkflowPublicNodeExecutionEvidence = Readonly<{
  nodeId: string
  actorId: string
  actorKey: string
  agentDefinitionRef: string
}>

/**
 * Sanitized own-data projection emitted by the live Workflow runtime. It is
 * intentionally independent of the Workflow fact-store layout.
 */
export type WorkflowPublicRuntimeEvidence = Readonly<{
  schemaVersion: typeof WORKFLOW_PUBLIC_RUNTIME_EVIDENCE_SCHEMA
  evidenceSource: typeof WORKFLOW_PUBLIC_RUNTIME_EVIDENCE_SOURCE
  kind: "AICtrlWorkflow" | "AIDataWorkflow"
  definitionRef: string
  instanceId: string
  runId: string
  nodeExecutions: readonly WorkflowPublicNodeExecutionEvidence[]
}>
