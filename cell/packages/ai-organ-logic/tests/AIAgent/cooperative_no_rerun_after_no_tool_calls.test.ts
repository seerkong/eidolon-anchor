import { describe, expect, it } from "bun:test"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { createAiAgentOrchestratorDriverWithCooperative } from "@cell/ai-organ-logic/OrchestratorDriver"

describe("cooperative no rerun after no_tool_calls", () => {
  it("does not start a second llm turn for the same human input after the first turn settles", async () => {
    let llmCalls = 0
    const adapter = {
      type: "openai" as const,
      async createStream() {
        llmCalls += 1
        async function* stream() {
          yield { ok: true }
        }
        return { stream: stream() }
      },
    }

    const actor = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock-model" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "hello" }),
      },
    })

    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry: new ToolFuncRegistry() },
    })

    const fiberId = `${actor.key}:${actor.id}`
    const messages: any[] = []
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId, vm, actor, messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })

    actor.send("humanInput", "你是谁")
    const now = Date.now()
    driver.resumeFiber(fiberId, now)
    await driver.tickUntilForegroundSettled({ now, maxTicks: 80, maxWallMs: 2000 })

    expect(llmCalls).toBe(1)
    expect(messages.filter((message) => message?.role === "assistant").length).toBe(1)

    await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 80, maxWallMs: 2000 })

    expect(llmCalls).toBe(1)
    expect(messages.filter((message) => message?.role === "assistant").length).toBe(1)
  })
})
