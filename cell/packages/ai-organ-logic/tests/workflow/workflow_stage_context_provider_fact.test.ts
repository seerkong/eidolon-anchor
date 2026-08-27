import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "bun:test"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM, ensureVmRuntimeContext } from "@cell/ai-core-logic/runtime/runtime"
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph"
import {
  aiAgentLoopStreaming,
  buildProviderPromptForActorTurn,
} from "../../src/exec/AiAgentExecutor"
import { composeToolRegistry } from "../../src/composer/AIAgent/ToolFuncComposer"
import { activateActorProviderEpoch } from "../../src/conversation/ProviderEpoch"
import { getConversationActorRawStateFromVm } from "../../src/conversation/ConversationDomainRuntime"
import {
  createWorkflowLifecycleFacetEnvelope,
  createWorkflowLifecycleFacetRegistry,
  createWorkflowLifecycleResourcePackageMaterial,
  WORKFLOW_LIFECYCLE_FACET_ID,
} from "../../src/workflow/runtime/WorkflowLifecycleFacet"
import { projectWorkflowProviderSurface } from "../../src/workflow/runtime/WorkflowProviderSurfaceStrategy"
import {
  AI_WORKFLOW_PROVIDER_TOOL_SURFACE,
} from "../../src/workflow/tools/WorkflowLoadStageContext/StageToolPolicy"
import type { FrozenAiWorkflowResourcePackage } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import { createMockProcessStream } from "../AIAgent/__test_support__/mockProcessStream"
import { LocalFileConversationPersistenceRepositoryFactory } from "@cell/ai-support"

const skill = [
  "---",
  "name: sys-eidolon-anchor-devops",
  "revision: typed-stage-facts-v1",
  "---",
  "# Frozen lifecycle authority",
].join("\n")

