import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { projectInputContentText } from "@shared/composer"
import { deepSeekChatEffectBundle, openAIOfficialChatEffectBundle } from "@cell/ai-organ-logic/llm/ChatCompletionsEffectBundles"
import { createLocalFileConversationProjectionReadPort } from "@cell/ai-support/conversation/LocalFileConversationProjectionReadPort"
import { __setLlmAdapterFactoryForTest, configureTuiRuntime, disposeTuiRuntimeBridge, getTuiRuntimeBridge } from "../src/runtime/bridge/TuiRuntime"

function makeTempWorkdir(): string {
  const dir = path.join(os.tmpdir(), `tui-history-dedup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(path.join(dir, ".eidolon", "agents"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".eidolon", "mcp"), { recursive: true })
  return dir
}

type StreamChunk = {
  id: string
  event_id?: string
  choices: Array<{ delta: { content?: string; reasoning_content?: string } }>
}

function chunk(delta: StreamChunk["choices"][number]["delta"], eventId?: string): StreamChunk {
  return { id: "completion-1", ...(eventId ? { event_id: eventId } : {}), choices: [{ delta }] }
}

// The old fixture conflated equal text with replayed events and expected OpenAI
// to retain DeepSeek reasoning. ChatCompletionsStreamCore fingerprints event_id,
// while ChatCompletionsEffectBundles owns the provider-specific reasoning policy.
// Keep the duplicate-persistence guard on explicit event identities, and cover
// legitimate equal tokens separately (as in OpenAICompletionsStreamAdapter.test).
const cases = [
  {
    name: "preserves equal consecutive content without event_id, even with the same completion id",
    adapter: "openai" as const,
    chunks: [chunk({ content: "Created member successfully" }), chunk({ content: "Created member successfully" })],
    content: "Created member successfullyCreated member successfully",
    reasoning: undefined,
  },
  {
    name: "persists an OpenAI content event once when its event_id is replayed",
    adapter: "openai" as const,
    chunks: [chunk({ content: "Created member successfully" }, "content-1"), chunk({ content: "Created member successfully" }, "content-1")],
    content: "Created member successfully",
    reasoning: undefined,
  },
  {
    name: "ignores reasoning_content in the official OpenAI protocol while persisting the answer",
    adapter: "openai" as const,
    chunks: [chunk({ reasoning_content: "Great" }, "reasoning-1"), chunk({ content: "Created member successfully" }, "content-1")],
    content: "Created member successfully",
    reasoning: undefined,
  },
  {
    name: "preserves DeepSeek reasoning and persists replayed reasoning and content event_ids once",
    adapter: "deepseek" as const,
    chunks: [
      chunk({ reasoning_content: "Great" }, "reasoning-1"),
      chunk({ reasoning_content: "Great" }, "reasoning-1"),
      chunk({ content: "Created member successfully" }, "content-1"),
      chunk({ content: "Created member successfully" }, "content-1"),
    ],
    content: "Created member successfully",
    reasoning: "Great",
  },
]

describe("TuiRuntime message history dedup", () => {
  it.each(cases)("$name", async ({ adapter, chunks, content, reasoning }) => {
    const workdir = makeTempWorkdir()
    configureTuiRuntime({
      workDir: workdir,
      adapter,
      model: adapter === "deepseek" ? "deepseek-chat" : "gpt-4o-mini",
      debug: false,
      mcp: false,
    })

    __setLlmAdapterFactoryForTest(async () => ({
      type: adapter,
      chatCompletionsEffectBundle: adapter === "deepseek" ? deepSeekChatEffectBundle : openAIOfficialChatEffectBundle,
      async createStream() {
        async function* stream() {
          yield* chunks
        }
        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge("dedup-session")
      await runtime!.turn("team spawn")

      const port = createLocalFileConversationProjectionReadPort()
      const sessionDir = path.join(workdir, ".eidolon", "sessions", "dedup-session")
      const session = await port.loadSessionProjection({ sessionDir })
      expect(session.activeActorKey).toBeTruthy()
      const history = await port.loadHistoryProjection({ sessionDir, actorKey: session.activeActorKey! })
      expect(history.source).toBe("conversation")
      expect(history.messages.filter((message) => message.role === "user").map((message) => projectInputContentText(message.content))).toEqual(["team spawn"])
      const assistants = history.messages.filter((message) => message.role === "assistant")
      expect(assistants).toHaveLength(1)
      expect(projectInputContentText(assistants[0]!.content)).toBe(content)
      expect(assistants[0]!.reasoning_content).toBe(reasoning)
    } finally {
      try {
        await disposeTuiRuntimeBridge("dedup-session")
      } finally {
        __setLlmAdapterFactoryForTest(null)
        fs.rmSync(workdir, { recursive: true, force: true })
      }
    }
  })
})
