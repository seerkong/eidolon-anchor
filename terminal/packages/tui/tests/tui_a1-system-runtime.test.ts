import { describe, expect, it } from "bun:test"
import { __setRuntimeBridgeFactoryForTest, createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"
import { splitMessageTextForRender, streamingTextWindow } from "../src/app/tui_a1/features/message/cards"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { flushTuiStreamDiagnostics } from "../src/support/util/stream-diagnostics"

describe("tui_a1 system runtime facade", () => {
  it("updates the session title through session.update", async () => {
    const sdk = createTuiRuntimeClient()

    await sdk.client.session.get({ sessionID: "ses_1" })
    await sdk.client.session.update({ sessionID: "ses_1", title: "Renamed Session" } as { sessionID: string; title: string })

    const result = await sdk.client.session.get({ sessionID: "ses_1" })
    expect(result.data?.title).toBe("Renamed Session")
  })

  it("refreshes forked session previews after prompting in the fork", async () => {
    const sdk = createTuiRuntimeClient()
    const source = await sdk.client.session.create({})
    const sourceID = source.data?.id
    expect(sourceID).toBeDefined()

    await sdk.client.session.prompt({
      sessionID: sourceID,
      parts: [{ id: "source-part", type: "text", text: "source question" } as any],
    })

    const forked = await sdk.client.session.fork({ sessionID: sourceID })
    const forkedID = forked.data?.id
    expect(forkedID).toBeDefined()

    await sdk.client.session.prompt({
      sessionID: forkedID,
      parts: [{ id: "fork-part", type: "text", text: "fork question" } as any],
    })

    const sessions = await sdk.client.session.list()
    const forkedPreview = sessions.data?.find((entry) => entry.id === forkedID)
    expect(forkedPreview?.preview?.initialUserMessage).toBe("source question")
    expect(forkedPreview?.preview?.latestMessage).toBe("收到：fork question")
  })

  it("tracks MCP connect and disconnect state in mock mode", async () => {
    const sdk = createTuiRuntimeClient()

    const initial = await sdk.client.mcp.status()
    expect(initial.data?.filesystem?.status).toBe("connected")
    expect(initial.data?.memory?.status).toBe("failed")

    await sdk.client.mcp.disconnect({ name: "filesystem" })
    const disconnected = await sdk.client.mcp.status()
    expect(disconnected.data?.filesystem?.status).toBe("disabled")

    await sdk.client.mcp.connect({ name: "memory" })
    const reconnected = await sdk.client.mcp.status()
    expect(reconnected.data?.memory?.status).toBe("connected")
  })

  it("emits throttled prompt text part updates while preserving final text", async () => {
    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn(_input, opts) {
        await opts?.onControl?.({ cmd: "NewMessage", category: "assist" })
        for (let index = 0; index < 40; index += 1) {
          await opts?.onChunk?.("abc")
        }
        return "abc".repeat(40)
      },
      async abort() {},
      dispose() {},
      subscribeNotifications() {
        return { unsubscribe() {} }
      },
    }))

    try {
      const sdk = createTuiRuntimeClient()
      const seen: string[] = []
      const unsub = sdk.event.on((event) => {
        if (event.type !== "message.part.updated") return
        const part = event.properties?.part
        if (part?.type === "text" && part.text) {
          seen.push(part.text)
        }
      })

      await sdk.client.session.prompt({
        sessionID: "ses_stream",
        parts: [{ id: "input", type: "text", text: "stream please" } as any],
      })
      unsub()

      expect(seen.length).toBeGreaterThan(1)
      expect(seen.length).toBeLessThan(40)
      expect(seen.at(-1)).toBe("abc".repeat(40))
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })

  it("coalesces bursty prompt text updates while preserving the final text", async () => {
    const chunk = "x".repeat(60)
    const chunks = 50
    const expected = chunk.repeat(chunks)
    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn(_input, opts) {
        await opts?.onControl?.({ cmd: "NewMessage", category: "assist" })
        for (let index = 0; index < chunks; index += 1) {
          void opts?.onChunk?.(chunk)
        }
        return expected
      },
      async abort() {},
      dispose() {},
      subscribeNotifications() {
        return { unsubscribe() {} }
      },
    }))

    try {
      const sdk = createTuiRuntimeClient()
      const lengths: number[] = []
      const unsub = sdk.event.on((event) => {
        if (event.type !== "message.part.updated") return
        const part = event.properties?.part
        if (part?.type === "text" && part.text) {
          lengths.push(part.text.length)
        }
      })

      await sdk.client.session.prompt({
        sessionID: "ses_bursty_stream",
        parts: [{ id: "input", type: "text", text: "stream please" } as any],
      })
      unsub()

      expect(lengths.length).toBeGreaterThanOrEqual(2)
      expect(lengths.length).toBeLessThan(chunks)
      expect(lengths.at(-1)).toBe(expected.length)
      expect(lengths.every((length, index) => index === 0 || length >= lengths[index - 1])).toBe(true)
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })

  it("writes stream diagnostics under the active session directory", async () => {
    const previous = process.env.EIDOLON_TUI_STREAM_DIAGNOSTICS
    process.env.EIDOLON_TUI_STREAM_DIAGNOSTICS = "1"
    const directory = await mkdtemp(join(tmpdir(), "eidolon-tui-stream-diagnostics-"))

    try {
      const sdk = createTuiRuntimeClient({ directory })
      await sdk.client.session.prompt({
        sessionID: "ses_diagnostics",
        parts: [{ id: "input", type: "text", text: "stream please" } as any],
      })
      await flushTuiStreamDiagnostics()

      const text = await readFile(
        join(directory, ".eidolon", "sessions", "ses_diagnostics", "diagnostics", "tui-stream.jsonl"),
        "utf8",
      )
      expect(text).toContain("tui.stream.diagnostic")
      expect(text).toContain("runtime.emit")
    } finally {
      if (previous === undefined) delete process.env.EIDOLON_TUI_STREAM_DIAGNOSTICS
      else process.env.EIDOLON_TUI_STREAM_DIAGNOSTICS = previous
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("prefers the outer project session directory for stream diagnostics", async () => {
    const previous = process.env.EIDOLON_TUI_STREAM_DIAGNOSTICS
    process.env.EIDOLON_TUI_STREAM_DIAGNOSTICS = "1"
    const directory = await mkdtemp(join(tmpdir(), "eidolon-tui-stream-diagnostics-root-"))
    const nested = join(directory, "terminal", "packages", "cli")
    await mkdir(join(directory, ".eidolon", "sessions"), { recursive: true })
    await mkdir(join(nested, ".eidolon", "sessions"), { recursive: true })

    try {
      const sdk = createTuiRuntimeClient({ directory: nested })
      await sdk.client.session.prompt({
        sessionID: "ses_diagnostics_root",
        parts: [{ id: "input", type: "text", text: "stream please" } as any],
      })
      await flushTuiStreamDiagnostics()

      const text = await readFile(
        join(directory, ".eidolon", "sessions", "ses_diagnostics_root", "diagnostics", "tui-stream.jsonl"),
        "utf8",
      )
      expect(text).toContain("tui.stream.diagnostic")
    } finally {
      if (previous === undefined) delete process.env.EIDOLON_TUI_STREAM_DIAGNOSTICS
      else process.env.EIDOLON_TUI_STREAM_DIAGNOSTICS = previous
      await rm(directory, { recursive: true, force: true })
    }
  })

  it("aligns the final assistant part when the runtime returns text missing from chunk events", async () => {
    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn(_input, opts) {
        await opts?.onControl?.({ cmd: "NewMessage", category: "assist" })
        await opts?.onChunk?.("开头")
        return "开头后续完整内容"
      },
      async abort() {},
      dispose() {},
      subscribeNotifications() {
        return { unsubscribe() {} }
      },
    }))

    try {
      const sdk = createTuiRuntimeClient()
      const result = await sdk.client.session.prompt({
        sessionID: "ses_final_align",
        parts: [{ id: "input", type: "text", text: "stream please" } as any],
      })

      const textPart = result.data?.parts.find((part: any) => part.type === "text") as { text?: string } | undefined
      expect(textPart?.text).toBe("开头后续完整内容")
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })

  it("streams final catch-up text in bounded frames", async () => {
    const suffix = "后续".repeat(180)
    __setRuntimeBridgeFactoryForTest(async () => ({
      async turn(_input, opts) {
        await opts?.onControl?.({ cmd: "NewMessage", category: "assist" })
        await opts?.onChunk?.("开头")
        return `开头${suffix}`
      },
      abort: async () => {},
      dispose() {},
      subscribeNotifications: () => ({ unsubscribe() {} }),
      subscribeHistoryEvents: () => ({ unsubscribe() {} }),
    }))
    try {
      const sdk = createTuiRuntimeClient({ mode: "local-runtime" })
      const lengths: number[] = []
      const unsub = sdk.event.on("message.part.updated", (event) => {
        const part = event.properties?.part as any
        if (part?.type === "text" && part.text?.startsWith("开头")) {
          lengths.push(part.text.length)
        }
      })

      await sdk.client.session.prompt({
        sessionID: "ses_final_catchup",
        parts: [{ id: "input", type: "text", text: "stream please" } as any],
      })
      unsub()

      expect(lengths.length).toBeGreaterThan(3)
      expect(lengths.at(-1)).toBe(`开头${suffix}`.length)
      expect(Math.max(...lengths.map((length, index) => index === 0 ? 0 : length - lengths[index - 1]))).toBeLessThanOrEqual(96)
    } finally {
      __setRuntimeBridgeFactoryForTest(null)
    }
  })

  it("limits the text handed to the streaming assistant card renderer", () => {
    const text = "x".repeat(5000)
    const windowed = streamingTextWindow(text)

    expect(windowed.length).toBeLessThan(text.length)
    expect(windowed).toBe(text.slice(-windowed.length))
  })

  it("splits long assistant card text into bounded render chunks", () => {
    const text = "x".repeat(7000)
    const chunks = splitMessageTextForRender(text)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join("")).toBe(text)
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThan(text.length)
  })
})
