import { createMemo } from "solid-js"
import { useSync } from "../app/tui_a1/state/sync-context"
import { Keybind } from "../support/util/keybind"
import { mapValues } from "remeda"

import type { KeybindsConfig } from "@terminal/core/AIAgent"

import type { ParsedKey, Renderable } from "@opentui/core"
import { createStore } from "solid-js/store"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { createSimpleContext } from "./helper"

export const { use: useKeybind, provider: KeybindProvider } = createSimpleContext({
  name: "Keybind",
  init: () => {
    const sync = useSync()
    const keybinds = createMemo(() => {
      return mapValues(sync.data.config.keybinds ?? {}, (value) => Keybind.parse(value ?? "none"))
    })
    const [store, setStore] = createStore({
      leader: false,
    })
    const renderer = useRenderer()

    let focus: Renderable | null
    let timeout: NodeJS.Timeout

    function restoreFocus(target: Renderable | null | undefined) {
      if (!target || target.isDestroyed) return
      try {
        target.focus()
      } catch {
        focus = null
      }
    }

    function leader(active: boolean) {
      if (active) {
        setStore("leader", true)
        focus = renderer.currentFocusedRenderable
        focus?.blur()
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(() => {
          if (!store.leader) return
          leader(false)
          restoreFocus(focus)
        }, 2000)
        return
      }

      if (!active) {
        if (focus && !renderer.currentFocusedRenderable) {
          restoreFocus(focus)
        }
        setStore("leader", false)
      }
    }

    useKeyboard(async (evt) => {
      if (!store.leader && result.match("leader", evt)) {
        leader(true)
        return
      }

      if (store.leader && evt.name) {
        setImmediate(() => {
          if (focus && renderer.currentFocusedRenderable === focus) {
            restoreFocus(focus)
          }
          leader(false)
        })
      }
    })

    const result = {
      get all() {
        return keybinds()
      },
      get leader() {
        return store.leader
      },
      parse(evt: ParsedKey): Keybind.Info {
        if (evt.name === "\x1F") {
          return Keybind.fromParsedKey({ ...evt, name: "_", ctrl: true }, store.leader)
        }
        return Keybind.fromParsedKey(evt, store.leader)
      },
      match(key: keyof KeybindsConfig, evt: ParsedKey) {
        const keybind = keybinds()[key]
        if (!keybind) return false
        const parsed: Keybind.Info = result.parse(evt)
        for (const key of keybind) {
          if (Keybind.match(key, parsed)) {
            return true
          }
        }
        return false
      },
      print(key: keyof KeybindsConfig) {
        const list = keybinds()[key]
        const first = list ? list[0] : undefined
        if (!first) return ""
        const result = Keybind.toString(first)
        const leader = keybinds().leader?.[0]
        if (!leader) return result
        return result.replace("<leader>", Keybind.toString(leader))
      },
    }
    return result
  },
})
