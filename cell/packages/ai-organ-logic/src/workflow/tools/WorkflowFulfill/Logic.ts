import type { StdInnerLogic } from "depa-processor"
import { spawnChildExecutionActor } from "../../../agent/DelegateActor"
import { planWorkflowExperience, projectWorkflowBusinessState } from "../../authoring"
import { assembleWorkflowFulfillmentPrompt } from "../../prompts"
import type {
  WorkflowFulfillInnerConfig,
  WorkflowFulfillInnerInput,
  WorkflowFulfillInnerOutput,
  WorkflowFulfillInnerRuntime,
} from "./InnerTypes"

export const workflowFulfillCoreLogic: StdInnerLogic<
  WorkflowFulfillInnerRuntime,
  WorkflowFulfillInnerInput,
  WorkflowFulfillInnerConfig,
  WorkflowFulfillInnerOutput
> = async (runtime, input) => {
  const plan = planWorkflowExperience({
    request: input.request,
    operation: input.operation,
    workflowRef: input.workflow_ref,
    publish: input.publish,
    execute: input.execute,
    route: input.route,
    scenario: input.scenario,
    expert: input.expert,
  })
  if (plan.route === "direct") {
    const chinese = /[\u3400-\u9fff]/u.test(plan.request)
    return JSON.stringify(projectWorkflowBusinessState({
      status: "direct",
      purpose: plan.request,
      summary: chinese
        ? "这个请求不需要持久工作流，请在当前 Eidolon 对话中直接完成。"
        : "This request does not need a durable workflow. Continue it directly in the current Eidolon conversation.",
      nextAction: chinese ? "直接完成用户要求的业务任务。" : "Perform the requested business task directly.",
      internal: { plan },
    }, plan.expert), null, 2)
  }
  return spawnChildExecutionActor(runtime.vm as any, runtime.actor as any, {
    description: "Fulfill a business goal through the Eidolon workflow product journey",
    prompt: assembleWorkflowFulfillmentPrompt(plan),
    agentType: input.agent_type?.trim() || (runtime.actor as any)?.agentName || "code",
    mode: "sync_wait",
    toolCallId: (runtime as any).toolCallId,
  })
}
