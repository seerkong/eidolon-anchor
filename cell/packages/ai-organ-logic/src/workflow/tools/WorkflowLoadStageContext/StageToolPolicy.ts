import type { AiWorkflowStageId } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import { resetActorContinuationBaseline } from "../../../runtime/ContextControlPlane"
import { readWorkflowLifecycleFacet } from "../../runtime/WorkflowLifecycleFacet"
import { projectWorkflowProviderSurface } from "../../runtime/WorkflowProviderSurfaceStrategy"
import {
  AI_WORKFLOW_PROVIDER_TOOL_SURFACE,
  AI_WORKFLOW_STAGE_TOOL_POLICY,
} from "../WorkflowStageToolCatalog"

export { AI_WORKFLOW_PROVIDER_TOOL_SURFACE, AI_WORKFLOW_STAGE_TOOL_POLICY }

export function applyAiWorkflowStageToolPolicy(
  actor: {
    toolPolicy?: {
      allowedTools: string[]
      allowedToolsMode?: "all" | "exact"
      providerToolSurface?: { mode: "all" | "exact"; toolNames: string[] }
    }
    continuationBaseline?: AiAgentActor["continuationBaseline"]
    runtimeFacets?: AiAgentActor["runtimeFacets"]
  },
  stage: AiWorkflowStageId,
): readonly string[] {
  const allowed = [...AI_WORKFLOW_STAGE_TOOL_POLICY[stage]]
  if (!actor.toolPolicy) throw new Error("Workflow stage context requires an actor tool policy")
  const facet = readWorkflowLifecycleFacet(actor as Pick<AiAgentActor, "runtimeFacets">)
  if (!facet) throw new Error("Workflow stage context requires lifecycle facet proof")
  const canonicalSurface = projectWorkflowProviderSurface({
    strategyRevision: facet.providerSurfaceStrategy.strategyRevision,
    stage,
  }).toolNames
  const currentSurface = actor.toolPolicy.providerToolSurface
  const surfaceMatches = currentSurface?.mode === "exact"
    && currentSurface.toolNames.length === canonicalSurface.length
    && currentSurface.toolNames.every((name, index) => name === canonicalSurface[index])
  if (!surfaceMatches) {
    actor.toolPolicy.providerToolSurface = {
      mode: "exact",
      toolNames: [...canonicalSurface],
    }
    resetActorContinuationBaseline({
      actor: actor as AiAgentActor,
      reason: "workflow_tool_surface_migration",
    })
  }
  actor.toolPolicy.allowedToolsMode = "exact"
  actor.toolPolicy.allowedTools = allowed
  return allowed
}

export function applyAiWorkflowStageSystemContext(
  actor: {
    systemPrompts?: string[]
    continuationBaseline?: AiAgentActor["continuationBaseline"]
  },
  stage: AiWorkflowStageId,
  context: string,
): {
  kind: "eidolon.aiWorkflowStageContext"
  stage: AiWorkflowStageId
  authority: "actor-durable-material:workflow-resource-package"
  context: string
} {
  if (!actor.systemPrompts) throw new Error("Workflow stage context requires actor system prompts")
  return {
    kind: "eidolon.aiWorkflowStageContext",
    stage,
    authority: "actor-durable-material:workflow-resource-package",
    context,
  }
}
