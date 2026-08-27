import { describe, expect, it } from "bun:test"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { buildBuiltinToolDefs } from "../../src/composer/AIAgent/ToolFuncBuiltin"
import {
  createWorkflowLifecycleFacetRegistry,
  createWorkflowLifecycleFacetEnvelope,
  WORKFLOW_LIFECYCLE_FACET_ID,
} from "../../src/workflow/runtime/WorkflowLifecycleFacet"
import {
  buildWorkflowLifecycleDefinitionToolDefs,
  buildWorkflowPublicGatewayToolDefs,
  createWorkflowLifecycleToolProfileRegistry,
  projectWorkflowLifecycleToolSchemas,
  WORKFLOW_LIFECYCLE_DEFINITION_TOOL_NAMES,
  WORKFLOW_LIFECYCLE_TOOL_PROFILE,
} from "../../src/workflow/tools"
import { AI_WORKFLOW_PROVIDER_TOOL_SURFACE } from "../../src/workflow/tools/WorkflowLoadStageContext/StageToolPolicy"

const managedSkill = [
  "---",
  "name: sys-eidolon-anchor-devops",
  "revision: tool-capability-v1",
  "---",
  "# Managed workflow skill",
].join("\n")

function workflowRuntime(options: { withFacet?: boolean; profileRegistry?: ReturnType<typeof createWorkflowLifecycleToolProfileRegistry> } = {}) {
  const actor = createActor({
    key: "workflow-capability",
    systemPrompts: [managedSkill],
    ...(options.withFacet ? {
      runtimeFacets: [createWorkflowLifecycleFacetEnvelope({
        strategyRevision: "hybrid/v1",
        systemPrompts: [managedSkill],
        toolNames: AI_WORKFLOW_PROVIDER_TOOL_SURFACE,
        progress: {
          stageStartedAt: 1,
          deadlineAt: 180_001,
          turnsSinceProgress: 0,
          maxNoProgressTurns: 4,
          proofRepairAttempts: 0,
          maxProofRepairAttempts: 3,
          lastProgressAt: 1,
        },
      })],
    } : {}),
  })
  const vm = createVM({
    controlActorKey: actor.key,
    actors: { [actor.key]: actor },
    runtimeContext: { actorFacetRuntime: createWorkflowLifecycleFacetRegistry() },
    outerCtx: {
      workDir: "/tmp/eidolon-workflow-tool-capability",
      metadata: { workflowRoots: { workspaceRoot: "vfs://./workflow" } },
    },
  })
  return { actor, vm, profileRegistry: options.profileRegistry ?? createWorkflowLifecycleToolProfileRegistry() }
}

