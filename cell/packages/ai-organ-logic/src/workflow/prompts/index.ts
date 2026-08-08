import universal from "./universal.md" with { type: "text" }
import lifecycle from "./workflow-authoring-lifecycle.md" with { type: "text" }
import architecture from "./workflow-architecture.md" with { type: "text" }
import edit from "./edit.md" with { type: "text" }
import repair from "./repair.md" with { type: "text" }
import fulfill from "./fulfill.md" with { type: "text" }
import {
  WorkflowAuthoringCatalog,
  WorkflowAuthoringCoordinator,
  type WorkflowAuthoringDirective,
} from "../authoring"
import type { WorkflowExperiencePlan } from "../authoring"

export type WorkflowAuthorPromptInput = {
  operation: "create" | "edit"
  request: string
  workflowRef?: string
  form?: "auto" | "ai-data" | "ai-ctrl" | "AIDataWorkflow" | "AICtrlWorkflow"
  publish?: boolean
  directive?: WorkflowAuthoringDirective
}

export function assembleWorkflowAuthorPrompt(input: WorkflowAuthorPromptInput): string {
  const operationGuide = input.operation === "edit" ? edit : "Create a new draft through the native authoring lifecycle."
  const directive = input.directive ?? new WorkflowAuthoringCoordinator(new WorkflowAuthoringCatalog()).prepare({
    operation: input.operation,
    request: input.request,
    workflowRef: input.workflowRef,
    publish: input.publish,
  })
  const intent = directive.intent
  return [
    universal,
    lifecycle,
    architecture,
    operationGuide,
    repair,
    "# Current authoring request",
    `Operation: ${input.operation}`,
    `Form hint: ${input.form ?? "auto"}`,
    `Coordinator route: ${directive.route}`,
    `Authoring context revision: ${directive.context.version}`,
    `Starting fact preference: ${directive.startingFactPreference}`,
    `Explicit publication authorization in this invocation: ${directive.publicationAuthorized ? "yes" : `no; stop after a successful dry-run proof (${directive.publicationDenialReasons.join(", ")})`}`,
    `Execution authorization: no; authoring never starts a workflow${intent.executionForbidden ? " and the request explicitly forbids execution" : ""}`,
    ...(input.workflowRef ? [`Workflow ref: ${input.workflowRef}`] : []),
    `Durable signals: ${intent.durableSignals.length ? intent.durableSignals.join(", ") : "none detected; do not force a workflow"}`,
    `Business payload source: ${intent.businessPayloadSource}`,
    ...(intent.businessPayload ? [`Exact business payload candidate (preserve verbatim):\n${intent.businessPayload}`] : ["Exact business payload candidate: ambiguous; do not publish by guessing"]),
    "",
    "User requirement/instruction:",
    input.request.trim(),
  ].join("\n\n")
}

export function assembleWorkflowFulfillmentPrompt(plan: WorkflowExperiencePlan): string {
  const startingFact = plan.route === "ai-data"
    ? "Use the installed minimal-ai-data template and open exactly one AIDataWorkflow authoring session. Do not open scratch, probe, or alternative-form sessions."
    : plan.route === "ai-ctrl"
      ? "Use the installed minimal-ai-ctrl template and open exactly one AICtrlWorkflow authoring session. Do not open scratch, probe, or alternative-form sessions."
      : plan.route === "composite"
        ? "Use only the smallest installed starting facts required by the composite topology. Never open scratch or probe sessions, and never open an alternative form merely to discover syntax."
        : "No workflow starting fact is required."
  return [
    universal,
    lifecycle,
    architecture,
    fulfill,
    "# Product journey contract",
    `Operation: ${plan.operation}`,
    `Internal route: ${plan.route} (${plan.routeSource})`,
    `Business scenario: ${plan.scenario.id} (${plan.scenarioSource})`,
    `Scenario purpose: ${plan.scenario.purpose}`,
    `Scenario topology: ${plan.scenario.topology.join(" -> ")}`,
    `Required starting-fact discipline: ${startingFact}`,
    `Completion condition: ${plan.scenario.completion}`,
    `Journey stages: ${plan.journey.join(" -> ")}`,
    `Publication authorization: ${plan.authorization.publication}`,
    `Execution authorization: ${plan.authorization.execution}`,
    ...(plan.workflowRef ? [`Existing workflow fact: ${plan.workflowRef}`] : []),
    "",
    "Use these native lifecycle tools when their stage is reached:",
    "WorkflowGetAuthoringContext, WorkflowListAuthoringTemplates, WorkflowListPrebuiltWorkflows, WorkflowListReusableAgents, WorkflowListAuthoringSessions, WorkflowGetAuthoringSummary, WorkflowOpenAuthoringSession, WorkflowWorkspace, WorkflowValidateAuthoringSession, WorkflowDryRunAuthoringSession, WorkflowPublishAuthoringSession, WorkflowMaterialImport, WorkflowMaterialBind, WorkflowCreateInstance, WorkflowRun, WorkflowStatus, WorkflowEvents, WorkflowResult, WorkflowResolve, WorkflowReject, WorkflowResume.",
    "",
    "Return a business result through the default business projection. Internal identifiers are evidence, not the human response.",
    "",
    "Original business request:",
    plan.request,
  ].join("\n\n")
}
