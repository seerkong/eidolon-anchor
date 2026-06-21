import { describe, expect, it } from "bun:test"

import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { createAiAgentOrchestratorDriverWithCooperative } from "@cell/ai-organ-logic/OrchestratorDriver"
import { createMockProcessStream } from "./__test_support__/mockProcessStream"

function makeMockAdapter() {
  return {
    type: "openai" as const,
    async createStream() {
      async function* stream() {
        yield { ok: true }
      }
      return { stream: stream() }
    },
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

describe("detached delegate observability", () => {
  it("captures assistant messages and tool events for detached RunDelegateActor tasks", async () => {
    const adapter = makeMockAdapter()
    const callCount: Record<string, number> = {}
    const processStream = async (_vm: any, actor: any) => {
      const key = String(actor.key)
      callCount[key] = (callCount[key] ?? 0) + 1
      const n = callCount[key]

      if (actor.type === "delegate" || actor.type === "detached") {
        if (n === 1) {
          return {
            role: "assistant",
            content: "child is using a tool",
            tool_calls: [
              {
                id: "tc-child-1",
                function: {
                  name: "list_city_major_atractions",
                  arguments: JSON.stringify({ city: "Tokyo" }),
                },
              },
            ],
          }
        }
        return { role: "assistant", content: "child final answer" }
      }

      if (n === 1) {
        return {
          role: "assistant",
          tool_calls: [
            {
              id: "tc-detached-delegate",
              function: {
                name: "RunDelegateActor",
                arguments: JSON.stringify({
                  description: "observe child",
                  prompt: "do child work",
                  agent_type: "code",
                  mode: "detached",
                }),
              },
            },
          ],
        }
      }

      return { role: "assistant", content: "parent idle" }
    }

    const main = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: createMockProcessStream(async (vm, actor) => processStream(vm, actor)),
      },
    })

    const toolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main },
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({
          code: {
            name: "code",
            description: "test agent",
            tools: "*",
            prompt: ["you are a test delegate actor"],
          },
        } as any),
      },
    })

    const messages: any[] = [{ role: "user", content: "hi" }]
    const mainFiberId = `${main.key}:${main.id}`
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: mainFiberId, vm, actor: main, messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })

    const now = Date.now()
    driver.resumeFiber(mainFiberId, now)
    await driver.tickUntilForegroundSettled({ now, maxTicks: 50, maxWallMs: 2000 })
    await flushMicrotasks()

    const toolMsg = main.messages.find((m: any) => m?.role === "tool" && (m?.tool_call_id ?? m?.toolCallId) === "tc-detached-delegate")
    const started = JSON.parse(String(toolMsg?.content ?? ""))
    expect(typeof started.task_id).toBe("string")

    await driver.tickUntilBackgroundSettled({ now: Date.now(), maxTicks: 100, maxWallMs: 2000 })
    await flushMicrotasks()

    const assistantMessages = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "DetachedActorMessages", vm, main, {
      task_id: started.task_id,
      roles: ["assistant"],
    })))
    expect(assistantMessages.entries.map((entry: any) => entry.text)).toContain("child is using a tool")

    const toolEvents = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "DetachedActorMessages", vm, main, {
      task_id: started.task_id,
      kinds: ["tool_call", "tool_result"],
    })))
    expect(toolEvents.entries.map((entry: any) => entry.kind)).toEqual(["tool_call", "tool_result"])
    expect(toolEvents.entries[0]).toMatchObject({
      tool_name: "list_city_major_atractions",
      tool_call_id: "tc-child-1",
    })

    const result = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "DetachedActorResult", vm, main, {
      task_id: started.task_id,
      include_messages: true,
    })))
    expect(result.status).toBe("completed")
    expect(result.output_text).toBe("child final answer")
    expect(result.messages.entries.some((entry: any) => entry.text === "child final answer")).toBe(true)
    expect(result.messages.entries).toContainEqual(expect.objectContaining({
      role: "system_event",
      kind: "status",
      text: "child final answer",
    }))
  })
})
