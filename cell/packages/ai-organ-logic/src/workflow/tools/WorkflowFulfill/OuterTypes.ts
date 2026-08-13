import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
export type WorkflowFulfillOuterRuntime = AiAgentOneActorRuntime
export type WorkflowFulfillOuterInput = {
  request: string
  operation?: "auto" | "create" | "edit" | "run" | "continue"
  workflow_ref?: string
  publish?: boolean
  execute?: boolean
}
export type WorkflowFulfillOuterConfig = Record<string, never>
export type WorkflowFulfillOuterDerived = null
export type WorkflowFulfillOuterOutput = string
