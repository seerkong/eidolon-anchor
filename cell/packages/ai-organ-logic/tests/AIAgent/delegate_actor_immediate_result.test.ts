import { describe, expect, it } from "bun:test"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer"
import { spawnChildExecutionActor } from "@cell/ai-organ-logic/agent/DelegateActor"
import { appendLiveHistoryMessageToConversationDomainRuntime } from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime"

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
})
