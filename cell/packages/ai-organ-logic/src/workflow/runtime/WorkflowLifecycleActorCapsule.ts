import type { ActorRuntimeFacetIndex } from "@cell/ai-core-contract/runtime/ActorRuntimeFacet"
import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime"
import type { FrozenAiWorkflowResourcePackage } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import { ensureVmRuntimeContext } from "@cell/ai-core-logic/runtime/runtime"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { spawnChildExecutionActor } from "../../agent/DelegateActor"
import {
  assertWorkflowLifecycleActorCapability,
  createWorkflowLifecycleFacetEnvelope,
  createWorkflowLifecycleResourcePackageMaterial,
  extendWorkflowLifecycleFacetRegistry,
  migrateWorkflowLifecycleFacetV1,
  readWorkflowLifecycleFacet,
  WORKFLOW_LIFECYCLE_FACET_ID,
  WORKFLOW_LIFECYCLE_TOOL_PROFILE_ID,
  WORKFLOW_LIFECYCLE_TOOL_PROFILE_REVISION,
  resolveWorkflowLifecycleFrozenResourcePackage,
} from "./WorkflowLifecycleFacet"
import {
  SELECTED_WORKFLOW_SURFACE_STRATEGY_REVISION,
  projectWorkflowProviderSurface,
  type WorkflowSurfaceStrategyRevision,
} from "./WorkflowProviderSurfaceStrategy"
import {
  resolveWorkflowLifecycleToolProfileRegistry,
  type WorkflowLifecycleToolProfileRegistry,
} from "../tools/WorkflowLifecycleToolProfileRuntime"

const BOUND_ACTORS = new WeakSet<AiAgentActor>()

function profileForVm(vm: AiAgentVm) {
  const toolRegistry = vm.registries.toolRegistry
  if (!toolRegistry) {
    throw new Error("WORKFLOW_LIFECYCLE_TOOL_PROFILE_UNAVAILABLE: VM tool registry is required")
  }
  const profileRegistry = resolveWorkflowLifecycleToolProfileRegistry(toolRegistry)
  const profile = profileRegistry.resolve(
    WORKFLOW_LIFECYCLE_TOOL_PROFILE_ID,
    WORKFLOW_LIFECYCLE_TOOL_PROFILE_REVISION,
  )
  return { toolRegistry, profileRegistry, profile }
}

function projectExactLifecycleToolset(
  vm: AiAgentVm,
  actor: AiAgentActor,
  profileRegistry: WorkflowLifecycleToolProfileRegistry,
): unknown[] {
  const facet = assertWorkflowLifecycleActorCapability({ actor, profileRegistry })
  const profile = profileRegistry.resolve(
    facet.toolProfile.profileId,
    facet.toolProfile.profileRevision,
  )
  const stage = (facet.stageId ?? "planning") as Parameters<typeof projectWorkflowProviderSurface>[0]["stage"]
  const presentation = projectWorkflowProviderSurface({
    strategyRevision: facet.providerSurfaceStrategy.strategyRevision,
    stage,
  })
  const definitions = new Map(
    ToolFuncRegistry.list(vm.registries.toolRegistry!).map((definition) => [
      definition.schema.function.name,
      definition.schema,
    ]),
  )
  return presentation.toolNames.map((name) => {
    const schema = definitions.get(name)
    if (!schema) {
      throw new Error(`WORKFLOW_LIFECYCLE_TOOL_PROFILE_UNAVAILABLE: admitted definition unavailable '${name}'`)
    }
    return structuredClone(schema)
  })
}

function bindLifecycleActorToolset(
  vm: AiAgentVm,
  actor: AiAgentActor,
  profileRegistry: WorkflowLifecycleToolProfileRegistry,
): void {
  if (BOUND_ACTORS.has(actor)) return
  actor.callbacks.buildToolset = (currentVm, currentActor) => (
    projectExactLifecycleToolset(currentVm, currentActor, profileRegistry)
  )
  BOUND_ACTORS.add(actor)
}

