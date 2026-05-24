import { createMemo } from "solid-js"
import { useLocal } from "../../state/local-context"
import { DialogSelect } from "../../../../ui/dialog/select"
import { useDialog } from "../../../../ui/dialog/context"
import { formatAgentOptionDescription, sortAgentsByCurrent } from "./agent-option"

export function DialogAgent() {
  const local = useLocal()
  const dialog = useDialog()

  const options = createMemo(() =>
    sortAgentsByCurrent(local.agent.list(), local.agent.current().name).map((item) => {
      return {
        value: item.name,
        title: item.name,
        description: formatAgentOptionDescription(item),
      }
    }),
  )

  return (
    <DialogSelect
      title="Select agent"
      current={local.agent.current().name}
      options={options()}
      onSelect={(option) => {
        local.agent.set(option.value)
        dialog.clear()
      }}
    />
  )
}
