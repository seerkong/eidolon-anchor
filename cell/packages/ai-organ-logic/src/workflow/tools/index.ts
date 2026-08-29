import { createHash } from "node:crypto"

import type { AnyToolDef } from "@cell/ai-core-contract/types"
import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import { stableDigest } from "../../llm/tool-schema/CanonicalSchemaFacts"
import { buildSkillToolDef } from "../../composer/AIAgent/tools/Skill"
import { readWorkflowLifecycleFacet } from "../runtime/WorkflowLifecycleFacet"
import { buildWorkflowFulfillToolDef } from "./WorkflowFulfill"
import { buildWorkflowAuthorToolDef } from "./WorkflowAuthor"
import { buildWorkflowAuthoringToolDefs } from "./WorkflowAuthoringTools"
import { buildWorkflowAppToolDefs } from "./WorkflowAppTools"
import { buildWorkflowCreateBundleToolDef } from "./WorkflowCreateBundle"
import { buildWorkflowInspectCapabilityToolDef } from "./WorkflowInspectCapability"
import { buildWorkflowPatchBundleToolDef } from "./WorkflowPatchBundle"
import {
  buildWorkflowEventsToolDef,
  buildWorkflowApplyGraphPatchToolDef,
  buildWorkflowMutateStepExtensionToolDef,
  buildWorkflowProcessHolonTaskToolDef,
  buildWorkflowReplanHolonTaskToolDef,
  buildWorkflowResultToolDef,
  buildWorkflowResumeToolDef,
  buildWorkflowResolveToolDef,
  buildWorkflowRejectToolDef,
  buildWorkflowRunToolDef,
  buildWorkflowStatusToolDef,
} from "./WorkflowRuntimeTools"
import { buildWorkflowValidateResourceRefToolDef } from "./WorkflowValidateResourceRef"
import { buildWorkflowWorkspaceToolDef } from "./WorkflowWorkspace"
import { buildWorkflowLifecycleToolDefs } from "./WorkflowLifecycleTools"
import { buildWorkflowLoadStageContextToolDef } from "./WorkflowLoadStageContext"
import { AI_WORKFLOW_PROVIDER_TOOL_SURFACE } from "./WorkflowLoadStageContext/StageToolPolicy"
import type {
  WorkflowLifecycleToolProfile,
  WorkflowLifecycleToolProfileRegistry,
} from "./WorkflowLifecycleToolProfileRuntime"
import {
  WORKFLOW_LIFECYCLE_DEFINITION_TOOL_NAMES,
  WORKFLOW_PUBLIC_GATEWAY_TOOL_NAMES,
} from "./WorkflowToolCatalog"

export type {
  WorkflowLifecycleToolProfile,
  WorkflowLifecycleToolProfileRegistry,
} from "./WorkflowLifecycleToolProfileRuntime"
export {
  bindWorkflowLifecycleToolProfileRegistry,
  resolveWorkflowLifecycleToolProfileRegistry,
} from "./WorkflowLifecycleToolProfileRuntime"

export { buildWorkflowCreateBundleToolDef } from "./WorkflowCreateBundle"
export { buildWorkflowFulfillToolDef } from "./WorkflowFulfill"
export { buildWorkflowAuthorToolDef } from "./WorkflowAuthor"
export * from "./WorkflowAuthoringTools"
export { buildWorkflowAppToolDefs } from "./WorkflowAppTools"
export { buildWorkflowInspectCapabilityToolDef } from "./WorkflowInspectCapability"
export { buildWorkflowPatchBundleToolDef } from "./WorkflowPatchBundle"
export {
  buildWorkflowEventsToolDef,
  buildWorkflowApplyGraphPatchToolDef,
  buildWorkflowMutateStepExtensionToolDef,
  buildWorkflowProcessHolonTaskToolDef,
  buildWorkflowReplanHolonTaskToolDef,
  buildWorkflowResultToolDef,
  buildWorkflowResumeToolDef,
  buildWorkflowResolveToolDef,
  buildWorkflowRejectToolDef,
  buildWorkflowRunToolDef,
  buildWorkflowStatusToolDef,
} from "./WorkflowRuntimeTools"
export { buildWorkflowValidateResourceRefToolDef } from "./WorkflowValidateResourceRef"
export { buildWorkflowWorkspaceToolDef } from "./WorkflowWorkspace"
export { buildWorkflowLifecycleToolDefs } from "./WorkflowLifecycleTools"
export { buildWorkflowLoadStageContextToolDef } from "./WorkflowLoadStageContext"
export {
  WORKFLOW_LIFECYCLE_DEFINITION_TOOL_NAMES,
  WORKFLOW_NATIVE_TOOL_NAMES,
  WORKFLOW_PUBLIC_GATEWAY_TOOL_NAMES,
} from "./WorkflowToolCatalog"

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sha256Names(names: readonly string[]): string {
  return `sha256:${createHash("sha256").update(names.join("\n")).digest("hex")}`
}

