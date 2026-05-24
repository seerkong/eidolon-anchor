import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import type { QuestionnaireOuterInput, QuestionnaireOuterOutput } from "./OuterTypes"

export type QuestionnaireInnerRuntime = AiAgentOneActorRuntime

export type QuestionnaireInnerInput = QuestionnaireOuterInput

export type QuestionnaireInnerConfig = Record<string, never>

export type QuestionnaireInnerOutput = QuestionnaireOuterOutput
