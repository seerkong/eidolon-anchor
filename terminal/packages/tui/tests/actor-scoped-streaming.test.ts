import { describe, expect, it } from "bun:test"
import { AgentEventGraph } from "@cell/ai-core-logic"
import { SemanticTerminalRuntimeBridge } from "@terminal/organ"

describe("actor-scoped TUI streaming", () => {
  it("forwards only the selected actor's semantic events into the visible TUI stream", () => {
    const eventBus = new AgentEventGraph()
    const tuiGraph = new SemanticTerminalRuntimeBridge()

    const main = { key: "main", id: "a1" }
    const detached = { key: "main:code:detached", id: "a2" }

    const messages: string[] = []
    const sub = tuiGraph.onTuiEvent((event) => {
      if (event.kind === "message") messages.push(String(event.payload))
    })
    const scoped = eventBus.addConsumer((event) => {
      if (event.actor.actor_name !== main.key || event.actor.actor_id !== main.id) {
        return
      }
      tuiGraph.consumeSemanticEvent(event)
    })

    eventBus.emitThinkStart(main)
    eventBus.emitThinkDelta(main, "main thinking")
    eventBus.emitThinkEnd(main)

    eventBus.emitThinkStart(detached)
    eventBus.emitThinkDelta(detached, "detached thinking")
    eventBus.emitThinkEnd(detached)

    eventBus.emitContentStart(main)
    eventBus.emitContentDelta(main, "main answer")
    eventBus.emitContentEnd(main)

    eventBus.emitContentStart(detached)
    eventBus.emitContentDelta(detached, "detached answer")
    eventBus.emitContentEnd(detached)

    expect(messages.join(" ")).toContain("main thinking")
    expect(messages.join(" ")).toContain("main answer")
    expect(messages.join(" ")).not.toContain("detached thinking")
    expect(messages.join(" ")).not.toContain("detached answer")

    scoped.unsubscribe()
    sub.unsubscribe()
    tuiGraph.dispose()
    eventBus.dispose()
  })
})
