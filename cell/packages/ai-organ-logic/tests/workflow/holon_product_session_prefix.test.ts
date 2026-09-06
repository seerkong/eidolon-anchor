import { expect, it } from "bun:test"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { appendLiveHistoryMessageToConversationDomainRuntime, getConversationActorRawStateFromVm } from "../../src/conversation/ConversationDomainRuntime"
import { buildProviderPromptForActorTurn } from "../../src/exec/AiAgentExecutor"
import { createHolonProductProviderTransport, readHolonProductProviderMessage } from "./fixtures/holonProductProviderTransport"

for (const metadata of [{ sessionDir: "/fixture/session-from-dir" }, { sessionDir: "/fixture/session-from-dir", sessionId: " explicit-session " }, {}]) {
  it(`preserves MessagePrefix on the real wire with Conversation-owned session identity ${JSON.stringify(metadata)}`, async () => {
    const expectedSession = "sessionId" in metadata ? "explicit-session" : "sessionDir" in metadata ? "session-from-dir" : "__unsessioned__"
    const transport = createHolonProductProviderTransport({ sessionId: expectedSession, respond: () => "ok" })
    try {
      const actor = createActor({ key: "worker", id: "worker-identity", systemPrompts: ["Frozen order recipe"], llmClient: transport.adapter })
      const vm = createVM({ controlActorKey: actor.key, actors: { [actor.key]: actor }, outerCtx: { metadata } })
      appendLiveHistoryMessageToConversationDomainRuntime({ vm, actorKey: actor.key, actorId: actor.id, message: { role: "user", content: "order-a" } })
      const prompt = buildProviderPromptForActorTurn({ vm, actor, tools: [], llmAdapter: transport.adapter, model: "deepseek-chat" })
      expect(prompt.promptPlan.systemPrompts).toContain("Frozen order recipe")
      expect(prompt.promptPlan.sessionId).toBe(expectedSession)
      expect(prompt.providerMessages.some(message => message.role === "system" && message.content === "Frozen order recipe")).toBe(true)
      expect(getConversationActorRawStateFromVm({ vm, actorKey: actor.key })?.promptHeadGenerationId).toBe(prompt.promptGenerationId)
      const response = await transport.adapter.createStream({ model: "deepseek-chat", messages: prompt.providerMessages, tools: [] })
      expect((await readHolonProductProviderMessage(response.stream)).content).toBe("ok")
      await response.providerOutput
      expect(transport.requests[0]!.body.messages.some(message => message.role === "system" && message.content === "Frozen order recipe")).toBe(true)
      const estimate = buildProviderPromptForActorTurn({ vm, actor, tools: [], llmAdapter: transport.adapter, model: "deepseek-chat", recordPromptPlan: false })
      expect(estimate.promptPlan.sessionId).toBe(expectedSession)
      expect(estimate.providerMessages).toEqual(prompt.providerMessages)
    } finally { await transport.close() }
  })
}
