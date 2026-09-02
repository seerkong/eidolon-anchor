import { describe, expect, it } from "bun:test"

import type { ToolDef, ToolExecutionResultEnvelope } from "@cell/ai-core-contract/types"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph"
import { buildTaskTreeWriteToolDef } from "@cell/ai-organ-logic/composer/AIAgent/tools/TaskTreeWrite"
import {
  aiAgentCooperativeStep,
  aiAgentLoopStreaming,
  buildProviderPromptForActorTurn,
} from "@cell/ai-organ-logic/exec/AiAgentExecutor"
import { getConversationActorRawStateFromVm } from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime"
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver"
import { activateActorProviderEpoch } from "@cell/ai-organ-logic/conversation/ProviderEpoch"
import { createMockProcessStream } from "../__test_support__/mockProcessStream"

const adapter = {
  type: "openai" as const,
  async createStream() {
    async function* stream() {
      yield { ok: true }
    }
    return {
      stream: stream(),
      providerOutput: Promise.resolve({
        provider_cache_cost_observation: { requestDigest: `sha256:${"a".repeat(64)}` },
      }),
    }
  },
}

function makeContextTool(name = "MutableStateProducer"): ToolDef<any, ToolExecutionResultEnvelope, Record<string, unknown>> {
  return {
    schema: {
      type: "function",
      function: { name, description: "test context producer", parameters: { type: "object" } },
    },
    briefPromptXnl: `<tool name="${name}" />`,
    run: async (_runtime, input) => ({
      output: `updated:${String(input?.value ?? "")}`,
      contextEffects: [{
        kind: "append_provider_context_fact",
        namespace: "task-tree-context",
        logicalKey: "test_mutable_state",
        revision: `revision-${String(input?.value ?? "")}`,
        payload: {
          logicalKey: "test_mutable_state",
          revision: `revision-${String(input?.value ?? "")}`,
          content: `full-state:${String(input?.value ?? "")}`,
        },
      }],
    }),
  }
}

function makeStreamingRuntime(params: {
  tool: ToolDef<any, any, any>
  processStream: () => Promise<any>
}) {
  const actor = createActor({
    key: "main",
    llmClient: adapter,
    modelConfig: { model: "mock", provider: "mock", adapter: "openai" },
    callbacks: {
      buildToolset: () => [params.tool.schema],
      processStream: async () => ({ role: "assistant", content: "unused" }),
    },
  })
  const toolRegistry = new ToolFuncRegistry()
  toolRegistry.register(params.tool)
  const eventBus = new AgentEventGraph()
  const vm = createVM({
    controlActorKey: actor.key,
    actors: { [actor.key]: actor },
    registries: { toolRegistry },
    eventBus,
    outerCtx: { metadata: { sessionId: "provider-projection-lifecycle" } },
  })
  actor.callbacks = {
    ...actor.callbacks,
    buildToolset: () => [params.tool.schema],
    processStream: createMockProcessStream(params.processStream),
  }
  activateActorProviderEpoch({
    vm,
    actor,
    sessionId: "provider-projection-lifecycle",
    targetProviderId: "mock",
    targetProfileId: "openai-chat@1",
    reason: "initial_projection",
  })
  return { actor, vm }
}

function contextSources(vm: any) {
  const raw = getConversationActorRawStateFromVm({ vm, actorKey: "main" })
  return raw?.session.contextAssets
    ?.flatMap((asset) => asset.providerContextFactCandidate?.sourceToolCalls ?? [])
    ?? []
}

