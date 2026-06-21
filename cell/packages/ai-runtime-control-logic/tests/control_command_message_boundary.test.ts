import { describe, expect, it } from "bun:test"

import {
  AI_RUNTIME_CONTROL_BOUNDARY_DECLARATIONS,
  createAiRuntimeControlBoundaryRegistry,
} from "@cell/ai-core-contract"
import {
  AI_AGENT_WAKE_MAILBOXES,
  createActor,
  listPendingAiAgentWakeMailboxes,
} from "@cell/ai-core-logic/runtime/actor"
import {
  createAiRuntimeControlState,
  enqueueAiRuntimeControlCommand,
  selectNextAiRuntimeControlCommand,
} from "../src"

/**
 * Conformance for the sync-command / async-message boundary (spec cases
 * sync-reducer-input-is-command, cross-actor-unblock-is-message, and
 * boundary-classification-is-declared).
 */

describe("conformance: sync reducer input is a command", () => {
  it("control state advances only through the public reducer and never mutates the input state", () => {
    const initial = createAiRuntimeControlState()
    const advanced = enqueueAiRuntimeControlCommand(initial, {
      kind: "effect_request",
      commandId: "cmd-1",
      effectId: "effect-1",
      handlerKey: "handler",
    })

    expect(advanced).not.toBe(initial)
    expect(initial.commands.deques.normal.items).toEqual([])
    expect(advanced.commands.deques.normal.items.length).toBe(1)
  })

  it("enqueue is pure dispatch intent: nothing executes until a step runs", () => {
    const state = enqueueAiRuntimeControlCommand(createAiRuntimeControlState(), {
      kind: "effect_request",
      commandId: "cmd-1",
      effectId: "effect-1",
      handlerKey: "handler",
    })
    expect(state.runtime.persistence.effects).toEqual({})
  })

  it("command selection honors the declared queue priorities (effect results preempt normal work)", () => {
    let state = createAiRuntimeControlState({
      effects: {
        "effect-0": {
          effectId: "effect-0",
          status: "requested",
          requestSeen: true,
          resultSeen: false,
        },
      },
    })
    state = enqueueAiRuntimeControlCommand(state, {
      kind: "effect_request",
      commandId: "cmd-normal",
      effectId: "effect-1",
      handlerKey: "handler",
    })
    state = enqueueAiRuntimeControlCommand(state, {
      kind: "effect_result",
      commandId: "cmd-result",
      effectId: "effect-0",
      resultId: "result-0",
    })

    expect(selectNextAiRuntimeControlCommand(state)?.commandId).toBe("cmd-result")
  })
})

describe("conformance: cross-actor unblock is a message", () => {
  it("unblock-capable signals (tool result, childDone, human input) enter through actor mailboxes", () => {
    const actor = createActor({ key: "main", id: "actor-main" })

    actor.send("toolResult", { toolCallId: "call-1" } as never)
    actor.send("childDone", { mode: "sync_wait", childFiberId: "child" } as never)
    actor.send("humanInput", { text: "go on" } as never)

    expect(actor.hasPending("toolResult")).toBe(true)
    expect(actor.hasPending("childDone")).toBe(true)
    expect(actor.hasPending("humanInput")).toBe(true)
    expect(listPendingAiAgentWakeMailboxes(actor)).toEqual(["toolResult", "childDone", "humanInput"])
  })

  it("the wake channel set is exactly the actor mailbox set — no side channel exists", () => {
    expect(AI_AGENT_WAKE_MAILBOXES).toEqual([
      "control",
      "toolResult",
      "asyncCompletion",
      "childDone",
      "memberCoordination",
      "humanInput",
      "memberChatInbox",
      "heartbeat",
    ])
  })

  it("mailbox delivery is queued, not executed: draining returns payloads in order without side effects", () => {
    const actor = createActor({ key: "main", id: "actor-main" })
    actor.send("toolResult", { toolCallId: "first" } as never)
    actor.send("toolResult", { toolCallId: "second" } as never)

    const drained = actor.drainMailbox("toolResult") as Array<{ toolCallId: string }>
    expect(drained.map((entry) => entry.toolCallId)).toEqual(["first", "second"])
    expect(actor.hasPending("toolResult")).toBe(false)
  })
})

describe("conformance: every control entry is classified on the boundary", () => {
  const registry = createAiRuntimeControlBoundaryRegistry()

  it("every declared entry resolves to sync_command or async_message", () => {
    for (const declaration of AI_RUNTIME_CONTROL_BOUNDARY_DECLARATIONS) {
      for (const entry of declaration.entries) {
        const kind = registry.classifyEntry(declaration.id, entry.entryId)
        expect(["sync_command", "async_message"]).toContain(kind)
      }
    }
  })

  it("every cluster declares both boundary kinds", () => {
    for (const declaration of AI_RUNTIME_CONTROL_BOUNDARY_DECLARATIONS) {
      const kinds = new Set(declaration.entries.map((entry) => entry.kind))
      expect(kinds.has("sync_command")).toBe(true)
      expect(kinds.has("async_message")).toBe(true)
    }
  })
})
