import { describe, expect, it } from "bun:test"
import type { TuiA1Message } from "../src/app/tui_a1/data"
import {
  computeVirtualHistoryWindow,
  prependScrollAnchor,
} from "../src/app/tui_a1/perf/virtual-history-window"

const messages = Array.from({ length: 300 }, (_, index): TuiA1Message => ({
  id: `m-${index}`,
  kind: index % 2 === 0 ? "user" : "assistant",
  text: `message ${index} ${"x".repeat(index % 11)}`,
  createdAt: index,
}))

describe("virtual session history window", () => {
  it("mounts only viewport plus overscan while retaining spacer geometry", () => {
    const window = computeVirtualHistoryWindow({
      messages,
      scrollTop: 600,
      viewportHeight: 30,
      width: 100,
    })
    expect(window.messages.length).toBeLessThan(40)
    expect(window.messages.length).toBeGreaterThan(0)
    expect(window.topSpacer).toBeGreaterThan(0)
    expect(window.bottomSpacer).toBeGreaterThan(0)
    expect(window.topSpacer + window.bottomSpacer).toBeLessThan(window.totalHeight)
  })

  it("keeps the prior viewport anchor after older content is prepended", () => {
    expect(prependScrollAnchor({ insertedHeight: 160, scrollTop: 8 })).toBe(168)
  })

  it("uses measured card heights as feedback for later window projections", () => {
    const baseline = computeVirtualHistoryWindow({
      messages: messages.slice(0, 10),
      scrollTop: 0,
      viewportHeight: 10,
      width: 100,
    })
    const measured = computeVirtualHistoryWindow({
      messages: messages.slice(0, 10),
      scrollTop: 0,
      viewportHeight: 10,
      width: 100,
      measuredHeights: new Map([["m-0", 30]]),
    })
    expect(measured.totalHeight).toBeGreaterThan(baseline.totalHeight)
    expect(measured.messages.length).toBeLessThan(baseline.messages.length)
  })
})
