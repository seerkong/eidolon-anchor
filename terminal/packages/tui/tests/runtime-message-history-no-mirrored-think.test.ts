import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { parseXnl } from "xnl-core"
import { __setLlmAdapterFactoryForTest, configureTuiRuntime, getTuiRuntimeBridge } from "../src/runtime/bridge/TuiRuntime"

function makeTempWorkdir(): string {
  const dir = path.join(os.tmpdir(), `tui-history-no-mirrored-think-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(path.join(dir, ".eidolon", "agents"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".eidolon", "mcp"), { recursive: true })
  return dir
}

async function readTranscriptXnl(filePath: string): Promise<{ streams: string[]; text: string }> {
  const doc = parseXnl(fs.readFileSync(filePath, "utf8"))
  const records = (doc.nodes ?? [])
    .filter((record: any) => record?.kind === "DataElement" && record?.tag === "actor-transcript-record")
  const streams: string[] = []
  const textParts: string[] = []
  for (const record of records as any[]) {
    for (const item of record.body ?? []) {
      if (item?.kind !== "TextElement" || item?.tag !== "record") continue
      streams.push(String(item.metadata?.stream ?? record.metadata.stream ?? ""))
      textParts.push(String(item.text ?? ""))
    }
  }
  return { streams, text: textParts.join("\n") }
}

describe("TuiRuntime mirrored think suppression", () => {
  it("does not replay reasoning-only assistant messages into the next OpenAI chat request", async () => {
    const workdir = makeTempWorkdir()
    configureTuiRuntime({
      workDir: workdir,
      adapter: "openai",
      model: "gpt-4o-mini",
      debug: false,
      mcp: false,
    })

    const capturedRequests: any[][] = []
    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream(options: { messages?: any[] }) {
        capturedRequests.push(options.messages ?? [])
        async function* stream() {
          if (capturedRequests.length === 1) {
            yield { choices: [{ delta: { reasoning_content: "thinking only" } }] } as any
            return
          }
          yield { choices: [{ delta: { content: "second answer" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge("reasoning-only-replay-session")
      await runtime!.turn("first")
      const second = await runtime!.turn("second")

      expect(second).toContain("second answer")
      const replayedAssistantMessages = (capturedRequests[1] ?? []).filter((message) => message.role === "assistant")
      expect(replayedAssistantMessages.every((message) => (
        typeof message.content === "string" && message.content.length > 0
      ) || Array.isArray(message.tool_calls))).toBe(true)
      expect(replayedAssistantMessages.some((message) => message.reasoning_content)).toBe(false)
      expect(replayedAssistantMessages.some((message) => !message.content && !message.tool_calls)).toBe(false)
    } finally {
      __setLlmAdapterFactoryForTest(null)
    }
  })

  it("does not persist a think block when reasoning_content mirrors content exactly", async () => {
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
      async createStream() {
        async function* stream() {
          yield {
            choices: [
              {
                delta: {
                  reasoning_content: "我是你的AI助手",
                  content: "我是你的AI助手",
                },
              },
            ],
          } as any
        }
        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge("mirrored-think-session")
      await runtime!.turn("你是谁")

      const sessionsDir = path.join(workdir, ".eidolon", "sessions")
      const sessionDirs = fs.readdirSync(sessionsDir)
      expect(sessionDirs.length).toBe(1)
      const actorsDir = path.join(sessionsDir, sessionDirs[0]!, "actors")
      const actorDirs = fs.readdirSync(actorsDir)
      expect(actorDirs.length).toBeGreaterThan(0)
      const historyPath = path.join(actorsDir, actorDirs[0]!, "transcript.xnl")
      const history = await readTranscriptXnl(historyPath)

      expect(history.streams.includes("think")).toBe(false)
      expect(history.streams.includes("content")).toBe(true)
      expect(history.text.match(/我是你的AI助手/g)?.length ?? 0).toBe(1)
    } finally {
      __setLlmAdapterFactoryForTest(null)
    }
  })
})
