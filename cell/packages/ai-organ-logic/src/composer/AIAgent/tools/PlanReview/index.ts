import { runByFuncStyleAdapter } from "depa-processor"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { readPromptFromDir } from "../_shared"
import {
  makePlanReviewOuterComputed,
  makePlanReviewInnerRuntime,
  makePlanReviewInnerInput,
  makePlanReviewInnerConfig,
  planReviewCoreLogic,
  makePlanReviewOuterOutput,
} from "./Logic"
import type { PlanReviewOuterConfig, PlanReviewOuterInput, PlanReviewOuterOutput } from "./OuterTypes"

export function buildPlanReviewToolDef(): ToolDef<PlanReviewOuterInput, PlanReviewOuterOutput, PlanReviewOuterConfig> {
  return {
    schema: {
      type: "function" as const,
      function: {
      name: "PlanReview",
      description: "Approve or reject a plan request by request_id, optionally sending feedback to the member.",
      parameters: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] },
      },
    },
    briefPromptXnl: readPromptFromDir("PlanReview", "Tool.brief.xnl"),
    detailPromptXnl: readPromptFromDir("PlanReview", "Tool.detail.xnl"),
    run: async (runtime, input, config) => {
      return await runByFuncStyleAdapter(
        runtime,
        input,
        config,
        makePlanReviewOuterComputed,
        makePlanReviewInnerRuntime,
        makePlanReviewInnerInput,
        makePlanReviewInnerConfig,
        planReviewCoreLogic,
        makePlanReviewOuterOutput,
      )
    },
  }
}
