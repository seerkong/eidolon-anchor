import type { AiWorkflowStageId } from "@cell/ai-support/system-skill/SystemSkillInstaller"

const LOAD = "WorkflowLoadStageContext"

export const AI_WORKFLOW_STAGE_TOOL_POLICY: Readonly<Record<AiWorkflowStageId, readonly string[]>> = {
  planning: [
    LOAD,
    "WorkflowListApps",
    "WorkflowGetApp",
    "WorkflowGetAuthoringContext",
    "WorkflowListAuthoringTemplates",
    "WorkflowListPrebuiltWorkflows",
    "WorkflowListReusableAgents",
    "WorkflowListAuthoringSessions",
    "WorkflowGetAuthoringSummary",
    "WorkflowInspectCapability",
    "WorkflowListTypes",
    "WorkflowListInstances",
    "WorkflowGetInstance",
    "WorkflowGetFlowSummary",
  ],
  coding: [
    LOAD,
    "Skill",
    "WorkflowListApps",
    "WorkflowGetApp",
    "WorkflowGetAuthoringContext",
    "WorkflowListAuthoringTemplates",
    "WorkflowListPrebuiltWorkflows",
    "WorkflowListReusableAgents",
    "WorkflowListAuthoringSessions",
    "WorkflowGetAuthoringSummary",
    "WorkflowOpenAuthoringSession",
    "WorkflowWorkspace",
    "WorkflowInspectCapability",
    "WorkflowValidateResourceRef",
    "WorkflowCreateBundle",
    "WorkflowPatchBundle",
  ],
  building: [
    LOAD,
    "Skill",
    "WorkflowGetAuthoringSummary",
    "WorkflowValidateAuthoringSession",
    "WorkflowValidateResourceRef",
    "WorkflowInspectCapability",
  ],
  testing: [
    LOAD,
    "Skill",
    "WorkflowGetAuthoringSummary",
    "WorkflowValidateAuthoringSession",
    "WorkflowDryRunAuthoringSession",
    "WorkflowPreparePublication",
    "WorkflowCompleteAuthoring",
    "WorkflowInspectCapability",
  ],
  releasing: [
    LOAD,
    "Skill",
    "WorkflowGetAuthoringSummary",
    "WorkflowValidateAuthoringSession",
    "WorkflowDryRunAuthoringSession",
    "WorkflowPreparePublication",
    "WorkflowCompleteAuthoring",
    "WorkflowPublishAuthoringSession",
  ],
  deploying: [
    LOAD,
    "Skill",
    "WorkflowListApps",
    "WorkflowGetApp",
    "WorkflowListTypes",
    "WorkflowGetType",
    "WorkflowCreateInstance",
    "WorkflowCreateInstanceFromPrebuilt",
    "WorkflowListInstances",
    "WorkflowGetInstance",
    "WorkflowMaterialImport",
    "WorkflowMaterialInspect",
    "WorkflowMaterialBind",
  ],
  operating: [
    LOAD,
    "Skill",
    "WorkflowGetInstance",
    "WorkflowUpdateRunVars",
    "WorkflowRun",
    "WorkflowStatus",
    "WorkflowResume",
    "WorkflowResolve",
    "WorkflowReject",
    "WorkflowApplyGraphPatch",
  ],
  monitoring: [
    LOAD,
    "Skill",
    "WorkflowStatus",
    "WorkflowEvents",
    "WorkflowResult",
    "WorkflowGetFlowSummary",
    "WorkflowListSessionFlows",
    "WorkflowMaterialInspect",
    "WorkflowMaterialExport",
    "WorkflowMaterialReplay",
    "WorkflowMaterialCleanup",
  ],
  improving: [
    LOAD,
    "Skill",
    "WorkflowGetAuthoringSummary",
    "WorkflowStatus",
    "WorkflowEvents",
    "WorkflowResult",
    "WorkflowGetFlowSummary",
  ],
}

export function applyAiWorkflowStageToolPolicy(
  actor: { toolPolicy?: { allowedTools: string[]; allowedToolsMode?: "all" | "exact" } },
  stage: AiWorkflowStageId,
): readonly string[] {
  const allowed = [...AI_WORKFLOW_STAGE_TOOL_POLICY[stage]]
  if (!actor.toolPolicy) throw new Error("Workflow stage context requires an actor tool policy")
  actor.toolPolicy.allowedToolsMode = "exact"
  actor.toolPolicy.allowedTools = allowed
  return allowed
}

const STAGE_SYSTEM_PROMPT_MARKER = "<!-- eidolon:sys-eidolon-anchor-devops-stage="

export function applyAiWorkflowStageSystemContext(
  actor: { systemPrompts?: string[] },
  stage: AiWorkflowStageId,
  context: string,
): void {
  if (!actor.systemPrompts) throw new Error("Workflow stage context requires actor system prompts")
  actor.systemPrompts = actor.systemPrompts.filter((prompt) => !prompt.startsWith(STAGE_SYSTEM_PROMPT_MARKER))
  actor.systemPrompts.push(`${STAGE_SYSTEM_PROMPT_MARKER}${stage} -->\n${context}`)
}
