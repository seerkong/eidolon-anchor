import type { StdInnerLogic } from "depa-processor"
import { spawnChildExecutionActor } from "../../../agent/DelegateActor"
import { createWorkflowComponentForRuntime } from "../../component"
import { assembleWorkflowAuthorPrompt } from "../../prompts"
import type {
  WorkflowAuthorInnerConfig,
  WorkflowAuthorInnerInput,
  WorkflowAuthorInnerOutput,
  WorkflowAuthorInnerRuntime,
} from "./InnerTypes"

export const workflowAuthorCoreLogic: StdInnerLogic<
  WorkflowAuthorInnerRuntime,
  WorkflowAuthorInnerInput,
  WorkflowAuthorInnerConfig,
  WorkflowAuthorInnerOutput
> = async (runtime, input) => {
  const request = input.request?.trim()
  if (!request) throw new Error("WorkflowAuthor requires a natural-language request")
  if (input.operation === "edit" && !input.workflow_ref?.trim()) {
    throw new Error("WorkflowAuthor edit requires workflow_ref")
  }
  const directive = createWorkflowComponentForRuntime(runtime).coordinator.prepare({
    operation: input.operation,
    request,
    workflowRef: input.workflow_ref,
    publish: input.publish,
  })
  if (directive.route === "direct-task") {
    return JSON.stringify({
      kind: "workflow.authoringDecision",
      status: "workflow_not_warranted",
      durableSignals: directive.intent.durableSignals,
      businessPayload: directive.intent.businessPayload,
      publicationAuthorized: false,
      executionAuthorized: false,
    }, null, 2)
  }
  return spawnChildExecutionActor(runtime.vm as any, runtime.actor as any, {
    description: input.operation === "edit" ? "Edit an AI workflow" : "Create an AI workflow",
    prompt: assembleWorkflowAuthorPrompt({
      operation: input.operation,
      request,
      workflowRef: input.workflow_ref,
      form: input.form,
      publish: input.publish,
      directive,
    }),
    agentType: input.agent_type?.trim() || (runtime.actor as any)?.agentName || "code",
    mode: "sync_wait",
    toolCallId: (runtime as any).toolCallId,
  })
}