function sha256(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`
}

function resourcePackage(): FrozenAiWorkflowResourcePackage {
  const resources = Object.freeze({
    "sys-eidolon-anchor-devops/SKILL.md": skill,
    "sys-eidolon-anchor-devops/coding/system.md": "coding system facts v1",
    "sys-eidolon-anchor-devops/coding/protocol.md": "coding protocol facts v1",
    "sys-eidolon-anchor-devops/testing/system.md": "testing system facts v1",
    "sys-eidolon-anchor-devops/testing/protocol.md": "testing protocol facts v1",
    "sys-eidolon-anchor-authoring/SKILL.md": "authoring Skill facts v1",
    "sys-eidolon-anchor-authoring/operations/index.md": "authoring operations facts v1",
  })
  const digest = sha256(Object.keys(resources).sort().map((path) => (
    `${path}\0${sha256(resources[path as keyof typeof resources])}\0`
  )).join(""))
  return Object.freeze({
    schemaVersion: "eidolon.ai-workflow-resource-package/v1",
    revision: "typed-stage-package-v1",
    digest,
    resources,
  })
}

function createFixture() {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-surface-epoch-"))
  const frozenPackage = resourcePackage()
  const material = createWorkflowLifecycleResourcePackageMaterial(frozenPackage)
  const toolRegistry = composeToolRegistry({ includeInternalOnly: false, includeWorkflowLifecycle: true })
  const schemas = new Map(toolRegistry.list().map((definition) => [
    definition.schema.function.name,
    definition.schema,
  ]))
  const admittedSchemas = AI_WORKFLOW_PROVIDER_TOOL_SURFACE.map((name) => {
    const schema = schemas.get(name)
    if (!schema) throw new Error(`missing lifecycle tool schema '${name}'`)
    return schema
  })
  let providerTurn = 0
  const transportEpochs: Array<{ epoch: number; reason: string; surfaceDigest: string }> = []
  let actorRef: ReturnType<typeof createActor>
  let vmRef: ReturnType<typeof createVM>
  const adapter = {
    type: "openai" as const,
    async createStream() {
      const receipt = getConversationActorRawStateFromVm({ vm: vmRef, actorKey: actorRef.key })
        ?.session.actorBindings[actorRef.key]?.providerEpochReceiptV2
      if (!receipt) throw new Error("transport requires provider epoch receipt")
      transportEpochs.push({
        epoch: receipt.epoch,
        reason: receipt.reason,
        surfaceDigest: receipt.providerSurfaceDigest,
      })
      async function* stream() { yield { ok: true } }
      return {
        stream: stream(),
        providerOutput: Promise.resolve({
          provider_cache_cost_observation: { requestDigest: `sha256:${"b".repeat(64)}` },
        }),
      }
    },
  }
  const envelope = createWorkflowLifecycleFacetEnvelope({
    strategyRevision: "hybrid/v1",
    systemPrompts: [skill],
    toolNames: AI_WORKFLOW_PROVIDER_TOOL_SURFACE,
    resourcePackage: frozenPackage,
    progress: {
      stageStartedAt: 1_000,
      deadlineAt: Date.now() + 180_000,
      turnsSinceProgress: 0,
      maxNoProgressTurns: 4,
      proofRepairAttempts: 0,
      maxProofRepairAttempts: 3,
      lastProgressAt: 1_000,
    },
  })
  const actor = createActor({
    key: "workflow-main",
    id: "workflow-main-id",
    llmClient: adapter,
    modelConfig: { model: "mock", provider: "mock", adapter: "openai" },
    systemPrompts: [skill],
    runtimeFacets: { [WORKFLOW_LIFECYCLE_FACET_ID]: envelope },
    durableMaterials: { [material.digest]: material },
    toolPolicy: {
      allowedTools: [...AI_WORKFLOW_PROVIDER_TOOL_SURFACE],
      allowedToolsMode: "exact",
      providerToolSurface: {
        mode: "exact",
        toolNames: [...projectWorkflowProviderSurface({ strategyRevision: "hybrid/v1", stage: "planning" }).toolNames],
      },
    },
    callbacks: {
      buildToolset: () => admittedSchemas,
      processStream: async () => ({ role: "assistant", content: "unused" }),
    },
  })
  const vm = createVM({
    controlActorKey: actor.key,
    actors: { [actor.key]: actor },
    registries: { toolRegistry },
    eventBus: new AgentEventGraph(),
    outerCtx: { metadata: { sessionId: "workflow-stage-context-facts" } },
    runtimeContext: { actorFacetRuntime: createWorkflowLifecycleFacetRegistry() },
  })
  vm.outerCtx = {
    ...vm.outerCtx,
    workDir: sessionDir,
    metadata: { sessionId: "workflow-stage-context-facts", sessionDir },
    conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
  }
  actorRef = actor
  vmRef = vm
  ensureVmRuntimeContext(vm)
  actor.callbacks = {
    ...actor.callbacks,
    processStream: createMockProcessStream(async () => {
      providerTurn += 1
      if (providerTurn === 1 || providerTurn === 3) {
        const stage = providerTurn === 1 ? "coding" : "testing"
        return {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `call-stage-${stage}`,
            function: {
              name: "WorkflowLoadStageContext",
              arguments: JSON.stringify({ stage }),
            },
          }],
        }
      }
      return { role: "assistant", content: `turn-${providerTurn}-done` }
    }),
  }
  activateActorProviderEpoch({
    vm,
    actor,
    sessionId: "workflow-stage-context-facts",
    targetProviderId: "mock",
    targetProfileId: "openai-chat@1",
    reason: "initial_projection",
  })
  return { actor, vm, admittedSchemas, sessionDir, transportEpochs }
}

describe("Workflow stage context provider facts", () => {
  it("retains tool pairs and appends frozen typed facts without rewriting system roots or schemas", async () => {
    const { actor, vm, admittedSchemas, sessionDir, transportEpochs } = createFixture()
    const originalSystemPrompts = structuredClone(actor.systemPrompts)
    const originalSchemaNames = admittedSchemas.map((schema) => schema.function.name)

    const coding = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [{ role: "user", content: "enter coding" }],
    })
    const testing = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [{ role: "user", content: "enter testing" }],
    })

    expect(coding.messages.find((message: any) => message.role === "tool")?.content).toContain("coding system facts v1")
    expect(testing.messages.find((message: any) => (
      message.role === "tool" && String(message.content ?? "").includes("testing system facts v1")
    ))?.content).toContain("testing system facts v1")
    expect(actor.systemPrompts).toEqual(originalSystemPrompts)
    expect(actor.toolPolicy.providerToolSurface).toEqual({
      mode: "exact",
      toolNames: projectWorkflowProviderSurface({ strategyRevision: "hybrid/v1", stage: "testing" }).toolNames,
    })
    expect(actor.callbacks.buildToolset(vm, actor).map((schema) => schema.function.name)).toEqual(originalSchemaNames)

    const raw = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })
    const facts = raw?.session.contextAssets.flatMap((asset) => (
      asset.providerContextFact?.namespace === "workflow-stage-context"
        ? [asset.providerContextFact]
        : []
    )) ?? []
    expect(facts).toHaveLength(2)
    expect(facts.map((fact) => fact.payload.stage)).toEqual(["coding", "testing"])
    expect(facts.map((fact) => fact.payload.packageRevision)).toEqual([
      "typed-stage-package-v1",
      "typed-stage-package-v1",
    ])
    expect(Number(facts[0]?.payload.facetRevision)).toBeGreaterThan(0)
    expect(facts[1]?.payload.facetRevision).toBeGreaterThan(Number(facts[0]?.payload.facetRevision))
    expect(facts.every((fact) => fact.sourceDeliveryProofs[0]?.kind === "first-delivery-pair")).toBe(true)

    const prompt = buildProviderPromptForActorTurn({
      vm,
      actor,
      tools: admittedSchemas,
      llmAdapter: actor.llmClient,
      model: "mock",
    }).executionMessages
    const serialized = JSON.stringify(prompt)
    expect(serialized).toContain("call-stage-coding")
    expect(serialized).toContain("call-stage-testing")
    expect(serialized).toContain("eidolon-context-fact/v1")
    expect(serialized).toContain("workflow-stage-context")
    expect(prompt.some((message: any) => (
      message.role === "system" && String(message.content ?? "").includes("coding system facts v1")
    ))).toBe(false)
    const admissions = raw?.session.actorBindings[actor.key]?.providerRequestAdmissions ?? []
    expect(admissions).toHaveLength(1)
    expect(raw?.session.actorBindings[actor.key]?.providerEpochReceiptV2?.reason)
      .toBe("provider_surface_revision_accepted")
    expect(transportEpochs.map(({ epoch, reason }) => [epoch, reason])).toEqual([
      [1, "initial_projection"],
      [2, "provider_surface_revision_accepted"],
      [2, "provider_surface_revision_accepted"],
      [3, "provider_surface_revision_accepted"],
    ])
    expect(new Set(transportEpochs.map((entry) => entry.surfaceDigest)).size).toBe(3)
    const fresh = await LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir).loadSessionIndex()
    expect(fresh.session.actorBindings[actor.key]?.providerEpochReceiptV2).toEqual(
      raw?.session.actorBindings[actor.key]?.providerEpochReceiptV2,
    )
    fs.rmSync(sessionDir, { recursive: true, force: true })
  })
})
