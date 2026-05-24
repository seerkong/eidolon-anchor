import { useTheme } from "../../providers/theme"
import { DialogHeader, useDialog, type DialogContext } from "./context"
import { createStore } from "solid-js/store"
import { For } from "solid-js"
import { useKeyboard } from "@opentui/solid"

export type DialogConfirmProps = {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm?: () => void
  onCancel?: () => void
}

export function DialogConfirm(props: DialogConfirmProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const [store, setStore] = createStore({
    active: "cancel" as "confirm" | "cancel",
  })
  const labels = {
    cancel: props.cancelLabel ?? "[取消]",
    confirm: props.confirmLabel ?? "[确认]",
  }

  useKeyboard((evt) => {
    if (evt.name === "return") {
      if (store.active === "confirm") props.onConfirm?.()
      if (store.active === "cancel") props.onCancel?.()
      dialog.clear()
    }

    if (evt.name === "left" || evt.name === "right") {
      setStore("active", store.active === "confirm" ? "cancel" : "confirm")
    }
  })
  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <DialogHeader title={props.title} showClose={false} />
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>{props.message}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <For each={["confirm", "cancel"] as const}>
          {(key) => (
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={key === store.active ? theme.primary : undefined}
              onMouseUp={(evt) => {
                if (key === "confirm") props.onConfirm?.()
                if (key === "cancel") props.onCancel?.()
                dialog.clear()
              }}
            >
              <text fg={key === store.active ? theme.selectedListItemText : theme.textMuted}>
                {labels[key]}
              </text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

DialogConfirm.show = (dialog: DialogContext, title: string, message: string) => {
  return new Promise<boolean>((resolve) => {
    dialog.replace(
      () => (
        <DialogConfirm
          title={title}
          message={message}
          onConfirm={() => resolve(true)}
          onCancel={() => resolve(false)}
        />
      ),
      () => resolve(false),
    )
  })
}
