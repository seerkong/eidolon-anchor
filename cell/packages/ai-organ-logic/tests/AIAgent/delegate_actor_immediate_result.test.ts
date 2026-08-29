import { describe, expect, it } from "bun:test"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer"
import { spawnChildExecutionActor } from "@cell/ai-organ-logic/agent/DelegateActor"
import { appendLiveHistoryMessageToConversationDomainRuntime } from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime"
import { materializeConversationHistoryMessagesFromVm } from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime"

describe("spawnChildExecutionActor immediate result", () => {
  it("returns the child assistant result from the conversation-domain history", async () => {
    const parent = createActor({
      key: "main",
      id: "parent",
      llmClient: {
        type: "openai",
        async createStream() {
          async function* stream() {
            yield { ok: true }
          }
          return { stream: stream() }
        },
      },
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (vm, actor) => {
          const message = {
            role: "assistant" as const,
            content: actor.type === "delegate" ? "grounded child report" : "parent",
          }
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
        agentRegistry: new AgentRegistry({
          code: {
            name: "code",
            description: "test delegate",
            tools: "*",
            prompt: ["Return the grounded report."],
          },
        } as any),
      },
    })

    const result = await spawnChildExecutionActor(vm, parent, {
      description: "produce report",
      prompt: "Produce the grounded report.",
      agentType: "code",
      mode: "sync_wait",
    })

    expect(result).toBe("grounded child report")
  })

  it("rejects a failed isolated child instead of returning its earlier assistant progress", async () => {
    const parent = createActor({
      key: "main",
      id: "parent-failure",
      llmClient: {
        type: "openai",
        async createStream() {
          async function* stream() {
            yield { ok: true }
          }
          return { stream: stream() }
        },
      },
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (vm, actor) => {
          appendLiveHistoryMessageToConversationDomainRuntime({
            vm,
            actorKey: actor.key,
            actorId: actor.id,
            message: { role: "assistant", content: "preparing workflow instance" },
          })
          throw new Error("invalid_tool_call_payload: invalid JSON arguments")
        },
      },
    })
    const vm = createVM({
      controlActorKey: parent.key,
      actors: { [parent.key]: parent },
      registries: {
        toolRegistry: composeToolRegistry(),
        agentRegistry: new AgentRegistry({
          workflow: {
            name: "workflow",
            description: "test workflow delegate",
            tools: "*",
            prompt: ["Complete the workflow journey."],
          },
        } as any),
      },
    })

    await expect(spawnChildExecutionActor(vm, parent, {
      description: "execute workflow",
      prompt: "Execute the workflow.",
      agentType: "workflow",
      mode: "sync_wait",
    })).rejects.toThrow("invalid_tool_call_payload")
  })

  it("uses an already resolved generic config and preserves ordered Agent seed messages", async () => {
    let observedSystemPrompts: string[] = []
    let observedHistory: Array<{ role: string; content: unknown }> = []
    let observedContextPipeline: unknown
    let observedToolPolicy: { allowedToolsMode: string; allowedTools: string[] } | undefined
    const parent = createActor({
      key: "main",
      id: "parent-resource-config",
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
          observedSystemPrompts = [...actor.systemPrompts]
          observedContextPipeline = actor.contextPipeline
          observedToolPolicy = {
            allowedToolsMode: actor.toolPolicy.allowedToolsMode,
            allowedTools: [...actor.toolPolicy.allowedTools],
          }
          observedHistory = materializeConversationHistoryMessagesFromVm({
            vm,
            actorKey: actor.key,
          }).map((message) => ({ role: message.role, content: message.content }))
          const message = { role: "assistant" as const, content: "resource result" }
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

    const result = await spawnChildExecutionActor(vm, parent, {
      description: "run resource Agent",
      prompt: "live task",
      agentType: "resource://eidolon.fixture.SupportAgent",
      resolvedConfig: {
        name: "resource://eidolon.fixture.SupportAgent",
        description: "resource Agent",
        tools: [],
        prompt: [],
        requireExactTools: true,
        seedMessages: [
          { role: "system", content: "system instruction" },
          { role: "developer", content: "developer instruction" },
          { role: "user", content: "example request" },
          { role: "assistant", content: "example response" },
        ],
        contextPipeline: {
          schemaVersion: "eidolon.agent-context-pipeline-binding/v1",
          resourceId: "eidolon.fixture.StandardContext",
          contentDigest: "sha256:delegate-context",
          implementation: "eidolon.standard-context-pipeline/v1",
          stages: [
            "prompt-plan",
            "conversation-prelude",
            "provider-context-facts-at-history-anchors",
            "stable-message-prefix",
            "conversation-boundary-overlays",
            "provider-conversion",
          ],
        },
      },
      mode: "sync_wait",
    })

    expect(result).toBe("resource result")
    expect(observedToolPolicy).toEqual({ allowedToolsMode: "exact", allowedTools: [] })
    expect(observedSystemPrompts).toEqual(["system instruction", "developer instruction"])
    expect(observedContextPipeline).toEqual(expect.objectContaining({
      implementation: "eidolon.standard-context-pipeline/v1",
    }))
    expect(observedHistory).toEqual([
      { role: "user", content: "example request" },
      { role: "assistant", content: "example response" },
      { role: "user", content: "live task" },
    ])
  })

  it("rejects an instruction message after conversation seed messages before actor creation", async () => {
    const parent = createActor({
      key: "main",
      id: "parent-invalid-resource-config",
      llmClient: {} as any,
      callbacks: { buildToolset: () => [], processStream: async () => undefined },
    })
    const vm = createVM({
      controlActorKey: parent.key,
      actors: { [parent.key]: parent },
      registries: {
        toolRegistry: composeToolRegistry(),
        agentRegistry: new AgentRegistry({}),
      },
    })

    await expect(spawnChildExecutionActor(vm, parent, {
      description: "invalid resource Agent",
      prompt: "live task",
      agentType: "resource://eidolon.fixture.InvalidAgent",
      resolvedConfig: {
        name: "resource://eidolon.fixture.InvalidAgent",
        description: "invalid resource Agent",
        tools: [],
        prompt: [],
        seedMessages: [
          { role: "user", content: "conversation seed" },
          { role: "system", content: "late instruction" },
        ],
      },
      mode: "sync_wait",
    })).rejects.toThrow("Agent seed instructions must precede conversation messages")
    expect(Object.keys(vm.actors)).toEqual(["main"])
  })

  it("requires resource Agent tool identities to exist exactly before actor creation", async () => {
    const parent = createActor({
      key: "main",
      id: "parent-missing-tool",
      llmClient: {} as any,
      callbacks: { buildToolset: () => [], processStream: async () => undefined },
    })
    const vm = createVM({
      controlActorKey: parent.key,
      actors: { [parent.key]: parent },
      registries: {
        toolRegistry: composeToolRegistry(),
        agentRegistry: new AgentRegistry({
          "resource://eidolon.fixture.ToolAgent": {
            name: "resource://eidolon.fixture.ToolAgent",
            description: "exact tool Agent",
            tools: ["eidolon.fixture.LookupTool"],
            prompt: [],
            requireExactTools: true,
          },
        }),
      },
    })

    await expect(spawnChildExecutionActor(vm, parent, {
      description: "missing exact tool",
      prompt: "live task",
      agentType: "resource://eidolon.fixture.ToolAgent",
      mode: "sync_wait",
    })).rejects.toThrow("requires unavailable exact tool 'eidolon.fixture.LookupTool'")
    expect(Object.keys(vm.actors)).toEqual(["main"])
  })

  it("validates generic execution input before provider dispatch and output before result delivery", async () => {
    let providerCalls = 0
    const parent = createActor({
      key: "main",
      id: "parent-execution-contract",
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
          const message = { role: "assistant" as const, content: JSON.stringify({ ok: false }) }
          appendLiveHistoryMessageToConversationDomainRuntime({ vm, actorKey: actor.key, actorId: actor.id, message })
          return message
        },
      },
    })
    const vm = createVM({
      controlActorKey: parent.key,
      actors: { [parent.key]: parent },
      registries: { toolRegistry: composeToolRegistry(), agentRegistry: new AgentRegistry({}) },
    })
    const base = {
      schemaVersion: "eidolon.agent-execution-contract/v1" as const,
      input: {
        schemaVersion: "eidolon.agent-execution-input/v1" as const,
        payload: { request: "hello" },
        materials: [],
      },
      messageSchemas: [],
      inputSchema: { type: "object", properties: { request: { type: "string" } }, required: ["request"] },
      outputSchema: { type: "object", properties: { ok: { const: true } }, required: ["ok"] },
      effectPolicy: { toolMode: "declared-only" as const },
    }
    await expect(spawnChildExecutionActor(vm, parent, {
      description: "invalid output",
      prompt: "canonical input",
      agentType: "resource://eidolon.fixture.ValidatedAgent",
      resolvedConfig: {
        name: "resource://eidolon.fixture.ValidatedAgent",
        description: "validated Agent",
        tools: [],
        prompt: [],
        requireExactTools: true,
        executionContract: base as any,
      },
    })).rejects.toThrow("AGENT_EXECUTION_OUTPUT_SCHEMA_MISMATCH")
    expect(providerCalls).toBe(1)

    await expect(spawnChildExecutionActor(vm, parent, {
      description: "invalid input",
      prompt: "canonical input",
      agentType: "resource://eidolon.fixture.InvalidInputAgent",
      resolvedConfig: {
        name: "resource://eidolon.fixture.InvalidInputAgent",
        description: "invalid input Agent",
        tools: [],
        prompt: [],
        requireExactTools: true,
        executionContract: {
          ...base,
          input: { ...base.input, payload: {} },
        } as any,
      },
    })).rejects.toThrow("AGENT_EXECUTION_SCHEMA_MISMATCH")
    expect(providerCalls).toBe(1)
  })
})
