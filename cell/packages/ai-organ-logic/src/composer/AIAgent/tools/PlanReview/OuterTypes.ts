import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
export type PlanReviewOuterRuntime = AiAgentOneActorRuntime
export type PlanReviewOuterInput = { request_id: string; approve: boolean; feedback?: string }
export type PlanReviewOuterConfig = Record<string, unknown>
export type PlanReviewOuterDerived = null
export type PlanReviewOuterOutput = string
