import type { AiWorkflowForm } from "@cell/ai-workflow-contract"
import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import type { WorkflowStructuredPatchOperation } from "../../authoring"

export type WorkflowWorkspaceOperation =
  | "describe"
  | "tree"
  | "read"
  | "search"
  | "diff"
  | "validate"
  | "write"
  | "edit"
  | "patch"
  | "delete"
  | "audit"

export type WorkflowWorkspaceOuterRuntime = AiAgentOneActorRuntime
export type WorkflowWorkspaceOuterInput = {
  operation: WorkflowWorkspaceOperation
  session_id?: string
  path?: string
  query?: string
  content?: string
  old_text?: string
  new_text?: string
  patch?: string
  expected_revision?: string
  operations?: WorkflowStructuredPatchOperation[]
  form?: AiWorkflowForm
}
export type WorkflowWorkspaceOuterConfig = Record<string, never>
export type WorkflowWorkspaceOuterDerived = null
export type WorkflowWorkspaceOuterOutput = string
