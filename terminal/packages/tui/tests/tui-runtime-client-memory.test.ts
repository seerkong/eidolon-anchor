import { describe, expect, it } from "bun:test"
import { createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"

describe("TuiRuntimeClient memory bounds", () => {
  it("keeps the in-memory session message cache bounded during long mock sessions", async () => {
    const sdk = createTuiRuntimeClient({ mode: "mock" })
    const session = await sdk.client.session.create({})
    const sessionID = session.data?.id
    expect(sessionID).toBeDefined()

    for (let index = 0; index < 170; index += 1) {
      await sdk.client.session.prompt({
        sessionID,
        parts: [{ id: `input-${index}`, type: "text", text: `message ${index}` } as any],
      })
    }

    const messages = await sdk.client.session.messages({ sessionID })

    expect(messages.data).toHaveLength(300)
    expect(messages.data?.[0]?.info.role).toBe("user")
    expect(messages.data?.[0]?.parts[0]?.type).toBe("text")
    expect((messages.data?.[0]?.parts[0] as any)?.text).toBe("message 20")
    expect(messages.data?.at(-1)?.info.role).toBe("assistant")
  })
})
