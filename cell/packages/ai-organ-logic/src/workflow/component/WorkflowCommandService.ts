import {
  AI_WORKFLOW_FORMS,
  validateAiWorkflowResourceRef,
  type AiWorkflowForm,
  type AiWorkflowResourceRefValidationResult,
} from "@cell/ai-workflow-contract"

export type WorkflowBundleFileDraft = {
  path: string
  ref: string
  content: string
}

export type WorkflowBundleDraft = {
  kind: "workflow.bundleDraft"
  form: AiWorkflowForm
  name: string
  fqn: string
  bundleRootRef: string
  resourceRef: string
  files: WorkflowBundleFileDraft[]
  diagnostics: AiWorkflowResourceRefValidationResult[]
  writePolicy: {
    physicalWritePerformed: false
    reason: string
  }
}

export type WorkflowCreateBundleCommand = {
  form: AiWorkflowForm | "ai-data" | "ai-ctrl"
  name: string
  fqn?: string
  description?: string
}

export type WorkflowPatchBundleCommand = {
  manifestRef: string
  intent?: string
  replacementManifestContent?: string
}

export type WorkflowPatchBundlePlan = {
  kind: "workflow.patchPlan"
  manifestRef: string
  manifestValidation: AiWorkflowResourceRefValidationResult
  intent: string
  replacementManifestContent?: string
  diagnostics: AiWorkflowResourceRefValidationResult[]
  writePolicy: {
    physicalWritePerformed: false
    reason: string
  }
}

function normalizeForm(form: WorkflowCreateBundleCommand["form"]): AiWorkflowForm {
  if (form === "ai-data") return "AIDataWorkflow"
  if (form === "ai-ctrl") return "AICtrlWorkflow"
  if ((AI_WORKFLOW_FORMS as readonly string[]).includes(form)) return form
  throw new Error(`Unsupported AI workflow form: ${String(form)}`)
}

function slugifyName(value: string): string {
  const slug = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "workflow"
}

function toPascalCase(value: string): string {
  const words = slugifyName(value).split("-").filter(Boolean)
  const pascal = words.map((word) => word.slice(0, 1).toUpperCase() + word.slice(1)).join("")
  return pascal || "Workflow"
}

function defaultFqn(name: string): string {
  return `local.workflow.${toPascalCase(name)}`
}

function resourceRefForFqn(fqn: string): string {
  return `resource://${fqn}`
}

function xnlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function renderManifest(command: {
  form: AiWorkflowForm
  name: string
  fqn: string
  description: string
  slug: string
}): string {
  return [
    `<AIWorkflowAppBundle #${command.fqn} {`,
    `  form = "${command.form}"`,
    `  name = "${command.name}"`,
    `  resource_ref = "${resourceRefForFqn(command.fqn)}"`,
    `}>`,
    `(`,
    `  <description ?>${xnlText(command.description)}</?>`,
    `  <ResourceCatalog src = "vfs://./resources/catalog.xnl" />`,
    `  <WorkflowDefinition src = "vfs://./workflows/${command.slug}.workflow.xnl" />`,
    `  <MaterialPorts src = "vfs://./materials/ports.xnl" />`,
    `)`,
    ``,
  ].join("\n")
}

function renderCatalog(command: { fqn: string; slug: string; form: AiWorkflowForm }): string {
  return [
    `<ResourceCatalog #${command.fqn}.catalog { bundle = "resource://${command.fqn}" }>`,
    `(`,
    `  <ResourceEntry #manifest { ref = "vfs://./manifest.xnl" kind = "manifest" format = "xnl" } />`,
    `  <ResourceEntry #workflow { ref = "vfs://./workflows/${command.slug}.workflow.xnl" kind = "${command.form}" format = "xnl" } />`,
    `  <ResourceEntry #ports { ref = "vfs://./materials/ports.xnl" kind = "MaterialPorts" format = "xnl" } />`,
    `  <ResourceEntry #code { ref = "vfs://./flow-code/index.ts" kind = "flow-code" format = "typescript" } />`,
    `)`,
    ``,
  ].join("\n")
}

