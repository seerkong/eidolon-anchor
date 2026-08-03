import type { AiWorkflowForm } from "@cell/ai-workflow-contract"
import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"

export type WorkflowCreateBundleOuterRuntime = AiAgentOneActorRuntime
export type WorkflowCreateBundleOuterInput = {
  form: AiWorkflowForm | "ai-data" | "ai-ctrl"
  name: string
  fqn?: string
  description?: string
}
export type WorkflowCreateBundleOuterConfig = Record<string, never>
export type WorkflowCreateBundleOuterDerived = null
export type WorkflowCreateBundleOuterOutput = string
