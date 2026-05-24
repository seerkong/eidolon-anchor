import { describe, expect, it } from "bun:test"
import { RGBA } from "@opentui/core"
import { resolveTheme, ansiToRgba, selectedForeground, type Theme, type ThemeJson } from "../src/providers/theme/resolve"

function makeMinimalThemeJson(overrides?: Partial<ThemeJson["theme"]>): ThemeJson {
  const hex = "#112233"
  return {
    theme: {
      primary: hex,
      secondary: hex,
      accent: hex,
      error: "#ff0000",
      warning: hex,
      success: hex,
      info: hex,
      text: "#ffffff",
      textMuted: "#888888",
      background: "#000000",
      backgroundPanel: hex,
      backgroundElement: hex,
      border: hex,
      borderActive: hex,
      borderSubtle: hex,
      diffAdded: hex,
      diffRemoved: hex,
      diffContext: hex,
      diffHunkHeader: hex,
      diffHighlightAdded: hex,
      diffHighlightRemoved: hex,
      diffAddedBg: hex,
      diffRemovedBg: hex,
      diffContextBg: hex,
      diffLineNumber: hex,
      diffAddedLineNumberBg: hex,
      diffRemovedLineNumberBg: hex,
      markdownText: hex,
      markdownHeading: hex,
      markdownLink: hex,
      markdownLinkText: hex,
      markdownCode: hex,
      markdownBlockQuote: hex,
      markdownEmph: hex,
      markdownStrong: hex,
      markdownHorizontalRule: hex,
      markdownListItem: hex,
      markdownListEnumeration: hex,
      markdownImage: hex,
      markdownImageText: hex,
      markdownCodeBlock: hex,
      syntaxComment: hex,
      syntaxKeyword: hex,
      syntaxFunction: hex,
      syntaxVariable: hex,
      syntaxString: hex,
      syntaxNumber: hex,
      syntaxType: hex,
      syntaxOperator: hex,
      syntaxPunctuation: hex,
      ...overrides,
    },
  }
}

describe("resolveTheme", () => {
  it("resolves hex colors", () => {
    const theme = resolveTheme(makeMinimalThemeJson({ primary: "#ff0000" }), "dark")
    const [r, g, b, a] = theme.primary.toInts()
    expect(r).toBe(255)
    expect(g).toBe(0)
    expect(b).toBe(0)
    expect(a).toBe(255)
  })

  it("resolves defs references", () => {
    const json: ThemeJson = {
      defs: { myColor: "#00ff00" },
      theme: {
        ...makeMinimalThemeJson().theme,
        primary: "myColor" as any,
      },
    }
    const theme = resolveTheme(json, "dark")
    const [r, g, b] = theme.primary.toInts()
    expect(r).toBe(0)
    expect(g).toBe(255)
    expect(b).toBe(0)
  })

  it("resolves dark/light variants", () => {
    const json = makeMinimalThemeJson({
      primary: { dark: "#ff0000", light: "#00ff00" } as any,
    })
    const dark = resolveTheme(json, "dark")
    expect(dark.primary.toInts()[0]).toBe(255)

    const light = resolveTheme(json, "light")
    expect(light.primary.toInts()[1]).toBe(255)
  })

  it("resolves transparent keyword", () => {
    const json = makeMinimalThemeJson({ background: "transparent" as any })
    const theme = resolveTheme(json, "dark")
    expect(theme.background.a).toBe(0)
  })

  it("defaults selectedListItemText to background when not specified", () => {
    const json = makeMinimalThemeJson({ background: "#aabbcc" })
    const theme = resolveTheme(json, "dark")
    expect(theme._hasSelectedListItemText).toBe(false)
    expect(theme.selectedListItemText.toInts()).toEqual(theme.background.toInts())
  })

  it("uses explicit selectedListItemText when specified", () => {
    const json = makeMinimalThemeJson()
    json.theme.selectedListItemText = "#ff00ff"
    const theme = resolveTheme(json, "dark")
    expect(theme._hasSelectedListItemText).toBe(true)
    const [r, , b] = theme.selectedListItemText.toInts()
    expect(r).toBe(255)
    expect(b).toBe(255)
  })

  it("defaults backgroundMenu to backgroundElement", () => {
    const json = makeMinimalThemeJson({ backgroundElement: "#334455" })
    const theme = resolveTheme(json, "dark")
    expect(theme.backgroundMenu.toInts()).toEqual(theme.backgroundElement.toInts())
  })

  it("defaults thinkingOpacity to 0.6", () => {
    const theme = resolveTheme(makeMinimalThemeJson(), "dark")
    expect(theme.thinkingOpacity).toBe(0.6)
  })

  it("uses explicit thinkingOpacity", () => {
    const json = makeMinimalThemeJson()
    json.theme.thinkingOpacity = 0.3
    const theme = resolveTheme(json, "dark")
    expect(theme.thinkingOpacity).toBe(0.3)
  })

  it("throws on unknown color reference", () => {
    const json = makeMinimalThemeJson({ primary: "nonexistent" as any })
    expect(() => resolveTheme(json, "dark")).toThrow('Color reference "nonexistent" not found')
  })
})

