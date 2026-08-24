import {
  AI_WORKFLOW_FORMS,
  validateAiWorkflowResourceRef,
  type AiWorkflowForm,
  type AiWorkflowResourceRefValidationResult,
  type AIWorkflowSubstrate,
} from "@cell/ai-workflow-contract"
import {
  WorkflowResourceLoader,
  type WorkflowResourceDiagnostic,
} from "../resources"

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
  workflowRef: string
  files: WorkflowBundleFileDraft[]
  diagnostics: AiWorkflowResourceRefValidationResult[]
  canonicalProof: {
    valid: true
    form: AiWorkflowForm
    substrate: AIWorkflowSubstrate
    definitionFqn: string
    diagnostics: WorkflowResourceDiagnostic[]
  }
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
  manifest_content?: string
  flow_code_content?: string
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

function renderManifest(command: {
  form: AiWorkflowForm
  fqn: string
}): string {
  if (command.form === "AICtrlWorkflow") {
    return [
      `<AICtrlWorkflow #${command.fqn} apiVersion="depa.flows/v1" version="1.0.0" (`,
      `  <FlowContract #${command.fqn}>`,
      `) [`,
      `  <Return #done>`,
      `]>`,
      ``,
    ].join("\n")
  }
  return [
    `<AIDataWorkflow #${command.fqn} apiVersion="depa.flows/v1" version="1.0.0" (`,
    `  <FlowContract #${command.fqn} { inputPorts = ["input"] outputPorts = ["result"] }>`,
    `) [`,
    `  <EntryNode #entry>`,
    `  <ReturnNode #return { inputs = { result = "flow-port://#entry/input" } }>`,
    `]>`,
    ``,
  ].join("\n")
}

function renderFlowCode(command: {
  form: AiWorkflowForm
  fqn: string
  name: string
  description: string
}): string {
  return [
    `import type {`,
    `  AIAgentEffectConfig,`,
    `  AIAgentInvocation,`,
    `  AIAgentSelector,`,
    `  AIWorkflowStepExtensionAuthoredRuntimeContext,`,
    `  FlowClosedValue,`,
    `  RunStepExtensionMutationConfig,`,
    `  RunStepExtensionMutationInvocation,`,
    `  RunStepExtensionSelector,`,
    `} from "ai-workflow-contract"`,
    ``,
    `type AuthoredMaterialWriteInput = Readonly<{ path: string; content: FlowClosedValue }>`,
    `type AuthoredMaterialWriteResult = Readonly<{ path: string; revision: string }>`,
    `type AuthoredMaterialEffects = {`,
    `  writeMaterial(`,
    `    input: AuthoredMaterialWriteInput,`,
    `    config?: Readonly<Record<string, FlowClosedValue>>,`,
    `  ): Promise<AuthoredMaterialWriteResult>`,
    `}`,
    `type AuthoredAgentRuntime = {`,
    `  readonly ai: AIWorkflowStepExtensionAuthoredRuntimeContext & {`,
    `    readonly effects: AIWorkflowStepExtensionAuthoredRuntimeContext["effects"] & AuthoredMaterialEffects`,
    `  }`,
    `}`,
    ``,
    `export const workflowDefinitionRef = "vfs://./manifest.xnl" as const`,
    `export const workflowForm = "${command.form}" as const`,
    `export const workflowName = ${JSON.stringify(command.name)} as const`,
    `export const workflowDescription = ${JSON.stringify(command.description)} as const`,
    ``,
    `export function runAgent<Input extends FlowClosedValue, Output extends FlowClosedValue>(`,
    `  runtime: AuthoredAgentRuntime,`,
    `  input: Input,`,
    `  config: AIAgentEffectConfig,`,
    `) {`,
    `  return runtime.ai.effects.runAgent<Input, Output>(input, config)`,
    `}`,
    ``,
    `export function runTargetedAgent<Input extends FlowClosedValue, Output extends FlowClosedValue>(`,
    `  runtime: AuthoredAgentRuntime,`,
    `  selector: AIAgentSelector,`,
    `  invocation: AIAgentInvocation<Input>,`,
    `  config: AIAgentEffectConfig,`,
    `) {`,
    `  return runtime.ai.effects.runTargetedAgent<Input, Output>(selector, invocation, config)`,
    `}`,
    ``,
    `export function mutateRunStepExtension(`,
    `  runtime: AuthoredAgentRuntime,`,
    `  selector: RunStepExtensionSelector,`,
    `  invocation: RunStepExtensionMutationInvocation,`,
    `  config: RunStepExtensionMutationConfig = {},`,
    `) {`,
    `  return runtime.ai.effects.mutateRunStepExtension(selector, invocation, config)`,
    `}`,
    ``,
    `export function writeMaterial(`,
    `  runtime: AuthoredAgentRuntime,`,
    `  input: AuthoredMaterialWriteInput,`,
    `  config: Readonly<Record<string, FlowClosedValue>> = {},`,
    `) {`,
    `  return runtime.ai.effects.writeMaterial(input, config)`,
    `}`,
    ``,
    `export function identity(_runtime: any, input: unknown) {`,
    `  return input`,
    `}`,
    ``,
  ].join("\n")
}

export class WorkflowCommandService {
  constructor(private readonly resources = new WorkflowResourceLoader()) {}

  createBundleDraft(command: WorkflowCreateBundleCommand): WorkflowBundleDraft {
    const form = normalizeForm(command.form)
    const name = command.name.trim() || "workflow"
    const slug = slugifyName(name)
    const fqn = command.fqn?.trim() || defaultFqn(name)
    const description = command.description?.trim() || `${name} ${form} bundle.`
    const bundleRootRef = `vfs://./${slug}/`
    const workflowRef = `vfs://./${slug}/manifest.xnl`
    const files: WorkflowBundleFileDraft[] = [
      {
        path: `${slug}/manifest.xnl`,
        ref: "vfs://./manifest.xnl",
        content: command.manifest_content?.trim() || renderManifest({ form, fqn }),
      },
      {
        path: `${slug}/flow-code/index.ts`,
        ref: "vfs://./flow-code/index.ts",
        content: command.flow_code_content?.trim() || renderFlowCode({ form, fqn, name, description }),
      },
    ]
    const diagnostics = [
      validateAiWorkflowResourceRef(bundleRootRef),
      validateAiWorkflowResourceRef(workflowRef),
      ...files.map((file) => validateAiWorkflowResourceRef(file.ref)),
    ]
    const canonical = this.resources.load({
      form,
      sources: { "manifest.xnl": files[0].content },
    })
    if (!canonical.binding || !canonical.substrate || canonical.diagnostics.length > 0) {
      const details = canonical.diagnostics
        .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
        .join("; ")
      throw new Error(`Generated ${form} draft failed canonical validation${details ? `: ${details}` : ""}`)
    }
    if (canonical.binding.definition.fqn !== fqn) {
      throw new Error(
        `Generated ${form} draft FQN mismatch: expected ${fqn}, got ${canonical.binding.definition.fqn}`,
      )
    }
    return {
      kind: "workflow.bundleDraft",
      form,
      name,
      fqn,
      bundleRootRef,
      workflowRef,
      files,
      diagnostics,
      canonicalProof: {
        valid: true,
        form,
        substrate: canonical.substrate,
        definitionFqn: canonical.binding.definition.fqn,
        diagnostics: canonical.diagnostics,
      },
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
