import { describe, expect, it } from "bun:test"
import { createActor, createVM } from "@cell/ai-core-logic"

import {
  classifyAiSnapshotBlockingMailboxes,
  evaluateAiAgentRuntimeSnapshotSafepoint,
} from "../src"

function createInspectedRuntime(params: {
  actor: ReturnType<typeof createActor>
  fiberId?: string
  status?: string
  execState?: Record<string, unknown>
}) {
  const fiberId = params.fiberId ?? `${params.actor.key}:${params.actor.id}`
  return {
    fibers: {
      [fiberId]: {
        actor: params.actor,
        actorKey: params.actor.key,
        actorId: params.actor.id,
        execState: params.execState,
      },
    },
    state: {
      fibers: {
        [fiberId]: {
          status: params.status ?? "ready",
        },
      },
    },
  }
}

describe("AI runtime snapshot safepoint", () => {
  it("classifies matching asyncCompletion as mandatory completion", () => {
    const actor = createActor({ key: "main", id: "actor-main" })
    actor.send("asyncCompletion", { opId: "llm:main:1", kind: "llm_done" } as any)

    const result = classifyAiSnapshotBlockingMailboxes(actor, {
      phase: "wait_llm",
      inflight: { kind: "llm", opId: "llm:main:1" },
    })

    expect(result).toEqual([
      {
        mailboxKind: "asyncCompletion",
        workClass: "mandatory_completion",
        reason: "pending_mailbox_work",
      },
    ])
  })

  it("classifies childDone sync_wait as mandatory completion", () => {
    const actor = createActor({ key: "main", id: "actor-main" })
    actor.send("childDone", { mode: "sync_wait", childFiberId: "child" } as any)

    expect(classifyAiSnapshotBlockingMailboxes(actor, { phase: "drain" })).toEqual([
      {
        mailboxKind: "childDone",
        workClass: "mandatory_completion",
        reason: "pending_mailbox_work",
      },
    ])
  })

  it("blocks snapshot for undrained recoverable wake inputs", () => {
    const actor = createActor({ key: "main", id: "actor-main" })
    actor.send("humanInput", "continue")
    actor.send("memberChatInbox", { text: "hello" } as any)
    actor.send("heartbeat", { scheduleId: "hb-1" } as any)

    expect(classifyAiSnapshotBlockingMailboxes(actor, { phase: "drain" })).toEqual([
      {
        mailboxKind: "humanInput",
        workClass: "recoverable_input",
        reason: "pending_mailbox_work",
      },
      {
        mailboxKind: "memberChatInbox",
        workClass: "low_priority_continuation",
        reason: "pending_mailbox_work",
      },
      {
        mailboxKind: "heartbeat",
        workClass: "timer_wake",
        reason: "pending_mailbox_work",
      },
    ])
  })

  it("detects start_tool without durable tool proof as non-safepoint", () => {
    const actor = createActor({
      key: "main",
      id: "actor-main",
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "bash", input: { command: "pwd" } }],
        },
      ] as any[],
    })
    const vm = createVM({ controlActorKey: "main", actors: { main: actor } })

    const result = evaluateAiAgentRuntimeSnapshotSafepoint({
      vm,
      inspected: createInspectedRuntime({
        actor,
        execState: {
          phase: "start_tool",
          toolCalls: [{ id: "call-1", name: "bash", input: { command: "pwd" } }],
          toolIndex: 0,
        },
      }),
    })

    expect(result.safe).toBe(false)
    expect(result.blockers).toEqual([
      expect.objectContaining({
        reason: "mandatory_continuation",
        phase: "start_tool",
        workClass: "mandatory_completion",
      }),
    ])
    expect(JSON.stringify(result.blockers)).not.toContain("pwd")
  })
})
