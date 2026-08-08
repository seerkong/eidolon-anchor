import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import type {
  WorkflowBusinessScenarioId,
  WorkflowExperienceOperation,
  WorkflowExperienceRoute,
} from "../../authoring"

export type WorkflowFulfillOuterRuntime = AiAgentOneActorRuntime
export type WorkflowFulfillOuterInput = {
  request: string
  operation?: WorkflowExperienceOperation
  workflow_ref?: string
  publish?: boolean
  execute?: boolean
  route?: WorkflowExperienceRoute
  scenario?: WorkflowBusinessScenarioId
  expert?: boolean
  agent_type?: string
}
export type WorkflowFulfillOuterConfig = Record<string, never>
export type WorkflowFulfillOuterDerived = null
export type WorkflowFulfillOuterOutput = string
