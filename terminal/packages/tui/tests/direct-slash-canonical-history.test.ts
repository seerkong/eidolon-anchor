import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { installBundledSystemSkills, LocalFileConversationPersistenceRepositoryFactory, loadConversationHistoryMessages } from "@cell/ai-support"
import { __setLlmAdapterFactoryForTest, configureTuiRuntime, disposeTuiRuntimeBridge, getTuiRuntimeBridge } from "../src/runtime/bridge/TuiRuntime"

async function withRuntime(run: (fixture: {
  runtime: NonNullable<Awaited<ReturnType<typeof getTuiRuntimeBridge>>>
  readHistory: () => Promise<unknown[]>
  providerCalls: () => number
}) => Promise<void>) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-direct-slash-"))
  const sessionKey = "direct-slash-session"
  const globalRoot = path.join(workDir, "isolated-authority")
  let providerCalls = 0
  try {
    await installBundledSystemSkills({ globalRoot })
    configureTuiRuntime({ workDir, globalRoot, adapter: "openai", model: "gpt-4o-mini", mcp: false })
    __setLlmAdapterFactoryForTest(async () => ({ type: "openai" as const, async createStream() {
      providerCalls += 1
      return { stream: (async function* () { yield { choices: [{ delta: { content: "hello from runtime" } }] } })() }
    } }))
    const runtime = await getTuiRuntimeBridge(sessionKey)
    expect(runtime).toBeTruthy()
    const sessionDir = path.join(workDir, ".eidolon", "sessions", sessionKey)
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir, sessionKey)
    await run({ runtime: runtime!, providerCalls: () => providerCalls,
      readHistory: async () => (await loadConversationHistoryMessages({ sessionDir, actorKey: "main", repository })).messages,
    })
  } finally {
    await disposeTuiRuntimeBridge(sessionKey)
    __setLlmAdapterFactoryForTest(null)
    fs.rmSync(workDir, { recursive: true, force: true })
  }
}

describe("direct slash canonical history", () => {
  it("shows direct slash output and persists it through the canonical Conversation owner", async () => {
    await withRuntime(async ({ runtime, readHistory, providerCalls }) => {
      const output = await runtime.turn("/member list")
      expect(output).toContain('"ok":true')
      const history = await readHistory()
      expect(JSON.stringify(history)).not.toContain("/member list")
      expect(history.some((message: any) => String(message.content).includes('"ok":true'))).toBe(true)
      expect(providerCalls()).toBe(0)
    })
  })

  it("shows namespace help and persists the visible output in canonical history", async () => {
    await withRuntime(async ({ runtime, readHistory, providerCalls }) => {
      const output = await runtime.turn("/actor help")
      expect(output).toContain("`/actor` commands:")
      expect(output).toContain("`/actor assign <target> -- <content>`")
      expect((await readHistory()).some((message: any) => String(message.content).includes("`/actor` commands:"))).toBe(true)
      expect(providerCalls()).toBe(0)
    })
  })

  it("appends canonical slash output without rewriting an existing conversation prefix", async () => {
    await withRuntime(async ({ runtime, readHistory, providerCalls }) => {
      await runtime.turn("hello")
      const before = await readHistory()
      expect(before.length).toBeGreaterThan(0)
      await runtime.turn("/actor help")
      const after = await readHistory()
      expect(after.length).toBeGreaterThan(before.length)
      expect(after.slice(0, before.length)).toEqual(before)
      expect(after.some((message: any) => String(message.content).includes("`/actor` commands:"))).toBe(true)
      expect(providerCalls()).toBe(1)
    })
  })
})
