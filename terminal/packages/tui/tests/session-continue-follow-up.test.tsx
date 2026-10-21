/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { installBundledSystemSkills } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import { createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"
import { TuiA1View } from "../src/app/tui_a1"
import {
  __setLlmAdapterFactoryForTest,
  configureTuiRuntime,
  disposeTuiRuntimeBridge,
  getTuiRuntimeBridge,
} from "../src/runtime/bridge/TuiRuntime"

const SESSION_ID = "recovered-follow-up"
const originalHome = process.env.HOME
const originalUserProfile = process.env.USERPROFILE
let tempRoot: string | undefined

function textOf(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(textOf).join("")
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).map(textOf).join("")
  return ""
}

afterEach(async () => {
  try {
    await disposeTuiRuntimeBridge(SESSION_ID)
  } finally {
    __setLlmAdapterFactoryForTest(null)
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
    tempRoot = undefined
  }
})

test("recovered session accepts a follow-up prompt and starts another model turn", async () => {
  tempRoot = await mkdtemp(path.join(tmpdir(), "eidolon-continue-"))
  const workDir = path.join(tempRoot, "workspace")
  const homeDir = path.join(tempRoot, "home")
  const globalRoot = path.join(homeDir, ".eidolon")
  await mkdir(workDir, { recursive: true })
  await mkdir(globalRoot, { recursive: true })
  await writeFile(path.join(globalRoot, "llm-provider.json"), JSON.stringify({
    providers: [{
      id: "openai",
      adapter: "openai",
      options: { baseURL: "http://127.0.0.1:9", apiKey: "test" },
      models: [{ id: "gpt-4o-mini", limits: { context: 128000, output: 8192 } }],
    }],
  }))
  await writeFile(path.join(globalRoot, "agent-present.json"), JSON.stringify({
    "default-preset": "fixture",
    presets: { fixture: { primary: { model: "openai/gpt-4o-mini" } } },
  }))
  process.env.HOME = homeDir
  process.env.USERPROFILE = homeDir

  const calls: string[] = []
  __setLlmAdapterFactoryForTest(async () => ({
    type: "openai" as const,
    runtime: { adapterName: "openai", providerId: "openai", chatCompatibilityProfileId: "openai-chat@1" },
    async createStream(options: { messages?: unknown }) {
      const text = textOf(options.messages)
      calls.push(text)
      async function* stream() {
        yield { choices: [{ delta: { content: text.includes("please-continue") ? "CONTINUED-OK" : "FIXTURE-READY" } }] }
        yield { choices: [{ delta: {}, finish_reason: "stop" }] }
      }
      return {
        stream: stream(),
        providerOutput: Promise.resolve({
          provider_cache_cost_observation: {
            requestDigest: `sha256:${createHash("sha256").update(JSON.stringify(options)).digest("hex")}`,
          },
        }),
      }
    },
  }))
  await installBundledSystemSkills({ globalRoot })
  configureTuiRuntime({ workDir, globalRoot, adapter: "openai", model: "gpt-4o-mini", debug: false, mcp: false })

  // Let the runtime own the current snapshot/index format and finish its writer
  // lifecycle before the UI opens a new bridge for the same persisted session.
  const seed = await getTuiRuntimeBridge(SESSION_ID)
  expect(seed).not.toBeNull()
  try {
    expect(await seed!.turn("create-fixture")).toContain("FIXTURE-READY")
  } finally {
    await disposeTuiRuntimeBridge(SESSION_ID)
  }
  const runtimeStateDir = path.join(workDir, ".eidolon", "sessions", SESSION_ID, "runtime_state")
  const manifest = JSON.parse(await readFile(path.join(runtimeStateDir, "manifest.json"), "utf8"))
  expect(manifest.version).toBe(4)
  const actorIndexPath = manifest.indexFiles.find((file: string) => file.endsWith("indexes/actors_by_key.json"))
  expect(actorIndexPath).toBeDefined()
  const actorIndex = JSON.parse(await readFile(path.join(runtimeStateDir, actorIndexPath), "utf8"))
  expect(actorIndex.schemaVersion).toBe(4)
  expect(actorIndex.kind).toBe("actors_by_key")
  expect(Object.keys(actorIndex.entries)).toContain(manifest.controlActorKey)
  calls.length = 0

  const sdk = createTuiRuntimeClient({ mode: "local-runtime", directory: workDir })
  let ui: Awaited<ReturnType<typeof testRender>> | undefined
  try {
    ui = await testRender(() => <TuiA1View directory={workDir} runtime={sdk} sessionID={SESSION_ID} />, {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })
    const waitForFrame = async (text: string) => {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        await Bun.sleep(10)
        await ui!.renderOnce()
        const frame = ui!.captureCharFrame()
        expect(frame).not.toContain("会话历史已变化")
        expect(frame).not.toContain("History changed")
        if (frame.includes(text)) return
      }
      throw new Error(`Timed out waiting for ${text}:\n${ui!.captureCharFrame()}`)
    }
    // Prove that the persisted first turn has been recovered before submitting once.
    await waitForFrame("FIXTURE-READY")
    await sdk.client.session.prompt({
      sessionID: SESSION_ID,
      messageID: "follow-up",
      model: { providerID: "openai", modelID: "gpt-4o-mini" },
      parts: [{ id: "follow-up-text", sessionID: SESSION_ID, messageID: "follow-up", type: "text", text: "please-continue" }],
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("please-continue")
    expect(calls[0]).toContain("create-fixture")
    await waitForFrame("CONTINUED-OK")
  } finally {
    ui?.renderer.destroy()
    await sdk.client.instance.dispose()
  }
}, 60_000)
