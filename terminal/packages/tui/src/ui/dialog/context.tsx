import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { batch, createContext, Show, useContext, type JSX, type ParentProps } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useTheme } from "../../providers/theme"
import { Renderable, RGBA, TextAttributes } from "@opentui/core"
import { createStore } from "solid-js/store"
import { useToast } from "../toast/toast"
import { copyRendererSelection } from "../selection/copy"

const DIALOG_HORIZONTAL_INSET_RATIO = 0.05
const DIALOG_VERTICAL_INSET_RATIO = 0.1
function dialogInset(size: number, ratio: number): number {
  return Math.max(1, Math.floor(size * ratio))
}

export function Dialog(
  props: ParentProps<{
    size?: "medium" | "large" | "xlarge"
    paddingTop?: number
    onClose: () => void
  }>,
) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const horizontalInset = () => dialogInset(dimensions().width, DIALOG_HORIZONTAL_INSET_RATIO)
  const verticalInset = () => dialogInset(dimensions().height, DIALOG_VERTICAL_INSET_RATIO)
  const contentWidth = () => Math.max(20, dimensions().width - horizontalInset() * 2)
  const contentHeight = () => Math.max(8, dimensions().height - verticalInset() * 2)

  return (
    <box
      onMouseUp={async () => {
        if (renderer.getSelection()) return
        props.onClose?.()
      }}
      width={dimensions().width}
      height={dimensions().height}
      position="absolute"
      left={0}
      top={0}
      backgroundColor={RGBA.fromInts(0, 0, 0, 150)}
    >
      <box
        onMouseUp={async (e) => {
          if (renderer.getSelection()) return
          e.stopPropagation()
        }}
        position="absolute"
        left={horizontalInset()}
        top={verticalInset()}
        width={contentWidth()}
        height={contentHeight()}
        backgroundColor={theme.backgroundPanel}
        border={true}
        borderStyle="rounded"
        borderColor={theme.secondary}
        paddingTop={props.paddingTop ?? 1}
      >
        {props.children}
      </box>
    </box>
  )
}

function init() {
  const [store, setStore] = createStore({
    stack: [] as {
      render: () => JSX.Element
      onClose?: () => void
    }[],
    size: "medium" as "medium" | "large" | "xlarge",
    paddingTop: 1,
  })

  useKeyboard((evt) => {
    if (evt.name === "escape" && store.stack.length > 0) {
      const current = store.stack[store.stack.length - 1]!
      current.onClose?.()
      setStore("stack", store.stack.slice(0, -1))
      evt.preventDefault()
      evt.stopPropagation()
      refocus()
    }
  })

  const renderer = useRenderer()
  let focus: Renderable | null
  function refocus() {
    setTimeout(() => {
      if (!focus) return
      if (focus.isDestroyed) return
      function find(item: Renderable) {
        for (const child of item.getChildren()) {
          if (child === focus) return true
          if (find(child)) return true
        }
        return false
      }
      const found = find(renderer.root)
      if (!found) return
      focus.focus()
    }, 1)
  }

  return {
    clear() {
      for (const item of store.stack) {
        if (item.onClose) item.onClose()
      }
      batch(() => {
        setStore("size", "medium")
        setStore("paddingTop", 1)
        setStore("stack", [])
      })
      refocus()
    },
    replace(input: JSX.Element | (() => JSX.Element), onClose?: () => void) {
      if (store.stack.length === 0) {
        focus = renderer.currentFocusedRenderable
        focus?.blur()
      }
      for (const item of store.stack) {
        if (item.onClose) item.onClose()
      }
      setStore("size", "medium")
      setStore("paddingTop", 1)
      setStore("stack", [
        {
          render: typeof input === "function" ? input : () => input,
          onClose,
        },
      ])
    },
    get stack() {
      return store.stack
    },
    get size() {
      return store.size
    },
    get paddingTop() {
      return store.paddingTop
    },
    setSize(size: "medium" | "large" | "xlarge") {
      setStore("size", size)
    },
    setPaddingTop(paddingTop: number) {
      setStore("paddingTop", paddingTop)
    },
  }
}

export type DialogContext = ReturnType<typeof init>

const ctx = createContext<DialogContext>()

export function DialogProvider(props: ParentProps) {
  const value = init()
  const renderer = useRenderer()
  const toast = useToast()
  const current = () => value.stack[value.stack.length - 1]
  return (
    <ctx.Provider value={value}>
      {props.children}
      <box
        position="absolute"
        onMouseUp={async () => {
          await copyRendererSelection(renderer as never, {
            onCopied: () => toast.show({ message: "Copied to clipboard", variant: "info" }),
            onError: toast.error,
          })
        }}
      >
        <Show when={current()} keyed>
          {(item: DialogContext["stack"][number]) => (
            <Dialog onClose={() => value.clear()} size={value.size} paddingTop={value.paddingTop}>
              <Dynamic component={item.render} />
            </Dialog>
          )}
        </Show>
      </box>
    </ctx.Provider>
  )
}

export function useDialog() {
  const value = useContext(ctx)
  if (!value) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  return value
}

export function DialogHeader(props: { title: JSX.Element | string; closeLabel?: string; showClose?: boolean }) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const showClose = () => props.showClose !== false

  return (
    <box flexDirection="row" justifyContent="space-between">
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        {props.title}
      </text>
      <Show when={showClose()}>
        <text
          fg={theme.textMuted}
          onMouseUp={(evt) => {
            evt.stopPropagation()
            dialog.clear()
          }}
        >
          {props.closeLabel ?? "[关闭(esc)]"}
        </text>
      </Show>
    </box>
  )
}
