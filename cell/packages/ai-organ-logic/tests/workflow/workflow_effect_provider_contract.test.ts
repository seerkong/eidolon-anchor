import { describe, expect, it } from "bun:test"
import { access, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { readRuntimeControlEffectEvidence } from "@cell/ai-file-store-logic"
import { composeToolRegistry } from "../../src/composer/AIAgent/ToolFuncComposer"
import { appendLiveHistoryMessageToConversationDomainRuntime } from "../../src/conversation/ConversationDomainRuntime"
import { EidolonWorkflowEffectProvider } from "../../src/workflow/effects/EidolonWorkflowEffectProvider"
import { WorkflowFactStore } from "../../src/workflow/runtime/WorkflowFactStore"
import { readWorkflowPublicRuntimeEvidence } from "../../src/workflow/runtime/WorkflowPublicRuntimeEvidence"
import { resolveProviderCacheActorClass } from "../../src/llm/ProviderCacheActorAttribution"

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

  for (const workflowForm of ["AICtrlWorkflow", "AIDataWorkflow"] as const) {
  it(`reuses generic lifecycle evidence for one ${workflowForm} resource Agent effect`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-agent-fact-"))
    try {
      let providerCalls = 0
      let observedProviderContextClass: string | undefined
      let observedRuntimeFacetIds: string[] | undefined
      let observedSystemPrompts: string[] | undefined
      let observedAllowedTools: string[] | undefined
      let observedAllowedToolsMode: string | undefined
      let releaseProvider!: () => void
      let markProviderStarted!: () => void
      const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve })
      const providerRelease = new Promise<void>((resolve) => { releaseProvider = resolve })
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
            providerCalls += 1
            observedProviderContextClass = resolveProviderCacheActorClass(actor)
            observedRuntimeFacetIds = Object.keys(actor.runtimeFacets)
            observedSystemPrompts = [...actor.systemPrompts]
            observedAllowedTools = [...actor.toolPolicy.allowedTools]
            observedAllowedToolsMode = actor.toolPolicy.allowedToolsMode
            markProviderStarted()
            await providerRelease
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
      ;(vm as any).outerCtx = { metadata: { sessionDir: root } }
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
          executionContract: Object.freeze({
            schemaVersion: "eidolon.agent-execution-contract/v1" as const,
            input: Object.freeze({
              schemaVersion: "eidolon.agent-execution-input/v1" as const,
              payload: Object.freeze({ request: "perform the task" }),
              materials: Object.freeze([]),
            }),
            messageSchemas: Object.freeze([]),
            effectPolicy: Object.freeze({ toolMode: "declared-only" as const }),
          }),
          agentConfig: Object.freeze({
            name: "resource://eidolon.fixture.SupportAgent",
            description: "frozen resource Agent",
            tools: Object.freeze([]) as string[],
            prompt: Object.freeze([]) as string[],
            seedMessages: Object.freeze([{ role: "system" as const, content: "frozen instruction" }]),
            requireExactTools: true,
            executionContract: Object.freeze({
              schemaVersion: "eidolon.agent-execution-contract/v1" as const,
              input: Object.freeze({
                schemaVersion: "eidolon.agent-execution-input/v1" as const,
                payload: Object.freeze({ request: "perform the task" }),
                materials: Object.freeze([]),
              }),
              messageSchemas: Object.freeze([]),
              effectPolicy: Object.freeze({ toolMode: "declared-only" as const }),
            }),
          }),
        }),
        receipt: Object.freeze({
          schemaVersion: "ai-workflow.run-resource-freeze/v1" as const,
          task: Object.freeze({
            workflowKind: workflowForm,
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
          workflowForm,
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
          payload: { request: "perform the task" },
        },
      } as const

      const firstExecution = provider.invoke(request as any)
      await providerStarted
      const sameProviderPending = provider.invoke(request as any)
      const reconstructedProvider = new EidolonWorkflowEffectProvider(
        { vm, actor: parent } as any,
        {} as any,
        facts,
        undefined,
        () => ACTIVE_RUN,
        {
          workflowForm,
          resourceRegistry: {
            async prepareWorkflowAgentExecution() {
              throw new Error("recovered execution must not read the live package")
            },
          } as any,
        },
      )
      const recoveredWhilePending = reconstructedProvider.invoke(request as any)
      releaseProvider()
      expect(await Promise.all([firstExecution, sameProviderPending, recoveredWhilePending]))
        .toEqual(["resource workflow result", "resource workflow result", "resource workflow result"])
      expect(await reconstructedProvider.invoke(request as any)).toBe("resource workflow result")
      expect(prepareCalls).toBe(1)
      expect(providerCalls).toBe(1)
      expect(observedProviderContextClass).toBe("workflow_node")
      expect(observedRuntimeFacetIds).toEqual([])
      expect(observedSystemPrompts).toEqual(["frozen instruction"])
      expect(observedSystemPrompts?.join("\n")).not.toContain("sys-eidolon-anchor-devops")
      expect(observedAllowedToolsMode).toBe("exact")
      expect(observedAllowedTools).toEqual([])
      expect(await readRuntimeControlEffectEvidence(root)).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "request", effectId: "agent-effect", handlerKey: "workflow:ai.agent" }),
        expect.objectContaining({ kind: "result", effectId: "agent-effect", handlerKey: "workflow:ai.agent" }),
      ]))
      await expect(access(path.join(root, "agent-executions", "active-run"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it(`rejects a ${workflowForm} resource Agent's frozen lifecycle-internal tool before effect or provider dispatch`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-node-tool-admission-"))
    try {
      let providerCalls = 0
      const parent = createActor({
        key: "main",
        id: "parent-resource-workflow",
        llmClient: {
          type: "openai",
          async createStream() {
            providerCalls += 1
            async function* stream() { yield { ok: true } }
            return { stream: stream() }
          },
        },
        modelConfig: { model: "mock" },
        callbacks: {
          buildToolset: () => [],
          processStream: async () => {
            providerCalls += 1
            return { role: "assistant" as const, content: "must not execute" }
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
      ;(vm as any).outerCtx = { metadata: { sessionDir: root } }
      const facts = new WorkflowFactStore(root)
      const provider = new EidolonWorkflowEffectProvider(
        { vm, actor: parent } as any,
        {} as any,
        facts,
        undefined,
        () => ACTIVE_RUN,
        {
          workflowForm,
          resourceRegistry: {
            async prepareWorkflowAgentExecution() {
              return {
                plan: Object.freeze({
                  schemaVersion: "eidolon.resource-agent-execution-plan/v1",
                  agentDefinitionRef: "resource://eidolon.fixture.SupportAgent",
                  registryRevision: "sha256:registry",
                  compositionRevision: "sha256:composition",
                  agentContentDigest: "sha256:agent",
                  messages: Object.freeze([]),
                  toolResourceIds: Object.freeze(["WorkflowRun"]),
                  requiresWorkflowTask: true,
                  executionContract: Object.freeze({
                    schemaVersion: "eidolon.agent-execution-contract/v1" as const,
                    input: Object.freeze({
                      schemaVersion: "eidolon.agent-execution-input/v1" as const,
                      payload: Object.freeze({ request: "perform the task" }),
                      materials: Object.freeze([]),
                    }),
                    messageSchemas: Object.freeze([]),
                    effectPolicy: Object.freeze({ toolMode: "declared-only" as const }),
                  }),
                  agentConfig: Object.freeze({
                    name: "resource://eidolon.fixture.SupportAgent",
                    description: "frozen resource Agent",
                    tools: Object.freeze(["WorkflowRun"]) as string[],
                    prompt: Object.freeze([]) as string[],
                    seedMessages: Object.freeze([{ role: "system" as const, content: "frozen instruction" }]),
                    requireExactTools: true,
                    executionContract: Object.freeze({
                      schemaVersion: "eidolon.agent-execution-contract/v1" as const,
                      input: Object.freeze({
                        schemaVersion: "eidolon.agent-execution-input/v1" as const,
                        payload: Object.freeze({ request: "perform the task" }),
                        materials: Object.freeze([]),
                      }),
                      messageSchemas: Object.freeze([]),
                      effectPolicy: Object.freeze({ toolMode: "declared-only" as const }),
                    }),
                  }),
                }),
                receipt: Object.freeze({
                  schemaVersion: "ai-workflow.run-resource-freeze/v1" as const,
                  task: Object.freeze({
                    workflowKind: workflowForm,
                    workflowRef: "resource://demo.workflow.Active" as const,
                    nodeId: "agent-node",
                    agentDefinitionRef: "resource://eidolon.fixture.SupportAgent" as const,
                  }),
                  bindingResourceIds: Object.freeze([]),
                  dependencySnapshot: Object.freeze({}) as any,
                  semanticFingerprint: "sha256:semantic" as const,
                }),
              }
            },
          } as any,
        },
      )

      await expect(provider.invoke({
        run: ACTIVE_RUN,
        effectId: "unauthorized-agent-effect",
        operation: "ai.agent",
        nodeId: "agent-node",
        input: {
          agentDefinitionRef: "resource://eidolon.fixture.SupportAgent",
          payload: { request: "perform the task" },
        },
      } as any)).rejects.toThrow(
        "WORKFLOW_NODE_LIFECYCLE_TOOL_UNAUTHORIZED: frozen Agent task cannot admit lifecycle-internal tool 'WorkflowRun'",
      )
      expect(providerCalls).toBe(0)
      expect(await facts.readRunEvents(ACTIVE_RUN.runId)).toEqual([])
      expect(await readRuntimeControlEffectEvidence(root)).toEqual([])
      expect(readWorkflowPublicRuntimeEvidence(vm)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  for (const typedHost of [false, true] as const) {
    it(`preserves ${workflowForm} ${typedHost ? "addressed" : "spawned"} resource node identity after provider failure`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), `eidolon-resource-workflow-failed-public-evidence-${typedHost}-`))
      try {
      const parent = createActor({
        key: "main",
        id: `parent-resource-failure-${workflowForm}`,
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
          processStream: async () => {
            throw new Error("official provider rejected after resource actor admission")
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
      ;(vm as any).outerCtx = { metadata: { sessionDir: root } }
      const facts = new WorkflowFactStore(root)
      const agentDefinitionRef = "resource://eidolon.fixture.FailingAgent"
      const provider = new EidolonWorkflowEffectProvider(
        { vm, actor: parent } as any,
        {} as any,
        facts,
        undefined,
        () => ACTIVE_RUN,
        {
          workflowForm,
          resourceRegistry: {
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
                    description: "failing resource Agent",
                    tools: [],
                    prompt: [],
                    seedMessages: [{ role: "system", content: "fail after admission" }],
                    requireExactTools: true,
                  },
                  executionContract: {
                    input: { payload: { request: "fail" }, materials: [] },
                    messageSchemas: [],
                    effectPolicy: { toolMode: "declared-only" },
                  },
                },
                receipt: {
                  schemaVersion: "ai-workflow.run-resource-freeze/v1",
                  task: {
                    workflowKind: workflowForm,
                    workflowRef: ACTIVE_RUN.workflow.ref,
                    nodeId: "execute",
                    agentDefinitionRef,
                  },
                  bindingResourceIds: [],
                  dependencySnapshot: {},
                  semanticFingerprint: "sha256:failure",
                },
              }
            },
          } as any,
        },
        undefined,
        { instanceId: `resource-instance-${workflowForm}`, workflowForm },
      )

      await expect(provider.invoke({
        run: ACTIVE_RUN,
        effectId: `resource-failure-${workflowForm}`,
        operation: "ai.agent",
        nodeId: "execute",
        input: { agentDefinitionRef, payload: { request: "fail" } },
        config: typedHost ? { typedHost: true } : {},
      } as any)).rejects.toThrow("official provider rejected after resource actor admission")

      expect((await facts.readRunEvents(ACTIVE_RUN.runId)).at(-1)).toMatchObject({
        type: "workflow.effect.failed",
        payload: { error: "Error: official provider rejected after resource actor admission" },
      })
      const evidence = readWorkflowPublicRuntimeEvidence(vm)
      expect(evidence).toEqual([
        expect.objectContaining({
          kind: workflowForm,
          definitionRef: ACTIVE_RUN.workflow.ref,
          instanceId: `resource-instance-${workflowForm}`,
          runId: ACTIVE_RUN.runId,
          nodeExecutions: [expect.objectContaining({
            nodeId: "execute",
            agentDefinitionRef,
          })],
        }),
      ])
      if (typedHost) {
        const admitted = evidence[0]!.nodeExecutions[0]!
        await expect(provider.invoke({
          run: ACTIVE_RUN,
          effectId: `resource-failure-reused-${workflowForm}`,
          operation: "ai.agent",
          nodeId: "execute",
          input: { agentDefinitionRef, payload: { request: "fail again" } },
          config: {
            typedHost: true,
            targetInstance: {
              authority: "eidolon.actor-runtime/v1",
              instanceId: admitted.actorId,
              agentDefinitionRef,
              metadata: { actorKey: admitted.actorKey },
            },
          },
        } as any)).rejects.toThrow("official provider rejected after resource actor admission")
        expect(readWorkflowPublicRuntimeEvidence(vm)[0]?.nodeExecutions).toEqual([admitted])
      }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
  }

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
        undefined,
        undefined,
        { instanceId: "legacy-instance", workflowForm: "AICtrlWorkflow" },
      )

      expect(await provider.invoke({
        run: vfsRun,
        effectId: "legacy-agent-1",
        operation: "ai.agent",
        nodeId: "legacy-node",
        input: { agentType: "code", prompt: "legacy task" },
      } as any)).toBe("legacy result")
      expect(await provider.invoke({
        run: vfsRun,
        effectId: "legacy-agent-2",
        operation: "ai.agent",
        nodeId: "legacy-node",
        input: { agentType: "code", prompt: "legacy task again" },
      } as any)).toBe("legacy result")
      expect(await facts.loadAgentExecutionFact("legacy-run", 0, "legacy-agent-1")).toBeUndefined()
      const publicEvidence = readWorkflowPublicRuntimeEvidence(vm)
      expect(publicEvidence).toHaveLength(1)
      expect(publicEvidence[0]?.nodeExecutions).toHaveLength(2)
      expect(new Set(publicEvidence[0]?.nodeExecutions.map((node) => node.actorId)).size).toBe(2)
      expect(publicEvidence[0]?.nodeExecutions.map((node) => node.nodeId)).toEqual(["legacy-node", "legacy-node"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  for (const workflowForm of ["AICtrlWorkflow", "AIDataWorkflow"] as const) {
    it(`preserves ${workflowForm} node identity when an admitted child later fails`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-workflow-failed-public-evidence-"))
      try {
        const run = {
          workflow: { ref: "vfs://./failed/manifest.xnl", scheme: "vfs" as const },
          runId: `failed-${workflowForm}`,
          generation: 0,
        }
        const parent = createActor({
          key: "main",
          id: `parent-${workflowForm}`,
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
            processStream: async () => {
              throw new Error("provider rejected after actor admission")
            },
          },
        })
        const vm = createVM({
          controlActorKey: parent.key,
          actors: { [parent.key]: parent },
          registries: {
            toolRegistry: composeToolRegistry(),
            agentRegistry: new AgentRegistry({
              code: { name: "code", description: "failing Agent", tools: "*", prompt: ["fail after admission"] },
            }),
          },
        })
        const facts = new WorkflowFactStore(root)
        const provider = new EidolonWorkflowEffectProvider(
          { vm, actor: parent } as any,
          {} as any,
          facts,
          undefined,
          () => run,
          undefined,
          undefined,
          { instanceId: `instance-${workflowForm}`, workflowForm },
        )

        await expect(provider.invoke({
          run,
          effectId: `failed-effect-${workflowForm}`,
          operation: "ai.agent",
          nodeId: "execute",
          input: { agentType: "code", prompt: "fail" },
        } as any)).rejects.toThrow("provider rejected after actor admission")

        const events = await facts.readRunEvents(run.runId)
        expect(events.at(-1)).toMatchObject({
          type: "workflow.effect.failed",
          payload: { error: "Error: provider rejected after actor admission" },
        })
        expect(readWorkflowPublicRuntimeEvidence(vm)).toEqual([
          expect.objectContaining({
            kind: workflowForm,
            definitionRef: run.workflow.ref,
            instanceId: `instance-${workflowForm}`,
            runId: run.runId,
            nodeExecutions: [expect.objectContaining({
              nodeId: "execute",
              agentDefinitionRef: "code",
            })],
          }),
        ])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
})
