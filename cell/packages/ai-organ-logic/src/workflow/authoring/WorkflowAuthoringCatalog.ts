import type { AiWorkflowForm } from "@cell/ai-workflow-contract"
import type { WorkflowAuthoringFile } from "./WorkflowAuthoringStore"
import {
  INSTALLED_WORKFLOW_AUTHORING_RESOURCES,
  type WorkflowAuthoringInstalledResourceRegistry,
} from "../resources/authoring/WorkflowAuthoringResourceRegistry"

export type WorkflowAuthoringStage = "definition" | "run"

export type WorkflowAuthoringContext = {
  kind: "workflow.authoringContext"
  stage: WorkflowAuthoringStage
  version: string
  instructions: string
  effectDispatched: false
}

export type WorkflowAuthoringTemplate = {
  id: string
  form: AiWorkflowForm
  description: string
  files: readonly WorkflowAuthoringFile[]
}

export type WorkflowPrebuiltBrief = {
  id: string
  form: AiWorkflowForm
  description: string
}

const DEFINITION_CONTEXT = "Load canonical authoring instructions with WorkflowLoadStageContext(stage=coding); this catalog only exposes installed starting facts."

const RUN_CONTEXT = "Load canonical runtime instructions with WorkflowLoadStageContext(stage=operating); this catalog only exposes installed runtime facts."

export class WorkflowAuthoringCatalog {
  constructor(
    private readonly installed: WorkflowAuthoringInstalledResourceRegistry = INSTALLED_WORKFLOW_AUTHORING_RESOURCES,
  ) {}

  getContext(stage: WorkflowAuthoringStage): WorkflowAuthoringContext {
    return Object.freeze({
      kind: "workflow.authoringContext",
      stage,
      version: "eidolon-workflow-authoring/v2",
      instructions: stage === "definition" ? DEFINITION_CONTEXT : RUN_CONTEXT,
      effectDispatched: false,
    })
  }

  listTemplates(): readonly Omit<WorkflowAuthoringTemplate, "files">[] {
    return this.installed.templates.map(({ files: _files, ...brief }) => Object.freeze(brief))
  }

  getTemplate(id: string): WorkflowAuthoringTemplate {
    const template = this.installed.templates.find((item) => item.id === id)
    if (!template) throw new Error(`Workflow authoring template not found: ${id}`)
    return template
  }

  listPrebuiltWorkflows(): readonly WorkflowPrebuiltBrief[] {
    return this.installed.prebuiltWorkflows.map(({ files: _files, ...brief }) => Object.freeze(brief))
  }

  listReusableAgents(): readonly { id: string; description: string; promptLoaded: false }[] {
    return this.installed.reusableAgents
  }

  getPrebuiltWorkflow(id: string): WorkflowPrebuiltBrief & { files: readonly WorkflowAuthoringFile[] } {
    const prebuilt = this.installed.prebuiltWorkflows.find((item) => item.id === id)
    if (!prebuilt) throw new Error(`Prebuilt workflow not found: ${id}`)
    return prebuilt
  }
}
