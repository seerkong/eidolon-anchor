/** @jsxImportSource @opentui/solid */
import { InputRenderable, RGBA, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTheme, selectedForeground } from "../../providers/theme"
import { entries, filter, flatMap, groupBy, pipe } from "remeda"
import { batch, createEffect, createMemo, For, Show, type JSX, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useKeyboard } from "@opentui/solid"
import * as fuzzysort from "fuzzysort"
import { isDeepEqual } from "remeda"
import { DialogHeader, useDialog, type DialogContext } from "./context"
import { useKeybind } from "../../providers/keybind"
import { Keybind } from "../../support/util/keybind"
import { Locale } from "../../support/util/locale"

export interface DialogSelectProps<T> {
  title: string
  placeholder?: string
  options: DialogSelectOption<T>[]
  ref?: (ref: DialogSelectRef<T>) => void
  onMove?: (option: DialogSelectOption<T>) => void
  onFilter?: (query: string) => void
  onSelect?: (option: DialogSelectOption<T>) => void
  skipFilter?: boolean
  keybind?: {
    keybind: Keybind.Info
    title: string
    disabled?: boolean
    onTrigger: (option: DialogSelectOption<T>) => void
  }[]
  current?: T
}

export interface DialogSelectOption<T = any> {
  title: string
  value: T
  description?: JSX.Element | string
  meta?: JSX.Element | string
  detail?: JSX.Element | string
  footer?: JSX.Element | string
  category?: string
  disabled?: boolean
  bg?: RGBA
  gutter?: JSX.Element
  onSelect?: (ctx: DialogContext, trigger?: "prompt") => void
}

export type DialogSelectRef<T> = {
  filter: string
  filtered: DialogSelectOption<T>[]
}