function renderWorkflowDefinition(command: {
  form: AiWorkflowForm
  fqn: string
  name: string
  description: string
}): string {
  return [
    `<${command.form} #${command.fqn}.workflow {`,
    `  resource_ref = "resource://${command.fqn}"`,
    `  name = "${command.name}"`,
    `}>`,
    `(`,
    `  <description ?>${xnlText(command.description)}</?>`,
    `  <Messages />`,
    `  <MaterialBindings />`,
    `  <Nodes />`,
    `)`,
    ``,
  ].join("\n")
}

function renderPorts(fqn: string): string {
  return [
    `<MaterialPorts #${fqn}.ports>`,
    `(`,
    `  <MaterialPort #input { direction = "input" kind = "json" required = true } />`,
    `  <MaterialPort #result { direction = "output" kind = "json" required = false } />`,
    `)`,
    ``,
  ].join("\n")
}

function renderFlowCode(command: { form: AiWorkflowForm; fqn: string }): string {
  return [
    `export const workflowResourceRef = "resource://${command.fqn}" as const`,
    `export const workflowForm = "${command.form}" as const`,
    ``,
  ].join("\n")
}

export class WorkflowCommandService {
  createBundleDraft(command: WorkflowCreateBundleCommand): WorkflowBundleDraft {
    const form = normalizeForm(command.form)
    const name = command.name.trim() || "workflow"
    const slug = slugifyName(name)
    const fqn = command.fqn?.trim() || defaultFqn(name)
    const description = command.description?.trim() || `${name} ${form} bundle.`
    const bundleRootRef = `vfs://./workflows/${slug}/`
    const resourceRef = resourceRefForFqn(fqn)
    const files: WorkflowBundleFileDraft[] = [
      {
        path: `workflows/${slug}/manifest.xnl`,
        ref: "vfs://./manifest.xnl",
        content: renderManifest({ form, name, fqn, description, slug }),
      },
      {
        path: `workflows/${slug}/resources/catalog.xnl`,
        ref: "vfs://./resources/catalog.xnl",
        content: renderCatalog({ fqn, slug, form }),
      },
      {
        path: `workflows/${slug}/workflows/${slug}.workflow.xnl`,
        ref: `vfs://./workflows/${slug}.workflow.xnl`,
        content: renderWorkflowDefinition({ form, fqn, name, description }),
      },
      {
        path: `workflows/${slug}/materials/ports.xnl`,
        ref: "vfs://./materials/ports.xnl",
        content: renderPorts(fqn),
      },
      {
        path: `workflows/${slug}/flow-code/index.ts`,
        ref: "vfs://./flow-code/index.ts",
        content: renderFlowCode({ form, fqn }),
      },
    ]
    const diagnostics = [
      validateAiWorkflowResourceRef(bundleRootRef),
      validateAiWorkflowResourceRef(resourceRef),
      ...files.map((file) => validateAiWorkflowResourceRef(file.ref)),
    ]
    return {
      kind: "workflow.bundleDraft",
      form,
      name,
      fqn,
      bundleRootRef,
      resourceRef,
      files,
      diagnostics,
      writePolicy: {
        physicalWritePerformed: false,
        reason: "Workflow component produced a controlled draft only; a write adapter must explicitly apply it.",
      },
    }
  }

  createPatchPlan(command: WorkflowPatchBundleCommand): WorkflowPatchBundlePlan {
    const manifestValidation = validateAiWorkflowResourceRef(command.manifestRef)
    return {
      kind: "workflow.patchPlan",
      manifestRef: command.manifestRef,
      manifestValidation,
      intent: command.intent?.trim() || "Patch workflow bundle.",
      replacementManifestContent: command.replacementManifestContent,
      diagnostics: [manifestValidation],
      writePolicy: {
        physicalWritePerformed: false,
        reason: "Workflow patch command validates and plans the change; it does not directly write host files.",
      },
    }
  }
}
