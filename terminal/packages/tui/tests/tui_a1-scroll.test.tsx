/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ScrollBoxRenderable } from "@opentui/core"
import { TuiA1View } from "../src/app/tui_a1"
import type { TuiA1Message } from "../src/app/tui_a1/data"
import { Clipboard } from "../src/support/util/clipboard"
import { scrollToBottom } from "../src/app/tui_a1/perf/scroll-history"

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

function buildMessages(count: number): TuiA1Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `assistant-${index}`,
    kind: "assistant" as const,
    label: "TuiA1",
    createdAt: Date.now() - (count - index) * 1000,
    text: `Message ${index}\n${"card body ".repeat(12)}`,
  }))
}

async function renderSettled(setup: Awaited<ReturnType<typeof testRender>>, passes = 2) {
  for (let index = 0; index < passes; index += 1) {
    await setup.renderOnce()
  }
}

function isNearBottom(scrollbox: ScrollBoxRenderable, tolerance = 1) {
  return scrollbox.scrollTop + scrollbox.height >= scrollbox.scrollHeight - tolerance
}

function displayWidth(text: string) {
  let width = 0
  for (const char of text) {
    width += char.codePointAt(0)! > 0xff ? 2 : 1
  }
  return width
}

function findSpanByText(setup: Awaited<ReturnType<typeof testRender>>, text: string) {
  const frame = setup.captureSpans()
  for (const [lineIndex, line] of frame.lines.entries()) {
    let x = 0
    for (const span of line.spans) {
      const offset = span.text.indexOf(text)
      if (offset >= 0) {
        return {
          ...span,
          x: x + displayWidth(span.text.slice(0, offset)),
          y: lineIndex,
        }
      }
      x += span.width ?? displayWidth(span.text)
    }
  }
  throw new Error(`Unable to find span containing ${text}`)
}

async function clickSpanByText(setup: Awaited<ReturnType<typeof testRender>>, text: string) {
  const span = findSpanByText(setup, text) as { text: string; x: number; y: number }
  const x = span.x + Math.max(1, Math.floor(displayWidth(text) / 2))
  await setup.mockMouse.click(x, span.y)
}

const PAGE_UP = "\x1b[5~"
const PAGE_DOWN = "\x1b[6~"
const originalClipboardCopy = Clipboard.copy

afterEach(() => {
  Clipboard.copy = originalClipboardCopy
})