export function DialogSelect<T>(props: DialogSelectProps<T>) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [store, setStore] = createStore({
    selected: 0,
    filter: "",
  })

  createEffect(
    on(
      () => props.current,
      (current) => {
        if (current) {
          const currentIndex = flat().findIndex((opt) => isDeepEqual(opt.value, current))
          if (currentIndex >= 0) {
            setStore("selected", currentIndex)
          }
        }
      },
    ),
  )

  let input: InputRenderable
  let destroyed = false
  onCleanup(() => {
    destroyed = true
  })

  const filtered = createMemo(() => {
    if (props.skipFilter) {
      return props.options.filter((x) => x.disabled !== true)
    }
    const needle = store.filter.toLowerCase()
    const result = pipe(
      props.options,
      filter((x) => x.disabled !== true),
      (x) => (!needle ? x : fuzzysort.go(needle, x, { keys: ["title", "category"] }).map((x) => x.obj)),
    )
    return result
  })

  const grouped = createMemo(() => {
    const result = pipe(
      filtered(),
      groupBy((x) => x.category ?? ""),
      // mapValues((x) => x.sort((a, b) => a.title.localeCompare(b.title))),
      entries(),
    )
    return result
  })

  const flat = createMemo(() => {
    return pipe(
      grouped(),
      flatMap(([_, options]) => options),
    )
  })

  const selected = createMemo(() => flat()[store.selected])

  createEffect(
    on([() => store.filter, () => props.current], ([filter, current]) => {
      if (filter.length > 0) {
        setStore("selected", 0)
      } else if (current) {
        const currentIndex = flat().findIndex((opt) => isDeepEqual(opt.value, current))
        if (currentIndex >= 0) {
          setStore("selected", currentIndex)
        }
      }
      scroll?.scrollTo(0)
    }),
  )

  function clearFilter() {
    batch(() => {
      setStore("filter", "")
      setStore("selected", 0)
      props.onFilter?.("")
    })
    if (input) input.setText("")
    scroll?.scrollTo(0)
  }

  function move(direction: number) {
    if (flat().length === 0) return
    let next = store.selected + direction
    if (next < 0) next = flat().length - 1
    if (next >= flat().length) next = 0
    moveTo(next)
  }

  function moveTo(next: number) {
    setStore("selected", next)
    props.onMove?.(selected()!)
    if (!scroll) return
    const target = scroll.getChildren().find((child) => {
      return child.id === JSON.stringify(selected()?.value)
    })
    if (!target) return
    const y = target.y - scroll.y
    if (y >= scroll.height) {
      scroll.scrollBy(y - scroll.height + 1)
    }
    if (y < 0) {
      scroll.scrollBy(y)
      if (isDeepEqual(flat()[0].value, selected()?.value)) {
        scroll.scrollTo(0)
      }
    }
  }

  const keybind = useKeybind()
  useKeyboard((evt) => {
    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) move(-1)
    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) move(1)
    if (evt.name === "pageup") move(-10)
    if (evt.name === "pagedown") move(10)
    if (evt.name === "return") {
      const option = selected()
      if (option) {
        evt.preventDefault()
        evt.stopPropagation()
        if (option.onSelect) option.onSelect(dialog)
        props.onSelect?.(option)
      }
    }
    if (evt.ctrl && evt.name === "l") {
      evt.preventDefault()
      evt.stopPropagation()
      clearFilter()
      return
    }

    for (const item of props.keybind ?? []) {
      if (item.disabled) continue
      if (Keybind.match(item.keybind, keybind.parse(evt))) {
        const s = selected()
        if (s) {
          evt.preventDefault()
          item.onTrigger(s)
        }
      }
    }
  })

  let scroll: ScrollBoxRenderable | undefined
  const ref: DialogSelectRef<T> = {
    get filter() {
      return store.filter
    },
    get filtered() {
      return filtered()
    },
  }
  props.ref?.(ref)

  const keybinds = createMemo(() => props.keybind?.filter((x) => !x.disabled) ?? [])

  return (
    <box gap={1} paddingBottom={1} height="100%" flexDirection="column">
      <box paddingLeft={4} paddingRight={4}>
        <DialogHeader title={props.title} />
        <box paddingTop={1} paddingBottom={1} flexDirection="row">
          <box flexGrow={1}>
            <input
              onInput={(e) => {
                batch(() => {
                  setStore("filter", e)
                  props.onFilter?.(e)
                })
              }}
              focusedBackgroundColor={theme.backgroundPanel}
              cursorColor={theme.primary}
              focusedTextColor={theme.textMuted}
              ref={(r) => {
                input = r
                setTimeout(() => {
                  if (destroyed || input?.isDestroyed) return
                  input.focus()
                }, 1)
              }}
              placeholder={props.placeholder ?? "Search"}
            />
          </box>
          <text
            flexShrink={0}
            fg={theme.secondary}
            attributes={TextAttributes.BOLD}
            onMouseUp={(evt) => {
              evt.stopPropagation()
              clearFilter()
            }}
          >
            [清空]
          </text>
        </box>
      </box>
      <Show
        when={grouped().length > 0}
        fallback={
          <box paddingLeft={4} paddingRight={4} paddingTop={1} flexGrow={1}>
            <text fg={theme.textMuted}>No results found</text>
          </box>
        }
      >
        <box flexGrow={1} minHeight={0}>
        <scrollbox
          paddingLeft={1}
          paddingRight={1}
          scrollbarOptions={{ visible: false }}
          ref={(r: ScrollBoxRenderable) => (scroll = r)}
          height="100%"
        >
          <For each={grouped()}>
            {([category, options], index) => (
              <>
                <Show when={category}>
                  <box paddingTop={index() > 0 ? 1 : 0} paddingLeft={3}>
                    <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                      {category}
                    </text>
                  </box>
                </Show>
                <For each={options}>
                  {(option) => {
                    const active = createMemo(() => isDeepEqual(option.value, selected()?.value))
                    const current = createMemo(() => isDeepEqual(option.value, props.current))
                    return (
                      <box
                        id={JSON.stringify(option.value)}
                        flexDirection="row"
                        onMouseUp={() => {
                          option.onSelect?.(dialog)
                          props.onSelect?.(option)
                        }}
                        onMouseOver={() => {
                          const index = flat().findIndex((x) => isDeepEqual(x.value, option.value))
                          if (index === -1) return
                          moveTo(index)
                        }}
                        backgroundColor={active() ? (option.bg ?? theme.primary) : RGBA.fromInts(0, 0, 0, 0)}
                        paddingLeft={current() || option.gutter ? 1 : 3}
                        paddingRight={3}
                        gap={1}
                      >
                        <Option
                          title={option.title}
                          footer={option.footer}
                          description={option.description !== category ? option.description : undefined}
                          meta={option.meta}
                          detail={option.detail}
                          active={active()}
                          current={current()}
                          gutter={option.gutter}
                        />
                      </box>
                    )
                  }}
                </For>
              </>
            )}
          </For>
        </scrollbox>
        </box>
      </Show>
      <Show when={keybinds().length} fallback={<box flexShrink={0} />}>
        <box paddingRight={2} paddingLeft={4} flexDirection="row" gap={2} flexShrink={0} paddingTop={1}>
          <For each={keybinds()}>
            {(item) => (
              <text>
                <span style={{ fg: theme.text }}>
                  <b>{item.title}</b>{" "}
                </span>
                <span style={{ fg: theme.textMuted }}>{Keybind.toString(item.keybind)}</span>
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  )
}

function Option(props: {
  title: string
  description?: JSX.Element | string
  meta?: JSX.Element | string
  detail?: JSX.Element | string
  active?: boolean
  current?: boolean
  footer?: JSX.Element | string
  gutter?: JSX.Element
  onMouseOver?: () => void
}) {
  const { theme } = useTheme()
  const fg = selectedForeground(theme)
  const hasExpandedBody = () => Boolean(props.meta || props.detail)

  const renderLine = (line: JSX.Element | string | undefined, color: RGBA) => {
    if (!line) return null
    if (typeof line === "string") {
      return (
        <text fg={color} overflow="hidden">
          {Locale.truncate(line, 120)}
        </text>
      )
    }
    return <box>{line}</box>
  }

  return (
    <>
      <Show when={props.current}>
        <text flexShrink={0} fg={props.active ? fg : props.current ? theme.primary : theme.text} marginRight={0}>
          ●
        </text>
      </Show>
      <Show when={!props.current && props.gutter}>
        <box flexShrink={0} marginRight={0}>
          {props.gutter}
        </box>
      </Show>
      <box flexGrow={1} flexDirection="column" paddingLeft={3}>
        <Show when={hasExpandedBody()}>{renderLine(props.meta, props.active ? fg : theme.textMuted)}</Show>
        <text
          fg={props.active ? fg : props.current ? theme.primary : theme.text}
          attributes={props.active ? TextAttributes.BOLD : undefined}
          overflow="hidden"
        >
          {Locale.truncate(props.title, hasExpandedBody() ? 120 : 61)}
          <Show when={!hasExpandedBody() && props.description}>
            <span style={{ fg: props.active ? fg : theme.textMuted }}>
              {" "}
              {typeof props.description === "string" ? props.description : props.description}
            </span>
          </Show>
        </text>
        <Show when={hasExpandedBody()}>{renderLine(props.detail ?? props.description, props.active ? fg : theme.textMuted)}</Show>
      </box>
      <Show when={props.footer}>
        <box flexShrink={0}>
          <text fg={props.active ? fg : theme.textMuted}>{props.footer}</text>
        </box>
      </Show>
    </>
  )
}
