import { describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { composeToolRegistry } from "../../src/composer/AIAgent/ToolFuncComposer"
import { appendLiveHistoryMessageToConversationDomainRuntime } from "../../src/conversation/ConversationDomainRuntime"
import { EidolonWorkflowEffectProvider } from "../../src/workflow/effects/EidolonWorkflowEffectProvider"
import { WorkflowFactStore } from "../../src/workflow/runtime/WorkflowFactStore"

const ACTIVE_RUN = {
  workflow: { ref: "resource://demo.workflow.Active", scheme: "resource" as const },
  runId: "active-run",
  generation: 3,
}

describe("Eidolon workflow effect provider contract", () => {
  it("publishes concurrent same-key Agent facts exclusively", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-agent-exclusive-"))
    try {
      const facts = new WorkflowFactStore(root)
      const first = {
        schemaVersion: "eidolon.workflow-agent-execution-fact/v1",
        runId: "same-run",
        generation: 0,
        effectId: "same-effect",
        nodeId: "same-node",
        workflowForm: "AICtrlWorkflow",
        workflowRef: "resource://eidolon.fixture.Workflow",
        agentDefinitionRef: "resource://eidolon.fixture.AgentA",
        plan: { agentDefinitionRef: "resource://eidolon.fixture.AgentA" },
        resourceReceipt: { task: { agentDefinitionRef: "resource://eidolon.fixture.AgentA" } },
        createdAt: 1,
      } as any
      const second = structuredClone(first)
      second.agentDefinitionRef = "resource://eidolon.fixture.AgentB"
      second.plan.agentDefinitionRef = "resource://eidolon.fixture.AgentB"
      second.resourceReceipt.task.agentDefinitionRef = "resource://eidolon.fixture.AgentB"
      second.createdAt = 2

      const results = await Promise.allSettled([
        facts.saveAgentExecutionFact(first),
        facts.saveAgentExecutionFact(second),
      ])
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
      const stored = await facts.loadAgentExecutionFact("same-run", 0, "same-effect")
      expect(stored?.agentDefinitionRef).toBe(
        results[0]?.status === "fulfilled" ? first.agentDefinitionRef : second.agentDefinitionRef,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("rejects a missing run capability with a stable contract diagnostic", async () => {
    const provider = new EidolonWorkflowEffectProvider(
      {} as any,
      {} as any,
      {} as any,
      undefined,
      () => ACTIVE_RUN,
    )

    await expect(provider.invoke({
      effectId: "missing-run",
      operation: "identity",
      input: {},
    } as any)).rejects.toThrow("Workflow effect request requires run.runId")
  })

  it("rejects a non-authoritative run capability before recording or dispatching an effect", async () => {
    const provider = new EidolonWorkflowEffectProvider(
      {} as any,
      {} as any,
      {} as any,
      undefined,
      () => ACTIVE_RUN,
    )

    await expect(provider.invoke({
      run: {
        ...ACTIVE_RUN,
        runId: "other-run",
      },
      effectId: "other-run",
      operation: "identity",
      input: {},
    })).rejects.toThrow("does not match active runtime run authority")
  })

  it("rejects a field-identical clone of the active run capability", async () => {
    const provider = new EidolonWorkflowEffectProvider(
      {} as any,
      {} as any,
      {} as any,
      undefined,
      () => ACTIVE_RUN,
    )

    await expect(provider.invoke({
      run: structuredClone(ACTIVE_RUN),
      effectId: "cloned-run",
      operation: "identity",
      input: {},
    })).rejects.toThrow("does not match active runtime run authority")
  })

  it("persists and reuses a frozen resource Agent plan before the existing delegate actor runs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-agent-fact-"))
    try {
      const parent = createActor({
        key: "main",
        id: "parent-resource-workflow",
        llmClient: {
          type: "openai",
          async createStream() {
            async function* stream() { yield { ok: true } }
            return { stream: stream() }
          },
        },
        modelConfig: { model: "mock" },
        callbacks: {
          buildToolset: () => [],
          processStream: async (vm, actor) => {
            const message = { role: "assistant" as const, content: "resource workflow result" }
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
      const vm = createVM({
        controlActorKey: parent.key,
        actors: { [parent.key]: parent },
        registries: {
          toolRegistry: composeToolRegistry(),
          agentRegistry: new AgentRegistry({}),
        },
      })
      const facts = new WorkflowFactStore(root)
      let prepareCalls = 0
      const prepared = {
        plan: Object.freeze({
          schemaVersion: "eidolon.resource-agent-execution-plan/v1",
          agentDefinitionRef: "resource://eidolon.fixture.SupportAgent",
          registryRevision: "sha256:registry",
          compositionRevision: "sha256:composition",
          agentContentDigest: "sha256:agent",
          messages: Object.freeze([]),
          toolResourceIds: Object.freeze([]),
          requiresWorkflowTask: true,
          agentConfig: Object.freeze({
            name: "resource://eidolon.fixture.SupportAgent",
            description: "frozen resource Agent",
            tools: Object.freeze([]) as string[],
            prompt: Object.freeze([]) as string[],
            seedMessages: Object.freeze([{ role: "system" as const, content: "frozen instruction" }]),
            requireExactTools: true,
          }),
        }),
        receipt: Object.freeze({
          schemaVersion: "ai-workflow.run-resource-freeze/v1" as const,
          task: Object.freeze({
            workflowKind: "AICtrlWorkflow" as const,
            workflowRef: "resource://demo.workflow.Active" as const,
            nodeId: "agent-node",
            agentDefinitionRef: "resource://eidolon.fixture.SupportAgent" as const,
          }),
          bindingResourceIds: Object.freeze([]),
          dependencySnapshot: Object.freeze({}) as any,
          semanticFingerprint: "sha256:semantic" as const,
        }),
      }
      const provider = new EidolonWorkflowEffectProvider(
        { vm, actor: parent } as any,
        {} as any,
        facts,
        undefined,
        () => ACTIVE_RUN,
        {
          workflowForm: "AICtrlWorkflow",
          resourceRegistry: {
            async prepareWorkflowAgentExecution() {
              prepareCalls += 1
              if (prepareCalls > 1) throw new Error("live package should not be read again")
              return prepared
            },
          } as any,
        },
      )
      const request = {
        run: ACTIVE_RUN,
        effectId: "agent-effect",
        operation: "ai.agent",
        nodeId: "agent-node",
        input: {
          agentDefinitionRef: "resource://eidolon.fixture.SupportAgent",
          prompt: "perform the task",
        },
      } as const

      expect(await provider.invoke(request as any)).toBe("resource workflow result")
      expect(await provider.invoke(request as any)).toBe("resource workflow result")
      expect(prepareCalls).toBe(1)
      const persisted = await facts.loadAgentExecutionFact("active-run", 3, "agent-effect")
      expect(persisted).toMatchObject({
        schemaVersion: "eidolon.workflow-agent-execution-fact/v1",
        runId: "active-run",
        generation: 3,
        effectId: "agent-effect",
        nodeId: "agent-node",
        agentDefinitionRef: "resource://eidolon.fixture.SupportAgent",
        plan: { agentConfig: { name: "resource://eidolon.fixture.SupportAgent" } },
        resourceReceipt: { semanticFingerprint: "sha256:semantic" },
      })
      expect(Object.isFrozen(persisted)).toBe(true)
      expect(Object.isFrozen(persisted?.plan.agentConfig)).toBe(true)

      const conflicting = structuredClone(persisted!) as any
      conflicting.agentDefinitionRef = "resource://eidolon.fixture.OtherAgent"
      await expect(facts.saveAgentExecutionFact(conflicting)).rejects.toThrow(
        "Workflow Agent execution fact collision",
      )
      expect((await facts.loadAgentExecutionFact("active-run", 3, "agent-effect"))?.agentDefinitionRef)
        .toBe("resource://eidolon.fixture.SupportAgent")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("requires resource workflows to provide an exact agentDefinitionRef without legacy fallback", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-agent-ref-"))
    try {
      const facts = new WorkflowFactStore(root)
      const provider = new EidolonWorkflowEffectProvider(
        { vm: {}, actor: {} } as any,
        {} as any,
        facts,
        undefined,
        () => ACTIVE_RUN,
        {
          workflowForm: "AICtrlWorkflow",
          resourceRegistry: { prepareWorkflowAgentExecution: async () => { throw new Error("not reached") } } as any,
        },
      )
      await expect(provider.invoke({
        run: ACTIVE_RUN,
        effectId: "missing-agent-ref",
        operation: "ai.agent",
        nodeId: "agent-node",
        input: { agentType: "code", prompt: "must not fall back" },
      } as any)).rejects.toThrow("requires one exact agentDefinitionRef")
      expect(await facts.loadAgentExecutionFact("active-run", 3, "missing-agent-ref")).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("keeps explicit vfs workflows on the existing AgentRegistry compatibility path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-agent-vfs-"))
    try {
      const vfsRun = {
        workflow: { ref: "vfs://./legacy/manifest.xnl", scheme: "vfs" as const },
        runId: "legacy-run",
        generation: 0,
      }
      const parent = createActor({
        key: "main",
        id: "parent-legacy-workflow",
        llmClient: {
          type: "openai",
          async createStream() {
            async function* stream() { yield { ok: true } }
            return { stream: stream() }
          },
        },
        modelConfig: { model: "mock" },
        callbacks: {
          buildToolset: () => [],
          processStream: async (vm, actor) => {
            const message = { role: "assistant" as const, content: "legacy result" }
            appendLiveHistoryMessageToConversationDomainRuntime({ vm, actorKey: actor.key, actorId: actor.id, message })
            return message
          },
        },
      })
      const vm = createVM({
        controlActorKey: parent.key,
        actors: { [parent.key]: parent },
        registries: {
          toolRegistry: composeToolRegistry(),
          agentRegistry: new AgentRegistry({
            code: { name: "code", description: "legacy Agent", tools: "*", prompt: ["legacy instruction"] },
          }),
        },
      })
      const facts = new WorkflowFactStore(root)
      const provider = new EidolonWorkflowEffectProvider(
        { vm, actor: parent } as any,
        {} as any,
        facts,
        undefined,
        () => vfsRun,
      )

      expect(await provider.invoke({
        run: vfsRun,
        effectId: "legacy-agent",
        operation: "ai.agent",
        nodeId: "legacy-node",
        input: { agentType: "code", prompt: "legacy task" },
      } as any)).toBe("legacy result")
      expect(await facts.loadAgentExecutionFact("legacy-run", 0, "legacy-agent")).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