function buildWorkflowPublicGatewayDefinitions(): AnyToolDef[] {
  return [buildWorkflowFulfillToolDef(), buildWorkflowAuthorToolDef()]
}

function buildWorkflowLifecycleRawDefinitions(): AnyToolDef[] {
  return [
    buildWorkflowLoadStageContextToolDef(),
    ...buildWorkflowAppToolDefs(),
    ...buildWorkflowAuthoringToolDefs(),
    buildWorkflowWorkspaceToolDef(),
    buildWorkflowInspectCapabilityToolDef(),
    buildWorkflowValidateResourceRefToolDef(),
    buildWorkflowCreateBundleToolDef(),
    buildWorkflowPatchBundleToolDef(),
    ...buildWorkflowLifecycleToolDefs(),
    buildWorkflowRunToolDef(),
    buildWorkflowStatusToolDef(),
    buildWorkflowEventsToolDef(),
    buildWorkflowResultToolDef(),
    buildWorkflowResumeToolDef(),
    buildWorkflowResolveToolDef(),
    buildWorkflowRejectToolDef(),
    buildWorkflowApplyGraphPatchToolDef(),
    buildWorkflowMutateStepExtensionToolDef(),
    buildWorkflowProcessHolonTaskToolDef(),
    buildWorkflowReplanHolonTaskToolDef(),
  ]
}

const WORKFLOW_NATIVE_HOST_COMMAND_TOOL_NAMES = new Set([
  "WorkflowCreateInstance",
  "WorkflowRun",
  "WorkflowCreateInstanceFromPrebuilt",
  "WorkflowListTypes",
  "WorkflowListInstances",
  "WorkflowMaterialImport",
  "WorkflowMaterialBind",
  "WorkflowMaterialExport",
  "WorkflowMaterialReplay",
  "WorkflowMaterialCleanup",
  "WorkflowStatus",
  "WorkflowGetFlowSummary",
  "WorkflowEvents",
  "WorkflowResult",
  "WorkflowResume",
  "WorkflowApplyGraphPatch",
  "WorkflowProcessHolonTask",
  "WorkflowReplanHolonTask",
])

/**
 * Executes one explicit user-facing `eidolon workflow` host command through
 * the same raw Processor as the lifecycle tool. This is a host authority
 * boundary, not an AI Actor tool call: ordinary Actors remain subject to the
 * guarded lifecycle facet/profile checks in ToolFuncRegistry.
 */
export async function runWorkflowNativeHostCommand(
  runtime: AiAgentOneActorRuntime,
  toolName: string,
  input: unknown,
): Promise<unknown> {
  if (!WORKFLOW_NATIVE_HOST_COMMAND_TOOL_NAMES.has(toolName)) {
    throw new Error(`WORKFLOW_NATIVE_HOST_COMMAND_UNSUPPORTED: ${toolName}`)
  }
  const definition = buildWorkflowLifecycleRawDefinitions().find(
    (candidate) => candidate.schema.function.name === toolName,
  )
  if (!definition) throw new Error(`WORKFLOW_NATIVE_HOST_COMMAND_MISSING: ${toolName}`)
  return await definition.run(runtime as any, input as any, {})
}

function buildCurrentProfile(): WorkflowLifecycleToolProfile {
  const admittedNames = Object.freeze([...AI_WORKFLOW_PROVIDER_TOOL_SURFACE].sort(compareCodeUnits))
  const definitions = [...buildWorkflowLifecycleRawDefinitions(), buildSkillToolDef()]
  const byName = new Map(definitions.map((definition) => [definition.schema.function.name, definition.schema]))
  const admittedSchemas = admittedNames.map((name) => {
    const schema = byName.get(name)
    if (!schema) throw new Error(`WORKFLOW_LIFECYCLE_TOOL_PROFILE_INVALID: definition missing for '${name}'`)
    return schema
  })
  return Object.freeze({
    profileId: "eidolon.workflow-lifecycle-tools/v1",
    profileRevision: "1",
    admittedNames,
    admittedNamesDigest: sha256Names(admittedNames),
    schemaDigest: stableDigest("eidolon.workflow-lifecycle-tools/v1/schema/v1", admittedSchemas),
  })
}

export const WORKFLOW_LIFECYCLE_TOOL_PROFILE = buildCurrentProfile()

function exactProfile(profile: WorkflowLifecycleToolProfile): boolean {
  const expected = WORKFLOW_LIFECYCLE_TOOL_PROFILE
  return profile.profileId === expected.profileId
    && profile.profileRevision === expected.profileRevision
    && profile.admittedNamesDigest === expected.admittedNamesDigest
    && profile.schemaDigest === expected.schemaDigest
    && profile.admittedNames.length === expected.admittedNames.length
    && profile.admittedNames.every((name, index) => name === expected.admittedNames[index])
}

