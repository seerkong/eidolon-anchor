import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { serializeActor, hydrateActor } from "@cell/ai-core-logic/runtime/snapshot/actorSnapshot"
import { composeToolRegistry } from "../../src/composer/AIAgent/ToolFuncComposer"
import { spawnChildExecutionActor } from "../../src/agent/DelegateActor"
import { appendLiveHistoryMessageToConversationDomainRuntime } from "../../src/conversation/ConversationDomainRuntime"
import {
  assertWorkflowLifecycleActorCapability,
  createWorkflowLifecycleFacetRegistry,
  readWorkflowLifecycleFacet,
  readWorkflowLifecycleFrozenResourcePackage,
  WORKFLOW_LIFECYCLE_FACET_ID,
} from "../../src/workflow/runtime/WorkflowLifecycleFacet"
import {
  recoverWorkflowLifecycleActorCapability,
  spawnWorkflowLifecycleExecutionActor,
} from "../../src/workflow/runtime/WorkflowLifecycleActorCapsule"
import {
  resolveWorkflowLifecycleToolProfileRegistry,
} from "../../src/workflow/tools/WorkflowLifecycleToolProfileRuntime"
import { AI_WORKFLOW_PROVIDER_TOOL_SURFACE } from "../../src/workflow/tools/WorkflowLoadStageContext/StageToolPolicy"
import { projectWorkflowProviderSurface } from "../../src/workflow/runtime/WorkflowProviderSurfaceStrategy"
import { loadFrozenAiWorkflowStageContext, type FrozenAiWorkflowResourcePackage } from "@cell/ai-support/system-skill/SystemSkillInstaller"

const skillV1 = [
  "---",
  "name: sys-eidolon-anchor-devops",
  "revision: capsule-v1",
  "---",
  "# Frozen lifecycle authority v1",
].join("\n")

const skillV2 = skillV1.replace("capsule-v1", "capsule-v2").replace("authority v1", "authority v2")

