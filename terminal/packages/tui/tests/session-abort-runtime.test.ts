import { describe, expect, it } from "bun:test"
import { __setRuntimeBridgeFactoryForTest, createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"

describe("session abort runtime wiring", () => {
  it("calls runtime.abort when session.abort is triggered", async () => {
    let aborted = 0
    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn() { return "ok" },
      async abort() { aborted += 1 },
      dispose() {},
      subscribeNotifications() {
        return { unsubscribe() {} }
      },
    }))
    try {
      const sdk = createTuiRuntimeClient()
      await sdk.client.session.abort({ sessionID: "ses_1" } as any)
      expect(aborted).toBe(1)
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })
})
