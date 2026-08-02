import { afterEach, describe, expect, it } from "bun:test"

import type { Event, Part } from "@terminal/core/AIAgent"
import type { InputContent } from "@shared/composer"
import { __setRuntimeBridgeFactoryForTest, createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"

afterEach(() => {
  __setRuntimeBridgeFactoryForTest(null)
})

describe("TuiRuntimeClient structured user ingress", () => {
  it("preserves ordered text/file parts in user message events", async () => {
    let runtimeInput: InputContent | undefined
    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn(input) {
        runtimeInput = input
        return "ok"
      },
      async abort() {},
      dispose() {},
      subscribeNotifications() {
        return { unsubscribe() {} }
      },
    }))

    const sdk = createTuiRuntimeClient({ mode: "local-runtime" })
    const userParts: Part[] = []
    const unsubscribe = sdk.event.on((event: Event) => {
      if (event.type !== "message.part.updated") return
      const part = event.properties?.part as Part | undefined
      if (part?.messageID === "msg-structured-user") userParts.push(part)
    })
    const submittedParts = [
      {
        id: "part-text",
        sessionID: "ses-structured-input",
        messageID: "msg-structured-user",
        type: "text",
        text: "inspect ",
      },
      {
        id: "part-file",
        sessionID: "ses-structured-input",
        messageID: "msg-structured-user",
        type: "file",
        filename: "screen.png",
        mime: "image/png",
        url: "data:image/png;base64,aW1hZ2U=",
        source: { path: "C:\\secret\\screen.png" },
      },
    ] as Part[]

    try {
      await sdk.client.session.prompt({
        sessionID: "ses-structured-input",
        messageID: "msg-structured-user",
        parts: submittedParts,
      })
    } finally {
      unsubscribe()
    }

    expect(userParts.map((part) => part.type)).toEqual(["text", "file"])
    expect(userParts[1]).toMatchObject({
      type: "file",
      filename: "screen.png",
      mime: "image/png",
      url: "data:image/png;base64,aW1hZ2U=",
    })
    expect(runtimeInput).toEqual([
      { type: "text", text: "inspect " },
      {
        type: "image",
        filename: "screen.png",
        mime: "image/png",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      },
    ])
    expect(JSON.stringify(runtimeInput)).not.toContain("C:\\\\secret")
  })
})