function buildPrompt(vm: any, actor: any, tool: ToolDef<any, any, any>) {
  return buildProviderPromptForActorTurn({
    vm,
    actor,
    tools: [tool.schema],
    llmAdapter: adapter,
    model: "mock",
  }).executionMessages
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

describe("provider context fact execution lifecycle", () => {
  it("admits context only after its complete pair, then retains the pair and appends a typed fact", async () => {
    const tool = makeContextTool()
    let providerTurn = 0
    const { actor, vm } = makeStreamingRuntime({
      tool,
      processStream: async () => {
        providerTurn += 1
        return providerTurn === 1
          ? {
              role: "assistant",
              tool_calls: [{
                id: "call-generic-1",
                function: { name: "MutableStateProducer", arguments: JSON.stringify({ value: 1 }) },
              }],
            }
          : { role: "assistant", content: "done" }
      },
    })
    expect(getConversationActorRawStateFromVm({ vm, actorKey: actor.key })
      ?.session.actorBindings[actor.key]?.providerEpochReceiptV2).toBeDefined()

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [{ role: "user", content: "update state" }],
    })

    expect(result.messages.find((message: any) => message.role === "tool")?.content).toBe("updated:1")
    expect(contextSources(vm)).toEqual([
      expect.objectContaining({ toolCallId: "call-generic-1", deliveryState: "delivered" }),
    ])
    const nextPrompt = buildPrompt(vm, actor, tool)
    const serialized = JSON.stringify(nextPrompt)
    expect(serialized).toContain("call-generic-1")
    expect(serialized).toContain("full-state:1")
    expect(nextPrompt.some((message: any) => (
      message.role === "user"
      && String(message.content ?? "").startsWith("eidolon-context-fact/v1\n")
    ))).toBe(true)
    expect(nextPrompt.some((message: any) => (
      message.role === "system" && String(message.content ?? "").includes("full-state:1")
    ))).toBe(false)
    const raw = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })
    const typedFacts = raw?.session.contextAssets?.flatMap((asset) => (
      asset.providerContextFact?.namespace === "task-tree-context" ? [asset.providerContextFact] : []
    )) ?? []
    expect(typedFacts).toHaveLength(1)
    const admissions = raw?.session.actorBindings[actor.key]?.providerRequestAdmissions ?? []
    expect(admissions).toHaveLength(2)
    const allTypedFacts = raw?.session.contextAssets?.flatMap((asset) => (
      asset.providerContextFact ? [asset.providerContextFact] : []
    )) ?? []
    expect(allTypedFacts.some((fact) => fact.namespace === "work-context")).toBe(false)
    expect(admissions[0]?.admittedFactRange).toBeNull()
    expect(admissions.every((admission) => admission.finalRequestDigest === `sha256:${"a".repeat(64)}`)).toBe(true)
    expect(admissions[1]?.previousAdmissionDigest).toBe(admissions[0]?.admissionDigest)
    expect(admissions[1]?.currentHeads.factHeadDigest).toBe(typedFacts[0]?.factDigest)
    expect(admissions[1]?.admittedFactRange).toEqual({
      previousHeadDigest: typedFacts[0]?.previousSequenceFactDigest,
      firstSequence: typedFacts[0]?.sequence,
      lastSequence: typedFacts[0]?.sequence,
      count: 1,
      factDigests: [typedFacts[0]?.factDigest],
    })
    expect(typedFacts[0]?.sourceDeliveryProofs[0]).toEqual(expect.objectContaining({
      kind: "first-delivery-pair",
      toolCallId: "call-generic-1",
      requestAdmissionIntentDigest: admissions[1]?.factAppendIntentDigest,
    }))
    expect(actor.continuationBaseline).toEqual(expect.objectContaining({
      lastResetReason: "provider_context:fact_appended",
    }))
  })

  it("leaves a source pair pending when the provider call fails", async () => {
    const tool = makeContextTool()
    let providerTurn = 0
    const { actor, vm } = makeStreamingRuntime({
      tool,
      processStream: async () => {
        providerTurn += 1
        if (providerTurn === 1) {
          return {
            role: "assistant",
            tool_calls: [{
              id: "call-failed-delivery",
              function: { name: "MutableStateProducer", arguments: JSON.stringify({ value: 2 }) },
            }],
          }
        }
        throw new Error("provider unavailable")
      },
    })

    await expect(aiAgentLoopStreaming({
      vm,
      actor,
      messages: [{ role: "user", content: "update state" }],
    })).rejects.toThrow("provider unavailable")

    expect(contextSources(vm)).toEqual([
      expect.objectContaining({ toolCallId: "call-failed-delivery", deliveryState: "pending" }),
    ])
    const retryPrompt = buildPrompt(vm, actor, tool)
    expect(JSON.stringify(retryPrompt)).toContain("call-failed-delivery")
    expect(JSON.stringify(retryPrompt)).not.toContain("full-state:2")
    expect(actor.continuationBaseline).toEqual(expect.objectContaining({
      lastResetReason: "provider_context:context_effect",
    }))
  })

  it("leaves a source pair pending when an in-flight provider call is aborted", async () => {
    const tool = makeContextTool()
    let providerTurn = 0
    let secondProviderStarted!: () => void
    const secondProviderStart = new Promise<void>((resolve) => {
      secondProviderStarted = resolve
    })
    const { actor, vm } = makeStreamingRuntime({
      tool,
      processStream: async () => {
        providerTurn += 1
        if (providerTurn === 1) {
          return {
            role: "assistant",
            tool_calls: [{
              id: "call-aborted-delivery",
              function: { name: "MutableStateProducer", arguments: JSON.stringify({ value: 3 }) },
            }],
          }
        }
        secondProviderStarted()
        await new Promise<void>((_resolve, reject) => {
          actor.llmAbortController?.signal.addEventListener("abort", () => reject(new Error("provider aborted")), { once: true })
        })
      },
    })

    const loop = aiAgentLoopStreaming({
      vm,
      actor,
      messages: [{ role: "user", content: "update state" }],
    })
    await secondProviderStart
    actor.llmAbortController?.abort()
    await expect(loop).rejects.toThrow("provider aborted")

    expect(contextSources(vm)).toEqual([
      expect.objectContaining({ toolCallId: "call-aborted-delivery", deliveryState: "pending" }),
    ])
  })

  it("keeps each TaskTree revision and first-delivery pair across consecutive writes", async () => {
    const tool = buildTaskTreeWriteToolDef()
    let providerTurn = 0
    const { actor, vm } = makeStreamingRuntime({
      tool,
      processStream: async () => {
        providerTurn += 1
        if (providerTurn === 1) {
          return {
            role: "assistant",
            tool_calls: [{
              id: "call-tree-1",
              function: {
                name: "TaskTreeWrite",
                arguments: JSON.stringify({
                  op: "replace_root",
                  tasks: [{ content: "old task", status: "in_progress" }],
                }),
              },
            }],
          }
        }
        if (providerTurn === 2) {
          return {
            role: "assistant",
            tool_calls: [{
              id: "call-tree-2",
              function: {
                name: "TaskTreeWrite",
                arguments: JSON.stringify({
                  op: "replace_root",
                  tasks: [{ content: "current task", status: "in_progress" }],
                }),
              },
            }],
          }
        }
        return { role: "assistant", content: "done" }
      },
    })

    const result = await aiAgentLoopStreaming({
      vm,
      actor,
      messages: [{ role: "user", content: "replace twice" }],
    })

    const toolOutputs = result.messages
      .filter((message: any) => message.role === "tool")
      .map((message: any) => String(message.content))
    expect(toolOutputs).toHaveLength(2)
    expect(toolOutputs.every((output) => output.length < 160)).toBe(true)
    expect(toolOutputs.some((output) => output.includes("old task"))).toBe(false)
    expect(toolOutputs.some((output) => output.includes("current task"))).toBe(false)

    const raw = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })
    const contextCandidates = raw?.session.contextAssets
      ?.flatMap((asset) => asset.providerContextFactCandidate ? [asset.providerContextFactCandidate] : [])
      ?? []
    expect(contextCandidates).toHaveLength(2)
    expect(contextCandidates.map((fact) => fact.payload.content)).toEqual([
      expect.stringContaining("old task"),
      expect.stringContaining("current task"),
    ])
    expect(contextCandidates.flatMap((fact) => fact.sourceToolCalls)).toEqual([
      expect.objectContaining({ toolCallId: "call-tree-1", deliveryState: "delivered" }),
      expect.objectContaining({ toolCallId: "call-tree-2", deliveryState: "delivered" }),
    ])

    const laterPrompt = buildPrompt(vm, actor, tool)
    const serialized = JSON.stringify(laterPrompt)
    expect(serialized).toContain("call-tree-1")
    expect(serialized).toContain("call-tree-2")
    expect(serialized).toContain("current task")
    expect(serialized).toContain("old task")
  })

  it("confirms the same generic delivery lifecycle in cooperative execution", async () => {
    const tool = makeContextTool("CooperativeMutableProducer")
    const eventBus = new AgentEventGraph()
    let providerTurn = 0
    const actor = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock", provider: "mock", adapter: "openai" },
      callbacks: {
        buildToolset: () => [tool.schema],
        processStream: createMockProcessStream(async () => {
          providerTurn += 1
          return providerTurn === 1
            ? {
                role: "assistant",
                tool_calls: [{
                  id: "call-cooperative",
                  function: {
                    name: "CooperativeMutableProducer",
                    arguments: JSON.stringify({ value: 4 }),
                  },
                }],
              }
            : { role: "assistant", content: "done" }
        }),
      },
    })
    const toolRegistry = new ToolFuncRegistry()
    toolRegistry.register(tool)
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry },
      eventBus,
      outerCtx: { metadata: { sessionId: "provider-projection-cooperative" } },
    })
    activateActorProviderEpoch({
      vm,
      actor,
      sessionId: "provider-projection-cooperative",
      targetProviderId: "mock",
      targetProfileId: "openai-chat@1",
      reason: "initial_projection",
    })
    const fiberId = `${actor.key}:${actor.id}`
    const driver = createAiAgentOrchestratorDriver({
      fibers: [{ fiberId, vm, actor, messages: [], basePriority: 1 }],
      runStep: async (context, helpers) => aiAgentCooperativeStep({
        fiberId: context.fiberId,
        vm: context.vm,
        actor: context.actor,
        messages: context.messages,
        state: context.execState,
        setState: (state) => {
          context.execState = state
        },
        resumeFiber: helpers.resume,
      }),
    })
    actor.send("humanInput", "update state")

    for (let step = 0; step < 80; step += 1) {
      driver.tick(Date.now())
      await flushAsyncWork()
      if (contextSources(vm).some((source) => source.deliveryState === "delivered")) break
    }

    expect(contextSources(vm)).toEqual([
      expect.objectContaining({ toolCallId: "call-cooperative", deliveryState: "delivered" }),
    ])
    const laterPrompt = buildPrompt(vm, actor, tool)
    expect(JSON.stringify(laterPrompt)).toContain("call-cooperative")
    expect(JSON.stringify(laterPrompt)).toContain("full-state:4")
  })
})
