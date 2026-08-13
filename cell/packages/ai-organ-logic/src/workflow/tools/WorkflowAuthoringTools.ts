import type { AiAgentOneActorRuntime, ToolDef } from "@cell/ai-core-contract/types"
import type { AiWorkflowForm } from "@cell/ai-workflow-contract"
import { createWorkflowComponentForRuntime } from "../component"
import {
  projectWorkflowAuthoringSessionPage,
  projectWorkflowAuthoringSummary,
} from "../authoring"
import { WorkflowDefinitionRepository } from "../runtime"

type ToolConfig = Record<string, unknown>
type JsonTool = ToolDef<any, string, ToolConfig>

function json(value: unknown): string {
  return JSON.stringify({ ok: true, ...value as object }, null, 2)
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}

function form(value: unknown): AiWorkflowForm {
  if (value === "AICtrlWorkflow" || value === "ai-ctrl") return "AICtrlWorkflow"
  if (value === "AIDataWorkflow" || value === "ai-data") return "AIDataWorkflow"
  throw new Error("workflow form is required")
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  run: (runtime: AiAgentOneActorRuntime, input: any) => Promise<unknown> | unknown,
): JsonTool {
  return {
    schema: {
      type: "function",
      function: {
        name,
        description,
        parameters: { type: "object", properties, required, additionalProperties: false },
      },
    },
    briefPromptXnl: "",
    detailPromptXnl: "",
    run: async (runtime, input) => json(await run(runtime, input)),
  }
}

export function buildWorkflowGetAuthoringContextToolDef(): JsonTool {
  return tool(
    "WorkflowGetAuthoringContext",
    "Load versioned native workflow authoring or run context without dispatching effects.",
    { stage: { type: "string", enum: ["definition", "run"] } },
    ["stage"],
    (runtime, input) => createWorkflowComponentForRuntime(runtime).catalog.getContext(input.stage),
  )
}

export function buildWorkflowListAuthoringTemplatesToolDef(): JsonTool {
  return tool(
    "WorkflowListAuthoringTemplates",
    "List installed canonical XNL workflow authoring templates.",
    {},
    [],
    (runtime) => ({ templates: createWorkflowComponentForRuntime(runtime).catalog.listTemplates(), effectDispatched: false }),
  )
}

export function buildWorkflowListPrebuiltWorkflowsToolDef(): JsonTool {
  return tool(
    "WorkflowListPrebuiltWorkflows",
    "List installed reusable workflow starting facts without loading hidden prompt bodies.",
    {},
    [],
    (runtime) => ({ workflows: createWorkflowComponentForRuntime(runtime).catalog.listPrebuiltWorkflows(), effectDispatched: false }),
  )
}

export function buildWorkflowListReusableAgentsToolDef(): JsonTool {
  return tool(
    "WorkflowListReusableAgents",
    "List prompt-free briefs for installed reusable workflow agent resources; an empty list is an explicit catalog fact.",
    {},
    [],
    (runtime) => ({ agents: createWorkflowComponentForRuntime(runtime).catalog.listReusableAgents(), effectDispatched: false }),
  )
}

export function buildWorkflowOpenAuthoringSessionToolDef(): JsonTool {
  return tool(
    "WorkflowOpenAuthoringSession",
    "Open a recoverable four-mount workflow authoring session from an empty, template or prebuilt starting fact.",
    {
      session_id: { type: "string" },
      form: { type: "string", enum: ["AICtrlWorkflow", "AIDataWorkflow", "ai-ctrl", "ai-data"] },
      template_id: { type: "string" },
      prebuilt_id: { type: "string" },
      workflow_ref: { type: "string", description: "Published logical resource or VFS ref to import into /base and /work." },
      target: { type: "object", additionalProperties: true },
    },
    [],
    async (runtime, input) => {
      const component = createWorkflowComponentForRuntime(runtime)
      const startingFacts = [input.template_id, input.prebuilt_id, input.workflow_ref].filter(Boolean)
      if (startingFacts.length > 1) throw new Error("Choose template_id, prebuilt_id or workflow_ref, not more than one")
      if (input.template_id) {
        const template = component.catalog.getTemplate(text(input.template_id, "template_id"))
        return component.sessions.open({
          sessionId: input.session_id,
          form: template.form,
          template: template.files,
          target: input.target,
        })
      }
      if (input.prebuilt_id) {
        const prebuilt = component.catalog.getPrebuiltWorkflow(text(input.prebuilt_id, "prebuilt_id"))
        return component.sessions.open({
          sessionId: input.session_id,
          form: prebuilt.form,
          template: prebuilt.files,
          target: input.target,
        })
      }
      if (input.workflow_ref) {
        if (!component.authoring) throw new Error("Workflow authoring workspace is not bound")
        const resolved = await new WorkflowDefinitionRepository(component.authoring).resolve(text(input.workflow_ref, "workflow_ref"))
        const paths = await component.authoring.tree(resolved.bundlePath)
        const prefix = `${resolved.bundlePath}/`
        const source = await Promise.all(paths.map(async (item) => ({
          path: item.slice(prefix.length),
          content: await component.authoring!.read(item),
        })))
        return component.sessions.open({
          sessionId: input.session_id,
          form: resolved.binding.kind,
          source,
          target: input.target ?? {
            scope: "definition",
            id: resolved.binding.definition.fqn,
            path: resolved.bundlePath,
            resourceRef: resolved.workflowRef,
          },
        })
      }
      return component.sessions.open({
        sessionId: input.session_id,
        form: form(input.form),
        target: input.target,
      })
    },
  )
}

