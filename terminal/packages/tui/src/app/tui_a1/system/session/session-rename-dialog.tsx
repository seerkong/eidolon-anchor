/** @jsxImportSource @opentui/solid */
import { DialogPrompt } from "../../../../ui/dialog/prompt"
import { useSync } from "../../state/sync-context"
import { createMemo } from "solid-js"
import { useRuntimeClient } from "../../../../providers/runtime-client"

interface DialogSessionRenameProps {
  session: string
  onRenamed?: () => void
}

export function DialogSessionRename(props: DialogSessionRenameProps) {
  const sync = useSync()
  const sdk = useRuntimeClient()
  const session = createMemo(() => sync.session.get(props.session))

  return (
    <DialogPrompt
      title="Rename Session"
      value={session()?.title}
      onConfirm={async (value) => {
        const result = await sdk.client.session.update({
          sessionID: props.session,
          title: value,
        })
        const updated = result.data
        const index = sync.data.session.findIndex((candidate) => candidate.id === props.session)
        if (updated && index >= 0) sync.set("session", index, updated)
        props.onRenamed?.()
      }}
    />
  )
}
