/** @jsxImportSource @opentui/solid */
import { DialogSelect, type DialogSelectRef } from "../../../../ui/dialog/select"
import { OFFICIAL_THEME_ID, useTheme } from "../../../../providers/theme"
import { useDialog } from "../../../../ui/dialog/context"
import { onCleanup, onMount } from "solid-js"

export function DialogThemeList() {
  const theme = useTheme()
  const options = [{ title: "Eidolon Flat", value: OFFICIAL_THEME_ID, description: "Official flat + fluent shell theme" }]
  const dialog = useDialog()
  let confirmed = false
  let ref: DialogSelectRef<string>
  const initial = OFFICIAL_THEME_ID

  onCleanup(() => {
    if (!confirmed) theme.set(initial)
  })

  return (
    <DialogSelect
      title="Appearance"
      options={options}
      current={initial}
      onMove={(opt) => {
        theme.set(opt.value)
      }}
      onSelect={(opt) => {
        theme.set(opt.value)
        confirmed = true
        dialog.clear()
      }}
      ref={(r) => {
        ref = r
      }}
      onFilter={(query) => {
        if (query.length === 0) {
          theme.set(initial)
          return
        }

        const first = ref.filtered[0]
        if (first) theme.set(first.value)
      }}
    />
  )
}
