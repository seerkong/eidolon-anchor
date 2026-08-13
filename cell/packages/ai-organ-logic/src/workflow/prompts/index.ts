export type WorkflowAuthorPromptInput = {
  operation: "create" | "edit"
  request: string
  workflowRef?: string
  form?: "auto" | "ai-data" | "ai-ctrl" | "AIDataWorkflow" | "AICtrlWorkflow"
  publish?: boolean
}

export function assembleWorkflowAuthorPrompt(input: WorkflowAuthorPromptInput): string {
  return [
    "Process this structured AI Workflow authoring invocation under the injected sys-ai-workflow system authority.",
    "Select the DevOps stage semantically and call WorkflowLoadStageContext before stage-specific work.",
    JSON.stringify({
      kind: "eidolon.aiWorkflowAuthoringInvocation",
      operation: input.operation,
      request: input.request.trim(),
      ...(input.workflowRef ? { workflowRef: input.workflowRef } : {}),
      formHint: input.form ?? "auto",
      authorization: { publication: input.publish === true, execution: false },
    }, null, 2),
  ].join("\n\n")
}

export type WorkflowFulfillmentPromptInput = {
  request: string
  operation?: "auto" | "create" | "edit" | "run" | "continue"
  workflowRef?: string
  publish?: boolean
  execute?: boolean
}

export function assembleWorkflowFulfillmentPrompt(input: WorkflowFulfillmentPromptInput): string {
  return [
    "Process this structured AI Workflow invocation under the injected sys-ai-workflow system authority.",
    "You own semantic stage and topology selection. Call WorkflowLoadStageContext with an explicit stage before stage-specific work.",
    JSON.stringify({
      kind: "eidolon.aiWorkflowInvocation",
      request: input.request.trim(),
      operation: input.operation ?? "auto",
      ...(input.workflowRef ? { workflowRef: input.workflowRef } : {}),
      authorization: {
        publication: input.publish === true,
        execution: input.execute === true,
      },
    }, null, 2),
  ].join("\n\n")
}
