import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { __setLlmAdapterFactoryForTest, configureTuiRuntime, disposeTuiRuntimeBridge, getTuiRuntimeBridge } from "../src/runtime/bridge/TuiRuntime"

function makeTempWorkdir(): string {
  const dir = path.join(os.tmpdir(), `tui-direct-slash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(path.join(dir, ".eidolon", "agents"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".eidolon", "mcp"), { recursive: true })
  return dir
}

describe("direct slash canonical history", () => {
  it("shows direct slash output and persists it into message_history files through the semantic bus", async () => {
    const workdir = makeTempWorkdir()
    configureTuiRuntime({
      workDir: workdir,
      adapter: "openai",
      model: "gpt-4o-mini",
      debug: false,
      mcp: false,
    })

    const previousForce = process.env.TUI_FORCE_MOCK_RESPONDER
    process.env.TUI_FORCE_MOCK_RESPONDER = "1"
    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { choices: [{ delta: { content: "mock" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge()
      expect(runtime).toBeTruthy()
      const chunks: string[] = []
      await runtime!.turn("/member list", {
        onChunk: (chunk) => {
          chunks.push(chunk)
        },
      })

      expect(chunks.join("")).toContain('"ok":true')

      const sessionsDir = path.join(workdir, ".eidolon", "sessions")
      const sessions = fs.readdirSync(sessionsDir)
      expect(sessions.length).toBeGreaterThan(0)
      const sessionDir = path.join(sessionsDir, sessions[0]!)
      const actorsDir = path.join(sessionDir, "actors")
      const historyText = fs.existsSync(actorsDir)
        ? fs.readdirSync(actorsDir)
            .map((name) => path.join(actorsDir, name, "transcript.txt"))
            .filter((file) => fs.existsSync(file))
            .map((file) => fs.readFileSync(file, "utf-8"))
            .join("\n")
        : ""

      expect(historyText.includes("/member list")).toBe(false)
      expect(historyText.includes('"ok":true')).toBe(true)
    } finally {
      await disposeTuiRuntimeBridge()
      __setLlmAdapterFactoryForTest(null)
      if (previousForce === undefined) delete process.env.TUI_FORCE_MOCK_RESPONDER
      else process.env.TUI_FORCE_MOCK_RESPONDER = previousForce
    }
  })
  it("shows namespace help directly and persists the visible output into message_history files", async () => {
    const workdir = makeTempWorkdir()
    configureTuiRuntime({
      workDir: workdir,
      adapter: "openai",
      model: "gpt-4o-mini",
      debug: false,
      mcp: false,
    })

    const previousForce = process.env.TUI_FORCE_MOCK_RESPONDER
    process.env.TUI_FORCE_MOCK_RESPONDER = "1"
    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { choices: [{ delta: { content: "mock" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge()
      expect(runtime).toBeTruthy()
      const chunks: string[] = []
      await runtime!.turn("/actor help", {
        onChunk: (chunk) => {
          chunks.push(chunk)
        },
      })

      expect(chunks.join("")).toContain("`/actor` commands:")
      expect(chunks.join("")).toContain("`/actor assign <target> -- <content>`")

      const sessionsDir = path.join(workdir, ".eidolon", "sessions")
      const sessions = fs.readdirSync(sessionsDir)
      expect(sessions.length).toBeGreaterThan(0)
      const sessionDir = path.join(sessionsDir, sessions[0]!)
      const actorsDir = path.join(sessionDir, "actors")
      const historyText = fs.existsSync(actorsDir)
        ? fs.readdirSync(actorsDir)
            .map((name) => path.join(actorsDir, name, "transcript.txt"))
            .filter((file) => fs.existsSync(file))
            .map((file) => fs.readFileSync(file, "utf-8"))
            .join("\n")
        : ""

      expect(historyText.includes("`/actor` commands:")).toBe(true)
    } finally {
      await disposeTuiRuntimeBridge()
      __setLlmAdapterFactoryForTest(null)
      if (previousForce === undefined) delete process.env.TUI_FORCE_MOCK_RESPONDER
      else process.env.TUI_FORCE_MOCK_RESPONDER = previousForce
    }
  })

  it("appends canonical slash output to an existing actor transcript when a direct slash command saves a snapshot", async () => {
    const workdir = makeTempWorkdir()
    const sessionKey = `direct-slash-stable-${Date.now()}`
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
          yield { choices: [{ delta: { content: "hello from runtime" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge(sessionKey)
      expect(runtime).toBeTruthy()
      await runtime!.turn("hello")

      const sessionDir = path.join(workdir, ".eidolon", "sessions", sessionKey)
      const actorsDir = path.join(sessionDir, "actors")
      const transcriptPath = fs.readdirSync(actorsDir)
        .map((name) => path.join(actorsDir, name, "transcript.txt"))
        .find((file) => fs.existsSync(file))
      expect(transcriptPath).toBeTruthy()

      const before = fs.readFileSync(transcriptPath!, "utf-8")
      await runtime!.turn("/actor help")
      const after = fs.readFileSync(transcriptPath!, "utf-8")

      expect(after).not.toBe(before)
      expect(after.startsWith(before)).toBe(true)
      expect(after.includes("`/actor` commands:")).toBe(true)
    } finally {
      await disposeTuiRuntimeBridge(sessionKey)
      __setLlmAdapterFactoryForTest(null)
    }
  })

})
