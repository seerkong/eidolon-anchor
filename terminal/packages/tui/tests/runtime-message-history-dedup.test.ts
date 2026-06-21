import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { __setLlmAdapterFactoryForTest, configureTuiRuntime, getTuiRuntimeBridge } from "../src/runtime/bridge/TuiRuntime"

function makeTempWorkdir(): string {
  const dir = path.join(os.tmpdir(), `tui-history-dedup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(path.join(dir, ".eidolon", "agents"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".eidolon", "mcp"), { recursive: true })
  return dir
}

describe("TuiRuntime message history dedup", () => {
  it("does not persist duplicated consecutive stream chunks into the control transcript", async () => {
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
          yield { choices: [{ delta: { reasoning_content: "Great" } }] } as any
          yield { choices: [{ delta: { reasoning_content: "Great" } }] } as any
          yield { choices: [{ delta: { content: "Created member successfully" } }] } as any
          yield { choices: [{ delta: { content: "Created member successfully" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge("dedup-session")
      await runtime!.turn("team spawn")

      const sessionsDir = path.join(workdir, ".eidolon", "sessions")
      const sessionDirs = fs.readdirSync(sessionsDir)
      expect(sessionDirs.length).toBe(1)
      const actorsDir = path.join(sessionsDir, sessionDirs[0]!, "actors")
      const actorDirs = fs.readdirSync(actorsDir)
      expect(actorDirs.length).toBeGreaterThan(0)
      const historyPath = path.join(actorsDir, actorDirs[0]!, "transcript.xnl")
      const historyText = fs.readFileSync(historyPath, "utf-8")

      expect(historyText.match(/Great/g)?.length ?? 0).toBe(1)
      expect(historyText.match(/Created member successfully/g)?.length ?? 0).toBe(1)
    } finally {
      __setLlmAdapterFactoryForTest(null)
    }
  })
})
