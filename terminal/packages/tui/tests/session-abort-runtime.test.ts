import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  __setLlmAdapterFactoryForTest,
  configureTuiRuntime,
  disposeTuiRuntimeBridge,
  getTuiRuntimeBridge,
} from "../src/runtime/bridge/TuiRuntime"
import { __setRuntimeBridgeFactoryForTest, createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"

function makeTempWorkdir(): string {
  const dir = path.join(os.tmpdir(), `tui-session-abort-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(path.join(dir, ".eidolon", "agents"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".eidolon", "mcp"), { recursive: true })
  return dir
}

async function waitForSignal(getSignal: () => AbortSignal | undefined, timeoutMs = 1000): Promise<AbortSignal | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const signal = getSignal()
    if (signal) return signal
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return getSignal()
}

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

  it("aborts and settles a primary local runtime turn even when the provider stream hangs", async () => {
    const workdir = makeTempWorkdir()
    const sessionKey = `abort-primary-${Date.now()}`
    configureTuiRuntime({
      workDir: workdir,
      adapter: "openai",
      model: "gpt-4o-mini",
      debug: false,
      mcp: false,
    })

    let signal: AbortSignal | undefined
    let aborted = false
    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream(options: { signal?: AbortSignal }) {
        signal = options.signal
        signal?.addEventListener("abort", () => {
          aborted = true
        })
        async function* stream() {
          await new Promise(() => {})
        }
        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge(sessionKey)
      let settled = false
      const turn = runtime!.turn("start a long turn")
        .then(() => "resolved", (error) => `rejected:${error instanceof Error ? error.message : String(error)}`)
        .finally(() => {
          settled = true
        })

      signal = await waitForSignal(() => signal)
      expect(signal).toBeTruthy()
      expect(settled).toBe(false)

      await runtime!.abort()
      const turnResult = await Promise.race([
        turn,
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 500)),
      ])

      expect(aborted).toBe(true)
      expect(turnResult).toBe("resolved")
      expect(settled).toBe(true)
    } finally {
      await disposeTuiRuntimeBridge(sessionKey)
      __setLlmAdapterFactoryForTest(null)
    }
  })

  it("aborts during the inflight-controller window before the actor controller is attached", async () => {
    const workdir = makeTempWorkdir()
    const sessionKey = `abort-inflight-window-${Date.now()}`
    configureTuiRuntime({
      workDir: workdir,
      adapter: "openai",
      model: "gpt-4o-mini",
      debug: false,
      mcp: false,
    })

    let signal: AbortSignal | undefined
    let started = () => {}
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })

    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream(options: { signal?: AbortSignal }) {
        signal = options.signal
        started()
        await new Promise(() => {})
        async function* stream() {}
        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge(sessionKey)
      const turn = runtime!.turn("start a turn").then(() => "resolved")
      await startedPromise
      expect(signal).toBeTruthy()
      expect(signal!.aborted).toBe(false)

      const abort = runtime!.abort()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(signal!.aborted).toBe(true)

      const result = await Promise.race([
        Promise.all([abort, turn]).then(() => "resolved"),
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 500)),
      ])
      expect(result).toBe("resolved")
    } finally {
      await disposeTuiRuntimeBridge(sessionKey)
      __setLlmAdapterFactoryForTest(null)
    }
  })
})
