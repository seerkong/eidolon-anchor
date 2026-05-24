import { describe, expect, it } from "bun:test"
import type { Event } from "@terminal/core/AIAgent"
import { __setRuntimeBridgeFactoryForTest, createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"

type MessageUpdatedEvent = Event<"message.updated", { info: { id: string; role: string } }>
type MessagePartUpdatedEvent = Event<"message.part.updated", { part: { type: string; text?: string } }>

type RuntimeTurnOptions = {
  onChunk?: (chunk: string) => void
  onControl?: (control: { cmd: "NewMessage" }) => void
}

type RuntimeHistoryEvent = {
  stream: string
  payload: string
  agentKey: string
  agentActorId: string
}

describe("mock runtime client new-message card split", () => {
  it("creates a new assistant message card on NewMessage control event", async () => {
    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn(_input: string, opts?: RuntimeTurnOptions) {
        opts?.onChunk?.("第一段")
        opts?.onControl?.({ cmd: "NewMessage" })
        opts?.onChunk?.("第二段")
        return "第一段第二段"
      },
      async abort() {},
      dispose() {},
      subscribeNotifications() {
        return { unsubscribe() {} }
      },
    }))

    try {
      const runtimeClient = createTuiRuntimeClient()
      const events: Event[] = []
      const unsub = runtimeClient.event.on((event) => events.push(event))

      await runtimeClient.client.session.prompt({
        parts: [
          {
            id: "p1",
            sessionID: "ses_1",
            messageID: "msg_1",
            type: "text",
            text: "触发 new message",
            synthetic: false,
            ignored: false,
          },
        ],
      })

      unsub()

      const assistantUpdates = events
        .filter((event) => event.type === "message.updated")
        .map((event) => (event as MessageUpdatedEvent).properties.info)
        .filter((message) => message.role === "assistant")

      const uniqueAssistantMessageIds = new Set(assistantUpdates.map((message) => message.id))
      expect(uniqueAssistantMessageIds.size).toBe(2)
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })

  it("creates a new assistant message card for asynchronous runtime notifications", async () => {
    let notify: ((payload: { text: string; category?: string }) => void) | null = null

    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn() {
        return "ok"
      },
      async abort() {},
      dispose() {},
      subscribeNotifications(handler: (payload: { text: string; category?: string }) => void) {
        notify = handler
        return { unsubscribe() { notify = null } }
      },
    } as any))

    try {
      const runtimeClient = createTuiRuntimeClient()
      const events: Event[] = []
      const unsub = runtimeClient.event.on((event) => events.push(event))

      await runtimeClient.client.session.prompt({
        parts: [
          {
            id: "p1",
            sessionID: "ses_1",
            messageID: "msg_1",
            type: "text",
            text: "触发异步通知",
            synthetic: false,
            ignored: false,
          },
        ],
      })

      const runtimeNotification = notify
      if (typeof runtimeNotification === "function") {
        ;(runtimeNotification as (payload: { text: string; category?: string }) => void)({
          text: "Member Alice finished:\nsummary",
          category: "assist",
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
      unsub()

      const partUpdates = events
        .filter((event) => event.type === "message.part.updated")
        .map((event) => (event as MessagePartUpdatedEvent).properties.part)

      expect(
        partUpdates.some((part) => part.type === "text" && typeof part.text === "string" && part.text.includes("Member Alice finished")),
      ).toBe(true)
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })

  it("projects runtime tool history into structured tool parts instead of toolcall text", async () => {
    let notifyHistory: ((event: RuntimeHistoryEvent) => void) | null = null

    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn(_input: string, opts?: RuntimeTurnOptions) {
        opts?.onControl?.({ cmd: "NewMessage", category: "assist" } as any)
        opts?.onChunk?.("准备查看文件。")
        notifyHistory?.({
          stream: "tool_call_start",
          payload: JSON.stringify({
            toolName: "bash",
            toolCallId: "call_1",
            arguments: JSON.stringify({ command: "tail -6 ~/tmp/demo3/AGENTS.md | cat -n" }),
          }),
          agentKey: "build",
          agentActorId: "actor_build",
        })
        opts?.onControl?.({ cmd: "NewMessage", category: "toolcall" } as any)
        opts?.onChunk?.('bash\n{"command":"tail -6 ~/tmp/demo3/AGENTS.md | cat -n"}\n')
        notifyHistory?.({
          stream: "tool_call_result",
          payload: JSON.stringify({
            toolName: "bash",
            toolCallId: "call_1",
            result: "1 hello",
            isError: false,
          }),
          agentKey: "build",
          agentActorId: "actor_build",
        })
        opts?.onControl?.({ cmd: "NewMessage", category: "assist" } as any)
        opts?.onChunk?.("已读取完成。")
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
      const runtimeClient = createTuiRuntimeClient()
      await runtimeClient.client.session.prompt({
        parts: [
          {
            id: "p1",
            sessionID: "ses_1",
            messageID: "msg_1",
            type: "text",
            text: "查看 AGENTS.md",
            synthetic: false,
            ignored: false,
          },
        ],
      })

      const messages = await runtimeClient.client.session.messages({ sessionID: "ses_1" })
      const parts = (messages.data ?? []).flatMap((message) => message.parts ?? [])
      const textParts = parts.filter((part) => part.type === "text")
      const toolParts = parts.filter((part) => part.type === "tool")

      expect(toolParts).toHaveLength(1)
      expect(toolParts[0]).toMatchObject({
        tool: "bash",
        callID: "call_1",
        state: {
          status: "completed",
          input: {
            command: "tail -6 ~/tmp/demo3/AGENTS.md | cat -n",
          },
          output: "1 hello",
        },
      })
      expect(
        textParts.some(
          (part) => typeof part.text === "string" && part.text.includes('bash\n{"command":"tail -6 ~/tmp/demo3/AGENTS.md | cat -n"}'),
        ),
      ).toBe(false)
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })

  it("derives research card metadata from runtime tool results when bridge metadata is absent", async () => {
    let notifyHistory: ((event: RuntimeHistoryEvent) => void) | null = null

    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn() {
        notifyHistory?.({
          stream: "tool_call_start",
          payload: JSON.stringify({
            toolName: "websearch",
            toolCallId: "call_search",
            arguments: JSON.stringify({ query: "latest bun release" }),
          }),
          agentKey: "build",
          agentActorId: "actor_build",
        })
        notifyHistory?.({
          stream: "tool_call_result",
          payload: JSON.stringify({
            toolName: "websearch",
            toolCallId: "call_search",
            result: JSON.stringify({
              results: [{ title: "a" }, { title: "b" }, { title: "c" }],
            }),
            isError: false,
          }),
          agentKey: "build",
          agentActorId: "actor_build",
        })
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
      const runtimeClient = createTuiRuntimeClient()
      await runtimeClient.client.session.prompt({
        parts: [
          {
            id: "p1",
            sessionID: "ses_1",
            messageID: "msg_1",
            type: "text",
            text: "帮我搜一下",
            synthetic: false,
            ignored: false,
          },
        ],
      })

      const messages = await runtimeClient.client.session.messages({ sessionID: "ses_1" })
      const toolPart = (messages.data ?? [])
        .flatMap((message) => message.parts ?? [])
        .find((part) => part.type === "tool" && (part as any).tool === "websearch") as any

      expect(toolPart).toBeDefined()
      expect(toolPart.state.metadata).toMatchObject({
        output: expect.any(String),
        numResults: 3,
      })
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })

  it("derives edit diff metadata from structured runtime tool results", async () => {
    let notifyHistory: ((event: RuntimeHistoryEvent) => void) | null = null

    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn() {
        notifyHistory?.({
          stream: "tool_call_start",
          payload: JSON.stringify({
            toolName: "edit",
            toolCallId: "call_edit",
            arguments: JSON.stringify({
              filePath: "~/tmp/demo3/AGENTS.md",
              oldString: "旧内容",
              newString: "新内容",
            }),
          }),
          agentKey: "build",
          agentActorId: "actor_build",
        })
        notifyHistory?.({
          stream: "tool_call_result",
          payload: JSON.stringify({
            toolName: "edit",
            toolCallId: "call_edit",
            result: JSON.stringify({
              message: "Edited ~/tmp/demo3/AGENTS.md",
              diff: [
                "--- ~/tmp/demo3/AGENTS.md",
                "+++ ~/tmp/demo3/AGENTS.md",
                "@@ -1 +1 @@",
                "-旧内容",
                "+新内容",
              ].join("\n"),
            }),
            isError: false,
          }),
          agentKey: "build",
          agentActorId: "actor_build",
        })
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
      const runtimeClient = createTuiRuntimeClient()
      await runtimeClient.client.session.prompt({
        parts: [
          {
            id: "p1",
            sessionID: "ses_1",
            messageID: "msg_1",
            type: "text",
            text: "改一下 AGENTS.md",
            synthetic: false,
            ignored: false,
          },
        ],
      })

      const messages = await runtimeClient.client.session.messages({ sessionID: "ses_1" })
      const toolPart = (messages.data ?? [])
        .flatMap((message) => message.parts ?? [])
        .find((part) => part.type === "tool" && (part as any).tool === "edit") as any

      expect(toolPart).toBeDefined()
      expect(toolPart.state.metadata).toMatchObject({
        output: "Edited ~/tmp/demo3/AGENTS.md",
        diff: expect.stringContaining("@@ -1 +1 @@"),
      })
      expect(toolPart.state.output).toBeString()
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })

  it("keeps structured edit error metadata visible for tool cards", async () => {
    let notifyHistory: ((event: RuntimeHistoryEvent) => void) | null = null

    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn() {
        notifyHistory?.({
          stream: "tool_call_start",
          payload: JSON.stringify({
            toolName: "edit",
            toolCallId: "call_edit_error",
            arguments: JSON.stringify({
              filePath: "~/tmp/demo5/notes.txt",
              oldString: "missing",
              newString: "replacement",
            }),
          }),
          agentKey: "build",
          agentActorId: "actor_build",
        })
        notifyHistory?.({
          stream: "tool_call_result",
          payload: JSON.stringify({
            toolName: "edit",
            toolCallId: "call_edit_error",
            result: JSON.stringify({
              message: "Text not found in ~/tmp/demo5/notes.txt: oldString not found exactly in file content",
              filePath: "~/tmp/demo5/notes.txt",
              error: "not_found",
              detail: "oldString not found exactly in file content",
              suggestions: [
                "Read the file again and copy the exact oldString snippet, including whitespace and surrounding punctuation.",
                "If the change spans multiple lines or nearby hunks, switch to apply_patch instead of retrying edit.",
              ],
            }),
            isError: true,
          }),
          agentKey: "build",
          agentActorId: "actor_build",
        })
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
      const runtimeClient = createTuiRuntimeClient()
      await runtimeClient.client.session.prompt({
        parts: [
          {
            id: "p1",
            sessionID: "ses_1",
            messageID: "msg_1",
            type: "text",
            text: "改一下 notes.txt",
            synthetic: false,
            ignored: false,
          },
        ],
      })

      const messages = await runtimeClient.client.session.messages({ sessionID: "ses_1" })
      const toolPart = (messages.data ?? [])
        .flatMap((message) => message.parts ?? [])
        .find((part) => part.type === "tool" && (part as any).tool === "edit") as any

      expect(toolPart).toBeDefined()
      expect(toolPart.state.metadata).toMatchObject({
        output: "Text not found in ~/tmp/demo5/notes.txt: oldString not found exactly in file content",
        filePath: "~/tmp/demo5/notes.txt",
      })
      expect(toolPart.state.output).toBeString()
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })

  it("keeps structured apply_patch failure metadata visible for patch cards", async () => {
    let notifyHistory: ((event: RuntimeHistoryEvent) => void) | null = null

    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn() {
        notifyHistory?.({
          stream: "tool_call_start",
          payload: JSON.stringify({
            toolName: "apply_patch",
            toolCallId: "call_patch_error",
            arguments: JSON.stringify({
              patchText: "*** Begin Patch\n*** Update File: demo.txt\n@@\n-missing\n+after\n*** End Patch\n",
            }),
          }),
          agentKey: "build",
          agentActorId: "actor_build",
        })
        notifyHistory?.({
          stream: "tool_call_result",
          payload: JSON.stringify({
            toolName: "apply_patch",
            toolCallId: "call_patch_error",
            result: JSON.stringify({
              message: "Patch could not be applied to demo.txt: update hunk not found in demo.txt",
              filePath: "demo.txt",
              error: "patch_failed",
              detail: "update hunk not found in demo.txt",
              suggestions: [
                "Read the target file again and copy the exact current hunk, including unchanged context lines.",
                "Reduce the patch to a smaller single-hunk change after confirming the current file contents.",
                "If the file changed since the patch was drafted, rebuild the patch from a fresh read before retrying.",
              ],
            }),
            isError: true,
          }),
          agentKey: "build",
          agentActorId: "actor_build",
        })
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
      const runtimeClient = createTuiRuntimeClient()
      await runtimeClient.client.session.prompt({
        parts: [
          {
            id: "p1",
            sessionID: "ses_1",
            messageID: "msg_1",
            type: "text",
            text: "打 patch",
            synthetic: false,
            ignored: false,
          },
        ],
      })

      const messages = await runtimeClient.client.session.messages({ sessionID: "ses_1" })
      const toolPart = (messages.data ?? [])
        .flatMap((message) => message.parts ?? [])
        .find((part) => part.type === "tool" && (part as any).tool === "apply_patch") as any

      expect(toolPart).toBeDefined()
      expect(toolPart.state.metadata).toMatchObject({
        output: "Patch could not be applied to demo.txt: update hunk not found in demo.txt",
        filePath: "demo.txt",
      })
      expect(toolPart.state.output).toBeString()
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })

  it("derives multiedit/apply_patch diff metadata from structured runtime tool results", async () => {
    let notifyHistory: ((event: RuntimeHistoryEvent) => void) | null = null

    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn() {
        notifyHistory?.({
          stream: "tool_call_start",
          payload: JSON.stringify({
            toolName: "multiedit",
            toolCallId: "call_multiedit",
            arguments: JSON.stringify({
              filePath: "~/tmp/demo4/demo.txt",
              edits: [{ oldString: "before", newString: "after" }],
            }),
          }),
          agentKey: "build",
          agentActorId: "actor_build",
        })
        notifyHistory?.({
          stream: "tool_call_result",
          payload: JSON.stringify({
            toolName: "multiedit",
            toolCallId: "call_multiedit",
            result: JSON.stringify({
              message: "Edited ~/tmp/demo4/demo.txt (2 edits)",
              filePath: "~/tmp/demo4/demo.txt",
              diff: ["--- ~/tmp/demo4/demo.txt", "+++ ~/tmp/demo4/demo.txt", "@@ -1 +1 @@", "-before", "+after"].join("\n"),
            }),
            isError: false,
          }),
          agentKey: "build",
          agentActorId: "actor_build",
        })
        notifyHistory?.({
          stream: "tool_call_start",
          payload: JSON.stringify({
            toolName: "apply_patch",
            toolCallId: "call_patch",
            arguments: JSON.stringify({
              patchText: "*** Begin Patch\n*** Update File: demo.txt\n@@\n-before\n+after\n*** End Patch\n",
            }),
          }),
          agentKey: "build",
          agentActorId: "actor_build",
        })
        notifyHistory?.({
          stream: "tool_call_result",
          payload: JSON.stringify({
            toolName: "apply_patch",
            toolCallId: "call_patch",
            result: JSON.stringify({
              message: "Patch applied successfully (1 operation).",
              diff: ["--- demo.txt", "+++ demo.txt", "@@ -1 +1 @@", "-before", "+after"].join("\n"),
            }),
            isError: false,
          }),
          agentKey: "build",
          agentActorId: "actor_build",
        })
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
      const runtimeClient = createTuiRuntimeClient()
      await runtimeClient.client.session.prompt({
        parts: [
          {
            id: "p1",
            sessionID: "ses_1",
            messageID: "msg_1",
            type: "text",
            text: "做多处编辑并打 patch",
            synthetic: false,
            ignored: false,
          },
        ],
      })

      const messages = await runtimeClient.client.session.messages({ sessionID: "ses_1" })
      const parts = (messages.data ?? []).flatMap((message) => message.parts ?? [])
      const multieditPart = parts.find((part) => part.type === "tool" && (part as any).tool === "multiedit") as any
      const patchPart = parts.find((part) => part.type === "tool" && (part as any).tool === "apply_patch") as any

      expect(multieditPart.state.metadata).toMatchObject({
        output: "Edited ~/tmp/demo4/demo.txt (2 edits)",
        filePath: "~/tmp/demo4/demo.txt",
        diff: expect.stringContaining("@@ -1 +1 @@"),
      })
      expect(patchPart.state.metadata).toMatchObject({
        output: "Patch applied successfully (1 operation).",
        diff: expect.stringContaining("@@ -1 +1 @@"),
      })
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })
})
