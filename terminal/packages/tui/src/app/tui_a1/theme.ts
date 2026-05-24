import { RGBA } from "@opentui/core"
import eidolonFlatTheme from "../../providers/theme/eidolon-flat.json" with { type: "json" }
import { resolveTheme, type ThemeJson } from "../../providers/theme/resolve"

const theme = resolveTheme(eidolonFlatTheme as ThemeJson, "dark")

export const tuiA1Theme = {
  ...theme,
  userBorder: theme.accent,
  assistantBorder: theme.secondary,
  toolBorder: theme.warning,
  panelGlow: RGBA.fromHex("#202830"),
  inputBorder: RGBA.fromHex("#5ba8ff"),
}