describe("Workflow lifecycle tool capability", () => {
  it("keeps ordinary all-tools at exactly two public Workflow gateways", () => {
    const publicNames = buildWorkflowPublicGatewayToolDefs().map((def) => def.schema.function.name)
    const internalNames = buildWorkflowLifecycleDefinitionToolDefs().map((def) => def.schema.function.name)
    const builtinWorkflowNames = buildBuiltinToolDefs({ includeInternalOnly: false })
      .map((def) => def.schema.function.name)
      .filter((name) => name.startsWith("Workflow"))

    expect(publicNames).toEqual(["WorkflowFulfill", "WorkflowAuthor"])
    expect(builtinWorkflowNames).toEqual(publicNames)
    expect(internalNames).toEqual([...WORKFLOW_LIFECYCLE_DEFINITION_TOOL_NAMES])
  })

  it("freezes the exact current lifecycle profile independently from the definition registry", () => {
    const expectedNames = [...AI_WORKFLOW_PROVIDER_TOOL_SURFACE].sort()
    expect(WORKFLOW_LIFECYCLE_TOOL_PROFILE).toMatchObject({
      profileId: "eidolon.workflow-lifecycle-tools/v1",
      profileRevision: "1",
      admittedNames: expectedNames,
    })
    expect(WORKFLOW_LIFECYCLE_TOOL_PROFILE.admittedNamesDigest).toBe(
      "sha256:121df5a6adee519d8add1cee77011baad25770eab5647123a7af2759601092a6",
    )
    expect(WORKFLOW_LIFECYCLE_TOOL_PROFILE.schemaDigest).toBe(
      "sha256:ecba04ba9f39aac5f644eb4afed84509c22c96207bc012b55ed3d39f8b6c1356",
    )
    expect(createWorkflowLifecycleToolProfileRegistry().resolve(
      WORKFLOW_LIFECYCLE_TOOL_PROFILE.profileId,
      WORKFLOW_LIFECYCLE_TOOL_PROFILE.profileRevision,
    )).toEqual(WORKFLOW_LIFECYCLE_TOOL_PROFILE)
  })

  it("uses the same exact proof for provider visibility and execution", async () => {
    const ordinary = workflowRuntime()
    const internalDefs = buildWorkflowLifecycleDefinitionToolDefs({ profileRegistry: ordinary.profileRegistry })
    expect(() => projectWorkflowLifecycleToolSchemas({
      actor: ordinary.actor,
      definitions: internalDefs,
      profileRegistry: ordinary.profileRegistry,
    })).toThrow(/facet proof/i)

    const registry = new ToolFuncRegistry()
    registry.registerMany(internalDefs)
    await expect(ToolFuncRegistry.call(
      registry,
      "WorkflowInspectCapability",
      ordinary.vm,
      ordinary.actor,
      {},
    )).rejects.toThrow(/facet proof/i)

    const admitted = workflowRuntime({ withFacet: true })
    const admittedDefs = buildWorkflowLifecycleDefinitionToolDefs({ profileRegistry: admitted.profileRegistry })
    expect(projectWorkflowLifecycleToolSchemas({
      actor: admitted.actor,
      definitions: admittedDefs,
      profileRegistry: admitted.profileRegistry,
    }).map((schema) => schema.function.name)).toEqual(
      AI_WORKFLOW_PROVIDER_TOOL_SURFACE.filter((name) => name.startsWith("Workflow")),
    )
    const admittedRegistry = new ToolFuncRegistry()
    admittedRegistry.registerMany(admittedDefs)
    expect(JSON.parse(await ToolFuncRegistry.call(
      admittedRegistry,
      "WorkflowInspectCapability",
      admitted.vm,
      admitted.actor,
      {},
    ) as string)).toMatchObject({ capability: "ai-workflow", native: true })
  })

  it("fails closed before an internal effect when the exact profile is unavailable or mismatched", async () => {
    const unavailable = createWorkflowLifecycleToolProfileRegistry([])
    const admitted = workflowRuntime({ withFacet: true, profileRegistry: unavailable })
    expect(() => projectWorkflowLifecycleToolSchemas({
      actor: admitted.actor,
      definitions: buildWorkflowLifecycleDefinitionToolDefs({ profileRegistry: unavailable }),
      profileRegistry: unavailable,
    })).toThrow(/profile unavailable/i)
    const unavailableRegistry = new ToolFuncRegistry()
    unavailableRegistry.registerMany(buildWorkflowLifecycleDefinitionToolDefs({ profileRegistry: unavailable }))
    await expect(ToolFuncRegistry.call(
      unavailableRegistry,
      "WorkflowInspectCapability",
      admitted.vm,
      admitted.actor,
      {},
    )).rejects.toThrow(/profile unavailable/i)

    const mismatched = workflowRuntime({ withFacet: true })
    const envelope = mismatched.actor.runtimeFacets[WORKFLOW_LIFECYCLE_FACET_ID]!
    mismatched.actor.runtimeFacets = Object.freeze({
      ...mismatched.actor.runtimeFacets,
      [WORKFLOW_LIFECYCLE_FACET_ID]: Object.freeze({
        ...envelope,
        value: Object.freeze({
          ...(envelope.value as Record<string, unknown>),
          toolProfile: Object.freeze({
            profileId: "eidolon.workflow-lifecycle-tools/v1",
            profileRevision: "1",
            admittedNamesDigest: "sha256:mismatch",
          }),
        }),
      }),
    })
    const defs = buildWorkflowLifecycleDefinitionToolDefs({ profileRegistry: mismatched.profileRegistry })
    const registry = new ToolFuncRegistry()
    registry.registerMany(defs)
    await expect(ToolFuncRegistry.call(
      registry,
      "WorkflowInspectCapability",
      mismatched.vm,
      mismatched.actor,
      {},
    )).rejects.toThrow(/profile proof mismatch/i)
  })
})
