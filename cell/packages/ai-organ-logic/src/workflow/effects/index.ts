import type {
  AiWorkflowForm,
  AiWorkflowNodeRecord,
  AiWorkflowResourceRefValidationResult,
  AiWorkflowRuntimeRef,
} from "@cell/ai-workflow-contract"

export type AiWorkflowEffectKind =
  | "agent_task"
  | "tool_call"
  | "human_input"
  | "material"

export type AiWorkflowEffectRequest<TInput = unknown> = {
  effectId: string
  kind: AiWorkflowEffectKind
  form: AiWorkflowForm
  nodeId: string
  input: TInput
  materialRefs?: string[]
}

export type AiWorkflowEffectResult<TOutput = unknown> = {
  effectId: string
  node: Pick<AiWorkflowNodeRecord, "nodeId" | "status" | "refs" | "materialRefs">
  output?: TOutput
}

export type AiWorkflowEffectAdapter<TRuntime = unknown, TInput = unknown, TOutput = unknown> = {
  kind: AiWorkflowEffectKind
  run: (
    runtime: TRuntime,
    request: AiWorkflowEffectRequest<TInput>,
  ) => Promise<AiWorkflowEffectResult<TOutput>>
}

export type AiWorkflowEffectAdapterRegistry<TRuntime = unknown> = {
  register: (adapter: AiWorkflowEffectAdapter<TRuntime, any, any>) => void
  get: (kind: AiWorkflowEffectKind) => AiWorkflowEffectAdapter<TRuntime, any, any> | undefined
  list: () => AiWorkflowEffectAdapter<TRuntime, any, any>[]
}

export function createAiWorkflowEffectAdapterRegistry<TRuntime = unknown>(): AiWorkflowEffectAdapterRegistry<TRuntime> {
  const adapters = new Map<AiWorkflowEffectKind, AiWorkflowEffectAdapter<TRuntime, any, any>>()
  return {
    register: (adapter) => {
      adapters.set(adapter.kind, adapter)
    },
    get: (kind) => adapters.get(kind),
    list: () => [...adapters.values()],
  }
}

export type AiWorkflowAgentTaskRuntimeRef = Required<Pick<AiWorkflowRuntimeRef, "actorKey" | "actorId" | "fiberId">> & {
  taskId?: string
}

export type AiWorkflowResourceRefGuard = {
  validateResourceRef: (ref: string) => AiWorkflowResourceRefValidationResult
}

export * from "./EidolonWorkflowEffectProvider"
export * from "./WorkflowStepExtensionAuthoredFacade"
