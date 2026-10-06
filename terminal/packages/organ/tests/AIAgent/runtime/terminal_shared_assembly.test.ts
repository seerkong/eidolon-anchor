import { expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { installBundledSystemSkills } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import {
  configureTuiRuntime,
  getTuiRuntimeBridge,
  getTextualRuntimeBridge,
  disposeTuiRuntimeBridge,
  disposeTextualRuntimeBridge,
  __setLlmAdapterFactoryForTest,
} from "../../../src/AIAgent/TerminalRuntime"
import { createMockProviderCacheCostObservation } from "../../../../../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream"
import { projectInputContentText } from "@shared/composer"

it("retains terminal projection and session history through shared real assembly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-shared-assembly-"))
  const globalRoot = path.join(root, "authority")
  const workDir = path.join(root, "workspace")
  fs.mkdirSync(path.join(workDir, ".eidolon"), { recursive: true })
  __setLlmAdapterFactoryForTest(async () => ({
    type: "openai",
    runtime: { adapterName: "openai", providerId: "openai" },
    async createStream(options: any) {
      const text = projectInputContentText(options.messages.filter((message: any) => message.role === "user").at(-1).content)
      async function* stream() {
        yield { choices: [{ delta: { reasoning_content: "thinking" } }] }
        yield { choices: [{ delta: { content: `reply:${text}` } }] }
        yield { choices: [{ delta: {}, finish_reason: "stop" }] }
      }
      return { stream: stream(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
    },
  }))
  try {
    await installBundledSystemSkills({ globalRoot })
    configureTuiRuntime({ workDir, globalRoot, adapter: "openai", model: "gpt-4o-mini", mcp: false })
    const tui = await getTuiRuntimeBridge("tui-session")
    const textual = await getTextualRuntimeBridge("text-session")
    const categories: string[] = []
    expect(await tui!.turn("terminal", { onControl: (control) => { if (control.category) categories.push(control.category) } })).toContain("reply:terminal")
    expect(categories).toContain("turn")
    expect(categories).toContain("assist")
    expect(categories).toContain("done")
    expect(await textual!.turn("textual")).toContain("reply:textual")
    expect((await tui!.loadConversationViews!())!.historyMessages.filter((row) => row.role === "user").map((row) => projectInputContentText(row.content))).toEqual(["terminal"])
    expect((await textual!.loadConversationViews!())!.historyMessages.filter((row) => row.role === "user").map((row) => projectInputContentText(row.content))).toEqual(["textual"])
  } finally {
    await Promise.all([disposeTuiRuntimeBridge("tui-session"), disposeTextualRuntimeBridge("text-session")])
    __setLlmAdapterFactoryForTest(null)
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
