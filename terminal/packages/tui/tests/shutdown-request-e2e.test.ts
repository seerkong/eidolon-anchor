import { afterEach, describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import {
  __setLlmAdapterFactoryForTest,
  configureTuiRuntime,
  disposeTuiRuntimeBridge,
  getTuiRuntimeBridge,
} from "../src/runtime/bridge/TuiRuntime"

function makeTempWorkdir(): string {
  const dir = path.join(os.tmpdir(), `tui-shutdown-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(path.join(dir, ".eidolon", "agents"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".eidolon", "mcp"), { recursive: true })
  return dir
}

function findLastMessage(messages: any[], role: string): any | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === role) return messages[i]
  }
  return null
}

function findToolMessage(messages: any[], toolCallId: string): any | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role === "tool" && message?.tool_call_id === toolCallId) return message
  }
  return null
}

function parseTrailingJson(text: string): any {
  const trimmed = String(text ?? "").trim()
  try {
    return JSON.parse(trimmed)
  } catch {}

  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start < 0 || end < start) throw new Error(`No JSON object found in output: ${trimmed}`)
  return JSON.parse(trimmed.slice(start, end + 1))
}

function readRuntimeIndex(workdir: string, sessionKey: string, fileName: string): any {
  const filePath = path.join(workdir, ".eidolon", "sessions", sessionKey, "runtime_state", "indexes", fileName)
  return JSON.parse(fs.readFileSync(filePath, "utf-8"))
}

afterEach(() => {
  __setLlmAdapterFactoryForTest(null)
})

describe("shutdown request e2e", () => {
  it("directly creates a member without invoking LLM even when trailing spaces are present", async () => {
    const sessionKey = `spawn-direct-${Date.now()}`
    const workdir = makeTempWorkdir()
    configureTuiRuntime({
      workDir: workdir,
      adapter: "openai",
      model: "gpt-4o-mini",
      debug: false,
      mcp: false,
    })

    let llmCalls = 0
    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        llmCalls += 1
        throw new Error("direct slash member create should not invoke LLM")
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge(sessionKey)
      expect(runtime).toBeTruthy()

      const spawnOutput = await runtime!.turn("/member create code-worker @code     ")
      const spawned = parseTrailingJson(spawnOutput)
      expect(spawned.ok).toBe(true)
      expect(spawned.member_id ?? spawned.memberId).toBeTruthy()
      expect(spawned.name).toBe("code-worker")

      const roster = readRuntimeIndex(workdir, sessionKey, "memberRoster.json")
      const created = roster.members.find((entry: any) => entry.memberId === (spawned.memberId ?? spawned.member_id))
      expect(created).toBeTruthy()
      expect(created.name).toBe("code-worker")
      expect(llmCalls).toBe(0)
    } finally {
      await disposeTuiRuntimeBridge(sessionKey)
    }
  })

  it("exposes member shutdown state immediately after the request turn", async () => {
    const sessionKey = `shutdown-e2e-${Date.now()}`
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
        const messages = Array.isArray(options?.messages) ? options.messages : []
        const lastUser = String(findLastMessage(messages, "user")?.content ?? "")
        const spawnTool = findToolMessage(messages, "tc-spawn")
        const shutdownTool = findToolMessage(messages, "tc-shutdown")

        async function* stream() {
          if (lastUser.includes("spawn alice")) {
            if (!spawnTool) {
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "tc-spawn",
                          type: "function",
                          function: {
                            name: "MemberCreate",
                            arguments: JSON.stringify({
                              name: "Alice",
                              role: "worker",
                              agent_type: "code",
                              prompt: "work from the board",
                            }),
                          },
                        },
                      ],
                    },
                  },
                ],
              } as any
              yield { choices: [{ finish_reason: "tool_calls", delta: {} }] } as any
              return
            }
            const memberId = JSON.parse(String(spawnTool.content ?? "{}")).member_id
            yield { choices: [{ delta: { content: `spawned ${memberId}` } }] } as any
            return
          }

          if (lastUser.includes("shutdown member-")) {
            const match = lastUser.match(/shutdown\s+(member-[^\s]+)/)
            const memberId = match?.[1] ?? ""
            if (!shutdownTool) {
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "tc-shutdown",
                          type: "function",
                          function: {
                            name: "ShutdownRequest",
                            arguments: JSON.stringify({ member_id: memberId, reason: "done" }),
                          },
                        },
                      ],
                    },
                  },
                ],
              } as any
              yield { choices: [{ finish_reason: "tool_calls", delta: {} }] } as any
              return
            }
            const requestId = JSON.parse(String(shutdownTool.content ?? "{}")).request_id
            yield { choices: [{ delta: { content: `shutdown requested ${requestId}` } }] } as any
            return
          }

          yield { choices: [{ delta: { content: "ok" } }] } as any
        }

        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge(sessionKey)
      expect(runtime).toBeTruthy()

      const spawnOutput = await runtime!.turn("spawn alice")
      expect(spawnOutput).toContain("spawned member-")

      const roster = readRuntimeIndex(workdir, sessionKey, "memberRoster.json")
      const alice = roster.members.find((entry: any) => entry.name === "Alice")
      expect(alice).toBeTruthy()

      await runtime!.turn(`shutdown ${alice.memberId}`)

      const rosterAfter = readRuntimeIndex(workdir, sessionKey, "memberRoster.json")
      const aliceAfter = rosterAfter.members.find((entry: any) => entry.memberId === alice.memberId)
      expect(aliceAfter).toBeTruthy()
      expect(["active", "shutting_down", "exited"]).toContain(aliceAfter.lifecycleState)
    } finally {
      await disposeTuiRuntimeBridge(sessionKey)
    }
  })
})
