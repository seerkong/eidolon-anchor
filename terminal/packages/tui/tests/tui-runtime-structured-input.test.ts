import { afterEach, describe, expect, it } from "bun:test"

import type { Event, Part } from "@terminal/core/AIAgent"
import type { InputContent } from "@shared/composer"
import { __setRuntimeBridgeFactoryForTest, createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"

afterEach(() => {
  __setRuntimeBridgeFactoryForTest(null)
})

describe("TuiRuntimeClient structured user ingress", () => {
  it("finalizes a visible unsupported-modality error and returns the session to idle", async () => {
    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn(_input, opts) {
        const message = "Model 'deepseek-v4-flash' does not support image input"
        await opts?.onChunk?.(message)
        throw Object.assign(new Error(message), { code: "unsupported_modality" })
      },
      async abort() {},
      dispose() {},
      subscribeNotifications() {
        return { unsubscribe() {} }
      },
    }))

    const sdk = createTuiRuntimeClient({ mode: "local-runtime" })
    await expect(sdk.client.session.prompt({
      sessionID: "ses-unsupported-image",
      messageID: "msg-unsupported-image",
      parts: [
        {
          id: "part-unsupported-image",
          sessionID: "ses-unsupported-image",
          messageID: "msg-unsupported-image",
          type: "file",
          filename: "screen.png",
          mime: "image/png",
          url: "data:image/png;base64,iVBORw0KGgo=",
        },
      ] as Part[],
    })).rejects.toMatchObject({ code: "unsupported_modality" })

    const statuses = await sdk.client.session.status()
    expect(statuses.data?.["ses-unsupported-image"]?.type).toBe("idle")
    const messages = await sdk.client.session.messages({ sessionID: "ses-unsupported-image" })
    const assistant = messages.data?.map((entry) => entry.info).find((message) => message.role === "assistant")
    expect(assistant?.time.completed).toBeNumber()
  })

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

  it("projects imported attachment snapshots by value without retaining the source path", async () => {
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
    await sdk.client.session.prompt({
      sessionID: "ses-imported-attachment",
      messageID: "msg-imported-attachment",
      parts: [
        {
          id: "part-imported-text",
          sessionID: "ses-imported-attachment",
          messageID: "msg-imported-attachment",
          type: "file",
          filename: "notes.md",
          mime: "text/plain",
          source: { path: "C:\\source-that-may-change\\notes.md" },
          attachment: {
            type: "text",
            text: "captured value\n",
            filename: "notes.md",
            sourceDigest: "sha256:captured-text",
          },
        },
        {
          id: "part-imported-image",
          sessionID: "ses-imported-attachment",
          messageID: "msg-imported-attachment",
          type: "file",
          filename: "renamed.bin",
          mime: "image/png",
          source: { path: "C:\\source-that-may-change\\renamed.bin" },
          attachment: {
            type: "image",
            mime: "image/png",
            dataUrl: "data:image/png;base64,iVBORw0KGgo=",
            filename: "renamed.bin",
            sourceDigest: "sha256:captured-image",
            size: 8,
          },
        },
      ] as Part[],
    })

    expect(runtimeInput).toEqual([
      {
        type: "text",
        text: "captured value\n",
        filename: "notes.md",
        sourceDigest: "sha256:captured-text",
      },
      {
        type: "image",
        mime: "image/png",
        dataUrl: "data:image/png;base64,iVBORw0KGgo=",
        filename: "renamed.bin",
        sourceDigest: "sha256:captured-image",
        size: 8,
      },
    ])
    expect(JSON.stringify(runtimeInput)).not.toContain("source-that-may-change")
  })
})
