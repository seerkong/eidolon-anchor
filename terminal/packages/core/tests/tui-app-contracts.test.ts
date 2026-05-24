import { describe, expect, it } from "bun:test"
import { isDefaultSessionTitle, parseModelRef, TuiSessionEvents } from "@terminal/core/AIAgent"

describe("TUI app shared contracts", () => {
  it("parses provider/model refs in a shared location", () => {
    expect(parseModelRef("openai/gpt-4o")).toEqual({
      providerID: "openai",
      modelID: "gpt-4o",
    })
    expect(parseModelRef("codeflicker/wanqing/gpt-5.4")).toEqual({
      providerID: "codeflicker",
      modelID: "wanqing/gpt-5.4",
    })
    expect(parseModelRef(" openai/gpt-4o ")).toEqual({
      providerID: "openai",
      modelID: "gpt-4o",
    })
    expect(parseModelRef("openai")).toBeUndefined()
    expect(parseModelRef("")).toBeUndefined()
  })

  it("keeps session shell helpers in core instead of TUI-local copies", () => {
    expect(TuiSessionEvents.Deleted.type).toBe("session.deleted")
    expect(TuiSessionEvents.Error.type).toBe("session.error")
    expect(isDefaultSessionTitle(undefined)).toBe(true)
    expect(isDefaultSessionTitle("")).toBe(true)
    expect(isDefaultSessionTitle("   ")).toBe(true)
    expect(isDefaultSessionTitle("Sprint Review")).toBe(false)
  })
})