export function createWorkflowLifecycleToolProfileRegistry(
  profiles: readonly WorkflowLifecycleToolProfile[] = [WORKFLOW_LIFECYCLE_TOOL_PROFILE],
): WorkflowLifecycleToolProfileRegistry {
  const entries = profiles.map((profile) => {
    if (!exactProfile(profile)) {
      throw new Error(`WORKFLOW_LIFECYCLE_TOOL_PROFILE_INVALID: unsupported profile ${profile.profileId}@${profile.profileRevision}`)
    }
    return WORKFLOW_LIFECYCLE_TOOL_PROFILE
  })
  if (new Set(entries.map((profile) => `${profile.profileId}\0${profile.profileRevision}`)).size !== entries.length) {
    throw new Error("WORKFLOW_LIFECYCLE_TOOL_PROFILE_INVALID: duplicate profile")
  }
  const frozen = Object.freeze([...entries])
  return Object.freeze({
    profiles: frozen,
    resolve(profileId: string, profileRevision: string): WorkflowLifecycleToolProfile {
      const profile = frozen.find((entry) => (
        entry.profileId === profileId && entry.profileRevision === profileRevision
      ))
      if (!profile) {
        throw new Error(`WORKFLOW_LIFECYCLE_TOOL_PROFILE_UNAVAILABLE: profile unavailable ${profileId}@${profileRevision}`)
      }
      return profile
    },
  })
}

export function assertWorkflowLifecycleToolAuthorized(input: {
  actor: Pick<AiAgentActor, "runtimeFacets">
  toolName: string
  profileRegistry: WorkflowLifecycleToolProfileRegistry
}): WorkflowLifecycleToolProfile {
  const facet = readWorkflowLifecycleFacet(input.actor)
  if (!facet) {
    throw new Error(`WORKFLOW_LIFECYCLE_TOOL_UNAUTHORIZED: facet proof is required for '${input.toolName}'`)
  }
  const profile = input.profileRegistry.resolve(
    facet.toolProfile.profileId,
    facet.toolProfile.profileRevision,
  )
  if (facet.toolProfile.admittedNamesDigest !== profile.admittedNamesDigest) {
    throw new Error(`WORKFLOW_LIFECYCLE_TOOL_UNAUTHORIZED: profile proof mismatch for '${input.toolName}'`)
  }
  if (!profile.admittedNames.includes(input.toolName)) {
    throw new Error(`WORKFLOW_LIFECYCLE_TOOL_UNAUTHORIZED: '${input.toolName}' is not an admitted profile member`)
  }
  return profile
}

function guardLifecycleDefinition(
  definition: AnyToolDef,
  profileRegistry: WorkflowLifecycleToolProfileRegistry,
): AnyToolDef {
  const toolName = definition.schema.function.name
  return Object.freeze({
    ...definition,
    async run(runtime: any, input: any, config: any) {
      assertWorkflowLifecycleToolAuthorized({ actor: runtime.actor, toolName, profileRegistry })
      return await definition.run(runtime, input, config)
    },
  })
}

export function buildWorkflowPublicGatewayToolDefs(): AnyToolDef[] {
  return buildWorkflowPublicGatewayDefinitions()
}

export function buildWorkflowLifecycleDefinitionToolDefs(options: {
  profileRegistry?: WorkflowLifecycleToolProfileRegistry
} = {}): AnyToolDef[] {
  const registry = options.profileRegistry ?? createWorkflowLifecycleToolProfileRegistry()
  return buildWorkflowLifecycleRawDefinitions().map((definition) => guardLifecycleDefinition(definition, registry))
}

export function projectWorkflowLifecycleToolSchemas(input: {
  actor: Pick<AiAgentActor, "runtimeFacets">
  definitions: readonly AnyToolDef[]
  profileRegistry: WorkflowLifecycleToolProfileRegistry
}): AnyToolDef["schema"][] {
  const definitions = new Map(input.definitions.map((definition) => [definition.schema.function.name, definition]))
  const profile = input.profileRegistry.resolve(
    WORKFLOW_LIFECYCLE_TOOL_PROFILE.profileId,
    WORKFLOW_LIFECYCLE_TOOL_PROFILE.profileRevision,
  )
  const workflowNames = profile.admittedNames.filter((name) => name.startsWith("Workflow"))
  return workflowNames.map((toolName) => {
    assertWorkflowLifecycleToolAuthorized({ actor: input.actor, toolName, profileRegistry: input.profileRegistry })
    const definition = definitions.get(toolName)
    if (!definition) {
      throw new Error(`WORKFLOW_LIFECYCLE_TOOL_PROFILE_UNAVAILABLE: admitted definition unavailable '${toolName}'`)
    }
    return structuredClone(definition.schema)
  })
}

/** @deprecated Use the explicit public gateway or lifecycle definition catalog. */
export function buildWorkflowNativeToolDefs(): AnyToolDef[] {
  return [
    ...buildWorkflowPublicGatewayToolDefs(),
    ...buildWorkflowLifecycleDefinitionToolDefs(),
  ]
}
