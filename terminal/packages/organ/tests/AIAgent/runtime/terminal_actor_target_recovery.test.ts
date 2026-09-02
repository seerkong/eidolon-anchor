import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import {
  __setLlmAdapterFactoryForTest,
  configureTerminalRuntime,
  disposeTerminalRuntimeBridge,
  getTerminalRuntimeBridge,
} from "@terminal/organ/AIAgent/TerminalRuntime"

const originalHome = process.env.HOME
let activeHome: string | null = null
let activeWorkdir: string | null = null
let activeSession = ""

function makeRuntimeFixture(): { home: string; workdir: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-actor-target-home-"))
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-actor-target-workdir-"))
  fs.mkdirSync(path.join(home, ".eidolon"), { recursive: true })
  fs.mkdirSync(path.join(workdir, ".eidolon"), { recursive: true })
  fs.writeFileSync(path.join(home, ".eidolon", "llm-provider.json"), JSON.stringify({
    providers: [{
      id: "openai-test",
      adapter: "openai",
      options: { baseURL: "https://api.example.com", apiKey: "test-key" },
      models: [{ id: "test-model", limits: { context: 128000, output: 8192 } }],
    }],
  }, null, 2))
  fs.writeFileSync(path.join(home, ".eidolon", "agent-present.json"), JSON.stringify({
    preset: "default",
    presets: { default: { main: { model: "openai-test/test-model" } } },
  }, null, 2))
  return { home, workdir }
}

afterEach(async () => {
  if (activeSession) await disposeTerminalRuntimeBridge(activeSession)
  activeSession = ""
  __setLlmAdapterFactoryForTest(null)
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  if (activeWorkdir) fs.rmSync(activeWorkdir, { recursive: true, force: true })
  if (activeHome) fs.rmSync(activeHome, { recursive: true, force: true })
  activeWorkdir = null
  activeHome = null
})

describe("TerminalRuntime actor-target recovery", () => {
  it("drives a failed Primary fiber to a terminal boundary before actor.send resolves", async () => {
    const fixture = makeRuntimeFixture()
    activeHome = fixture.home
    activeWorkdir = fixture.workdir
    process.env.HOME = fixture.home
    activeSession = `actor-target-recovery-${Date.now()}`

    let providerCalls = 0
    let releaseRecoveredProvider = () => {}
    const recoveredProviderGate = new Promise<void>((resolve) => {
      releaseRecoveredProvider = resolve
    })
    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        providerCalls += 1
        if (providerCalls === 1) {
          async function* failedStream() {
            throw new Error("incident-shaped provider failure")
          }
          return { stream: failedStream() }
        }
        await recoveredProviderGate
        async function* recoveredStream() {
          yield { choices: [{ delta: { content: "ACTOR_TARGET_RECOVERED" } }] } as any
        }
        return { stream: recoveredStream() }
      },
    }))

    configureTerminalRuntime({ workDir: fixture.workdir, mcp: false, timeoutSeconds: 10 })
    const runtime = await getTerminalRuntimeBridge(activeSession)
    expect(runtime).toBeTruthy()

    await expect(runtime!.turn("fail the first provider turn")).rejects.toThrow(
      "incident-shaped provider failure",
    )

    const send = runtime!.sendActorHumanMessage!({ laneId: "lane:primary" }, "continue")
    const premature = await Promise.race([
      send.then(() => "resolved" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 1_500)),
    ])
    expect(premature).toBe("pending")

    releaseRecoveredProvider()
    const projection = await send
    expect(providerCalls).toBe(2)
    expect(projection.conversationLanes.find((lane) => lane.laneId === "lane:primary")?.status)
      .toBe("idle")

    const history = await runtime!.loadActorConversationMessages!({ laneId: "lane:primary" })
    expect(history.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "ACTOR_TARGET_RECOVERED",
    })
  })

  it("surfaces a recovered actor-target provider failure instead of returning a stale projection", async () => {
    const fixture = makeRuntimeFixture()
    activeHome = fixture.home
    activeWorkdir = fixture.workdir
    process.env.HOME = fixture.home
    activeSession = `actor-target-visible-failure-${Date.now()}`

    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        async function* failedStream() {
          throw new Error("actor-target-provider-failure")
        }
        return { stream: failedStream() }
      },
    }))

    configureTerminalRuntime({ workDir: fixture.workdir, mcp: false, timeoutSeconds: 10 })
    const runtime = await getTerminalRuntimeBridge(activeSession)

    await expect(
      runtime!.sendActorHumanMessage!({ laneId: "lane:primary" }, "continue"),
    ).rejects.toThrow("actor-target-provider-failure")

    const history = await runtime!.loadActorConversationMessages!({ laneId: "lane:primary" })
    expect(history.messages.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "continue" }],
    })
  })
})
