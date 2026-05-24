import { useTheme } from "../../providers/theme"
import { DialogHeader, useDialog, type DialogContext } from "./context"
import { useKeyboard } from "@opentui/solid"

export type DialogAlertProps = {
  title: string
  message: string
  confirmLabel?: string
  onConfirm?: () => void
}

export function DialogAlert(props: DialogAlertProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const confirmLabel = () => props.confirmLabel ?? "[确认]"

  useKeyboard((evt) => {
    if (evt.name === "return") {
      props.onConfirm?.()
      dialog.clear()
    }
  })
  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <DialogHeader title={props.title} showClose={false} />
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>{props.message}</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={theme.primary}
          onMouseUp={() => {
            props.onConfirm?.()
            dialog.clear()
          }}
        >
          <text fg={theme.selectedListItemText}>{confirmLabel()}</text>
        </box>
      </box>
    </box>
  )
}

DialogAlert.show = (dialog: DialogContext, title: string, message: string) => {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => <DialogAlert title={title} message={message} onConfirm={() => resolve()} />,
      () => resolve(),
    )
  })
}
