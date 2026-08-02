/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { existsSync } from "fs"
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { RuntimeClientProvider } from "../src/providers/runtime-client"
import { TuiA1Shell } from "../src/app/tui_a1"
import { tuiA1Theme as theme } from "../src/app/tui_a1/theme"
import { Clipboard } from "../src/support/util/clipboard"
import { createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))
const createdDirs: string[] = []
const originalClipboardCopy = Clipboard.copy
const originalClipboardRead = Clipboard.read

afterEach(async () => {
  Clipboard.copy = originalClipboardCopy
  Clipboard.read = originalClipboardRead
  while (createdDirs.length > 0) {
    const directory = createdDirs.pop()
    if (!directory) break
    await rm(directory, { recursive: true, force: true })
  }
})

async function renderSettled(setup: Awaited<ReturnType<typeof testRender>>, passes = 4) {
  for (let index = 0; index < passes; index += 1) {
    await tick()
    await setup.renderOnce()
  }
}

function captureText(setup: Awaited<ReturnType<typeof testRender>>) {
  const frame = setup.captureSpans()
  return frame.lines.map((line) => line.spans.map((span) => span.text).join("")).join("\n")
}

function renderTuiA1(directory: string, runtime?: ReturnType<typeof createTuiRuntimeClient>) {
  return (
    <RuntimeClientProvider url="mock" client={runtime}>
      <TuiA1Shell directory={directory} sessionID="ses_1" isAttachmentFile={existsSync} />
    </RuntimeClientProvider>
  )
}

