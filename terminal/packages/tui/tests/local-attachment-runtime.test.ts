import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { installBundledSystemSkills } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import { createLocalAttachmentResolver } from "../src/support/attachment-resolver"
import {
  __setLlmAdapterFactoryForTest, configureTuiRuntime, disposeTuiRuntimeBridge, getTuiRuntimeBridge,
} from "../src/runtime/bridge/TuiRuntime"

test("TUI resolves file references through shared assembly into provider input and durable history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tui-attachment-runtime-"))
  const globalRoot = path.join(root, "authority")
  const sessionKey = "attachment-roundtrip"
  const textPath = path.join(root, "local notes.txt")
  const imagePath = path.join(root, "local image.bin")
  const binaryPath = path.join(root, "unsupported.bin")
  const imageBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fixture")])
  let captured = ""
  let calls = 0
  try {
    await installBundledSystemSkills({ globalRoot })
    fs.mkdirSync(path.join(root, ".eidolon"), { recursive: true })
    fs.writeFileSync(path.join(root, ".eidolon", "llm-provider.json"), JSON.stringify({ providers: [{
      id: "attachment-fixture", adapter: "openai", options: { apiKey: "fixture-only", baseURL: "https://unused.invalid" },
      models: [{ id: "gpt-4o-mini", limits: { context: 128000, output: 8192 }, modalities: { input: ["text", "image"], output: ["text"] } }],
    }] }))
    fs.writeFileSync(textPath, "attachment text snapshot")
    fs.writeFileSync(imagePath, imageBytes)
    fs.writeFileSync(binaryPath, Buffer.from([0, 255, 1]))
    __setLlmAdapterFactoryForTest(async () => ({ type: "openai" as const, async createStream(options: { messages?: unknown[] }) {
      calls += 1
      captured = JSON.stringify(options.messages)
      return { stream: (async function* () { yield { choices: [{ delta: { content: "attachments received" } }] } })() }
    } }))
    configureTuiRuntime({ workDir: root, globalRoot, model: "attachment-fixture/gpt-4o-mini", mcp: false,
      attachmentResolver: createLocalAttachmentResolver() })
    const runtime = await getTuiRuntimeBridge(sessionKey)
    expect(await runtime!.turn([
      { type: "text", text: "inspect attachments" },
      { type: "file_reference", path: textPath, filename: "notes.txt" },
      { type: "file_reference", path: imagePath, filename: "image.png" },
    ])).toContain("attachments received")
    expect(captured).toContain("attachment text snapshot")
    expect(captured).toContain(imageBytes.toString("base64"))
    expect(captured).not.toContain(textPath)
    expect(captured).not.toContain(imagePath)
    await expect(runtime!.turn([{ type: "file_reference", path: binaryPath, filename: "unsupported.bin" }]))
      .rejects.toThrow("attachment_unsupported_binary:unsupported.bin")
    expect(calls).toBe(1)
    await disposeTuiRuntimeBridge(sessionKey)
    const reopened = await getTuiRuntimeBridge(sessionKey)
    const history = JSON.stringify((await reopened!.loadConversationViews!())!.historyMessages)
    expect(history).toContain("attachment text snapshot")
    expect(history).toContain(imageBytes.toString("base64"))
    expect(history).not.toContain(textPath)
    expect(history).not.toContain(imagePath)
    expect(await reopened!.turn("continue after attachment rejection")).toContain("attachments received")
    expect(calls).toBe(2)
  } finally {
    await disposeTuiRuntimeBridge(sessionKey)
    __setLlmAdapterFactoryForTest(null)
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