describe("tui_a1 scrollbox", () => {
  it("coalesces repeated scroll-to-bottom requests into one scroll operation", async () => {
    let calls = 0
    const scrollbox = {
      scrollHeight: 100,
      scrollTo() {
        calls += 1
      },
    } as any

    scrollToBottom(scrollbox)
    scrollToBottom(scrollbox)
    scrollToBottom(scrollbox)
    await tick()

    expect(calls).toBe(1)
  })

  it("accepts mouse wheel scrolling inside the card list area", async () => {
    let scrollbox: ScrollBoxRenderable | undefined

    const setup = await testRender(
      () => (
        <TuiA1View
          directory={process.cwd()}
          initialMessages={buildMessages(40)}
          onScrollboxReady={(value) => {
            scrollbox = value
          }}
        />
      ),
      {
        width: 120,
        height: 40,
      },
    )

    try {
      await renderSettled(setup)

      const target = scrollbox
      expect(target).toBeTruthy()

      const before = target!.scrollTop
      expect(before).toBeGreaterThan(0)

      await setup.mockMouse.scroll(target!.x + 4, target!.y + 4, "up")
      await setup.renderOnce()

      expect(target!.scrollTop).toBeLessThan(before)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("accepts arrow-key scrolling when the composer is empty", async () => {
    let scrollbox: ScrollBoxRenderable | undefined

    const setup = await testRender(
      () => (
        <TuiA1View
          directory={process.cwd()}
          initialMessages={buildMessages(40)}
          onScrollboxReady={(value) => {
            scrollbox = value
          }}
        />
      ),
      {
        width: 120,
        height: 40,
      },
    )

    try {
      await renderSettled(setup)

      const target = scrollbox
      expect(target).toBeTruthy()

      const before = target!.scrollTop
      expect(before).toBeGreaterThan(0)

      setup.mockInput.pressArrow("up")
      await setup.renderOnce()

      expect(target!.scrollTop).toBeLessThan(before)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("accepts PageUp/PageDown/Home/End navigation when the composer is empty", async () => {
    let scrollbox: ScrollBoxRenderable | undefined

    const setup = await testRender(
      () => (
        <TuiA1View
          directory={process.cwd()}
          initialMessages={buildMessages(60)}
          onScrollboxReady={(value) => {
            scrollbox = value
          }}
        />
      ),
      {
        width: 120,
        height: 40,
      },
    )

    try {
      await renderSettled(setup)

      const target = scrollbox
      expect(target).toBeTruthy()
      expect(isNearBottom(target!)).toBe(true)

      const before = target!.scrollTop
      setup.mockInput.pressKey(PAGE_UP)
      await renderSettled(setup, 1)
      expect(target!.scrollTop).toBeLessThan(before)

      const afterPageUp = target!.scrollTop
      setup.mockInput.pressKey(PAGE_DOWN)
      await renderSettled(setup, 1)
      expect(target!.scrollTop).toBeGreaterThan(afterPageUp)

      setup.mockInput.pressKey("HOME")
      await renderSettled(setup, 1)
      expect(target!.scrollTop).toBe(0)

      setup.mockInput.pressKey("END")
      await renderSettled(setup, 1)
      expect(isNearBottom(target!)).toBe(true)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("keeps manual history browsing stable while a local reply keeps streaming", async () => {
    let scrollbox: ScrollBoxRenderable | undefined

    const setup = await testRender(
      () => (
        <TuiA1View
          directory={process.cwd()}
          initialMessages={buildMessages(60)}
          initialPrompt="stabilize scroll behaviour"
          onScrollboxReady={(value) => {
            scrollbox = value
          }}
        />
      ),
      {
        width: 120,
        height: 40,
      },
    )

    try {
      await renderSettled(setup, 3)

      const target = scrollbox
      expect(target).toBeTruthy()
      expect(isNearBottom(target!)).toBe(true)

      setup.mockInput.pressKey(PAGE_UP)
      await renderSettled(setup, 1)

      const manualTop = target!.scrollTop
      expect(isNearBottom(target!)).toBe(false)

      await Bun.sleep(550)
      await renderSettled(setup, 3)

      expect(target!.scrollTop).toBeLessThanOrEqual(manualTop + 1)
      expect(isNearBottom(target!)).toBe(false)

      setup.mockInput.pressKey("END")
      await renderSettled(setup, 1)
      expect(isNearBottom(target!)).toBe(true)

      await Bun.sleep(120)
      await renderSettled(setup, 2)
      expect(isNearBottom(target!)).toBe(true)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("ignores wheel-driven history scrolling while text selection is active", async () => {
    let scrollbox: ScrollBoxRenderable | undefined

    const setup = await testRender(
      () => (
        <TuiA1View
          directory={process.cwd()}
          initialMessages={buildMessages(40)}
          onScrollboxReady={(value) => {
            scrollbox = value
          }}
        />
      ),
      {
        width: 120,
        height: 40,
      },
    )

    try {
      await renderSettled(setup)

      const target = scrollbox
      expect(target).toBeTruthy()

      const before = target!.scrollTop
      Object.defineProperty(setup.renderer, "getSelection", {
        configurable: true,
        value: () => ({
          getSelectedText: () => "selected text",
        }),
      })

      await setup.mockMouse.scroll(target!.x + 4, target!.y + 4, "up")
      await renderSettled(setup, 1)

      expect(target!.scrollTop).toBeLessThanOrEqual(before + 1)
    } finally {
      setup.renderer.destroy()
    }
  })

  it("copies selected history text on mouse release", async () => {
    const copied: string[] = []
    Clipboard.copy = async (text: string) => {
      copied.push(text)
    }

    const setup = await testRender(
      () => (
        <TuiA1View
          directory={process.cwd()}
          initialMessages={buildMessages(4)}
        />
      ),
      {
        width: 120,
        height: 40,
      },
    )

    try {
      await renderSettled(setup)

      Object.defineProperty(setup.renderer, "getSelection", {
        configurable: true,
        value: () => ({
          getSelectedText: () => "Message 3",
        }),
      })

      const target = findSpanByText(setup, "Message 3")
      await setup.mockMouse.click(target.x + 2, target.y)
      await renderSettled(setup, 1)

      expect(copied).toEqual(["Message 3"])
    } finally {
      setup.renderer.destroy()
    }
  })

  it("lets the history regain wheel and keyboard scrolling while the composer still has draft text", async () => {
    let scrollbox: ScrollBoxRenderable | undefined

    const setup = await testRender(
      () => (
        <TuiA1View
          directory={process.cwd()}
          initialMessages={buildMessages(60)}
          onScrollboxReady={(value) => {
            scrollbox = value
          }}
        />
      ),
      {
        width: 120,
        height: 40,
      },
    )

    try {
      await renderSettled(setup)

      const target = scrollbox
      expect(target).toBeTruthy()

      await setup.mockInput.typeText("draft still here")
      await renderSettled(setup, 1)

      await setup.mockMouse.click(target!.x + 4, target!.y + 4)
      await renderSettled(setup, 1)

      const beforeWheel = target!.scrollTop
      await setup.mockMouse.scroll(target!.x + 4, target!.y + 4, "up")
      await renderSettled(setup, 1)

      const afterWheel = target!.scrollTop
      expect(afterWheel).toBeLessThanOrEqual(beforeWheel)

      await setup.mockMouse.moveTo(target!.x + 4, target!.y + 4)
      await renderSettled(setup, 1)

      const beforeArrow = target!.scrollTop
      setup.mockInput.pressArrow("up")
      await renderSettled(setup, 1)

      expect(target!.scrollTop).toBeLessThan(beforeArrow)
      expect(setup.captureCharFrame()).toContain("draft still here")
    } finally {
      setup.renderer.destroy()
    }
  })

  it("keeps history scrolling stable after repeated focus toggles once streaming has finished", async () => {
    let scrollbox: ScrollBoxRenderable | undefined

    const setup = await testRender(
      () => (
        <TuiA1View
          directory={process.cwd()}
          initialMessages={buildMessages(60)}
          initialPrompt="finish a local stream first"
          onOpenSessionList={() => {}}
          onOpenUsage={() => {}}
          onOpenFunctionMenu={() => {}}
          onScrollboxReady={(value) => {
            scrollbox = value
          }}
        />
      ),
      {
        width: 120,
        height: 40,
      },
    )

    try {
      await renderSettled(setup, 3)
      await Bun.sleep(1500)
      await renderSettled(setup, 3)

      const target = scrollbox
      expect(target).toBeTruthy()
      expect(isNearBottom(target!)).toBe(true)

      await clickSpanByText(setup, "会话列表")
      await renderSettled(setup, 2)
      await clickSpanByText(setup, "使用说明")
      await renderSettled(setup, 2)
      await clickSpanByText(setup, "功能菜单")
      await renderSettled(setup, 2)
      await clickSpanByText(setup, "会话列表")
      await renderSettled(setup, 2)
      await clickSpanByText(setup, "使用说明")
      await renderSettled(setup, 2)

      const beforeWheel = target!.scrollTop
      await setup.mockMouse.scroll(target!.x + 4, target!.y + 4, "up")
      await renderSettled(setup, 1)
      expect(target!.scrollTop).toBeLessThan(beforeWheel)

      const beforeArrow = target!.scrollTop
      setup.mockInput.pressArrow("up")
      await renderSettled(setup, 1)

      expect(target!.scrollTop).toBeLessThan(beforeArrow)
    } finally {
      setup.renderer.destroy()
    }
  })

})