export function recoverWorkflowLifecycleActorCapability(vm: AiAgentVm, actor: AiAgentActor): boolean {
  if (!actor.runtimeFacets[WORKFLOW_LIFECYCLE_FACET_ID]) return false
  migrateWorkflowLifecycleFacetV1(actor)
  const runtimeContext = ensureVmRuntimeContext(vm)
  runtimeContext.actorFacetRuntime = extendWorkflowLifecycleFacetRegistry(runtimeContext.actorFacetRuntime)
  const { profileRegistry } = profileForVm(vm)
  assertWorkflowLifecycleActorCapability({ actor, profileRegistry })
  bindLifecycleActorToolset(vm, actor, profileRegistry)
  return true
}

export async function spawnWorkflowLifecycleExecutionActor(
  vm: AiAgentVm,
  parentActor: AiAgentActor,
  params: {
    description: string
    prompt: string
    systemSkillMaterial: string
    systemSkillPackage?: FrozenAiWorkflowResourcePackage
    mode?: "sync_wait" | "detached"
    toolCallId?: string
    parentToolName?: string
    retainActor?: boolean
    onActorCreated?: (actor: AiAgentActor) => void
  },
): Promise<string> {
  return spawnWorkflowLifecycleActorWithStrategy(vm, parentActor, params, SELECTED_WORKFLOW_SURFACE_STRATEGY_REVISION)
}

/**
 * Closed experiment-only admission. Production WorkflowAuthor always calls
 * spawnWorkflowLifecycleExecutionActor and therefore cannot select a strategy.
 */
export async function spawnWorkflowLifecycleSurfaceExperimentActor(
  vm: AiAgentVm,
  parentActor: AiAgentActor,
  params: Parameters<typeof spawnWorkflowLifecycleExecutionActor>[2] & {
    strategyRevision: WorkflowSurfaceStrategyRevision
  },
): Promise<string> {
  const { strategyRevision, ...actorParams } = params
  return spawnWorkflowLifecycleActorWithStrategy(vm, parentActor, actorParams, strategyRevision)
}

async function spawnWorkflowLifecycleActorWithStrategy(
  vm: AiAgentVm,
  parentActor: AiAgentActor,
  params: Parameters<typeof spawnWorkflowLifecycleExecutionActor>[2],
  strategyRevision: WorkflowSurfaceStrategyRevision,
): Promise<string> {
  const runtimeContext = ensureVmRuntimeContext(vm)
  runtimeContext.actorFacetRuntime = extendWorkflowLifecycleFacetRegistry(runtimeContext.actorFacetRuntime)
  const { profileRegistry, profile } = profileForVm(vm)
  const now = Date.now()
  const resourcePackage = resolveWorkflowLifecycleFrozenResourcePackage({
    systemPrompts: [params.systemSkillMaterial],
    resourcePackage: params.systemSkillPackage,
  })
  const packageMaterial = createWorkflowLifecycleResourcePackageMaterial(resourcePackage)
  const envelope = createWorkflowLifecycleFacetEnvelope({
    systemPrompts: [params.systemSkillMaterial],
    toolNames: profile.admittedNames,
    strategyRevision,
    resourcePackage,
    progress: {
      stageStartedAt: now,
      deadlineAt: now + 180_000,
      turnsSinceProgress: 0,
      maxNoProgressTurns: 4,
      proofRepairAttempts: 0,
      maxProofRepairAttempts: 3,
      lastProgressAt: now,
    },
  })
  const runtimeFacets: ActorRuntimeFacetIndex = Object.freeze({
    [WORKFLOW_LIFECYCLE_FACET_ID]: envelope,
  })
  const initialSurface = projectWorkflowProviderSurface({
    strategyRevision,
    stage: "planning",
  })
  return await spawnChildExecutionActor(vm, parentActor, {
    description: params.description,
    prompt: params.prompt,
    agentType: "workflow",
    additionalSystemPrompts: [params.systemSkillMaterial],
    runtimeFacets,
    durableMaterials: { [packageMaterial.digest]: packageMaterial },
    providerToolSurface: { mode: "exact", toolNames: initialSurface.toolNames },
    buildToolset: (currentVm, currentActor) => projectExactLifecycleToolset(
      currentVm,
      currentActor,
      profileRegistry,
    ),
    validateBeforeRegistration: (actor) => {
      assertWorkflowLifecycleActorCapability({ actor, profileRegistry })
    },
    mode: params.mode,
    toolCallId: params.toolCallId,
    parentToolName: params.parentToolName,
    retainActor: params.retainActor,
    onActorCreated: params.onActorCreated,
  })
}
