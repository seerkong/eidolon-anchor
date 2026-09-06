import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { createLocalFileConversationProjectionReadPort } from "@cell/ai-support/conversation/LocalFileConversationProjectionReadPort"
import { __setLlmAdapterFactoryForTest, configureTuiRuntime, disposeTuiRuntimeBridge, getTuiRuntimeBridge } from "../src/runtime/bridge/TuiRuntime"

function makeTempWorkdir(): string {
  const dir = path.join(os.tmpdir(), `tui-history-no-mirrored-think-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(path.join(dir, ".eidolon", "agents"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".eidolon", "mcp"), { recursive: true })
  return dir
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
      try {
        await disposeTuiRuntimeBridge("reasoning-only-replay-session")
      } finally {
        __setLlmAdapterFactoryForTest(null)
        fs.rmSync(workdir, { recursive: true, force: true })
      }
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

      const port = createLocalFileConversationProjectionReadPort()
      const sessionDir = path.join(workdir, ".eidolon", "sessions", "mirrored-think-session")
      const session = await port.loadSessionProjection({ sessionDir })
      expect(session.activeActorKey).toBeTruthy()
      const history = await port.loadHistoryProjection({ sessionDir, actorKey: session.activeActorKey! })
      expect(history.source).toBe("conversation")

      expect(history.messages.some((message) => Boolean(message.reasoning_content))).toBe(false)
      expect(history.messages.filter((message) => message.role === "assistant").map((message) => message.content)).toEqual(["我是你的AI助手"])
      expect(history.messages.map((message) => String(message.content)).join("\n").match(/我是你的AI助手/g)?.length ?? 0).toBe(1)
    } finally {
      try {
        await disposeTuiRuntimeBridge("mirrored-think-session")
      } finally {
        __setLlmAdapterFactoryForTest(null)
        fs.rmSync(workdir, { recursive: true, force: true })
      }
    }
  })
})
