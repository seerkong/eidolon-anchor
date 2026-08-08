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

const DEFINITION_CONTEXT = `Author workflows from ordinary business language.

Decide first whether durable coordination is warranted. Separate authoring and orchestration clauses from the exact contiguous business payload; do not copy workflow protocol into the task.

Select the smallest installed template or prebuilt starting fact. Open one recoverable authoring session with /base and /refs read-only, /work and /out writable. Use only WorkflowWorkspace operations inside that VFS.

Canonical AIDataWorkflow authoring contract:
- Close the XNL workflow root with \`]>\`.
- A TransformNode or SinkNode \`src\` export is called as \`(runtime, inputs, config)\`. Never treat the first argument as inputs.
- Each \`inputs\` property is the unwrapped upstream port value. For \`source = "flow-port://#fetch/result"\`, the function receives \`inputs.source\` equal to that result value, not \`{ result: value }\`.
- A TransformNode must return the exact output map declared by \`outputs\`; for \`outputs = ["result"]\`, return \`{ result: value }\`.
- FlowContract input and output port names are exact. Entry input is an exact map keyed by FlowContract inputPorts; ReturnNode inputs must match outputPorts.
- For publication, \`target_path\` is a plain workspace-relative bundle directory such as \`ai-trend-report\`. Never pass a URI or a manifest filename as the bundle directory.
- For repair, inspect the compact run status/result and the authored source first. Do not request full event payloads unless compact evidence is insufficient; public-source node payloads can be very large.

Complete diff -> validate -> dry-run for one revision, repair in /work when needed, then present business intent and proof. publication requires independent explicit authorization and never implies execution.`

const RUN_CONTEXT = `Run only an already published workflow. Recover definition, instance, run and Material facts before acting. Publication is not execution authorization. Start, resume or reject through native workflow tools and preserve frozen revisions and durable evidence.

WorkflowCreateInstance input must be an exact map keyed by FlowContract inputPorts. For inputPorts = ["input"], pass { "input": value }, not an unkeyed value or an empty map. Preview before confirmed execution and report the durable run result.`

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