export function buildWorkflowValidateAuthoringSessionToolDef(): JsonTool {
  return tool(
    "WorkflowValidateAuthoringSession",
    "Canonically validate the current /work package and bind proof to its content revision.",
    { session_id: { type: "string" } },
    ["session_id"],
    (runtime, input) => createWorkflowComponentForRuntime(runtime).sessions.validate(text(input.session_id, "session_id")),
  )
}

export function buildWorkflowDryRunAuthoringSessionToolDef(): JsonTool {
  return tool(
    "WorkflowDryRunAuthoringSession",
    "Statically dry-run the currently validated /work revision without dispatching effects.",
    { session_id: { type: "string" } },
    ["session_id"],
    (runtime, input) => createWorkflowComponentForRuntime(runtime).sessions.dryRun(text(input.session_id, "session_id")),
  )
}

export function buildWorkflowPublishAuthoringSessionToolDef(): JsonTool {
  return tool(
    "WorkflowPublishAuthoringSession",
    "Publish one current validated and dry-run authoring revision after explicit authorization; publication never executes it.",
    {
      session_id: { type: "string" },
      confirmed: { type: "boolean" },
      target_path: {
        type: "string",
        description: "Plain workspace-relative bundle directory, for example ai-trend-report; never a URI or manifest filename.",
      },
    },
    ["session_id", "confirmed"],
    (runtime, input) => createWorkflowComponentForRuntime(runtime).sessions.publish({
      sessionId: text(input.session_id, "session_id"),
      confirmed: input.confirmed === true,
      targetPath: input.target_path,
    }),
  )
}

export function buildWorkflowPreparePublicationToolDef(): JsonTool {
  return tool(
    "WorkflowPreparePublication",
    "Deterministically produce the complete exact-revision diff, validation, static projection, build and component-derived acceptance-disposition receipt set without publishing or running real effects.",
    { session_id: { type: "string" } },
    ["session_id"],
    (runtime, input) => createWorkflowComponentForRuntime(runtime).sessions.preparePublication({
      sessionId: text(input.session_id, "session_id"),
    }),
  )
}

export function buildWorkflowCompleteAuthoringToolDef(): JsonTool {
  return tool(
    "WorkflowCompleteAuthoring",
    "Request a terminal authoring transition; the component generates the authoritative typed receipt from persisted session and proof facts.",
    {
      session_id: { type: "string" },
      expected_revision: { type: "string" },
      stage: { type: "string", enum: ["coding", "testing", "releasing"] },
      outcome: { type: "string", enum: ["ready", "published", "waiting", "failed"] },
    },
    ["session_id", "expected_revision", "stage", "outcome"],
    (runtime, input) => createWorkflowComponentForRuntime(runtime).sessions.createAuthoringReceipt({
      sessionId: text(input.session_id, "session_id"),
      expectedWorkingRevision: text(input.expected_revision, "expected_revision"),
      stage: input.stage,
      outcome: input.outcome,
    }),
  )
}

export function buildWorkflowListAuthoringSessionsToolDef(): JsonTool {
  return tool(
    "WorkflowListAuthoringSessions",
    "List recoverable workflow authoring session facts for the current injected workspace root.",
    {
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      cursor: { type: "string" },
    },
    [],
    async (runtime, input) => projectWorkflowAuthoringSessionPage(
      await createWorkflowComponentForRuntime(runtime).sessions.list(),
      { limit: input.limit, cursor: input.cursor },
    ),
  )
}

export function buildWorkflowGetAuthoringSummaryToolDef(): JsonTool {
  return tool(
    "WorkflowGetAuthoringSummary",
    "Read one compact recoverable authoring session fact without guessing host paths.",
    { session_id: { type: "string" } },
    ["session_id"],
    async (runtime, input) => projectWorkflowAuthoringSummary(
      await createWorkflowComponentForRuntime(runtime).sessions.describe(text(input.session_id, "session_id")),
    ),
  )
}

export function buildWorkflowAuthoringToolDefs(): JsonTool[] {
  return [
    buildWorkflowGetAuthoringContextToolDef(),
    buildWorkflowListAuthoringTemplatesToolDef(),
    buildWorkflowListPrebuiltWorkflowsToolDef(),
    buildWorkflowListReusableAgentsToolDef(),
    buildWorkflowOpenAuthoringSessionToolDef(),
    buildWorkflowValidateAuthoringSessionToolDef(),
    buildWorkflowDryRunAuthoringSessionToolDef(),
    buildWorkflowPreparePublicationToolDef(),
    buildWorkflowCompleteAuthoringToolDef(),
    buildWorkflowPublishAuthoringSessionToolDef(),
    buildWorkflowListAuthoringSessionsToolDef(),
    buildWorkflowGetAuthoringSummaryToolDef(),
  ]
}
