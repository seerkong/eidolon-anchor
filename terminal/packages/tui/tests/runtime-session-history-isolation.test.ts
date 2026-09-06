import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { projectInputContentText } from "@shared/composer"
import { createLocalFileConversationProjectionReadPort } from "@cell/ai-support/conversation/LocalFileConversationProjectionReadPort"
import { __setLlmAdapterFactoryForTest, configureTuiRuntime, disposeTuiRuntimeBridge, getTuiRuntimeBridge } from "../src/runtime/bridge/TuiRuntime"

function makeTempWorkdir(): string {
  const dir = path.join(os.tmpdir(), `tui-runtime-history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(path.join(dir, ".eidolon", "agents"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".eidolon", "mcp"), { recursive: true })
  return dir
}

describe("TuiRuntime session history isolation", () => {
  it("persists the first user input into the matching session history and does not leak across runtime sessions", async () => {
    const workdir = makeTempWorkdir()
    configureTuiRuntime({
      workDir: workdir,
      adapter: "openai",
      model: "gpt-4o-mini",
      debug: false,
      mcp: false,
    })

    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream(options: any) {
        const userMessages = Array.isArray(options?.messages) ? options.messages.filter((msg: any) => msg?.role === "user") : []
        const prompt = String(userMessages[userMessages.length - 1]?.content ?? "")
        async function* stream() {
          yield { choices: [{ delta: { content: `echo:${prompt}` } }] } as any
        }
        return { stream: stream() }
      },
    }))

    try {
      const runtimeA = await getTuiRuntimeBridge("session-a")
      const runtimeB = await getTuiRuntimeBridge("session-b")

      await runtimeA!.turn("todo app")
      await runtimeB!.turn("你是谁")

      const port = createLocalFileConversationProjectionReadPort()
      const histories = await Promise.all(["session-a", "session-b"].map(async (sessionId) => {
        const sessionDir = path.join(workdir, ".eidolon", "sessions", sessionId)
        const session = await port.loadSessionProjection({ sessionDir })
        expect(session.sessionId).toBe(sessionId)
        expect(session.activeActorKey).toBeTruthy()
        const history = await port.loadHistoryProjection({ sessionDir, actorKey: session.activeActorKey! })
        expect(history.source).toBe("conversation")
        return history.messages
      }))

      expect(histories.length).toBe(2)
      expect(histories[0]!.filter((message) => message.role === "user").map((message) => projectInputContentText(message.content))).toEqual(["todo app"])
      expect(histories[1]!.filter((message) => message.role === "user").map((message) => projectInputContentText(message.content))).toEqual(["你是谁"])
      const texts = histories.map((messages) => JSON.stringify(messages))
      expect(texts.filter((text) => text.includes("todo app")).length).toBe(1)
      expect(texts.filter((text) => text.includes("你是谁")).length).toBe(1)
      expect(texts.some((text) => text.includes("todo app") && text.includes("你是谁"))).toBe(false)
    } finally {
      try {
        await Promise.all(["session-a", "session-b"].map(disposeTuiRuntimeBridge))
      } finally {
        __setLlmAdapterFactoryForTest(null)
        fs.rmSync(workdir, { recursive: true, force: true })
      }
    }
  })
})
