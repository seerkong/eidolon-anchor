import { describe, expect, it } from "bun:test"
import eidolonFlat from "../src/providers/theme/eidolon-flat.json" with { type: "json" }
import { DEFAULT_THEMES, OFFICIAL_THEME_ID } from "../src/providers/theme"
import { resolveTheme } from "../src/providers/theme/resolve"

describe("official theme", () => {
  it("exposes a single official theme id", () => {
    expect(OFFICIAL_THEME_ID).toBe("eidolon-flat")
    expect(Object.keys(DEFAULT_THEMES)).toEqual([OFFICIAL_THEME_ID])
  })

  it("resolves the official theme in both dark and light modes", () => {
    const dark = resolveTheme(eidolonFlat, "dark")
    const light = resolveTheme(eidolonFlat, "light")

    expect(dark.background.r).toBeCloseTo(0x0f / 255, 5)
    expect(dark.background.g).toBeCloseTo(0x11 / 255, 5)
    expect(dark.background.b).toBeCloseTo(0x14 / 255, 5)
    expect(light.background.r).toBeCloseTo(0xf5 / 255, 5)
    expect(light.background.g).toBeCloseTo(0xf7 / 255, 5)
    expect(light.background.b).toBeCloseTo(0xfa / 255, 5)
    expect(dark.borderActive.r).toBeCloseTo(0x55 / 255, 5)
    expect(dark.borderActive.g).toBeCloseTo(0xd1 / 255, 5)
    expect(dark.borderActive.b).toBeCloseTo(0x6a / 255, 5)
    expect(light.borderActive.r).toBeCloseTo(0x1f / 255, 5)
    expect(light.borderActive.g).toBeCloseTo(0x7a / 255, 5)
    expect(light.borderActive.b).toBeCloseTo(0x36 / 255, 5)
  })
})