function resourcePackage(skill: string, version: "v1" | "v2"): FrozenAiWorkflowResourcePackage {
  const resources = {
    "sys-eidolon-anchor-devops/SKILL.md": skill,
    "sys-eidolon-anchor-devops/coding/system.md": `coding system ${version}`,
    "sys-eidolon-anchor-devops/coding/protocol.md": `coding protocol ${version}`,
    "sys-eidolon-anchor-authoring/SKILL.md": `authoring Skill ${version}`,
    "sys-eidolon-anchor-authoring/operations/index.md": `authoring operations ${version}`,
  }
  const digest = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}` as const
  return Object.freeze({
    schemaVersion: "eidolon.ai-workflow-resource-package/v1",
    revision: `package-${version}`,
    digest: digest(Object.keys(resources).sort().map((resourcePath) => (
      `${resourcePath}\0${digest(resources[resourcePath as keyof typeof resources])}\0`
    )).join("")),
    resources: Object.freeze(resources),
  })
}

function makeVm(skillMaterial: string) {
  let observedActor: ReturnType<typeof createActor> | undefined
  let observedTools: string[] = []
  const parent = createActor({
    key: "main",
    id: "parent",
    llmClient: {
      type: "openai",
      async createStream() {
        async function* stream() { yield { ok: true } }
        return { stream: stream() }
      },
    },
    modelConfig: { model: "mock" },
    callbacks: {
      buildToolset: (vm) => vm.registries.toolRegistry?.list().map((tool) => tool.schema) ?? [],
      processStream: async (vm, actor) => {
        observedActor = actor
        observedTools = actor.callbacks.buildToolset(vm, actor).map((tool) => tool.function.name)
        const message = { role: "assistant" as const, content: "lifecycle completed" }
        appendLiveHistoryMessageToConversationDomainRuntime({
          vm,
          actorKey: actor.key,
          actorId: actor.id,
          message,
        })
        return message
      },
    },
  })
  const toolRegistry = composeToolRegistry({ includeInternalOnly: false, includeWorkflowLifecycle: true })
  const vm = createVM({
    controlActorKey: parent.key,
    actors: { [parent.key]: parent },
    registries: {
      toolRegistry,
      agentRegistry: new AgentRegistry({
        workflow: {
          name: "workflow",
          description: "test lifecycle actor",
          tools: [...AI_WORKFLOW_PROVIDER_TOOL_SURFACE],
          prompt: ["Lifecycle actor base instruction."],
          requireExactTools: true,
        },
      }),
    },
  })
  return { vm, parent, skillMaterial, observed: () => ({ actor: observedActor, tools: observedTools }) }
}

describe("Workflow lifecycle Actor capsule", () => {
  it("creates a distinct capability Actor with exact facet, frozen Skill proof and admitted profile", async () => {
    const fixture = makeVm(skillV1)
    const output = await spawnWorkflowLifecycleExecutionActor(fixture.vm, fixture.parent, {
      description: "author a workflow",
      prompt: "author the requested workflow",
      systemSkillMaterial: fixture.skillMaterial,
      mode: "sync_wait",
    })

    expect(output).toBe("lifecycle completed")
    const observed = fixture.observed()
    expect(observed.actor).toBeDefined()
    expect(observed.actor).not.toBe(fixture.parent)
    expect(observed.actor!.runtimeFacets[WORKFLOW_LIFECYCLE_FACET_ID]).toBeDefined()
    expect(observed.actor!.systemPrompts).toContain(skillV1)
    const profileRegistry = resolveWorkflowLifecycleToolProfileRegistry(fixture.vm.registries.toolRegistry!)
    const capability = assertWorkflowLifecycleActorCapability({
      actor: observed.actor!,
      profileRegistry,
    })
    expect(capability.toolProfile).toMatchObject({
      profileId: "eidolon.workflow-lifecycle-tools/v1",
      profileRevision: "1",
      admittedNamesDigest: profileRegistry.profiles[0]!.admittedNamesDigest,
    })
    expect(capability.providerSurfaceStrategy).toMatchObject({
      strategyRevision: "stable-superset/v1",
      strategyDigest: "sha256:d691fc45d08bed2ce3e1d5190b5981babb1314b7275865ac8f0f7dfae1fef4c3",
    })
    expect(observed.tools).toEqual(
      projectWorkflowProviderSurface({ strategyRevision: "stable-superset/v1", stage: "planning" }).toolNames,
    )
  })

  it("does not authorize from Actor name, provider class, codec registry or definition presence", () => {
    const fixture = makeVm(skillV1)
    const forged = createActor({
      key: "forged-workflow",
      agentName: "workflow",
      providerContextClass: "workflow_lifecycle",
      systemPrompts: [skillV1],
    })
    fixture.vm.runtimeContext.actorFacetRuntime = createWorkflowLifecycleFacetRegistry()
    expect(fixture.vm.registries.toolRegistry!.get("WorkflowInspectCapability")).toBeDefined()
    expect(() => assertWorkflowLifecycleActorCapability({
      actor: forged,
      profileRegistry: resolveWorkflowLifecycleToolProfileRegistry(fixture.vm.registries.toolRegistry!),
    })).toThrow(/facet proof/i)
  })

  it("does not mint a facet when the generic delegate API is given only the legacy name and provider class", async () => {
    const fixture = makeVm(skillV1)
    let created: ReturnType<typeof createActor> | undefined
    await spawnChildExecutionActor(fixture.vm, fixture.parent, {
      description: "legacy-looking delegate",
      prompt: "run without a capability request",
      agentType: "workflow",
      providerContextClass: "workflow_lifecycle",
      additionalSystemPrompts: [skillV1],
      mode: "sync_wait",
      onActorCreated: (actor) => { created = actor },
    })
    expect(created).toBeDefined()
    expect(readWorkflowLifecycleFacet(created!)).toBeUndefined()
  })

  it("rejects unverified Skill material before Actor registration", async () => {
    const fixture = makeVm(skillV1)
    await expect(spawnWorkflowLifecycleExecutionActor(fixture.vm, fixture.parent, {
      description: "invalid lifecycle capability",
      prompt: "must not register",
      systemSkillMaterial: "# untrusted live text without managed Skill identity",
      mode: "sync_wait",
    })).rejects.toThrow(/exactly one managed/i)
    expect(Object.keys(fixture.vm.actors)).toEqual([fixture.parent.key])
  })

  it("recovers from persisted bytes and never substitutes changed live Skill material", async () => {
    const fixture = makeVm(skillV1)
    let created: ReturnType<typeof createActor> | undefined
    await spawnWorkflowLifecycleExecutionActor(fixture.vm, fixture.parent, {
      description: "retain workflow capability",
      prompt: "retain",
      systemSkillMaterial: skillV1,
      mode: "sync_wait",
      onActorCreated: (actor) => { created = actor },
    })
    expect(created).toBeDefined()

    const recoveredVm = makeVm(skillV2).vm
    const recovered = hydrateActor(serializeActor(created!), {
      actorFacetRuntime: createWorkflowLifecycleFacetRegistry(),
    })
    recoverWorkflowLifecycleActorCapability(recoveredVm, recovered)
    expect(recovered.systemPrompts).toContain(skillV1)
    expect(recovered.systemPrompts).not.toContain(skillV2)
    expect(readWorkflowLifecycleFacet(recovered)?.systemSkill.materialDigest).toBe(
      readWorkflowLifecycleFacet(created!)?.systemSkill.materialDigest,
    )

    const liveChangedFixture = makeVm(skillV2)
    let newlyCreated: ReturnType<typeof createActor> | undefined
    await spawnWorkflowLifecycleExecutionActor(liveChangedFixture.vm, liveChangedFixture.parent, {
      description: "new actor after Skill revision",
      prompt: "new actor",
      systemSkillMaterial: skillV2,
      mode: "sync_wait",
      onActorCreated: (actor) => { newlyCreated = actor },
    })
    expect(readWorkflowLifecycleFacet(newlyCreated!)?.systemSkill.materialDigest).not.toBe(
      readWorkflowLifecycleFacet(recovered)?.systemSkill.materialDigest,
    )

    const tamperedSnapshot = serializeActor(created!)
    tamperedSnapshot.systemPrompts = tamperedSnapshot.systemPrompts.map((prompt) => (
      prompt === skillV1 ? skillV2 : prompt
    ))
    const tampered = hydrateActor(tamperedSnapshot, {
      actorFacetRuntime: createWorkflowLifecycleFacetRegistry(),
    })
    expect(() => recoverWorkflowLifecycleActorCapability(recoveredVm, tampered)).toThrow(/Skill material digest mismatch/i)
  })

  it("freezes the complete reachable stage package for old and fresh recovery", async () => {
    const packageV1 = resourcePackage(skillV1, "v1")
    const packageV2 = resourcePackage(skillV2, "v2")
    const fixture = makeVm(skillV1)
    let created: ReturnType<typeof createActor> | undefined
    await spawnWorkflowLifecycleExecutionActor(fixture.vm, fixture.parent, {
      description: "freeze package v1",
      prompt: "retain v1",
      systemSkillMaterial: skillV1,
      systemSkillPackage: packageV1,
      mode: "sync_wait",
      onActorCreated: (actor) => { created = actor },
    })
    const oldContext = loadFrozenAiWorkflowStageContext({
      resourcePackage: readWorkflowLifecycleFrozenResourcePackage({
        actor: created!, facet: readWorkflowLifecycleFacet(created!)!,
      }),
      stage: "coding",
    })
    expect(oldContext).toContain("coding system v1")

    const recoveredVm = makeVm(skillV2).vm
    const recovered = hydrateActor(serializeActor(created!), {
      actorFacetRuntime: createWorkflowLifecycleFacetRegistry(),
    })
    recoverWorkflowLifecycleActorCapability(recoveredVm, recovered)
    expect(recovered.durableMaterials).toEqual(created!.durableMaterials)
    expect(JSON.stringify(readWorkflowLifecycleFacet(recovered))).not.toContain("coding system v1")
    expect(JSON.stringify(readWorkflowLifecycleFacet(recovered))).not.toContain("authoring Skill v1")
    expect(loadFrozenAiWorkflowStageContext({
      resourcePackage: readWorkflowLifecycleFrozenResourcePackage({
        actor: recovered, facet: readWorkflowLifecycleFacet(recovered)!,
      }),
      stage: "coding",
    })).toContain("coding system v1")

    const freshFixture = makeVm(skillV2)
    let fresh: ReturnType<typeof createActor> | undefined
    await spawnWorkflowLifecycleExecutionActor(freshFixture.vm, freshFixture.parent, {
      description: "freeze package v2",
      prompt: "admit v2",
      systemSkillMaterial: skillV2,
      systemSkillPackage: packageV2,
      mode: "sync_wait",
      onActorCreated: (actor) => { fresh = actor },
    })
    expect(loadFrozenAiWorkflowStageContext({
      resourcePackage: readWorkflowLifecycleFrozenResourcePackage({
        actor: fresh!, facet: readWorkflowLifecycleFacet(fresh!)!,
      }),
      stage: "coding",
    })).toContain("coding system v2")
  })
})
