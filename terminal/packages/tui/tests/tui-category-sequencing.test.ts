import { describe, expect, it } from "bun:test"
import type { Event } from "@terminal/core/AIAgent"
import {
  __setRuntimeBridgeFactoryForTest,
  createTuiRuntimeClient,
  shouldDisplayAssistantCategory,
} from "../src/runtime/client/TuiRuntimeClient"

type RuntimeTurnOptions = {
  onChunk?: (chunk: string) => void
  onControl?: (control: { cmd: "NewMessage"; category?: string }) => void
}

type RuntimeHistoryEvent = {
  stream: string
  payload: string
  agentKey: string
  agentActorId: string
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

async function getAssistantTextMessages(sdk: ReturnType<typeof createTuiRuntimeClient>) {
  const messages = await sdk.client.session.messages({ sessionID: "ses_1" })
  return (messages.data ?? [])
    .filter((entry) => entry.info.role === "assistant" && (entry.parts ?? []).some((part) => part.type === "text"))
    .map((entry) => ({
      mode: (entry.info as any).mode,
      text: (entry.parts ?? [])
        .filter((part) => part.type === "text")
        .map((part: any) => part.text ?? "")
        .join(""),
    }))
}

describe("TUI category card sequencing", () => {
  it("keeps hidden categories out of assistant text messages while preserving visible think output", async () => {
    const controls: string[] = []

    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn(_input: string, opts?: RuntimeTurnOptions) {
        controls.push("turn")
        opts?.onControl?.({ cmd: "NewMessage", category: "turn" })
        opts?.onChunk?.("Starting turn 1\n")
        controls.push("think")
        opts?.onControl?.({ cmd: "NewMessage", category: "think" })
        opts?.onChunk?.("Thinking text\n")
        controls.push("toolcall")
        opts?.onControl?.({ cmd: "NewMessage", category: "toolcall" })
        opts?.onChunk?.("RunDetachedBash call_1\n")
        controls.push("result")
        opts?.onControl?.({ cmd: "NewMessage", category: "result" })
        opts?.onChunk?.("RunDetachedBash: {\"task_id\":\"t1\",\"status\":\"running\"}\n")
        controls.push("done")
        opts?.onControl?.({ cmd: "NewMessage", category: "done" })
        opts?.onChunk?.("Turn no_tool_calls\n")
        return "Turn no_tool_calls"
      },
      async abort() {},
      dispose() {},
      subscribeNotifications() {
        return { unsubscribe() {} }
      },
    } as any))

    try {
      const sdk = createTuiRuntimeClient()
      await sdk.client.session.prompt({
        parts: [
          {
            id: "p1",
            sessionID: "ses_1",
            messageID: "m1",
            type: "text",
            text: "trigger categories",
            synthetic: false,
            ignored: false,
          },
        ],
      } as any)

      const visibleCategories = controls.filter((category) => shouldDisplayAssistantCategory(category))
      expect(visibleCategories).toEqual(["think"])

      const assistantTextMessages = await getAssistantTextMessages(sdk)
      expect(unique(assistantTextMessages.map((message) => message.mode))).toEqual(["think"])
      expect(assistantTextMessages.map((message) => message.text).join("\n")).toContain("Thinking text")
      expect(assistantTextMessages.some((message) => message.text.includes("RunDetachedBash"))).toBe(false)
      expect(assistantTextMessages.some((message) => message.text.includes("Turn no_tool_calls"))).toBe(false)
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })

  it("projects toolcall and result categories through structured tool parts instead of assistant text cards", async () => {
    const controls: string[] = []
    let notifyHistory: ((event: RuntimeHistoryEvent) => void) | null = null

    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn(_input: string, opts?: RuntimeTurnOptions) {
        controls.push("think")
        opts?.onControl?.({ cmd: "NewMessage", category: "think" })
        opts?.onChunk?.("Thinking text\n")

        notifyHistory?.({
          stream: "tool_call_start",
          payload: JSON.stringify({
            toolName: "bash",
            toolCallId: "call_1",
            arguments: JSON.stringify({ command: "echo hello" }),
          }),
          agentKey: "build",
          agentActorId: "actor_build",
        })

        controls.push("toolcall")
        opts?.onControl?.({ cmd: "NewMessage", category: "toolcall" })
        opts?.onChunk?.("RunDetachedBash call_1\n")

        notifyHistory?.({
          stream: "tool_call_result",
          payload: JSON.stringify({
            toolName: "bash",
            toolCallId: "call_1",
            result: "hello",
            isError: false,
          }),
          agentKey: "build",
          agentActorId: "actor_build",
        })

        controls.push("result")
        opts?.onControl?.({ cmd: "NewMessage", category: "result" })
        opts?.onChunk?.("RunDetachedBash: {\"status\":\"completed\"}\n")
        return "ok"
      },
      async abort() {},
      dispose() {},
      subscribeNotifications() {
        return { unsubscribe() {} }
      },
      subscribeHistoryEvents(handler: (event: RuntimeHistoryEvent) => void) {
        notifyHistory = handler
        return {
          unsubscribe() {
            notifyHistory = null
          },
        }
      },
    } as any))

    try {
      const sdk = createTuiRuntimeClient()
      const events: Event[] = []
      const unsub = sdk.event.on((event) => events.push(event))
      await sdk.client.session.prompt({
        parts: [
          {
            id: "p1",
            sessionID: "ses_1",
            messageID: "m1",
            type: "text",
            text: "trigger categories",
            synthetic: false,
            ignored: false,
          },
        ],
      } as any)
      unsub()

      const visibleCategories = controls.filter((category) => shouldDisplayAssistantCategory(category))
      expect(visibleCategories).toEqual(["think"])

      const assistantTextMessages = await getAssistantTextMessages(sdk)
      expect(unique(assistantTextMessages.map((message) => message.mode))).toEqual(["think"])
      expect(assistantTextMessages.some((message) => message.text.includes("RunDetachedBash"))).toBe(false)

      const toolParts = events
        .filter((event): event is Event<"message.part.updated"> => event.type === "message.part.updated")
        .map((event) => event.properties.part)
        .filter((part: any) => part.type === "tool")

      expect(toolParts).toHaveLength(2)
      expect(toolParts.at(-1)).toMatchObject({
        tool: "bash",
        callID: "call_1",
        state: {
          status: "completed",
          input: {
            command: "echo hello",
          },
          output: "hello",
        },
      })
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })
})
