import type { WorkflowAuthoringCatalog, WorkflowAuthoringContext } from "./WorkflowAuthoringCatalog"
import { analyzeWorkflowAuthoringIntent, type WorkflowAuthoringIntent } from "./WorkflowAuthoringIntent"

export type WorkflowAuthoringDirective = {
  kind: "workflow.authoringDirective"
  operation: "create" | "edit"
  route: "author-workflow" | "direct-task"
  intent: WorkflowAuthoringIntent
  context: WorkflowAuthoringContext
  startingFactPreference: "prebuilt" | "template" | "existing-definition"
  publicationAuthorized: boolean
  publicationDenialReasons: readonly string[]
  executionAuthorized: false
}

export class WorkflowAuthoringCoordinator {
  constructor(private readonly catalog: WorkflowAuthoringCatalog) {}

  prepare(input: {
    operation: "create" | "edit"
    request: string
    workflowRef?: string
    publish?: boolean
  }): WorkflowAuthoringDirective {
    const intent = analyzeWorkflowAuthoringIntent(input.request)
    const route = input.operation === "edit" || intent.workflowWarranted
      ? "author-workflow"
      : "direct-task"
    const publicationDenialReasons = [
      ...(input.publish === true ? [] : ["publication-not-explicitly-authorized"]),
      ...(intent.publicationForbidden ? ["request-forbids-publication"] : []),
      ...(intent.businessPayloadSource === "ambiguous" ? ["business-payload-ambiguous"] : []),
      ...(route === "direct-task" ? ["durable-workflow-not-warranted"] : []),
    ]
    return Object.freeze({
      kind: "workflow.authoringDirective" as const,
      operation: input.operation,
      route,
      intent,
      context: this.catalog.getContext("definition"),
      startingFactPreference: input.operation === "edit"
        ? "existing-definition"
        : intent.durableSignals.includes("human-approval")
          ? "prebuilt"
          : "template",
      publicationAuthorized: publicationDenialReasons.length === 0,
      publicationDenialReasons: Object.freeze(publicationDenialReasons),
      executionAuthorized: false as const,
    })
  }
}
