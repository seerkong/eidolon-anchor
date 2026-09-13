import { describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { hydrateActor, serializeActor } from "@cell/ai-core-logic/runtime/snapshot/actorSnapshot"
import { appendLiveHistoryMessageToConversationDomainRuntime } from "../../src/conversation/ConversationDomainRuntime"
import { EidolonWorkflowEffectProvider } from "../../src/workflow/effects/EidolonWorkflowEffectProvider"
import { WorkflowFactStore } from "../../src/workflow/runtime/WorkflowFactStore"
import {
  createWorkflowLifecycleFacetRegistry,
  readWorkflowLifecycleFacet,
} from "../../src/workflow/runtime/WorkflowLifecycleFacet"
import {
  recoverWorkflowLifecycleActorCapability,
  spawnWorkflowLifecycleExecutionActor,
} from "../../src/workflow/runtime/WorkflowLifecycleActorCapsule"
import { composeToolRegistry } from "../../src/composer/AIAgent/ToolFuncComposer"
import { AI_WORKFLOW_PROVIDER_TOOL_SURFACE } from "../../src/workflow/tools/WorkflowLoadStageContext/StageToolPolicy"

const skill = ["---", "name: sys-eidolon-anchor-devops", "revision: boundary-v1", "---", "# lifecycle Skill"].join("\n")
const agentDefinitionRef = "resource://eidolon.fixture.Reviewer"
const run = {
  workflow: { ref: "resource://eidolon.fixture.Ctrl", scheme: "resource" as const },
  runId: "lifecycle-node-boundary-run",
  generation: 0,
}

function resourceRegistry() {
  return {
    async prepareWorkflowAgentExecution() {
      return {
        plan: {
          schemaVersion: "eidolon.resource-agent-execution-plan/v1",
          agentDefinitionRef,
          registryRevision: "sha256:registry",
          compositionRevision: "sha256:composition",
          agentContentDigest: "sha256:agent",
          messages: [],
          toolResourceIds: [],
          requiresWorkflowTask: false,
          agentConfig: {
            name: agentDefinitionRef,
            description: "ordinary frozen business Agent",
            tools: [],
            prompt: [],
            seedMessages: [{ role: "system", content: "business child" }],
            requireExactTools: true,
          },
          executionContract: {
            input: { payload: { request: "review" }, materials: [] },
            messageSchemas: [],
            effectPolicy: { toolMode: "declared-only" },
          },
        },
        receipt: {
          schemaVersion: "ai-workflow.run-resource-freeze/v1",
          task: {
            workflowKind: "AICtrlWorkflow",
            workflowRef: run.workflow.ref,
            nodeId: "review",
            agentDefinitionRef,
          },
          bindingResourceIds: [],
          dependencySnapshot: {},
          semanticFingerprint: "sha256:binding",
        },
      }
    },
  }
}

function makeRuntime(observed: { child?: ReturnType<typeof createActor>; builderActorKeys: string[] }) {
  const buildToolset = (_vm: unknown, actor: ReturnType<typeof createActor>) => {
    observed.builderActorKeys.push(actor.key)
    return []
  }
  const processStream = async (vm: any, actor: ReturnType<typeof createActor>) => {
    if (!readWorkflowLifecycleFacet(actor)) observed.child = actor
    const message = { role: "assistant" as const, content: "business completed" }
    appendLiveHistoryMessageToConversationDomainRuntime({ vm, actorKey: actor.key, actorId: actor.id, message })
    return message
  }
  const parent = createActor({
    key: "main",
    id: "main-boundary",
    llmClient: {
      type: "openai",
      async createStream() {
        async function* stream() { yield { ok: true } }
        return { stream: stream() }
      },
    },
    modelConfig: { model: "mock" },
    callbacks: { buildToolset, processStream },
  })
  const registries = {
    toolRegistry: composeToolRegistry({ includeInternalOnly: false, includeWorkflowLifecycle: true }),
    agentRegistry: new AgentRegistry({
      workflow: {
        name: "workflow",
        description: "lifecycle Actor",
        tools: [...AI_WORKFLOW_PROVIDER_TOOL_SURFACE],
        prompt: ["lifecycle"],
        requireExactTools: true,
      },
    }),
  }
  const vm = createVM({ controlActorKey: parent.key, actors: { [parent.key]: parent }, registries })
  return { vm, parent, registries, callbacks: { buildToolset, processStream } }
}

let effectSequence = 0

async function invokeResourceAgent({ vm, lifecycle, root, typedHost = false }: {
  vm: any
  lifecycle: ReturnType<typeof createActor>
  root: string
  typedHost?: boolean
}) {
  ;(vm as any).outerCtx = { metadata: { sessionDir: root } }
  const provider = new EidolonWorkflowEffectProvider(
    { vm, actor: lifecycle } as any,
    {} as any,
    new WorkflowFactStore(root),
    undefined,
    () => run,
    { workflowForm: "AICtrlWorkflow", resourceRegistry: resourceRegistry() as any },
    undefined,
    { instanceId: "lifecycle-boundary-instance", workflowForm: "AICtrlWorkflow" },
  )
  return provider.invoke({
    run,
    effectId: `resource-agent-${effectSequence++}`,
    operation: "ai.agent",
    nodeId: "review",
    input: { agentDefinitionRef, payload: { request: "review" } },
    ...(typedHost ? { config: { typedHost: true } } : {}),
  } as any)
}

async function expectIsolatedResourceAgent(params: Parameters<typeof invokeResourceAgent>[0]) {
  const output = await invokeResourceAgent(params) as any
  expect(params.typedHost ? output.output : output).toBe("business completed")
}

describe("lifecycle resource-Agent callback boundary", () => {
  it("uses the host builder for spawned and addressed ordinary resource Agents, before and after repeated recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-lifecycle-node-boundary-"))
    try {
      const freshObserved: { child?: ReturnType<typeof createActor>; builderActorKeys: string[] } = { builderActorKeys: [] }
      const fresh = makeRuntime(freshObserved)
      let lifecycle: ReturnType<typeof createActor> | undefined
      await spawnWorkflowLifecycleExecutionActor(fresh.vm, fresh.parent, {
        description: "retain lifecycle Actor",
        prompt: "prepare workflow",
        systemSkillMaterial: skill,
        retainActor: true,
        onActorCreated: (actor) => { lifecycle = actor },
      })
      expect(lifecycle).toBeDefined()
      recoverWorkflowLifecycleActorCapability(fresh.vm, lifecycle!)
      for (const typedHost of [false, true]) {
        freshObserved.builderActorKeys = []
        await expectIsolatedResourceAgent({ vm: fresh.vm, lifecycle: lifecycle!, root, typedHost })
        expect(freshObserved.builderActorKeys).toEqual([freshObserved.child!.key])
        expect(readWorkflowLifecycleFacet(freshObserved.child!)).toBeUndefined()
        expect(freshObserved.child!.systemPrompts.join("\n")).not.toContain("sys-eidolon-anchor-devops")
        expect(freshObserved.child!.toolPolicy.providerToolSurface).toEqual({ mode: "exact", toolNames: [] })
      }

      let nestedLifecycle: ReturnType<typeof createActor> | undefined
      await spawnWorkflowLifecycleExecutionActor(fresh.vm, lifecycle!, {
        description: "retain nested lifecycle Actor",
        prompt: "prepare nested workflow",
        systemSkillMaterial: skill,
        retainActor: true,
        onActorCreated: (actor) => { nestedLifecycle = actor },
      })
      expect(nestedLifecycle).toBeDefined()
      freshObserved.builderActorKeys = []
      await expectIsolatedResourceAgent({ vm: fresh.vm, lifecycle: nestedLifecycle!, root })
      expect(freshObserved.builderActorKeys).toEqual([freshObserved.child!.key])
      expect(readWorkflowLifecycleFacet(freshObserved.child!)).toBeUndefined()

      const recoveredObserved: { child?: ReturnType<typeof createActor>; builderActorKeys: string[] } = { builderActorKeys: [] }
      const recoveredRuntime = makeRuntime(recoveredObserved)
      const recovered = hydrateActor(serializeActor(lifecycle!), {
        llmClient: recoveredRuntime.parent.llmClient,
        callbacks: recoveredRuntime.callbacks,
        actorFacetRuntime: createWorkflowLifecycleFacetRegistry(),
      })
      recoveredRuntime.vm.actors = { [recovered.key]: recovered }
      recoveredRuntime.vm.actorRuntime.register(recovered.key, recovered)
      recoverWorkflowLifecycleActorCapability(recoveredRuntime.vm, recovered)
      recoverWorkflowLifecycleActorCapability(recoveredRuntime.vm, recovered)
      for (const typedHost of [false, true]) {
        recoveredObserved.builderActorKeys = []
        await expectIsolatedResourceAgent({ vm: recoveredRuntime.vm, lifecycle: recovered, root, typedHost })
        expect(recoveredObserved.builderActorKeys).toEqual([recoveredObserved.child!.key])
        expect(readWorkflowLifecycleFacet(recoveredObserved.child!)).toBeUndefined()
        expect(recoveredObserved.child!.systemPrompts.join("\n")).not.toContain("sys-eidolon-anchor-devops")
        expect(recoveredObserved.child!.toolPolicy.providerToolSurface).toEqual({ mode: "exact", toolNames: [] })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
