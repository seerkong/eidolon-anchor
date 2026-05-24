import { describe, expect, it } from "bun:test"
import type { Part } from "@terminal/core/AIAgent"
import { __setRuntimeBridgeFactoryForTest, createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"

function textPartsOf(messages: Array<{ parts: Part[] }>): string[] {
  return messages.flatMap((entry) =>
    entry.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  )
}

describe("TuiRuntimeClient session isolation", () => {
  it("keeps per-session runtime inputs and message lists isolated", async () => {
    const turns: Array<{ sessionID: string; input: string }> = []

    __setRuntimeBridgeFactoryForTest(async (sessionID) => ({
      async turn(input, opts) {
        turns.push({ sessionID: String(sessionID ?? ""), input })
        await opts?.onControl?.({ cmd: "NewMessage", category: "assist" })
        await opts?.onChunk?.(`reply:${sessionID}:${input}`)
        return `reply:${sessionID}:${input}`
      },
      async abort() {},
      dispose() {},
      subscribeNotifications() {
        return { unsubscribe() {} }
      },
    }))

    try {
      const sdk = createTuiRuntimeClient()
      const sessionA = (await sdk.client.session.create({})).data!
      const sessionB = (await sdk.client.session.create({})).data!

      await sdk.client.session.prompt({
        sessionID: sessionA.id,
        parts: [{ id: "part-a", type: "text", text: "todo app" } as Part],
      })
      await sdk.client.session.prompt({
        sessionID: sessionB.id,
        parts: [{ id: "part-b", type: "text", text: "你是谁" } as Part],
      })

      expect(turns.filter((entry) => entry.sessionID === sessionA.id).map((entry) => entry.input)).toEqual(["todo app"])
      expect(turns.filter((entry) => entry.sessionID === sessionB.id).map((entry) => entry.input)).toEqual(["你是谁"])

      const messagesA = (await sdk.client.session.messages({ sessionID: sessionA.id })).data
      const messagesB = (await sdk.client.session.messages({ sessionID: sessionB.id })).data
      const textsA = textPartsOf(messagesA ?? [])
      const textsB = textPartsOf(messagesB ?? [])

      expect(textsA.join("\n")).toContain("todo app")
      expect(textsA.join("\n")).toContain(`reply:${sessionA.id}:todo app`)
      expect(textsA.join("\n")).not.toContain("你是谁")

      expect(textsB.join("\n")).toContain("你是谁")
      expect(textsB.join("\n")).toContain(`reply:${sessionB.id}:你是谁`)
      expect(textsB.join("\n")).not.toContain("todo app")
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })
})