describe("ansiToRgba", () => {
  it("converts standard ANSI black (0)", () => {
    const [r, g, b, a] = ansiToRgba(0).toInts()
    expect(r).toBe(0)
    expect(g).toBe(0)
    expect(b).toBe(0)
    expect(a).toBe(255)
  })

  it("converts standard ANSI bright white (15)", () => {
    const [r, g, b] = ansiToRgba(15).toInts()
    expect(r).toBe(255)
    expect(g).toBe(255)
    expect(b).toBe(255)
  })

  it("converts 6x6x6 color cube (code 16 = rgb(0,0,0))", () => {
    const [r, g, b] = ansiToRgba(16).toInts()
    expect(r).toBe(0)
    expect(g).toBe(0)
    expect(b).toBe(0)
  })

  it("converts 6x6x6 color cube (code 196 = rgb(255,0,0))", () => {
    const [r, g, b] = ansiToRgba(196).toInts()
    expect(r).toBe(255)
    expect(g).toBe(0)
    expect(b).toBe(0)
  })

  it("converts grayscale ramp (code 232 = darkest gray)", () => {
    const [r, g, b] = ansiToRgba(232).toInts()
    expect(r).toBe(8)
    expect(g).toBe(8)
    expect(b).toBe(8)
  })

  it("converts grayscale ramp (code 255 = lightest gray)", () => {
    const [r, g, b] = ansiToRgba(255).toInts()
    expect(r).toBe(238)
    expect(g).toBe(238)
    expect(b).toBe(238)
  })

  it("returns black for invalid codes >= 256", () => {
    const [r, g, b] = ansiToRgba(999).toInts()
    expect(r).toBe(0)
    expect(g).toBe(0)
    expect(b).toBe(0)
  })
})

describe("selectedForeground", () => {
  function makeTheme(overrides: Partial<Theme>): Theme {
    const base = resolveTheme(makeMinimalThemeJson(), "dark")
    return { ...base, ...overrides }
  }

  it("returns selectedListItemText when _hasSelectedListItemText is true", () => {
    const color = RGBA.fromInts(100, 200, 50)
    const theme = makeTheme({ _hasSelectedListItemText: true, selectedListItemText: color })
    expect(selectedForeground(theme).toInts()).toEqual(color.toInts())
  })

  it("returns white for dark transparent bg with dark primary", () => {
    const theme = makeTheme({
      _hasSelectedListItemText: false,
      background: RGBA.fromInts(0, 0, 0, 0),
      primary: RGBA.fromInts(10, 10, 10),
    })
    const [r, g, b] = selectedForeground(theme).toInts()
    expect(r).toBe(255)
    expect(g).toBe(255)
    expect(b).toBe(255)
  })

  it("returns black for transparent bg with bright primary", () => {
    const theme = makeTheme({
      _hasSelectedListItemText: false,
      background: RGBA.fromInts(0, 0, 0, 0),
      primary: RGBA.fromInts(250, 250, 250),
    })
    const [r, g, b] = selectedForeground(theme).toInts()
    expect(r).toBe(0)
    expect(g).toBe(0)
    expect(b).toBe(0)
  })

  it("uses custom bg for contrast when transparent background", () => {
    const theme = makeTheme({
      _hasSelectedListItemText: false,
      background: RGBA.fromInts(0, 0, 0, 0),
      primary: RGBA.fromInts(200, 200, 200),
    })
    const darkBg = RGBA.fromInts(10, 10, 10)
    const [r, g, b] = selectedForeground(theme, darkBg).toInts()
    expect(r).toBe(255)
    expect(g).toBe(255)
    expect(b).toBe(255)
  })

  it("falls back to background color for opaque backgrounds", () => {
    const bg = RGBA.fromInts(30, 40, 50)
    const theme = makeTheme({
      _hasSelectedListItemText: false,
      background: bg,
    })
    expect(selectedForeground(theme).toInts()).toEqual(bg.toInts())
  })
})
