/** @jsxImportSource @opentui/solid */
import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { onCleanup, onMount, type JSX } from "solid-js"
import { useKeybind } from "../../providers/keybind"
import { useTheme } from "../../providers/theme"
import { DialogHeader, useDialog, type DialogContext } from "./context"
import { Log } from "../../support/util/log"

export type DialogPromptProps = {
  title: string
  description?: () => JSX.Element
  placeholder?: string
  value?: string
  onConfirm?: (value: string) => void | Promise<void>
  onCancel?: () => void
  confirmLabel?: string
  cancelLabel?: string
}

export function DialogPrompt(props: DialogPromptProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const renderer = useRenderer()
  let textarea: TextareaRenderable
  let initialValueSet = false
  let submitting = false
  let mounted = true

  onCleanup(() => {
    mounted = false
  })

  const submit = async () => {
    if (submitting) return
    submitting = true
    const value = textarea?.plainText ?? ""
    Log.Default.info("tui.dialog.prompt.submit", {
      title: props.title,
      hasValue: Boolean(value),
      length: value.length,
    })
    try {
      await props.onConfirm?.(value)
      if (mounted) {
        dialog.clear()
      }
    } finally {
      submitting = false
    }
  }

  const cancel = () => {
    props.onCancel?.()
    dialog.clear()
  }

  useKeyboard((evt) => {
    if (evt.name === "escape" || keybind.match("app_exit", evt)) {
      evt.preventDefault()
      cancel()
      return
    }
    if (evt.name === "return" || evt.name === "linefeed" || evt.name === "kpenter") {
      evt.preventDefault()
      void submit()
      return
    }
  })

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      textarea.focus()
      textarea.gotoLineEnd()
    }, 1)
    if (!initialValueSet && props.value) {
      textarea.initialValue = props.value
      initialValueSet = true
    }
  })

  return (
    <box paddingLeft={4} paddingRight={4} paddingBottom={1} gap={1}>
      <DialogHeader title={props.title} showClose={false} />
      <box gap={1}>
        {props.description}
        <textarea
          height={3}
          focused
          keyBindings={[
            { name: "return", action: "submit" },
            { name: "linefeed", action: "submit" },
          ]}
          onContentChange={() => {
          }}
          onSubmit={() => {
            Log.Default.info("tui.dialog.prompt.onsubmit", {
              title: props.title,
              hasValue: Boolean(textarea?.plainText),
              length: textarea?.plainText?.length ?? 0,
            })
            void submit()
          }}
          ref={(val: TextareaRenderable) => {
            textarea = val
            if (!initialValueSet && props.value) {
              textarea.initialValue = props.value
              initialValueSet = true
            }
          }}
          initialValue={props.value}
          placeholder={props.placeholder ?? "Enter text"}
          textColor={theme.text}
          focusedTextColor={theme.text}
          cursorColor={theme.text}
        />
      </box>
      <box paddingBottom={1} gap={2} flexDirection="row" justifyContent="flex-end">
        <text
          fg={theme.primary}
          attributes={TextAttributes.BOLD}
          onMouseUp={(evt) => {
            evt.stopPropagation()
            void submit()
          }}
        >
          {props.confirmLabel ?? "[确认]"}
        </text>
        <text
          fg={theme.textMuted}
          onMouseUp={(evt) => {
            evt.stopPropagation()
            cancel()
          }}
        >
          {props.cancelLabel ?? "[取消]"}
        </text>
      </box>
    </box>
  )
}

DialogPrompt.show = (dialog: DialogContext, title: string, options?: Omit<DialogPromptProps, "title">) => {
  return new Promise<string | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogPrompt title={title} {...options} onConfirm={(value) => resolve(value)} onCancel={() => resolve(null)} />
      ),
      () => resolve(null),
    )
  })
}
