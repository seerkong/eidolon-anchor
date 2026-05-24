import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { StreamTranscript } from "@cell/symbiont-logic/stream/StreamTranscript"
import { __setLlmAdapterFactoryForTest, configureTuiRuntime, getTuiRuntimeBridge } from "../src/runtime/bridge/TuiRuntime"

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

      const sessionsDir = path.join(workdir, ".eidolon", "sessions")
      const sessionDirs = fs.readdirSync(sessionsDir).map((name) => path.join(sessionsDir, name))
      const histories = sessionDirs
        .flatMap((dir) => {
          const actorsDir = path.join(dir, "actors")
          if (!fs.existsSync(actorsDir)) return [] as string[]
          return fs.readdirSync(actorsDir)
            .map((name) => path.join(actorsDir, name, "transcript.txt"))
            .filter((file) => fs.existsSync(file))
        })
        .map((file) => StreamTranscript.parse(fs.readFileSync(file, "utf-8")).records.map((record) => record.payload).join("\n"))

      expect(histories.length).toBe(2)
      expect(histories.filter((text) => text.includes("todo app")).length).toBe(1)
      expect(histories.filter((text) => text.includes("你是谁")).length).toBe(1)
      expect(histories.some((text) => text.includes("todo app") && text.includes("你是谁"))).toBe(false)
    } finally {
      __setLlmAdapterFactoryForTest(null)
    }
  })
})
