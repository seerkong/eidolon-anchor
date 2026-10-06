import { expect, test } from "bun:test"
import { AgentEventGraph, createActor, createVM } from "@cell/ai-core-logic"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { createAiAgentOrchestratorDriverWithCooperative } from "@cell/ai-organ-logic/OrchestratorDriver"
import { createAiAgentRuntimeCoordinator } from "@cell/ai-organ-logic/runtime/AiAgentRuntimeCoordinator"
import { createInteractiveActor } from "@cell/ai-organ-logic/runtime/InteractiveActor"
import { processRuntimeIngressStream } from "@cell/ai-organ-logic/runtime/ShellRuntimeSupport"
import { createMockProviderCacheCostObservation } from "../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream"
import { projectInputContentText } from "@shared/composer"

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function until(predicate: () => boolean) { const deadline = Date.now() + 3000; while (!predicate() && Date.now() < deadline) await Bun.sleep(2); expect(predicate()).toBe(true) }

test("two real interactive fibers interleave provider and leaf tools without duplicate or cross-actor history", async () => {
  const eventBus = new AgentEventGraph(), registry = new ToolFuncRegistry()
  const providers = { A: gate(), B: gate() }, tools = { A: gate(), B: gate() }
  const enteredProviders = new Set<string>(), enteredTools = new Set<string>()
  const events: Array<{ actorId: string; kind: string }> = []
  eventBus.addConsumer(event => events.push({ actorId: event.actor.actor_id, kind: event.event_type }))
  const tool = { schema: { type: "function" as const, function: { name: "Barrier", description: "independent leaf barrier", parameters: { type: "object", properties: { label: { type: "string" } } } } },
    briefPromptXnl: "<tool name=\"Barrier\" />", resourceEffect: "read_only" as const,
    run: async (_runtime: unknown, input: { label: "A" | "B" }) => { enteredTools.add(input.label); await tools[input.label].promise; return `tool-result-${input.label}` } }
  registry.register(tool)
  const provider = { type: "openai", runtime: { adapterName: "openai", providerId: "tools-test" },
    async createStream(options: any) {
      const label = projectInputContentText(options.messages.find((message: any) => message.role === "user").content) as "A" | "B"
      const done = options.messages.some((message: any) => message.role === "tool")
      async function* stream() {
        if (!done) {
          enteredProviders.add(label); await providers[label].promise
          yield { choices: [{ delta: { content: `planning-${label}` } }] }
          yield { choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${label}`, type: "function", function: { name: "Barrier", arguments: JSON.stringify({ label }) } }] } }] }
          yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
        } else {
          yield { choices: [{ delta: { content: `finished-${label}` } }] }
          yield { choices: [{ delta: {}, finish_reason: "stop" }] }
        }
      }
      return { stream: stream(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
    } }
  const main = createActor({ key: "main" })
  const vm = createVM({ controlActorKey: main.key, actors: { main }, eventBus, registries: { toolRegistry: registry },
    options: { storage: { files: false, logs: false } }, outerCtx: { metadata: { sessionId: "tools" } } })
  const driver = createAiAgentOrchestratorDriverWithCooperative({ fibers: [] })
  const coordinator = createAiAgentRuntimeCoordinator({ vm, driver })
  const callbacks = { buildToolset: () => [tool.schema], processStream: (_vm: any, actor: any, stream: any, options: any) => processRuntimeIngressStream({
    stream, adapterType: "openai", eventBus, actorMeta: { agentKey: actor.key, agentActorId: actor.id }, storageLogsEnabled: false, signal: options?.signal,
  }) }
  const actors = (["A", "B"] as const).map(label => createInteractiveActor({ vm, driver, now: Date.now, newId: () => label }, {
    llmClient: provider, modelConfig: { model: "controlled", adapter: "openai", provider: "tools-test" }, callbacks,
  }))
  try {
    const turns = actors.map(target => coordinator.admitInteractiveTurn({ actorId: target.actor.id, mainFiberId: target.fiberId, turnId: `turn-${target.actor.id}`,
      deliver: () => { driver.emitFiberSignal({ fiberId: target.fiberId, signalKind: "mailbox_enqueue", mailbox: { kind: "humanInput", payload: target.actor.id }, idempotencyKey: target.actor.id }) } }))
    await until(() => enteredProviders.size === 2)
    providers.A.resolve(); providers.B.resolve()
    await until(() => enteredTools.size === 2)
    expect(enteredTools).toEqual(new Set(["A", "B"]))
    tools.A.resolve()
    expect((await turns[0]!.settled).status).toBe("settled")
    expect(coordinator.readInteractiveTurns().find(turn => turn.actorId === "B")?.state).toBe("running")
    tools.B.resolve(); await turns[1]!.settled
    for (const target of actors) {
      const label = target.actor.id
      const messages = target.actor.messages
      const calls = messages.filter(message => message.role === "assistant" && message.toolCalls?.some(call => call.id === `call-${label}`))
      expect(calls).toHaveLength(1)
      expect(messages.filter(message => message.role === "tool")).toHaveLength(1)
      expect(messages.filter(message => message.role === "assistant").map(message => projectInputContentText(message.content))).toEqual([`planning-${label}`, `finished-${label}`])
      expect(JSON.stringify(messages)).not.toContain(`tool-result-${label === "A" ? "B" : "A"}`)
      expect(events.filter(event => event.actorId === label && event.kind === "semantic_tool_call_start")).toHaveLength(1)
    }
  } finally {
    for (const item of [...Object.values(providers), ...Object.values(tools)]) item.resolve()
    await coordinator.shutdown(); coordinator.dispose(); eventBus.dispose()
  }
})
