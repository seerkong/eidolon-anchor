import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import type { AiWorkflowStageId } from "@cell/ai-support/system-skill/SystemSkillInstaller"

export type WorkflowLoadStageContextOuterRuntime = AiAgentOneActorRuntime
export type WorkflowLoadStageContextOuterInput = { stage: AiWorkflowStageId }
export type WorkflowLoadStageContextOuterConfig = Record<string, never>
export type WorkflowLoadStageContextOuterOutput = string