describe("tuiA1 composer file picker", () => {
  it("turns bracketed-paste file paths into atomic attachment blocks", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "eidolon-composer-path-paste-"))
    createdDirs.push(directory)
    const attachmentPath = path.join(directory, "meeting notes.md")
    await writeFile(attachmentPath, "notes\n")

    const setup = await testRender(() => renderTuiA1(directory), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 5)
      await setup.mockInput.pasteBracketedText(`"${attachmentPath}"`)
      await renderSettled(setup, 4)

      let text = captureText(setup)
      expect(text).toContain("@fs:meeting notes.md")
      expect(text).toContain("parts 1 file")
      expect(text).toContain("1 parts")

      setup.mockInput.pressBackspace()
      await renderSettled(setup, 4)

      text = captureText(setup)
      expect(text).not.toContain("@fs:meeting notes.md")
      expect(text).not.toContain("parts 1 file")
      expect(text).toContain("0 chars · 0 parts")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("keeps ordinary bracketed paste as text and shares the attachment shape for clipboard images", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "eidolon-composer-clipboard-"))
    createdDirs.push(directory)
    Clipboard.read = async () => ({ mime: "image/png", data: "aW1hZ2U=" })

    const setup = await testRender(() => renderTuiA1(directory), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 5)
      await setup.mockInput.pasteBracketedText("ordinary pasted text")
      await renderSettled(setup, 3)
      expect(captureText(setup)).toContain("ordinary pasted text")
      expect(captureText(setup)).toContain("0 parts")

      setup.mockInput.pressKey("v", { ctrl: true })
      await renderSettled(setup, 4)
      const text = captureText(setup)
      expect(text).toContain("@fs:clipboard-image.png")
      expect(text).toContain("parts 1 file")
      expect(text).toContain("1 parts")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("keeps the file tree stable and inserts a visible file part into the composer", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "eidolon-composer-picker-"))
    createdDirs.push(directory)
    await mkdir(path.join(directory, "src"), { recursive: true })
    await writeFile(path.join(directory, "README.md"), "# hello\n")
    await writeFile(path.join(directory, "src/app.ts"), "export const app = true\n")

    const setup = await testRender(() => renderTuiA1(directory), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 5)
      expect(captureText(setup)).toContain("Actor")

      const before = (setup.renderer as unknown as { listenerCount?: (name: string) => number }).listenerCount?.("selection")
      setup.mockInput.pressKey("o", { ctrl: true })
      await renderSettled(setup, 6)

      const openText = captureText(setup)
      const afterOpen = (setup.renderer as unknown as { listenerCount?: (name: string) => number }).listenerCount?.("selection")
      expect(openText).toContain("Insert file")
      expect(openText).toContain("Enter insert file into prompt")
      expect(openText).toContain("filter all files")
      expect(openText).toContain(`path ${path.basename(directory)} / src`)
      expect(openText).toContain("src/")
      expect(openText).toContain("README.md")
      expect(openText).not.toContain("score")
      expect(afterOpen).toBe((before ?? 0) + 1)

      await renderSettled(setup, 6)
      const afterStable = (setup.renderer as unknown as { listenerCount?: (name: string) => number }).listenerCount?.("selection")
      expect(afterStable).toBe(afterOpen)

      await setup.mockInput.typeText("read")
      await renderSettled(setup, 2)
      const jumpedText = captureText(setup)
      expect(jumpedText).toContain("filter read")
      expect(jumpedText).toContain(`path ${path.basename(directory)} / README.md`)
      setup.mockInput.pressEnter()
      await renderSettled(setup, 6)
      await setup.mockInput.typeText("next")
      await renderSettled(setup, 3)

      const composerText = captureText(setup)
      expect(composerText).toContain("@fs:README.md next")
      expect(composerText).toContain("parts 1 file")
      expect(composerText).not.toContain("parts @fs:README.md")

      const afterClose = (setup.renderer as unknown as { listenerCount?: (name: string) => number }).listenerCount?.("selection")
      expect(afterClose).toBe(before)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("clears the current draft with the dedicated shortcut", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "eidolon-composer-clear-"))
    createdDirs.push(directory)

    const setup = await testRender(() => renderTuiA1(directory), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 5)

      await setup.mockInput.typeText("draft text")
      await renderSettled(setup, 2)
      expect(captureText(setup)).toContain("draft text")

      setup.mockInput.pressKey("l", { ctrl: true, shift: true })
      await renderSettled(setup, 3)

      const text = captureText(setup)
      expect(text).not.toContain("draft text")
      expect(text).toContain("0 chars · 0 parts")

      const frame = setup.captureSpans()
      const spans = frame.lines.flatMap((line) => line.spans)
      const selectionSpan = spans.find((span) => span.text.includes("Code ·"))
      const metricsSpan = spans.find((span) => span.text.includes("0 chars · 0 parts"))
      expect(selectionSpan?.bg).not.toEqual(theme.panelGlow)
      expect(metricsSpan?.bg).not.toEqual(theme.panelGlow)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("clears text and attachment parts before the runtime turn settles", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "eidolon-composer-submit-clear-"))
    createdDirs.push(directory)
    const attachmentPath = path.join(directory, "pending notes.md")
    await writeFile(attachmentPath, "notes\n")

    const runtime = createTuiRuntimeClient()
    await runtime.client.session.create({ sessionID: "ses_1" } as any)
    const originalPrompt = runtime.client.session.prompt.bind(runtime.client.session)
    runtime.client.session.prompt = (() => new Promise(() => {})) as typeof runtime.client.session.prompt

    const setup = await testRender(() => renderTuiA1(directory, runtime), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 5)
      await setup.mockInput.typeText("review ")
      await setup.mockInput.pasteBracketedText(`"${attachmentPath}"`)
      await renderSettled(setup, 4)
      expect(captureText(setup)).toContain("@fs:pending notes.md")

      setup.mockInput.pressEnter()
      await renderSettled(setup, 4)

      const text = captureText(setup)
      expect(text).not.toContain("review")
      expect(text).not.toContain("@fs:pending notes.md")
      expect(text).toContain("0 chars · 0 parts")
    } finally {
      runtime.client.session.prompt = originalPrompt
      setup.renderer.destroy()
    }
  })

  it("inserts a selected agent mention into the composer", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "eidolon-composer-mention-"))
    createdDirs.push(directory)

    const setup = await testRender(() => renderTuiA1(directory), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 5)

      setup.mockInput.pressKey("g", { ctrl: true })
      await renderSettled(setup, 4)
      const openText = captureText(setup)
      expect(openText).toContain("Insert mention")
      expect(openText).toContain("Implement code changes and complete the")
      expect(openText).toContain("task end to end")

      setup.mockInput.pressEnter()
      await renderSettled(setup, 4)
      await setup.mockInput.typeText("next")
      await renderSettled(setup, 3)

      const text = captureText(setup)
      expect(text).toContain("@build next")
      expect(text).toContain("1 parts")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("copies selected composer text on mouse release", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "eidolon-composer-copy-"))
    createdDirs.push(directory)
    const copied: string[] = []
    Clipboard.copy = async (text: string) => {
      copied.push(text)
    }

    const setup = await testRender(() => renderTuiA1(directory), {
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })

    try {
      await renderSettled(setup, 5)
      await setup.mockInput.typeText("draft text")
      await renderSettled(setup, 2)

      Object.defineProperty(setup.renderer, "getSelection", {
        configurable: true,
        value: () => ({
          getSelectedText: () => "draft text",
        }),
      })

      const frame = setup.captureSpans()
      const draftLine = frame.lines.findIndex((line) => line.spans.some((span) => span.text.includes("draft text")))
      expect(draftLine).toBeGreaterThanOrEqual(0)
      await setup.mockMouse.click(4, draftLine)
      await renderSettled(setup, 1)

      expect(copied).toEqual(["draft text"])
    } finally {
      setup.renderer.destroy()
    }
  })
})
