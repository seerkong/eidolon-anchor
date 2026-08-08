import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"

export type WorkflowAuthorOuterRuntime = AiAgentOneActorRuntime
export type WorkflowAuthorOuterInput = {
  operation: "create" | "edit"
  request: string
  workflow_ref?: string
  form?: "auto" | "ai-data" | "ai-ctrl" | "AIDataWorkflow" | "AICtrlWorkflow"
  publish?: boolean
  agent_type?: string
}
export type WorkflowAuthorOuterConfig = Record<string, never>
export type WorkflowAuthorOuterDerived = null
export type WorkflowAuthorOuterOutput = string
