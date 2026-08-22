import type { AiWorkflowForm } from "@cell/ai-workflow-contract"
import type { WorkflowAuthoringFile } from "../../authoring/WorkflowAuthoringStore"
import minimalCtrlManifest from "./templates/minimal-ai-ctrl/manifest.xnl" with { type: "text" }
import minimalDataManifest from "./templates/minimal-ai-data/manifest.xnl" with { type: "text" }
import durableApprovalManifest from "./prebuilt/durable-approval-flow/manifest.xnl" with { type: "text" }

export type InstalledWorkflowTemplateResource = {
  id: string
  form: AiWorkflowForm
  description: string
  files: readonly WorkflowAuthoringFile[]
}

export type InstalledPrebuiltWorkflowResource = InstalledWorkflowTemplateResource

export type WorkflowAuthoringInstalledResourceRegistry = {
  templates: readonly InstalledWorkflowTemplateResource[]
  prebuiltWorkflows: readonly InstalledPrebuiltWorkflowResource[]
}

export const INSTALLED_WORKFLOW_AUTHORING_RESOURCES: WorkflowAuthoringInstalledResourceRegistry = Object.freeze({
  templates: Object.freeze([
    Object.freeze({
      id: "minimal-ai-ctrl",
      form: "AICtrlWorkflow" as const,
      description: "Smallest canonical durable control workflow package.",
      files: Object.freeze([{ path: "manifest.xnl", content: minimalCtrlManifest }]),
    }),
    Object.freeze({
      id: "minimal-ai-data",
      form: "AIDataWorkflow" as const,
      description: "Smallest canonical typed data workflow package.",
      files: Object.freeze([{ path: "manifest.xnl", content: minimalDataManifest }]),
    }),
  ]),
  prebuiltWorkflows: Object.freeze([
    Object.freeze({
      id: "durable-approval-flow",
      form: "AICtrlWorkflow" as const,
      description: "Reusable durable human approval lifecycle starting fact.",
      files: Object.freeze([{ path: "manifest.xnl", content: durableApprovalManifest }]),
    }),
  ]),
})
