import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"

export type WorkflowPatchBundleOuterRuntime = AiAgentOneActorRuntime
export type WorkflowPatchBundleOuterInput = {
  manifestRef: string
  intent?: string
  replacementManifestContent?: string
}
export type WorkflowPatchBundleOuterConfig = Record<string, never>
export type WorkflowPatchBundleOuterDerived = null
export type WorkflowPatchBundleOuterOutput = string
