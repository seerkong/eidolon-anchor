/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo } from "solid-js"
import { useSync } from "../app/tui_a1/state/sync-context"
import { createSimpleContext } from "./helper"
import eidolonFlat from "./theme/eidolon-flat.json" with { type: "json" }
import { useKV } from "./kv"
import { createStore } from "solid-js/store"

import {
  type ThemeColors,
  type Theme,
  type ThemeJson,
  selectedForeground,
  resolveTheme,
} from "./theme/resolve"
import { generateSyntax, generateSubtleSyntax } from "./theme/syntax"

export { selectedForeground }
export type { Theme, ThemeColors, ThemeJson }

export const OFFICIAL_THEME_ID = "eidolon-flat"
const STORAGE_THEME_KEY = "theme"
const STORAGE_MODE_KEY = "theme_mode"

export const DEFAULT_THEMES: Record<string, ThemeJson> = {
  [OFFICIAL_THEME_ID]: eidolonFlat,
}

export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: (props: { mode: "dark" | "light" }) => {
    const sync = useSync()
    const kv = useKV()
    const [store, setStore] = createStore({
      themes: DEFAULT_THEMES,
      mode: kv.get(STORAGE_MODE_KEY, props.mode),
      ready: true,
    })

    createEffect(() => {
      if (sync.data.config.theme && sync.data.config.theme !== OFFICIAL_THEME_ID) {
        kv.set(STORAGE_THEME_KEY, OFFICIAL_THEME_ID)
      }
    })

    const values = createMemo(() => resolveTheme(store.themes[OFFICIAL_THEME_ID], store.mode))
    const syntax = createMemo(() => generateSyntax(values()))
    const subtleSyntax = createMemo(() => generateSubtleSyntax(values()))

    return {
      theme: new Proxy(values(), {
        get(_target, prop) {
          // @ts-expect-error dynamic proxy access
          return values()[prop]
        },
      }),
      get selected() {
        return OFFICIAL_THEME_ID
      },
      all() {
        return { [OFFICIAL_THEME_ID]: store.themes[OFFICIAL_THEME_ID] }
      },
      syntax,
      subtleSyntax,
      mode() {
        return store.mode
      },
      setMode(mode: "dark" | "light") {
        setStore("mode", mode)
        kv.set(STORAGE_MODE_KEY, mode)
      },
      set(_theme: string) {
        kv.set(STORAGE_THEME_KEY, OFFICIAL_THEME_ID)
      },
      get ready() {
        return store.ready
      },
    }
  },
})
